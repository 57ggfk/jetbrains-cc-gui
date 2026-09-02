import { useState, useCallback, useRef, useEffect } from 'react';
import type { Attachment } from '../components/ChatInputBox/types';
import {
  MESSAGE_QUEUE_INTERRUPT_FAILED_EVENT,
  MESSAGE_QUEUE_RESET_EVENT,
  MESSAGE_QUEUE_STREAM_COMPLETED_EVENT,
  MESSAGE_QUEUE_STREAM_STARTED_EVENT,
  type MessageQueueStreamCompletedDetail,
  type MessageQueueStreamStartedDetail,
} from '../constants/messageQueueEvents';

export interface QueuedMessage {
  id: string;
  content: string;
  attachments?: Attachment[];
  queuedAt: number;
}

export interface UseMessageQueueOptions {
  /** Whether AI is currently processing */
  isLoading: boolean;
  /**
   * Callback to execute a message
   * 返回 false 表示消息未真实发出（如 SDK 状态守卫拦截、桥不可用），
   * 调度器会把消息放回队首等待下次消费，避免静默丢失。
   */
  onExecute: (content: string, attachments?: Attachment[]) => boolean;
  /** 打断当前任务的回调 */
  onInterrupt?: () => void;
}

export interface UseMessageQueueReturn {
  /** Current queue */
  queue: QueuedMessage[];
  /** Add message to queue */
  enqueue: (content: string, attachments?: Attachment[]) => void;
  /** Remove message from queue by id */
  dequeue: (id: string) => void;
  /** Clear entire queue */
  clearQueue: () => void;
  /** Update the content of a queued message */
  update: (id: string, content: string) => void;
  /** Move a queued message one position earlier */
  moveUp: (id: string) => void;
  /** Move a queued message one position later */
  moveDown: (id: string) => void;
  /** Move a queued message to the next execution position */
  moveToFront: (id: string) => void;
  /** Move a queued message to the last execution position */
  moveToBack: (id: string) => void;
  /** Move a queued message to the next execution position without interruption */
  insert: (id: string) => void;
  /** 打断当前任务并优先调度指定消息 */
  interruptAndSendNow: (id: string) => void;
  /** Whether queue has items */
  hasQueuedMessages: boolean;
}

type QueueSchedulerState =
  | { phase: 'idle' }
  | {
      phase: 'waiting-for-interrupted-turn-end';
      generation: number;
      target: QueuedMessage;
    }
  | {
      phase: 'waiting-for-queued-turn-start';
      generation: number;
      itemId: string;
      releasedByCompletionId: string | null;
    }
  | {
      phase: 'waiting-for-queued-turn-end';
      generation: number;
      itemId: string;
      releasedByCompletionId: string | null;
      turnId: number;
    };

/**
 * Hook for managing message queue
 * 普通队列保持 loading 结束后自动消费；仅“打断并优先执行”使用严格流状态机。
 */
export function useMessageQueue({
  isLoading,
  onExecute,
  onInterrupt,
}: UseMessageQueueOptions): UseMessageQueueReturn {
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const onExecuteRef = useRef(onExecute);
  onExecuteRef.current = onExecute;
  const prevLoadingRef = useRef(isLoading);
  const isExecutingFromQueueRef = useRef(false);
  const schedulerStateRef = useRef<QueueSchedulerState>({ phase: 'idle' });
  const schedulerGenerationRef = useRef(0);
  const executeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressLoadingAutoConsumeRef = useRef(false);

  /**
   * 执行失败（onExecute 返回 false）时把消息放回队首，等待下次 loading 下降再消费。
   * 防御同一 id 已存在（如用户手动重发入队），避免重复项。
   */
  const restoreToQueueFront = useCallback((message: QueuedMessage) => {
    setQueue(prev => prev.some(item => item.id === message.id) ? prev : [message, ...prev]);
  }, []);

  const scheduleQueueItem = useCallback((nextMessage: QueuedMessage) => {
    if (isExecutingFromQueueRef.current) return;

    isExecutingFromQueueRef.current = true;
    setQueue(prev => prev.some(item => item.id === nextMessage.id)
      ? prev.filter(item => item.id !== nextMessage.id)
      : prev);
    executeTimerRef.current = setTimeout(() => {
      executeTimerRef.current = null;
      const succeeded = onExecuteRef.current(nextMessage.content, nextMessage.attachments);
      isExecutingFromQueueRef.current = false;
      // 发送失败：消息已出队但从未发出，放回队首防止静默丢失。
      // loading 未跳变，剩余队列的消费随之暂停，待用户处理（如安装 SDK）后的下一轮恢复。
      if (succeeded === false) {
        restoreToQueueFront(nextMessage);
      }
    }, 50);
  }, [restoreToQueueFront]);

  const releaseInterruptedTarget = useCallback((
    nextMessage: QueuedMessage,
    generation: number,
    releasedByCompletionId: string,
  ) => {
    schedulerStateRef.current = {
      phase: 'waiting-for-queued-turn-start',
      generation,
      itemId: nextMessage.id,
      releasedByCompletionId,
    };
    setQueue(prev => prev.some(item => item.id === nextMessage.id)
      ? prev.filter(item => item.id !== nextMessage.id)
      : prev);

    const execute = () => {
      executeTimerRef.current = null;
      const schedulerState = schedulerStateRef.current;
      if (
        schedulerState.phase !== 'waiting-for-queued-turn-start'
        || schedulerState.generation !== generation
        || schedulerState.itemId !== nextMessage.id
      ) {
        return;
      }
      const succeeded = onExecuteRef.current(nextMessage.content, nextMessage.attachments);
      // 发送失败：目标从未发出，不会有任何流事件到达，必须在此解除等待相位，
      // 否则调度器永久卡在 waiting-for-queued-turn-start。
      if (succeeded === false) {
        schedulerStateRef.current = { phase: 'idle' };
        restoreToQueueFront(nextMessage);
      }
    };

    // 保留现有延迟，确保目标项先从队列移除，再发送消息。
    executeTimerRef.current = setTimeout(execute, 50);
  }, [restoreToQueueFront]);

  // Generate unique ID
  const generateId = useCallback(() => {
    return `queue-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }, []);

  // Add message to queue
  const enqueue = useCallback((content: string, attachments?: Attachment[]) => {
    const newItem: QueuedMessage = {
      id: generateId(),
      content,
      attachments,
      queuedAt: Date.now(),
    };
    setQueue(prev => [...prev, newItem]);
  }, [generateId]);

  /**
   * 取消调度器等待相位中引用的目标消息（dequeue/clearQueue 删除目标时调用）。
   * 仅在目标仍可撤回的两个相位生效：
   * - waiting-for-interrupted-turn-end：目标仍在队列中，打断信号已发出但目标尚未补发；
   * - waiting-for-queued-turn-start：目标已出队，但 50ms execute 闭包可能仍挂起。
   * waiting-for-queued-turn-end 的目标已发送，无法撤回，不在此处理。
   */
  const cancelScheduledItem = useCallback((id: string): void => {
    const schedulerState = schedulerStateRef.current;
    const isInterruptWaitTarget =
      schedulerState.phase === 'waiting-for-interrupted-turn-end' && schedulerState.target.id === id;
    const isQueuedStartTarget =
      schedulerState.phase === 'waiting-for-queued-turn-start' && schedulerState.itemId === id;
    if (!isInterruptWaitTarget && !isQueuedStartTarget) return;

    schedulerStateRef.current = { phase: 'idle' };
    // 递增 generation，使 releaseInterruptedTarget 挂起的 50ms execute 闭包失效。
    schedulerGenerationRef.current += 1;
    if (executeTimerRef.current != null) {
      clearTimeout(executeTimerRef.current);
      executeTimerRef.current = null;
    }
    // 打断等待相位下，interruptSession() 触发的 loading 下降可能尚未到达；
    // 目标已被删除，这次下降不能再自动消费队首。
    // waiting-for-queued-turn-start 相位不置该标记：若消息已真实发出，
    // 其轮次结束时的 loading 下降仍需正常自动消费队首。
    if (isInterruptWaitTarget && prevLoadingRef.current) {
      suppressLoadingAutoConsumeRef.current = true;
    }
  }, []);

  // Remove message from queue
  const dequeue = useCallback((id: string) => {
    // 删除的若是调度器等待中的目标消息，需同步取消其挂起的自动发送，
    // 否则旧轮次结束或挂起的 50ms 闭包仍会补发这条已删除的消息。
    cancelScheduledItem(id);
    setQueue(prev => prev.filter(item => item.id !== id));
  }, [cancelScheduledItem]);

  // Clear entire queue
  const clearQueue = useCallback(() => {
    // 清空队列会连同等待相位引用的目标一起移除，需同步取消调度器。
    const schedulerState = schedulerStateRef.current;
    if (schedulerState.phase === 'waiting-for-interrupted-turn-end') {
      cancelScheduledItem(schedulerState.target.id);
    } else if (schedulerState.phase === 'waiting-for-queued-turn-start') {
      cancelScheduledItem(schedulerState.itemId);
    }
    setQueue([]);
  }, [cancelScheduledItem]);

  // Update a queued message while preserving its metadata and position.
  const update = useCallback((id: string, content: string) => {
    setQueue(prev => {
      const index = prev.findIndex(item => item.id === id);
      if (index === -1) return prev;

      const next = [...prev];
      next[index] = { ...next[index], content };
      return next;
    });
  }, []);

  // Move a queued message one position earlier in logical execution order.
  const moveUp = useCallback((id: string) => {
    setQueue(prev => {
      const index = prev.findIndex(item => item.id === id);
      if (index <= 0) return prev;

      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
  }, []);

  // Move a queued message one position later in logical execution order.
  const moveDown = useCallback((id: string) => {
    setQueue(prev => {
      const index = prev.findIndex(item => item.id === id);
      if (index === -1 || index === prev.length - 1) return prev;

      const next = [...prev];
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
      return next;
    });
  }, []);

  // Move a queued message to the next execution position.
  const moveToFront = useCallback((id: string) => {
    setQueue(prev => {
      const index = prev.findIndex(item => item.id === id);
      if (index <= 0) return prev;

      return [prev[index], ...prev.slice(0, index), ...prev.slice(index + 1)];
    });
  }, []);

  // Move a queued message to the last execution position.
  const moveToBack = useCallback((id: string) => {
    setQueue(prev => {
      const index = prev.findIndex(item => item.id === id);
      if (index === -1 || index === prev.length - 1) return prev;

      return [...prev.slice(0, index), ...prev.slice(index + 1), prev[index]];
    });
  }, []);

  // insert currently points to moveToFront temporarily and will be refactored later.
  const insert = moveToFront;

  const interruptAndSendNow = useCallback((id: string) => {
    const item = queueRef.current.find(message => message.id === id);
    if (!item) return;

    const schedulerState = schedulerStateRef.current;
    if (
      schedulerState.phase === 'waiting-for-interrupted-turn-end'
      || schedulerState.phase === 'waiting-for-queued-turn-start'
    ) {
      return;
    }

    if (isLoading) {
      const generation = ++schedulerGenerationRef.current;
      schedulerStateRef.current = {
        phase: 'waiting-for-interrupted-turn-end',
        generation,
        target: item,
      };
      moveToFront(id);
      onInterrupt?.();
      return;
    }

    if (schedulerState.phase !== 'idle') return;

    setQueue(prev => prev.filter(message => message.id !== id));
    onExecuteRef.current(item.content, item.attachments);
  }, [isLoading, moveToFront, onInterrupt]);

  // 保持原有行为：普通完成和右下角停止都在 loading true -> false 时消费一条队首。
  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = isLoading;
    if (!wasLoading || isLoading) return;

    // 打断失败解锁、或目标轮次已由路径 B 消费队首时，跳过这一次 loading 下降，避免连发。
    if (suppressLoadingAutoConsumeRef.current) {
      suppressLoadingAutoConsumeRef.current = false;
      return;
    }

    if (
      schedulerStateRef.current.phase === 'idle'
      && !isExecutingFromQueueRef.current
    ) {
      const nextMessage = queueRef.current[0];
      if (nextMessage) scheduleQueueItem(nextMessage);
    }
  }, [isLoading, queue, scheduleQueueItem]);

  useEffect(() => {
    const handleStreamStarted = (event: Event) => {
      const detail = (event as CustomEvent<MessageQueueStreamStartedDetail>).detail;
      if (!detail || !Number.isFinite(detail.turnId) || detail.turnId <= 0) return;

      const schedulerState = schedulerStateRef.current;
      if (schedulerState.phase === 'waiting-for-queued-turn-start') {
        schedulerStateRef.current = {
          phase: 'waiting-for-queued-turn-end',
          generation: schedulerState.generation,
          itemId: schedulerState.itemId,
          releasedByCompletionId: schedulerState.releasedByCompletionId,
          turnId: detail.turnId,
        };
        return;
      }

      // 重复 STREAM_START 会生成新的前端 turnId，以最新一次为准。
      if (schedulerState.phase === 'waiting-for-queued-turn-end') {
        schedulerStateRef.current = {
          ...schedulerState,
          turnId: detail.turnId,
        };
      }
    };

    const handleStreamCompleted = (event: Event) => {
      const detail = (event as CustomEvent<MessageQueueStreamCompletedDetail>).detail;
      if (!detail || typeof detail.completionId !== 'string' || !detail.completionId) return;

      const schedulerState = schedulerStateRef.current;
      if (schedulerState.phase === 'idle') return;

      if (schedulerState.phase === 'waiting-for-interrupted-turn-end') {
        releaseInterruptedTarget(
          schedulerState.target,
          schedulerState.generation,
          detail.completionId,
        );
        return;
      }

      if (schedulerState.phase === 'waiting-for-queued-turn-start') {
        // 目标项尚未收到新的 STREAM_START；此时到达的结束信号都属于旧轮次或其重复通知。
        return;
      }

      if (schedulerState.phase === 'waiting-for-queued-turn-end') {
        if (detail.completionId === schedulerState.releasedByCompletionId) return;
        if (detail.turnId !== schedulerState.turnId) return;

        schedulerStateRef.current = { phase: 'idle' };
        // 目标轮次结束会伴随 loading 下降；这次队首由路径 B 消费，路径 A 必须跳过。
        const nextMessage = queueRef.current[0];
        if (nextMessage) {
          if (prevLoadingRef.current) {
            suppressLoadingAutoConsumeRef.current = true;
          }
          scheduleQueueItem(nextMessage);
        }
        return;
      }
    };

    const handleInterruptFailed = () => {
      const currentState = schedulerStateRef.current;
      if (currentState.phase !== 'waiting-for-interrupted-turn-end') return;

      schedulerStateRef.current = { phase: 'idle' };
      // 失败回调可能早于 interruptSession() 触发的 loading 下降；跳过那一次自动消费。
      if (prevLoadingRef.current) {
        suppressLoadingAutoConsumeRef.current = true;
      }
    };

    // 会话切换时重置调度器：切换期间流事件被 __sessionTransitioning 守卫拦截，
    // 等待中的相位永远等不到预期事件，必须显式回 idle，避免卡死状态跨会话存活。
    const handleQueueReset = () => {
      schedulerStateRef.current = { phase: 'idle' };
      // 递增 generation，使 releaseInterruptedTarget 挂起的 50ms execute 闭包因
      // generation 不匹配而失效，切换后不再补发旧会话的目标消息。
      schedulerGenerationRef.current += 1;
      if (executeTimerRef.current != null) {
        clearTimeout(executeTimerRef.current);
        executeTimerRef.current = null;
      }
      // 旧会话遗留的 suppress 标记对新会话无意义，必须清掉，
      // 否则新会话第一次 loading 下降会被误跳过，队首无法正常自动消费。
      suppressLoadingAutoConsumeRef.current = false;
    };

    window.addEventListener(MESSAGE_QUEUE_STREAM_STARTED_EVENT, handleStreamStarted);
    window.addEventListener(MESSAGE_QUEUE_STREAM_COMPLETED_EVENT, handleStreamCompleted);
    window.addEventListener(MESSAGE_QUEUE_INTERRUPT_FAILED_EVENT, handleInterruptFailed);
    window.addEventListener(MESSAGE_QUEUE_RESET_EVENT, handleQueueReset);
    return () => {
      window.removeEventListener(MESSAGE_QUEUE_STREAM_STARTED_EVENT, handleStreamStarted);
      window.removeEventListener(MESSAGE_QUEUE_STREAM_COMPLETED_EVENT, handleStreamCompleted);
      window.removeEventListener(MESSAGE_QUEUE_INTERRUPT_FAILED_EVENT, handleInterruptFailed);
      window.removeEventListener(MESSAGE_QUEUE_RESET_EVENT, handleQueueReset);
      if (executeTimerRef.current != null) {
        clearTimeout(executeTimerRef.current);
        executeTimerRef.current = null;
      }
    };
  }, [releaseInterruptedTarget, scheduleQueueItem]);

  return {
    queue,
    enqueue,
    dequeue,
    clearQueue,
    update,
    moveUp,
    moveDown,
    moveToFront,
    moveToBack,
    insert,
    interruptAndSendNow,
    hasQueuedMessages: queue.length > 0,
  };
}

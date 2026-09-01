import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMessageQueue } from './useMessageQueue.js';
import {
  MESSAGE_QUEUE_INTERRUPT_FAILED_EVENT,
  MESSAGE_QUEUE_RESET_EVENT,
  MESSAGE_QUEUE_STREAM_COMPLETED_EVENT,
  MESSAGE_QUEUE_STREAM_STARTED_EVENT,
} from '../constants/messageQueueEvents.js';

function dispatchStreamStarted(turnId: number) {
  act(() => {
    window.dispatchEvent(new CustomEvent(MESSAGE_QUEUE_STREAM_STARTED_EVENT, {
      detail: { turnId },
    }));
  });
}

function dispatchStreamCompleted(
  completionId: string,
  turnId: number | null,
  sequence: number | null,
) {
  act(() => {
    window.dispatchEvent(new CustomEvent(MESSAGE_QUEUE_STREAM_COMPLETED_EVENT, {
      detail: { completionId, turnId, sequence },
    }));
  });
}

function dispatchInterruptFailed(message = 'interrupt failed') {
  act(() => {
    window.dispatchEvent(new CustomEvent(MESSAGE_QUEUE_INTERRUPT_FAILED_EVENT, {
      detail: { message },
    }));
  });
}

function dispatchQueueReset() {
  act(() => {
    window.dispatchEvent(new CustomEvent(MESSAGE_QUEUE_RESET_EVENT));
  });
}

function createQueue(isLoading = true) {
  const onExecute = vi.fn();
  const onInterrupt = vi.fn();
  const hook = renderHook(({ loading }) => useMessageQueue({
    isLoading: loading,
    onExecute,
    onInterrupt,
  }), { initialProps: { loading: isLoading } });

  return { ...hook, onExecute, onInterrupt };
}

function enqueueMessages(result: ReturnType<typeof createQueue>['result'], ...contents: string[]) {
  act(() => {
    contents.forEach(content => result.current.enqueue(content));
  });
}

describe('useMessageQueue', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('updates only the message content and keeps metadata and position', () => {
    const { result } = createQueue();
    const attachments = [{ id: 'a1', fileName: 'a.txt', mediaType: 'text/plain', data: 'YQ==' }];

    act(() => {
      result.current.enqueue('first', attachments);
      result.current.enqueue('second');
    });
    const before = result.current.queue[0];

    act(() => result.current.update(before.id, 'updated'));

    expect(result.current.queue.map(item => item.content)).toEqual(['updated', 'second']);
    expect(result.current.queue[0]).toMatchObject({
      id: before.id,
      attachments,
      queuedAt: before.queuedAt,
    });
  });

  it('moves messages one position in logical execution order and ignores boundaries or unknown ids', () => {
    const { result } = createQueue();
    enqueueMessages(result, 'first', 'second', 'third');

    const [first, , third] = result.current.queue;
    act(() => result.current.moveUp(third.id));
    expect(result.current.queue.map(item => item.content)).toEqual(['first', 'third', 'second']);

    act(() => result.current.moveDown(first.id));
    expect(result.current.queue.map(item => item.content)).toEqual(['third', 'first', 'second']);

    const beforeBoundaryMove = result.current.queue;
    act(() => result.current.moveUp(third.id));
    expect(result.current.queue).toBe(beforeBoundaryMove);

    const beforeUnknownMove = result.current.queue;
    act(() => result.current.moveDown('unknown'));
    expect(result.current.queue).toBe(beforeUnknownMove);
  });

  it('moves messages to either queue boundary and treats insert as moveToFront', () => {
    const { result } = createQueue();
    enqueueMessages(result, 'first', 'second', 'third');
    const [, second, third] = result.current.queue;

    act(() => result.current.moveToFront(third.id));
    expect(result.current.queue.map(item => item.content)).toEqual(['third', 'first', 'second']);

    act(() => result.current.moveToBack(third.id));
    expect(result.current.queue.map(item => item.content)).toEqual(['first', 'second', 'third']);

    expect(result.current.insert).toBe(result.current.moveToFront);
    act(() => result.current.insert(second.id));
    expect(result.current.queue.map(item => item.content)).toEqual(['second', 'first', 'third']);

    const beforeBoundaryMove = result.current.queue;
    act(() => result.current.moveToFront(second.id));
    expect(result.current.queue).toBe(beforeBoundaryMove);

    const beforeUnknownMove = result.current.queue;
    act(() => result.current.moveToBack('unknown'));
    expect(result.current.queue).toBe(beforeUnknownMove);

  });

  it('keeps the original behavior and consumes one queue head when loading finishes', () => {
    vi.useFakeTimers();
    const { result, rerender, onExecute } = createQueue();
    enqueueMessages(result, 'first', 'second');

    rerender({ loading: false });
    act(() => {
      vi.advanceTimersByTime(50);
    });

    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute).toHaveBeenCalledWith('first', undefined);
    expect(result.current.queue.map(item => item.content)).toEqual(['second']);

    act(() => {
      vi.runAllTimers();
    });
    expect(onExecute).toHaveBeenCalledTimes(1);
  });

  it('waits for the interrupted turn end, ignores its duplicate, then consumes the remaining head only after the target ends', () => {
    vi.useFakeTimers();
    const { result, rerender, onExecute, onInterrupt } = createQueue();
    enqueueMessages(result, 'first', 'second');

    const targetId = result.current.queue[1].id;
    act(() => {
      result.current.interruptAndSendNow(targetId);
      result.current.interruptAndSendNow(targetId);
    });

    expect(result.current.queue.map(item => item.content)).toEqual(['second', 'first']);
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(onExecute).not.toHaveBeenCalled();

    rerender({ loading: false });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(onExecute).not.toHaveBeenCalled();

    dispatchStreamCompleted('sequence:10', 1, 10);
    act(() => {
      vi.advanceTimersByTime(50);
    });

    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute).toHaveBeenCalledWith('second', undefined);
    expect(result.current.queue.map(item => item.content)).toEqual(['first']);

    // 同一旧任务的完成信号再次到达，不能把 first 当作普通队首发送。
    dispatchStreamCompleted('sequence:10', 1, 10);
    dispatchStreamCompleted('sequence:11', null, 11);
    act(() => {
      vi.advanceTimersByTime(50);
    });

    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(result.current.queue.map(item => item.content)).toEqual(['first']);

    dispatchStreamStarted(2);
    rerender({ loading: true });
    dispatchStreamCompleted('sequence:20', 2, 20);
    rerender({ loading: false });
    act(() => {
      vi.advanceTimersByTime(50);
    });

    expect(onExecute).toHaveBeenCalledTimes(2);
    expect(onExecute).toHaveBeenNthCalledWith(2, 'first', undefined);
    expect(result.current.queue).toEqual([]);
  });

  it('sends the interrupted target even if queue reordering has not committed yet', () => {
    vi.useFakeTimers();
    const { result, onExecute } = createQueue();
    enqueueMessages(result, 'first', 'second');
    const targetId = result.current.queue[1].id;

    act(() => result.current.interruptAndSendNow(targetId));
    // 模拟队列重排尚未提交时旧任务已经结束。
    dispatchStreamCompleted('sequence:30', 3, 30);
    act(() => vi.advanceTimersByTime(50));

    expect(onExecute).toHaveBeenCalledWith('second', undefined);
    expect(result.current.queue.map(item => item.content)).toEqual(['first']);
  });

  it('does not react to loading=false before the interrupted turn really ends', () => {
    vi.useFakeTimers();
    const { result, rerender, onExecute } = createQueue();
    enqueueMessages(result, 'first', 'second');
    const targetId = result.current.queue[1].id;

    act(() => result.current.interruptAndSendNow(targetId));
    rerender({ loading: false });
    act(() => vi.advanceTimersByTime(50));

    expect(onExecute).not.toHaveBeenCalled();
    expect(result.current.queue.map(item => item.content)).toEqual(['second', 'first']);
  });

  it('removes and executes a queued message immediately when idle', () => {
    const { result, onExecute, onInterrupt } = createQueue(false);
    enqueueMessages(result, 'first', 'second');

    act(() => result.current.interruptAndSendNow(result.current.queue[1].id));

    expect(result.current.queue.map(item => item.content)).toEqual(['first']);
    expect(onExecute).toHaveBeenCalledWith('second', undefined);
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it('preserves attachments when executing the interrupted target', () => {
    vi.useFakeTimers();
    const { result, onExecute } = createQueue();
    const attachments = [{ id: 'a1', fileName: 'a.txt', mediaType: 'text/plain', data: 'YQ==' }];

    act(() => {
      result.current.enqueue('first');
      result.current.enqueue('second', attachments);
    });

    act(() => result.current.interruptAndSendNow(result.current.queue[1].id));
    dispatchStreamCompleted('sequence:40', 4, 40);
    act(() => vi.advanceTimersByTime(50));

    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute).toHaveBeenCalledWith('second', attachments);
  });

  it('unlocks the scheduler on interrupt failure without sending, then consumes the head on a later loading drop', () => {
    vi.useFakeTimers();
    const { result, rerender, onExecute, onInterrupt } = createQueue();
    enqueueMessages(result, 'first', 'second');
    const targetId = result.current.queue[1].id;

    act(() => result.current.interruptAndSendNow(targetId));
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(result.current.queue.map(item => item.content)).toEqual(['second', 'first']);

    dispatchInterruptFailed();
    act(() => vi.advanceTimersByTime(50));
    expect(onExecute).not.toHaveBeenCalled();
    expect(result.current.queue.map(item => item.content)).toEqual(['second', 'first']);

    // 失败回调早于 loading 下降：这次下降不能把队首发出去。
    rerender({ loading: false });
    act(() => vi.advanceTimersByTime(50));
    expect(onExecute).not.toHaveBeenCalled();
    expect(result.current.queue.map(item => item.content)).toEqual(['second', 'first']);

    rerender({ loading: true });
    rerender({ loading: false });
    act(() => vi.advanceTimersByTime(50));
    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute).toHaveBeenCalledWith('second', undefined);
    expect(result.current.queue.map(item => item.content)).toEqual(['first']);
  });

  it('does not send on interrupt failure after loading already dropped, then consumes the head on a later drop', () => {
    vi.useFakeTimers();
    const { result, rerender, onExecute, onInterrupt } = createQueue();
    enqueueMessages(result, 'first', 'second');
    const targetId = result.current.queue[1].id;

    act(() => result.current.interruptAndSendNow(targetId));
    expect(onInterrupt).toHaveBeenCalledTimes(1);

    // 常见时序：interruptSession() 先把 loading 降下来，随后 interrupt() reject。
    rerender({ loading: false });
    act(() => vi.advanceTimersByTime(50));
    expect(onExecute).not.toHaveBeenCalled();
    expect(result.current.queue.map(item => item.content)).toEqual(['second', 'first']);

    dispatchInterruptFailed();
    act(() => vi.advanceTimersByTime(50));
    expect(onExecute).not.toHaveBeenCalled();
    expect(result.current.queue.map(item => item.content)).toEqual(['second', 'first']);

    rerender({ loading: true });
    rerender({ loading: false });
    act(() => vi.advanceTimersByTime(50));
    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute).toHaveBeenCalledWith('second', undefined);
    expect(result.current.queue.map(item => item.content)).toEqual(['first']);
  });

  it('consumes the remaining queue head only once when the target turn ends and loading drops', () => {
    vi.useFakeTimers();
    const { result, rerender, onExecute } = createQueue();
    enqueueMessages(result, 'first', 'second', 'third');
    const targetId = result.current.queue[1].id;

    act(() => result.current.interruptAndSendNow(targetId));
    dispatchStreamCompleted('sequence:60', 6, 60);
    act(() => vi.advanceTimersByTime(50));
    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute).toHaveBeenCalledWith('second', undefined);
    expect(result.current.queue.map(item => item.content)).toEqual(['first', 'third']);

    dispatchStreamStarted(7);
    rerender({ loading: true });
    dispatchStreamCompleted('sequence:70', 7, 70);
    act(() => vi.advanceTimersByTime(50));
    expect(onExecute).toHaveBeenCalledTimes(2);
    expect(onExecute).toHaveBeenNthCalledWith(2, 'first', undefined);
    expect(result.current.queue.map(item => item.content)).toEqual(['third']);

    // 路径 B 的 50ms timer 先结束时，loading 下降不能把下一条也发出去。
    rerender({ loading: false });
    act(() => vi.advanceTimersByTime(50));
    expect(onExecute).toHaveBeenCalledTimes(2);
    expect(result.current.queue.map(item => item.content)).toEqual(['third']);
  });

  it('keeps normal stop/completion scheduling on loading and ignores completion events while idle', () => {
    vi.useFakeTimers();
    const { result, rerender, onExecute } = createQueue();
    enqueueMessages(result, 'first', 'second');

    dispatchStreamCompleted('sequence:50', 5, 50);
    expect(onExecute).not.toHaveBeenCalled();

    rerender({ loading: false });
    act(() => vi.advanceTimersByTime(50));

    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute).toHaveBeenCalledWith('first', undefined);
    expect(result.current.queue.map(item => item.content)).toEqual(['second']);

    dispatchStreamCompleted('sequence:50', 5, 50);
    dispatchStreamCompleted('sequence:51', null, 51);
    act(() => vi.advanceTimersByTime(50));

    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(result.current.queue.map(item => item.content)).toEqual(['second']);
  });

  it('resets the scheduler to idle on session switch while waiting for the interrupted turn end', () => {
    vi.useFakeTimers();
    const { result, rerender, onExecute, onInterrupt } = createQueue();
    enqueueMessages(result, 'first', 'second');
    const targetId = result.current.queue[1].id;

    act(() => result.current.interruptAndSendNow(targetId));
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(result.current.queue.map(item => item.content)).toEqual(['second', 'first']);

    // 会话切换：旧轮次的完成事件不会再到达（被切换守卫拦截），调度器直接回 idle。
    dispatchQueueReset();

    // 切换前旧轮次迟到的完成事件必须被忽略，不能补发目标消息。
    dispatchStreamCompleted('sequence:10', 1, 10);
    act(() => vi.advanceTimersByTime(50));
    expect(onExecute).not.toHaveBeenCalled();
    expect(result.current.queue.map(item => item.content)).toEqual(['second', 'first']);

    // 新一轮 loading 下降即可正常自动消费队首（队列内容跨会话保留）。
    rerender({ loading: false });
    act(() => vi.advanceTimersByTime(50));
    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute).toHaveBeenCalledWith('second', undefined);
    expect(result.current.queue.map(item => item.content)).toEqual(['first']);
  });

  it('cancels the pending execute closure when reset arrives during waiting-for-queued-turn-start', () => {
    vi.useFakeTimers();
    const { result, rerender, onExecute } = createQueue();
    enqueueMessages(result, 'first', 'second');
    const targetId = result.current.queue[1].id;

    act(() => result.current.interruptAndSendNow(targetId));
    dispatchStreamCompleted('sequence:10', 1, 10);
    // 目标已出队、50ms execute 闭包挂起中，此时发生会话切换。
    expect(result.current.queue.map(item => item.content)).toEqual(['first']);

    dispatchQueueReset();
    act(() => vi.advanceTimersByTime(50));

    // 挂起的闭包因 generation 不匹配失效，目标消息不补发、不丢失（目标项内容不在本项范围）。
    expect(onExecute).not.toHaveBeenCalled();
    expect(result.current.queue.map(item => item.content)).toEqual(['first']);

    // 旧会话迟到的 STREAM_START 不得再驱动调度器。
    dispatchStreamStarted(2);
    rerender({ loading: false });
    act(() => vi.advanceTimersByTime(50));
    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute).toHaveBeenCalledWith('first', undefined);
    expect(result.current.queue).toEqual([]);
  });

  it('resets the scheduler to idle on session switch while waiting for the queued turn end', () => {
    vi.useFakeTimers();
    const { result, rerender, onExecute } = createQueue();
    enqueueMessages(result, 'first', 'second');
    const targetId = result.current.queue[1].id;

    act(() => result.current.interruptAndSendNow(targetId));
    dispatchStreamCompleted('sequence:10', 1, 10);
    act(() => vi.advanceTimersByTime(50));
    expect(onExecute).toHaveBeenCalledWith('second', undefined);

    dispatchStreamStarted(2);
    // 目标轮次已起流、等待其结束时发生会话切换。
    dispatchQueueReset();

    // 切换后旧轮次的完成事件必须被忽略，不能连发队首。
    dispatchStreamCompleted('sequence:20', 2, 20);
    act(() => vi.advanceTimersByTime(50));
    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(result.current.queue.map(item => item.content)).toEqual(['first']);

    rerender({ loading: true });
    rerender({ loading: false });
    act(() => vi.advanceTimersByTime(50));
    expect(onExecute).toHaveBeenCalledTimes(2);
    expect(onExecute).toHaveBeenNthCalledWith(2, 'first', undefined);
    expect(result.current.queue).toEqual([]);
  });

  it('clears the suppressed loading auto-consume flag on session reset', () => {
    vi.useFakeTimers();
    const { result, rerender, onExecute } = createQueue();
    enqueueMessages(result, 'first', 'second');
    const targetId = result.current.queue[1].id;

    // 打断失败会先置 suppress 标记；随后发生的会话切换必须清掉它。
    act(() => result.current.interruptAndSendNow(targetId));
    dispatchInterruptFailed();
    dispatchQueueReset();

    rerender({ loading: false });
    act(() => vi.advanceTimersByTime(50));

    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute).toHaveBeenCalledWith('second', undefined);
    expect(result.current.queue.map(item => item.content)).toEqual(['first']);
  });
});

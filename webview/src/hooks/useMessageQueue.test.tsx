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
  // onExecute 契约：返回 false 表示消息未真实发出，调度器会将其放回队首。
  const onExecute = vi.fn(() => true);
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

  it('cancels the interrupted target on dequeue so the turn end no longer sends it', () => {
    vi.useFakeTimers();
    const { result, rerender, onExecute, onInterrupt } = createQueue();
    enqueueMessages(result, 'first', 'second');
    const targetId = result.current.queue[1].id;

    act(() => result.current.interruptAndSendNow(targetId));
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(result.current.queue.map(item => item.content)).toEqual(['second', 'first']);

    // 用户在打断等待期间删除目标消息：旧轮次结束后不得再补发它。
    act(() => result.current.dequeue(targetId));
    expect(result.current.queue.map(item => item.content)).toEqual(['first']);

    dispatchStreamCompleted('sequence:10', 1, 10);
    act(() => vi.advanceTimersByTime(50));
    expect(onExecute).not.toHaveBeenCalled();
    expect(result.current.queue.map(item => item.content)).toEqual(['first']);

    // interruptSession() 触发的 loading 下降被跳过，不能把队首顶出去。
    rerender({ loading: false });
    act(() => vi.advanceTimersByTime(50));
    expect(onExecute).not.toHaveBeenCalled();

    // 下一轮真实 loading 周期恢复自动消费。
    rerender({ loading: true });
    rerender({ loading: false });
    act(() => vi.advanceTimersByTime(50));
    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute).toHaveBeenCalledWith('first', undefined);
    expect(result.current.queue).toEqual([]);
  });

  it('cancels the pending execute closure when dequeue targets the released item', () => {
    vi.useFakeTimers();
    const { result, rerender, onExecute } = createQueue();
    enqueueMessages(result, 'first', 'second');
    const targetId = result.current.queue[1].id;

    act(() => result.current.interruptAndSendNow(targetId));
    dispatchStreamCompleted('sequence:10', 1, 10);
    // 目标已出队、50ms execute 闭包挂起中，此时删除目标（队列中已不存在，仅取消调度）。
    expect(result.current.queue.map(item => item.content)).toEqual(['first']);
    act(() => result.current.dequeue(targetId));

    act(() => vi.advanceTimersByTime(50));
    expect(onExecute).not.toHaveBeenCalled();
    expect(result.current.queue.map(item => item.content)).toEqual(['first']);

    // 该相位不置 suppress 标记：loading 下降应正常自动消费队首。
    rerender({ loading: false });
    act(() => vi.advanceTimersByTime(50));
    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute).toHaveBeenCalledWith('first', undefined);
    expect(result.current.queue).toEqual([]);
  });

  it('keeps the scheduler intact when dequeue removes a non-target message', () => {
    vi.useFakeTimers();
    const { result, onExecute } = createQueue();
    enqueueMessages(result, 'first', 'second');
    const targetId = result.current.queue[1].id;

    act(() => result.current.interruptAndSendNow(targetId));
    // 删除非目标消息不影响等待中的调度。
    const firstId = result.current.queue.find(item => item.content === 'first')!.id;
    act(() => result.current.dequeue(firstId));
    expect(result.current.queue.map(item => item.content)).toEqual(['second']);

    dispatchStreamCompleted('sequence:10', 1, 10);
    act(() => vi.advanceTimersByTime(50));
    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute).toHaveBeenCalledWith('second', undefined);
    expect(result.current.queue).toEqual([]);
  });

  it('cancels the scheduler on clearQueue while waiting for the interrupted turn end', () => {
    vi.useFakeTimers();
    const { result, rerender, onExecute } = createQueue();
    enqueueMessages(result, 'first', 'second');
    const targetId = result.current.queue[1].id;

    act(() => result.current.interruptAndSendNow(targetId));
    // 清空队列连同目标一起移除，调度器必须取消，旧轮次结束不得补发。
    act(() => result.current.clearQueue());
    expect(result.current.queue).toEqual([]);

    dispatchStreamCompleted('sequence:10', 1, 10);
    act(() => vi.advanceTimersByTime(50));
    expect(onExecute).not.toHaveBeenCalled();

    // 打断引发的 loading 下降被跳过；队列已空，无副作用。
    rerender({ loading: false });
    act(() => vi.advanceTimersByTime(50));
    expect(onExecute).not.toHaveBeenCalled();
  });

  it('cancels the pending execute closure on clearQueue during waiting-for-queued-turn-start', () => {
    vi.useFakeTimers();
    const { result, onExecute } = createQueue();
    enqueueMessages(result, 'first', 'second');
    const targetId = result.current.queue[1].id;

    act(() => result.current.interruptAndSendNow(targetId));
    dispatchStreamCompleted('sequence:10', 1, 10);
    // 目标已出队、50ms execute 闭包挂起中，清空队列必须一并取消该闭包。
    act(() => result.current.clearQueue());

    act(() => vi.advanceTimersByTime(50));
    expect(onExecute).not.toHaveBeenCalled();
    expect(result.current.queue).toEqual([]);
  });

  it('restores the interrupted target to the queue head when execution fails', () => {
    vi.useFakeTimers();
    const { result, rerender, onExecute, onInterrupt } = createQueue();
    enqueueMessages(result, 'first', 'second');
    const targetId = result.current.queue[1].id;

    act(() => result.current.interruptAndSendNow(targetId));
    expect(onInterrupt).toHaveBeenCalledTimes(1);

    // SDK 状态守卫等提前返回场景：execute 返回 false，目标从未发出。
    onExecute.mockReturnValue(false);
    dispatchStreamCompleted('sequence:10', 1, 10);
    act(() => vi.advanceTimersByTime(50));

    // 目标放回队首不丢失，等待相位同步解除，不会卡在 waiting-for-queued-turn-start。
    expect(onExecute).toHaveBeenCalledWith('second', undefined);
    expect(result.current.queue.map(item => item.content)).toEqual(['second', 'first']);

    // 调度器已回 idle：下一轮 loading 下降正常消费队首。
    onExecute.mockReturnValue(true);
    rerender({ loading: true });
    rerender({ loading: false });
    act(() => vi.advanceTimersByTime(50));
    expect(onExecute).toHaveBeenNthCalledWith(2, 'second', undefined);
    expect(result.current.queue.map(item => item.content)).toEqual(['first']);
  });

  it('restores the queue head when auto-consume execution fails', () => {
    vi.useFakeTimers();
    const { result, rerender, onExecute } = createQueue();
    onExecute.mockReturnValue(false);
    enqueueMessages(result, 'first', 'second');

    // loading 下降触发路径 A 消费队首，但执行失败。
    rerender({ loading: false });
    act(() => vi.advanceTimersByTime(50));

    // 队首选回：消息不丢失、顺序不变。
    expect(onExecute).toHaveBeenCalledWith('first', undefined);
    expect(result.current.queue.map(item => item.content)).toEqual(['first', 'second']);

    // 执行恢复后，下一轮 loading 下降再次消费同一条队首。
    onExecute.mockReturnValue(true);
    rerender({ loading: true });
    rerender({ loading: false });
    act(() => vi.advanceTimersByTime(50));
    expect(onExecute).toHaveBeenNthCalledWith(2, 'first', undefined);
    expect(result.current.queue.map(item => item.content)).toEqual(['second']);
  });
});

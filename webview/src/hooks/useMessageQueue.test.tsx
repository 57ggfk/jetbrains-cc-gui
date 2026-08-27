import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMessageQueue } from './useMessageQueue.js';

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

    act(() => result.current.insert(second.id));
    expect(result.current.queue.map(item => item.content)).toEqual(['second', 'first', 'third']);

    const beforeBoundaryMove = result.current.queue;
    act(() => result.current.moveToFront(second.id));
    expect(result.current.queue).toBe(beforeBoundaryMove);

    const beforeUnknownMove = result.current.queue;
    act(() => result.current.moveToBack('unknown'));
    expect(result.current.queue).toBe(beforeUnknownMove);

  });

  it('consumes the logical queue head once after loading changes from true to false', () => {
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

  it('prioritizes a queued message and interrupts while loading, then consumes it once', () => {
    vi.useFakeTimers();
    const { result, rerender, onExecute, onInterrupt } = createQueue();
    enqueueMessages(result, 'first', 'second');

    act(() => result.current.interruptAndSendNow(result.current.queue[1].id));

    expect(result.current.queue.map(item => item.content)).toEqual(['second', 'first']);
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(onExecute).not.toHaveBeenCalled();

    rerender({ loading: false });
    act(() => {
      vi.advanceTimersByTime(50);
    });

    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute).toHaveBeenCalledWith('second', undefined);
    expect(result.current.queue.map(item => item.content)).toEqual(['first']);
  });

  it('removes and executes a queued message immediately when idle', () => {
    const { result, onExecute, onInterrupt } = createQueue(false);
    enqueueMessages(result, 'first', 'second');

    act(() => result.current.interruptAndSendNow(result.current.queue[1].id));

    expect(result.current.queue.map(item => item.content)).toEqual(['first']);
    expect(onExecute).toHaveBeenCalledWith('second', undefined);
    expect(onInterrupt).not.toHaveBeenCalled();
  });
});

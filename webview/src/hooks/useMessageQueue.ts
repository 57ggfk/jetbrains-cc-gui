import { useState, useCallback, useEffect, useRef } from 'react';
import type { Attachment } from '../components/ChatInputBox/types';

export interface QueuedMessage {
  id: string;
  content: string;
  attachments?: Attachment[];
  queuedAt: number;
}

export interface UseMessageQueueOptions {
  /** Whether AI is currently processing */
  isLoading: boolean;
  /** Callback to execute a message */
  onExecute: (content: string, attachments?: Attachment[]) => void;
}

export interface UseMessageQueueReturn {
  /** Current queue */
  queue: QueuedMessage[];
  /** Add message to queue */
  enqueue: (content: string, attachments?: Attachment[]) => void;
  /** Remove message from queue by id */
  dequeue: (id: string) => void;
  /**
   * Remove a queued message and return it so its content and attachments can be
   * restored into the input draft for editing. Messages around it keep their
   * order; an unknown id returns undefined and leaves the queue untouched.
   */
  dequeueForEdit: (id: string) => QueuedMessage | undefined;
  /** Clear entire queue */
  clearQueue: () => void;
  /** Reorder the queue by an ordered list of ids (index 0 executes first) */
  reorder: (orderedIds: string[]) => void;
  /** Whether queue has items */
  hasQueuedMessages: boolean;
}

/**
 * Hook for managing message queue
 * Automatically executes next message when loading completes
 */
export function useMessageQueue({
  isLoading,
  onExecute,
}: UseMessageQueueOptions): UseMessageQueueReturn {
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  // Timestamp of the last dispatch. The drain effect re-runs synchronously after
  // its own dequeue (queue state change) while `isLoading` is still false — the
  // execute path flips it only in the next render. Without a gate the effect
  // drained the whole queue in one idle period, overlapping multiple sends on
  // the same Codex thread (writer-lock conflict).
  const dispatchedAtRef = useRef<number | null>(null);
  // Mirror of the committed queue. A removal callback has to report what it
  // took out, and reading `queue` from its closure would be one render behind.
  const queueRef = useRef<QueuedMessage[]>(queue);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

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

  // Remove a message for editing: the caller gets its payload back so the
  // draft can be restored in the same interaction (same semantics as dequeue
  // for the remaining items). The ref keeps repeated calls in one tick safe —
  // a state read would hand the same message out twice.
  const dequeueForEdit = useCallback((id: string): QueuedMessage | undefined => {
    const removed = queueRef.current.find(item => item.id === id);
    if (!removed) return undefined;
    queueRef.current = queueRef.current.filter(item => item.id !== id);
    setQueue(prev => prev.filter(item => item.id !== id));
    return removed;
  }, []);

  // Remove message from queue (the removed payload is ignored here)
  const dequeue = useCallback((id: string) => {
    dequeueForEdit(id);
  }, [dequeueForEdit]);

  // Clear entire queue
  const clearQueue = useCallback(() => {
    setQueue([]);
  }, []);

  /**
   * Reorder the queue by the given id sequence (orderedIds[0] executes next).
   * - Ids not present in the current queue are ignored.
   * - Items missing from orderedIds (e.g. enqueued mid-drag) are appended in
   *   their original order so no message is ever dropped.
   */
  const reorder = useCallback((orderedIds: string[]) => {
    setQueue(prev => {
      const byId = new Map(prev.map(item => [item.id, item]));
      const seen = new Set<string>();
      const ordered: QueuedMessage[] = [];
      for (const id of orderedIds) {
        const item = byId.get(id);
        if (item && !seen.has(id)) {
          ordered.push(item);
          seen.add(id);
        }
      }
      const remaining = prev.filter(item => !seen.has(item.id));
      return [...ordered, ...remaining];
    });
  }, []);

  // Auto-execute next message whenever the chat is idle. Dequeue and execute
  // must stay atomic inside this effect: deferring the execution behind a
  // timer let the very next re-render (the dequeue's own state update) run
  // effect cleanup, cancel the timer, and silently drop the already-dequeued
  // message. Checking "idle && non-empty" instead of a loading transition also
  // covers messages enqueued while `isLoading` was already flipping to false.
  //
  // Single-flight: at most one dispatch per idle period. The drain effect
  // re-runs synchronously after its own dequeue while `isLoading` is still
  // false (the execute path flips it only in the next render); without the
  // gate it drained the whole queue at once, overlapping multiple sends on
  // the same Codex thread (thread-writer lock conflict). The gate reopens
  // when `isLoading` turns true — i.e. the dispatched message actually
  // started a turn. A dispatch that bails before flipping loading (e.g. SDK
  // missing) leaves the gate closed so the queue waits instead of spamming
  // doomed sends; any subsequent turn reopens it.
  useEffect(() => {
    if (isLoading) {
      dispatchedAtRef.current = null;
      return;
    }
    if (queue.length === 0 || dispatchedAtRef.current !== null) {
      return;
    }
    const nextMessage = queue[0];
    dispatchedAtRef.current = Date.now();
    setQueue(prev => prev.slice(1));
    onExecute(nextMessage.content, nextMessage.attachments);
  }, [isLoading, queue, onExecute]);

  return {
    queue,
    enqueue,
    dequeue,
    dequeueForEdit,
    clearQueue,
    reorder,
    hasQueuedMessages: queue.length > 0,
  };
}

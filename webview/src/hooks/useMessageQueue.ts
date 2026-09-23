import { useState, useCallback, useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import type { Attachment } from '../components/ChatInputBox/types';

export interface QueuedMessage {
  id: string;
  content: string;
  attachments?: Attachment[];
  queuedAt: number;
  /** queued waits for idle send; steering is in-flight on the live turn */
  status: 'queued' | 'steering';
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
  /** Clear entire queue */
  clearQueue: () => void;
  /** Reorder queue by an ordered list of ids (index 0 executes first) */
  reorder: (orderedIds: string[]) => void;
  /** Mark an item as steering after the daemon accepted it */
  markSteering: (id: string) => void;
  /** Restore a rejected item in place */
  restore: (id: string) => void;
  /** Put an undelivered item back at the head as queued */
  requeueAtHead: (item: QueuedMessage) => void;
  /** Steering items retained for undelivered receipts */
  steeringItemsRef: MutableRefObject<Map<string, QueuedMessage>>;
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
  const steeringItemsRef = useRef<Map<string, QueuedMessage>>(new Map());

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
      status: 'queued',
    };
    setQueue(prev => [...prev, newItem]);
  }, [generateId]);

  // Remove message from queue
  const dequeue = useCallback((id: string) => {
    steeringItemsRef.current.delete(id);
    setQueue(prev => prev.filter(item => item.id !== id));
  }, []);

  // Clear entire queue
  const clearQueue = useCallback(() => {
    steeringItemsRef.current.clear();
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

  const markSteering = useCallback((id: string) => {
    setQueue(prev => prev.map(item => {
      if (item.id !== id) return item;
      const next: QueuedMessage = { ...item, status: 'steering' };
      steeringItemsRef.current.set(id, next);
      return next;
    }));
  }, []);

  const restore = useCallback((id: string) => {
    steeringItemsRef.current.delete(id);
    setQueue(prev => prev.map(item => (
      item.id === id ? { ...item, status: 'queued' } : item
    )));
  }, []);

  const requeueAtHead = useCallback((item: QueuedMessage) => {
    const restored: QueuedMessage = { ...item, status: 'queued' };
    steeringItemsRef.current.delete(item.id);
    setQueue(prev => {
      const without = prev.filter(existing => existing.id !== item.id);
      return [restored, ...without];
    });
  }, []);

  // Auto-execute next message whenever the chat is idle. Dequeue and execute
  // must stay atomic inside this effect: deferring the execution behind a
  // timer let the very next re-render (the dequeue's own state update) run
  // effect cleanup, cancel the timer, and silently drop the already-dequeued
  // message. Checking "idle && non-empty" instead of a loading transition also
  // covers messages enqueued while `isLoading` was already flipping to false.
  // Steering items wait for a fold/undelivered receipt and are skipped.
  useEffect(() => {
    if (isLoading || queue.length === 0) {
      return;
    }
    const nextMessage = queue.find(item => item.status === 'queued');
    if (!nextMessage) {
      return;
    }
    setQueue(prev => prev.filter(item => item.id !== nextMessage.id));
    onExecute(nextMessage.content, nextMessage.attachments);
  }, [isLoading, queue, onExecute]);

  return {
    queue,
    enqueue,
    dequeue,
    clearQueue,
    reorder,
    markSteering,
    restore,
    requeueAtHead,
    steeringItemsRef,
    hasQueuedMessages: queue.length > 0,
  };
}

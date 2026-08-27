import { useState, useCallback, useRef, useEffect } from 'react';
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
  const prevLoadingRef = useRef(isLoading);
  const isExecutingFromQueueRef = useRef(false);

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

  // Remove message from queue
  const dequeue = useCallback((id: string) => {
    setQueue(prev => prev.filter(item => item.id !== id));
  }, []);

  // Clear entire queue
  const clearQueue = useCallback(() => {
    setQueue([]);
  }, []);

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

  // Insert is a semantic alias for becoming the next queued execution.
  const insert = useCallback((id: string) => {
    setQueue(prev => {
      const index = prev.findIndex(item => item.id === id);
      if (index <= 0) return prev;

      return [prev[index], ...prev.slice(0, index), ...prev.slice(index + 1)];
    });
  }, []);

  // Auto-execute next message when loading completes
  useEffect(() => {
    // Detect transition from loading to not loading
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = isLoading;

    // If just finished loading and queue has items, execute next
    if (wasLoading && !isLoading && !isExecutingFromQueueRef.current && queue.length > 0) {
      const nextMessage = queue[0];
      isExecutingFromQueueRef.current = true;

      // Remove from queue first
      setQueue(prev => prev.slice(1));

      // Execute with small delay to ensure state updates
      setTimeout(() => {
        onExecute(nextMessage.content, nextMessage.attachments);
        isExecutingFromQueueRef.current = false;
      }, 50);
    }
  }, [isLoading, queue, onExecute]);

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
    hasQueuedMessages: queue.length > 0,
  };
}

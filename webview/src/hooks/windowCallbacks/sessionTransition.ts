/**
 * sessionTransition.ts
 *
 * Helpers for session transition guard management and transient UI state reset.
 * These functions encapsulate the logic that coordinates the React state setters
 * and streaming refs when a new session is initiated.
 */

import type { MutableRefObject } from 'react';
import { MESSAGE_QUEUE_RESET_EVENT } from '../../constants/messageQueueEvents';
import { forceWebviewRepaint } from '../../utils/forceWebviewRepaint';

export interface ResetTransientUiStateOptions {
  clearToasts: () => void;
  setStatus: React.Dispatch<React.SetStateAction<string>>;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setLoadingStartTime: React.Dispatch<React.SetStateAction<number | null>>;
  setIsThinking: React.Dispatch<React.SetStateAction<boolean>>;
  setStreamingActive: React.Dispatch<React.SetStateAction<boolean>>;

  // Streaming refs
  isStreamingRef: MutableRefObject<boolean>;
  useBackendStreamingRenderRef: MutableRefObject<boolean>;
  streamingMessageIndexRef: MutableRefObject<number>;
  streamingContentRef: MutableRefObject<string>;
  streamingThinkingRef: MutableRefObject<string>;
  autoExpandedThinkingKeysRef: MutableRefObject<Set<string>>;
  contentUpdateTimeoutRef: MutableRefObject<number | null>;
  thinkingUpdateTimeoutRef: MutableRefObject<number | null>;

  // Turn tracking ref (for streaming assistant isolation)
  streamingTurnIdRef: MutableRefObject<number>;
}

/**
 * Clear all transient UI state (streaming refs + React state flags).
 * Called on clearMessages and exposed as window.__resetTransientUiState so
 * useSessionManagement can invoke it synchronously during session transitions.
 */
export const buildResetTransientUiState = (opts: ResetTransientUiStateOptions) => {
  return () => {
    opts.clearToasts();
    opts.setStatus('');
    opts.setLoading(false);
    opts.setLoadingStartTime(null);
    opts.setIsThinking(false);
    opts.setStreamingActive(false);
    opts.isStreamingRef.current = false;
    opts.useBackendStreamingRenderRef.current = false;
    opts.streamingMessageIndexRef.current = -1;
    opts.streamingContentRef.current = '';
    opts.streamingThinkingRef.current = '';
    opts.autoExpandedThinkingKeysRef.current.clear();
    // Reset active turn ID to prevent stale streaming assistant recovery.
    // NOTE: turnIdCounterRef is intentionally NOT reset — it must stay monotonically
    // increasing across sessions so that stale messages from an old session can never
    // collide with a new session's turn IDs (and React keys like "turn-N" stay unique).
    opts.streamingTurnIdRef.current = -1;
    // Clear stream-end idempotency guard to avoid stale state across sessions.
    window.__streamEndProcessedTurnId = undefined;
    window.__streamEndProcessedSequence = undefined;
    if (opts.contentUpdateTimeoutRef.current != null) {
      cancelAnimationFrame(opts.contentUpdateTimeoutRef.current);
      opts.contentUpdateTimeoutRef.current = null;
    }
    if (opts.thinkingUpdateTimeoutRef.current != null) {
      cancelAnimationFrame(opts.thinkingUpdateTimeoutRef.current);
      opts.thinkingUpdateTimeoutRef.current = null;
    }
    // Cancel any updateMessages deferred during the outgoing session's streaming.
    // beginSessionTransition reaches this via window.__resetTransientUiState
    // (not clearMessages, which cancels them itself), so without this a buffered
    // frame would later fire its deferred processUpdateMessages — with
    // isStreamingRef already cleared here — and resurrect the cleared messages.
    if (typeof window.__cancelPendingUpdateMessages === 'function') {
      window.__cancelPendingUpdateMessages();
    }
    // Clear JCEF native-rendering ghosting left by the outgoing session's overlays
    // and input-box content after the transition unmounts/reflows them.
    forceWebviewRepaint('session-transition');
    // 通知消息队列调度器重置：切换期间 onStreamStart/onStreamEnd 被 __sessionTransitioning
    // 守卫拦截，处于等待相位的调度器永远等不到预期事件，必须显式复位避免卡死跨会话存活。
    window.dispatchEvent(new CustomEvent(MESSAGE_QUEUE_RESET_EVENT));
  };
};

/**
 * Release the session transition guard flags set by beginSessionTransition
 * (useSessionManagement). Flushes any history snapshot that arrived while the
 * guard was active so updateMessages racing the transition is not lost.
 */
export const releaseSessionTransition = (): void => {
  if (window.__sessionTransitioning) {
    window.__sessionTransitioning = false;
  }
  window.__sessionTransitionToken = null;
  if (typeof window.__flushDeferredTransitionUpdateMessages === 'function') {
    window.__flushDeferredTransitionUpdateMessages();
  }
};

/** Drop a deferred transition snapshot (new transition / clearMessages). */
export const clearDeferredTransitionUpdateMessages = (): void => {
  window.__deferredTransitionUpdateMessages = null;
};

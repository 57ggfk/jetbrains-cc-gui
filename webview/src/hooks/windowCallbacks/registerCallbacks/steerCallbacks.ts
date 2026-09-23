/**
 * Window callbacks for steer receipts and live provider capabilities.
 */

import type { MutableRefObject } from 'react';
import type { TFunction } from 'i18next';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import type { ClaudeMessage, ClaudeRawMessage } from '../../../types';

interface SteerResultPayload {
  steerId?: string;
  status?: string;
  reason?: string;
}

interface SteerFoldedPayload {
  steerId?: string;
  message?: {
    type?: string;
    content?: string;
    timestamp?: number | string;
    raw?: ClaudeRawMessage;
  };
}

/**
 * Convert the Java fold payload into a frontend user message.
 *
 * @param payload folded steer payload
 * @returns steered user message
 */
function toSteeredUserMessage(payload: SteerFoldedPayload): ClaudeMessage {
  const source = payload.message;
  const timestamp = typeof source?.timestamp === 'number'
    ? new Date(source.timestamp).toISOString()
    : (typeof source?.timestamp === 'string' ? source.timestamp : new Date().toISOString());
  const raw: ClaudeRawMessage = {
    ...(source?.raw && typeof source.raw === 'object' ? source.raw : {}),
    steered: true,
    steerId: payload.steerId,
  };
  return {
    type: 'user',
    content: typeof source?.content === 'string' ? source.content : '',
    timestamp,
    raw,
  };
}

/**
 * Register onSteerResult / onSteerFolded / onProviderCapabilities.
 *
 * @param options window callback options
 * @param tRef live translator for reject toasts
 */
export function registerSteerCallbacks(
  options: UseWindowCallbacksOptions,
  tRef: MutableRefObject<TFunction>,
): void {
  window.onSteerResult = (json: string) => {
    try {
      const payload = JSON.parse(json) as SteerResultPayload;
      const api = options.messageQueueSteerRef?.current;
      const steerId = payload.steerId;
      if (!api || !steerId) return;
      if (payload.status === 'accepted') {
        api.markSteering(steerId);
        return;
      }
      if (payload.status === 'rejected') {
        api.restore(steerId);
        const reason = payload.reason || 'no_active_turn';
        const message = tRef.current(`chat.steerRejected.${reason}`, { defaultValue: reason });
        options.addToast(message, 'warning');
        return;
      }
      if (payload.status === 'undelivered') {
        const item = api.steeringItemsRef.current.get(steerId);
        if (item) {
          api.requeueAtHead(item);
        }
      }
    } catch {
      // Ignore malformed steer receipts
    }
  };

  window.onSteerFolded = (json: string) => {
    try {
      const payload = JSON.parse(json) as SteerFoldedPayload;
      const api = options.messageQueueSteerRef?.current;
      const steerId = payload.steerId;
      if (api && steerId) {
        api.dequeue(steerId);
      }
      const nextTurnId = options.turnIdCounterRef.current + 1;
      options.turnIdCounterRef.current = nextTurnId;
      options.streamingTurnIdRef.current = nextTurnId;
      options.streamingContentRef.current = '';
      options.streamingThinkingRef.current = '';
      options.setMessages((prev) => {
        const alreadyPresent = !!steerId && prev.some((message) => (
          message.type === 'user'
          && typeof message.raw === 'object'
          && message.raw !== null
          && message.raw.steerId === steerId
        ));
        // Segment 1 is complete at the fold; later deltas belong to the placeholder.
        const settled = prev.map((message) => (
          message.type === 'assistant' && message.isStreaming
            ? { ...message, isStreaming: false }
            : message
        ));
        const steeredUser = alreadyPresent ? null : toSteeredUserMessage(payload);
        const placeholder: ClaudeMessage = {
          type: 'assistant',
          content: '',
          isStreaming: true,
          __turnId: nextTurnId,
          timestamp: new Date().toISOString(),
        };
        const next = alreadyPresent
          ? [...settled, placeholder]
          : [...settled, steeredUser as ClaudeMessage, placeholder];
        options.streamingMessageIndexRef.current = next.length - 1;
        return next;
      });
    } catch {
      // Ignore malformed fold payloads
    }
  };

  window.onProviderCapabilities = (json: string) => {
    try {
      const payload = JSON.parse(json) as { steer?: boolean };
      options.applyCapabilitiesRef?.current?.({ steer: !!payload.steer });
    } catch {
      // Ignore malformed capability payloads
    }
  };
}

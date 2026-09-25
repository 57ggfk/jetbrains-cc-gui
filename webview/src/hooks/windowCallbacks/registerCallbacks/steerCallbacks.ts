/**
 * Window callbacks for steer receipts and live provider capabilities.
 */

import type { MutableRefObject } from 'react';
import type { TFunction } from 'i18next';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import type { ClaudeMessage, ClaudeRawMessage } from '../../../types';
import {
  clearSteerPending,
  getSteerIdOf,
  removeSteeredMessage,
} from '../../../utils/steerMessages';

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
    steered: true,
    steerId: payload.steerId,
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
        // The bubble was inserted optimistically on click and the CLI never
        // took the steer: retract it and put the row back in the queue.
        options.setMessages((prev) => removeSteeredMessage(prev, steerId));
        api.restore(steerId);
        const reason = payload.reason || 'no_active_turn';
        const message = tRef.current(`chat.steerRejected.${reason}`, { defaultValue: reason });
        options.addToast(message, 'warning');
        return;
      }
      if (payload.status === 'undelivered') {
        const item = api.steeringItemsRef.current.get(steerId);
        options.setMessages((prev) => removeSteeredMessage(prev, steerId));
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
          message.type === 'user' && getSteerIdOf(message) === steerId
        ));
        // Segment 1 is complete at the fold; later deltas belong to the placeholder.
        const settled = prev.map((message) => (
          message.type === 'assistant' && message.isStreaming
            ? { ...message, isStreaming: false }
            : message
        ));
        // The optimistic bubble was already on screen: only clear its pending
        // marker, otherwise insert the row we never showed.
        const withDeliveredRow = alreadyPresent
          ? clearSteerPending(settled, steerId as string)
          : settled;
        const steeredUser = alreadyPresent ? null : toSteeredUserMessage(payload);
        const placeholder: ClaudeMessage = {
          type: 'assistant',
          content: '',
          isStreaming: true,
          __turnId: nextTurnId,
          timestamp: new Date().toISOString(),
        };
        const next = alreadyPresent
          ? [...withDeliveredRow, placeholder]
          : [...withDeliveredRow, steeredUser as ClaudeMessage, placeholder];
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

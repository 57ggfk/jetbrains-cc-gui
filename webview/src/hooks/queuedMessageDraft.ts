import type { Attachment } from '../components/ChatInputBox/types';
import type { QueuedMessage } from './useMessageQueue';

/** Input-draft payload produced when a queued message is edited */
export interface QueuedDraftRestore {
  /** Content to write back into the input draft */
  content: string;
  /** Attachments to restore on the input draft */
  attachments: Attachment[];
  /** True when a non-empty draft was kept and the queued message was merged into it */
  merged: boolean;
}

/**
 * The draft surface a queued message is restored into.
 *
 * Structurally satisfied by `ChatInputBoxHandle`, but kept narrow so the
 * restore flow can be exercised without rendering the input box.
 */
export interface QueuedDraftTarget {
  getValue: () => string;
  getAttachments: () => Attachment[];
  setValue: (content: string) => void;
  /** Returns false when the target cannot take the attachments (externally controlled) */
  setAttachments: (attachments: Attachment[]) => boolean;
  focus: () => void;
}

export interface QueuedDraftWrite extends QueuedDraftRestore {
  /** False when the target refused the attachments, so the caller can warn the user */
  attachmentsApplied: boolean;
  /** How many attachments the queued message itself carried */
  queuedAttachmentCount: number;
}

/**
 * Build the input-draft payload for editing a queued message.
 *
 * The queued message is restored as if it had never been sent. When the input
 * already holds unsent content or attachments, nothing is overwritten: the
 * queued message is appended after the current draft text and its attachments
 * are merged in (deduplicated by id).
 */
export function mergeQueuedMessageIntoDraft(
  current: { content: string; attachments: Attachment[] },
  queued: { content: string; attachments?: Attachment[] },
): QueuedDraftRestore {
  const hasCurrentContent = current.content.trim().length > 0;
  const content = hasCurrentContent
    ? `${current.content.replace(/\s+$/, '')}\n\n${queued.content}`
    : queued.content;
  const seen = new Set(current.attachments.map(attachment => attachment.id));
  const attachments = [...current.attachments];
  for (const attachment of queued.attachments ?? []) {
    if (seen.has(attachment.id)) continue;
    seen.add(attachment.id);
    attachments.push(attachment);
  }
  return {
    content,
    attachments,
    merged: hasCurrentContent || current.attachments.length > 0,
  };
}

/**
 * Write a queued message back into the draft: merge it with whatever the draft
 * already holds, then apply content and attachments to the target.
 */
export function writeQueuedMessageToDraft(
  target: QueuedDraftTarget,
  queued: QueuedMessage,
): QueuedDraftWrite {
  const restored = mergeQueuedMessageIntoDraft(
    { content: target.getValue(), attachments: target.getAttachments() },
    { content: queued.content, attachments: queued.attachments },
  );
  target.setValue(restored.content);
  const attachmentsApplied = target.setAttachments(restored.attachments);
  target.focus();
  return {
    ...restored,
    attachmentsApplied,
    queuedAttachmentCount: queued.attachments?.length ?? 0,
  };
}

/**
 * Take a queued message out of the queue and restore it into the draft.
 *
 * The target is checked before the message is dequeued: without a draft to
 * restore into, dequeuing would drop the message for good.
 */
export function takeQueuedMessageForEdit(
  target: QueuedDraftTarget | null | undefined,
  dequeueForEdit: (id: string) => QueuedMessage | undefined,
  id: string,
): QueuedDraftWrite | null {
  if (!target) return null;
  const removed = dequeueForEdit(id);
  if (!removed) return null;
  return writeQueuedMessageToDraft(target, removed);
}

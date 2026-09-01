export const MESSAGE_QUEUE_STREAM_STARTED_EVENT = 'message-queue-stream-started';
export const MESSAGE_QUEUE_STREAM_COMPLETED_EVENT = 'message-queue-stream-completed';
export const MESSAGE_QUEUE_INTERRUPT_FAILED_EVENT = 'message-queue-interrupt-failed';
/** 会话切换时派发，通知消息队列调度器重置为 idle（等待中的事件已被切换守卫拦截，永远不会到达） */
export const MESSAGE_QUEUE_RESET_EVENT = 'message-queue-reset';

export interface MessageQueueStreamStartedDetail {
  turnId: number;
}

export interface MessageQueueStreamCompletedDetail {
  completionId: string;
  turnId: number | null;
  sequence: number | null;
}

export interface MessageQueueInterruptFailedDetail {
  message?: string;
}

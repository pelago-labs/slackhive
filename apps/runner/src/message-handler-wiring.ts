import type { IncomingMessage, MessageDeletedEvent, PlatformAdapter } from '@slackhive/shared';

type MessageEventAdapter = Pick<PlatformAdapter, 'onMessage' | 'onMessageDeleted'>;

interface MessageEventHandler {
  handleMessage(message: IncomingMessage): Promise<void>;
  cancelByDeletedMessage(channelId: string, messageId: string): Promise<boolean>;
}

/** Connect platform events to the platform-agnostic message handler. */
export function wireMessageHandler(
  adapter: MessageEventAdapter,
  handler: MessageEventHandler,
): void {
  adapter.onMessage(message => handler.handleMessage(message));
  adapter.onMessageDeleted?.(async (event: MessageDeletedEvent) => {
    await handler.cancelByDeletedMessage(event.channelId, event.messageId);
  });
}

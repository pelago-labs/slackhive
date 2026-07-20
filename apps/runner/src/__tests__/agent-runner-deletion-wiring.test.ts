import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, MessageDeletedEvent, PlatformAdapter } from '@slackhive/shared';
import { wireMessageHandler } from '../message-handler-wiring';

describe('AgentRunner deletion-event wiring', () => {
  it('routes platform messages and deletion events to the message handler', async () => {
    let onMessage: ((message: IncomingMessage) => Promise<void>) | undefined;
    let onMessageDeleted: ((event: MessageDeletedEvent) => Promise<void>) | undefined;
    const adapter = {
      onMessage: (handler: (message: IncomingMessage) => Promise<void>) => { onMessage = handler; },
      onMessageDeleted: (handler: (event: MessageDeletedEvent) => Promise<void>) => { onMessageDeleted = handler; },
    } as Pick<PlatformAdapter, 'onMessage' | 'onMessageDeleted'>;
    const messageHandler = {
      handleMessage: vi.fn(async () => undefined),
      cancelByDeletedMessage: vi.fn(async () => true),
    };

    wireMessageHandler(adapter, messageHandler);

    const message = { id: '123.456' } as IncomingMessage;
    const deletion = { channelId: 'C1', messageId: '123.456' };
    await onMessage?.(message);
    await onMessageDeleted?.(deletion);

    expect(messageHandler.handleMessage).toHaveBeenCalledWith(message);
    expect(messageHandler.cancelByDeletedMessage).toHaveBeenCalledWith('C1', '123.456');
  });
});

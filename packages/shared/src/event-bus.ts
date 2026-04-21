/**
 * @fileoverview Event bus for agent lifecycle events.
 *
 * Uses an in-process EventEmitter for publish/subscribe.
 * The web process communicates with the runner via the internal HTTP server,
 * not this event bus (separate processes can't share EventEmitter).
 *
 * @module @slackhive/shared/event-bus
 */

import { EventEmitter } from 'events';
import { AGENT_EVENTS_CHANNEL, type AgentEvent } from './types';

export interface EventBus {
  publish(event: AgentEvent): Promise<void>;
  subscribe(handler: (event: AgentEvent) => void): Promise<void>;
  close(): Promise<void>;
  readonly type: 'memory';
}

class MemoryEventBus implements EventBus {
  readonly type = 'memory' as const;
  private emitter = new EventEmitter();

  async publish(event: AgentEvent): Promise<void> {
    this.emitter.emit(AGENT_EVENTS_CHANNEL, event);
  }

  async subscribe(handler: (event: AgentEvent) => void): Promise<void> {
    this.emitter.on(AGENT_EVENTS_CHANNEL, handler);
  }

  async close(): Promise<void> {
    this.emitter.removeAllListeners();
  }
}

let _bus: EventBus | null = null;

export function getEventBus(): EventBus {
  if (!_bus) _bus = new MemoryEventBus();
  return _bus;
}

export function setEventBus(bus: EventBus): void {
  _bus = bus;
}

export async function closeEventBus(): Promise<void> {
  if (_bus) { await _bus.close(); _bus = null; }
}

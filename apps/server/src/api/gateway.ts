/**
 * WS fan-out registry (plans/03 §7): thread sockets (`/ws?threadId=`) receive
 * one thread's turn stream; user sockets (`/ws/user`) receive memory.commit +
 * turn lifecycle for all the user's threads. This object is both the
 * ThreadManager's event sink and the MemoryPipeline's commit emitter; events
 * are dropped silently when no socket is connected (clients resync from
 * ItemMirror on reconnect — deltas are never replayed).
 */
import type { WsEvent } from '@eduagent/shared';
import type { CodexLogger } from '../codex/index.js';
import type { ThreadEventSink } from '../threads/index.js';

/** Structural view of a connected socket; `ws` WebSocket satisfies it. */
export interface GatewaySocket {
  send(data: string): void;
}

const NOOP_LOGGER: CodexLogger = { debug() {}, info() {}, warn() {}, error() {} };

export class WsGateway implements ThreadEventSink {
  private readonly threadSockets = new Map<string, Set<GatewaySocket>>();
  private readonly userSockets = new Map<string, Set<GatewaySocket>>();
  private readonly log: CodexLogger;

  constructor(logger?: CodexLogger) {
    this.log = logger ?? NOOP_LOGGER;
  }

  addThreadSocket(threadId: string, socket: GatewaySocket): void {
    this.add(this.threadSockets, threadId, socket);
  }

  removeThreadSocket(threadId: string, socket: GatewaySocket): void {
    this.remove(this.threadSockets, threadId, socket);
  }

  addUserSocket(userId: string, socket: GatewaySocket): void {
    this.add(this.userSockets, userId, socket);
  }

  removeUserSocket(userId: string, socket: GatewaySocket): void {
    this.remove(this.userSockets, userId, socket);
  }

  emitToThread(threadId: string, event: WsEvent): void {
    this.fan(this.threadSockets.get(threadId), event);
  }

  emitToUser(userId: string, event: WsEvent): void {
    this.fan(this.userSockets.get(userId), event);
  }

  private add(registry: Map<string, Set<GatewaySocket>>, key: string, socket: GatewaySocket): void {
    let set = registry.get(key);
    if (!set) {
      set = new Set();
      registry.set(key, set);
    }
    set.add(socket);
  }

  private remove(
    registry: Map<string, Set<GatewaySocket>>,
    key: string,
    socket: GatewaySocket,
  ): void {
    const set = registry.get(key);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) registry.delete(key);
  }

  private fan(sockets: Set<GatewaySocket> | undefined, event: WsEvent): void {
    if (!sockets || sockets.size === 0) return;
    const data = JSON.stringify(event);
    for (const socket of [...sockets]) {
      try {
        socket.send(data);
      } catch (err) {
        this.log.warn({ err, type: event.type }, 'ws send failed — dropping event for socket');
      }
    }
  }
}

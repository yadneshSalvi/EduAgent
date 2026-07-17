import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { RawData } from 'ws';
import { clientWsEventSchema, type WsEvent } from '@eduagent/shared';
import type { AuthedUser } from '../auth/index.js';

/**
 * The WS gateway (plans/03 §7):
 *   `GET /ws?threadId=` — one thread's turn stream; accepts
 *     {type:"user.message"} → ThreadManager.startTurn and {type:"ping"}.
 *   `GET /ws/user`       — user-level socket: memory.commit + turn lifecycle
 *     for all the user's threads.
 * On (re)connect the gateway sends the current turn-status snapshot
 * (turn.started per in-flight turn); missed deltas are never replayed — the
 * client refetches `GET /api/threads/:id/items`.
 *
 * The auth handshake below is the reviewer-fixed Phase 0 shape: the message
 * listener attaches synchronously and buffers frames until resolveUser
 * settles (`ws` does not replay messages for late listeners).
 */

/** Close codes: 4400 bad request, 4401 unauthenticated, 4403 not your thread. */
const WS_BAD_REQUEST = 4400;
const WS_UNAUTHENTICATED = 4401;
const WS_FORBIDDEN = 4403;

export const wsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/ws', { websocket: true }, (socket, req) => {
    connect(socket, req, async (authed) => {
      const { threadId } = req.query as { threadId?: string };
      if (!threadId) {
        socket.close(WS_BAD_REQUEST, 'threadId query parameter required');
        return null;
      }
      const gateway = app.wsGateway;
      const threads = app.threads;
      if (!gateway || !threads) {
        socket.close(1013, 'gateway not ready');
        return null;
      }
      const thread = await app.prisma.thread.findUnique({ where: { id: threadId } });
      if (!thread || thread.userId !== authed.userId) {
        socket.close(WS_FORBIDDEN, 'thread not found or not yours');
        return null;
      }

      gateway.addThreadSocket(threadId, socket);
      socket.on('close', () => gateway.removeThreadSocket(threadId, socket));
      if (threads.turnInFlight(threadId)) {
        send(socket, { type: 'turn.started', threadId });
      }

      return (raw) => {
        const parsed = parseClientFrame(raw);
        if (parsed === 'pong-raw') {
          socket.send('pong');
          return;
        }
        if (parsed === null) {
          socket.send(JSON.stringify({ error: 'unsupported', message: unsupportedHint() }));
          return;
        }
        if (parsed.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        // user.message: fire-and-forget through the per-thread queue; failures
        // to even start the turn surface as a retryable turn.error.
        threads.startTurn(thread, parsed.text).catch((err: unknown) => {
          req.log.error({ err, threadId }, 'user.message turn failed to start');
          gateway.emitToThread(threadId, {
            type: 'turn.error',
            message: 'The tutor is reconnecting to its backend. Try again in a moment.',
            retryable: true,
          });
        });
      };
    });
  });

  app.get('/ws/user', { websocket: true }, (socket, req) => {
    connect(socket, req, async (authed) => {
      const gateway = app.wsGateway;
      const threads = app.threads;
      if (!gateway || !threads) {
        socket.close(1013, 'gateway not ready');
        return null;
      }

      gateway.addUserSocket(authed.userId, socket);
      socket.on('close', () => gateway.removeUserSocket(authed.userId, socket));
      for (const threadId of threads.inFlightThreads(authed.userId)) {
        send(socket, { type: 'turn.started', threadId });
      }

      return (raw) => {
        const parsed = parseClientFrame(raw);
        if (parsed === 'pong-raw') {
          socket.send('pong');
          return;
        }
        if (parsed !== null && parsed.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        socket.send(JSON.stringify({ error: 'unsupported', message: unsupportedHint() }));
      };
    });
  });
};

type MessageHandler = (raw: RawData) => void;

/**
 * Shared connection scaffolding: synchronous listener + pre-auth buffer, then
 * resolveUser, then the route-specific setup returns the real handler (or
 * null after closing the socket itself).
 */
function connect(
  socket: WebSocket,
  req: FastifyRequest,
  setup: (authed: AuthedUser) => Promise<MessageHandler | null>,
): void {
  let handleMessage: MessageHandler | null = null;
  const preAuthBuffer: RawData[] = [];
  socket.on('message', (raw: RawData) => {
    if (handleMessage) handleMessage(raw);
    else preAuthBuffer.push(raw);
  });

  void (async () => {
    const authed = await req.server.resolveUser(req);
    if (!authed) {
      socket.close(WS_UNAUTHENTICATED, 'unauthenticated');
      return;
    }
    const handler = await setup(authed);
    if (handler === null) return;
    req.log.debug({ userId: authed.userId, url: req.url }, 'ws connected');
    handleMessage = handler;
    for (const raw of preAuthBuffer.splice(0)) handleMessage(raw);
  })().catch((err: unknown) => {
    req.log.error({ err }, 'ws connection setup failed');
    socket.close(1011, 'internal error');
  });
}

/**
 * Parses one client frame with the shared schema. Returns 'pong-raw' for the
 * legacy plain-text "ping" (kept from Phase 0 as a connectivity probe), null
 * for anything unparseable.
 */
function parseClientFrame(
  raw: RawData,
): ReturnType<typeof clientWsEventSchema.parse> | 'pong-raw' | null {
  const text = raw.toString();
  if (text === 'ping') return 'pong-raw';
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = clientWsEventSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

function send(socket: WebSocket, event: WsEvent): void {
  socket.send(JSON.stringify(event));
}

function unsupportedHint(): string {
  return 'Supported frames: {type:"user.message",text} (thread sockets), {type:"ping"}.';
}

import type { FastifyPluginAsync } from 'fastify';
import type { RawData } from 'ws';

/**
 * Phase 0 WS stub: proves the auth path (same resolveUser as REST, per
 * plans/01 §7) and echoes ping→pong. Phase 1 replaces the message handler
 * with the real gateway (`GET /ws?threadId=` turn events + `/ws/user`,
 * plans/03 §7) — the auth handshake below stays as-is.
 */
export const wsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/ws', { websocket: true }, (socket, req) => {
    // Attach the message listener synchronously: `ws` does not replay messages
    // for late listeners, so anything sent while resolveUser is in flight must
    // be buffered here and drained once auth settles.
    let handleMessage: ((raw: RawData) => void) | null = null;
    const preAuthBuffer: RawData[] = [];
    socket.on('message', (raw: RawData) => {
      if (handleMessage) handleMessage(raw);
      else preAuthBuffer.push(raw);
    });

    void (async () => {
      const authed = await app.resolveUser(req);
      if (!authed) {
        socket.close(4401, 'unauthenticated');
        return;
      }
      req.log.debug({ userId: authed.userId }, 'ws connected');

      handleMessage = (raw: RawData) => {
        const text = raw.toString();
        if (text === 'ping') {
          socket.send('pong');
          return;
        }
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          // not JSON — falls through to the unsupported reply
        }
        if (parsed !== null && typeof parsed === 'object' && 'type' in parsed) {
          if ((parsed as { type: unknown }).type === 'ping') {
            socket.send(JSON.stringify({ type: 'pong' }));
            return;
          }
        }
        socket.send(
          JSON.stringify({
            error: 'unsupported',
            message: 'Phase 0 stub: only ping/pong. The WS gateway (turn events) lands in Phase 1.',
          }),
        );
      };
      for (const raw of preAuthBuffer.splice(0)) handleMessage(raw);
    })().catch((err) => {
      req.log.error({ err }, 'ws connection setup failed');
      socket.close(1011, 'internal error');
    });
  });
};

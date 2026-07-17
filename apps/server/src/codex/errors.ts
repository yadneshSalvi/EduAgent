/**
 * Typed errors surfaced by the codex protocol layer (plans/03 §8): callers
 * branch on `retryable` to decide whether a one-click retry makes sense.
 */
export abstract class AppServerError extends Error {
  abstract readonly retryable: boolean;
}

/** The app-server answered a request with a JSON-RPC error object. */
export class AppServerRequestError extends AppServerError {
  readonly retryable = false;

  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(`app-server ${method} failed (code ${code}): ${message}`);
    this.name = 'AppServerRequestError';
  }
}

/**
 * The codex child was not available to serve the request (died mid-flight,
 * still restarting, or never started). Always retryable — the client
 * auto-restarts and threads survive via `thread/resume` (PROTOCOL_NOTES §5).
 */
export class AppServerConnectionError extends AppServerError {
  readonly retryable = true;

  constructor(message: string) {
    super(message);
    this.name = 'AppServerConnectionError';
  }
}

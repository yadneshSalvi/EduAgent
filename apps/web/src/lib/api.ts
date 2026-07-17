import { z } from 'zod';
import {
  apiErrorSchema,
  createThreadRequestSchema,
  createThreadResponseSchema,
  listThreadsResponseSchema,
  localLoginRequestSchema,
  meResponseSchema,
  okResponseSchema,
  threadItemsResponseSchema,
  type CreateThreadRequest,
  type CreateThreadResponse,
  type ListThreadsResponse,
  type LocalLoginRequest,
  type MeResponse,
  type OkResponse,
  type ThreadItemsResponse,
  type ThreadMode,
} from '@eduagent/shared';

/**
 * Typed fetch wrapper for the agent host (plans/03 §7). Base URL comes from
 * NEXT_PUBLIC_SERVER_URL (default http://localhost:8787); every call is
 * credentialed (the AUTH_MODE=local session cookie / Clerk JWT ride along) and
 * every response is zod-parsed against the shared contract schemas.
 */
export function serverBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:8787').replace(/\/+$/, '');
}

/** ws(s):// equivalent of the server base, for the WS gateway. */
function wsBaseUrl(): string {
  return serverBaseUrl().replace(/^http/, 'ws');
}

/** Per-thread turn socket (plans/03 §7): `GET /ws?threadId=`. */
export function threadSocketUrl(threadId: string): string {
  return `${wsBaseUrl()}/ws?threadId=${encodeURIComponent(threadId)}`;
}

/** User-level socket for memory commits / dashboard invalidation: `/ws/user`. */
export function userSocketUrl(): string {
  return `${wsBaseUrl()}/ws/user`;
}

/** Non-2xx response carrying the server's error envelope (or a fallback). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** Machine-readable code from the error envelope, e.g. "unauthenticated". */
    readonly code: string,
    message: string,
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** fetch itself failed — the agent host is unreachable (not running, wrong port). */
export class ApiConnectionError extends Error {
  constructor(readonly baseUrl: string) {
    super(`Can't reach the agent host at ${baseUrl} — is the server running?`);
    this.name = 'ApiConnectionError';
  }
}

interface ApiFetchOptions<T> {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  schema: z.ZodType<T>;
  signal?: AbortSignal;
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions<T>): Promise<T> {
  const { method = 'GET', body, schema, signal } = options;
  let res: Response;
  try {
    res = await fetch(`${serverBaseUrl()}${path}`, {
      method,
      credentials: 'include',
      signal,
      ...(body !== undefined
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiConnectionError(serverBaseUrl());
  }

  if (!res.ok) {
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      // non-JSON error body — fall through to the status fallback
    }
    const envelope = apiErrorSchema.safeParse(payload);
    if (envelope.success) {
      throw new ApiError(
        res.status,
        envelope.data.error,
        envelope.data.message ?? envelope.data.error,
        envelope.data.retryable ?? false,
      );
    }
    throw new ApiError(res.status, 'http_error', `Request failed with status ${res.status}.`);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ApiError(res.status, 'invalid_response', 'The server returned a non-JSON response.');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError(
      res.status,
      'invalid_response',
      `The server response didn't match the shared contract for ${method} ${path}.`,
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Endpoints (shapes are the shared schemas — never invented here)
// ---------------------------------------------------------------------------

export function getMe(signal?: AbortSignal): Promise<MeResponse> {
  return apiFetch('/auth/me', { schema: meResponseSchema, signal });
}

export function localLogin(request: LocalLoginRequest): Promise<MeResponse> {
  return apiFetch('/auth/local-login', {
    method: 'POST',
    body: localLoginRequestSchema.parse(request),
    schema: meResponseSchema,
  });
}

export function listThreads(mode?: ThreadMode, signal?: AbortSignal): Promise<ListThreadsResponse> {
  const query = mode ? `?mode=${mode}` : '';
  return apiFetch(`/api/threads${query}`, { schema: listThreadsResponseSchema, signal });
}

export function createThread(request: CreateThreadRequest): Promise<CreateThreadResponse> {
  return apiFetch('/api/threads', {
    method: 'POST',
    body: createThreadRequestSchema.parse(request),
    schema: createThreadResponseSchema,
  });
}

export function getThreadItems(
  threadId: string,
  signal?: AbortSignal,
): Promise<ThreadItemsResponse> {
  return apiFetch(`/api/threads/${encodeURIComponent(threadId)}/items`, {
    schema: threadItemsResponseSchema,
    signal,
  });
}

export function interruptThread(threadId: string): Promise<OkResponse> {
  return apiFetch(`/api/threads/${encodeURIComponent(threadId)}/interrupt`, {
    method: 'POST',
    schema: okResponseSchema,
  });
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ApiConnectionError,
  ApiError,
  apiFetch,
  serverBaseUrl,
  threadSocketUrl,
  userSocketUrl,
} from './api';

function mockFetch(response: Partial<Response> & { json?: () => Promise<unknown> }) {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({}),
    ...response,
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('base urls', () => {
  it('defaults to the agent host contract (http://localhost:8787)', () => {
    expect(serverBaseUrl()).toBe('http://localhost:8787');
  });

  it('derives ws:// urls for the thread and user sockets', () => {
    expect(threadSocketUrl('t-1')).toBe('ws://localhost:8787/ws?threadId=t-1');
    expect(threadSocketUrl('a b')).toBe('ws://localhost:8787/ws?threadId=a%20b');
    expect(userSocketUrl()).toBe('ws://localhost:8787/ws/user');
  });
});

describe('apiFetch', () => {
  const schema = z.object({ ok: z.literal(true) });

  it('sends credentials and json bodies, parses the response', async () => {
    const fetchMock = mockFetch({ json: () => Promise.resolve({ ok: true }) });
    const result = await apiFetch('/api/test', {
      method: 'POST',
      body: { hello: 'world' },
      schema,
    });
    expect(result).toEqual({ ok: true });
    const call = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    const [url, init] = call;
    expect(url).toBe('http://localhost:8787/api/test');
    expect(init.credentials).toBe('include');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ hello: 'world' }));
  });

  it('non-2xx with the shared error envelope → typed ApiError', async () => {
    mockFetch({
      ok: false,
      status: 404,
      json: () =>
        Promise.resolve({ error: 'not_found', message: 'no such thread', retryable: false }),
    });
    const err = await apiFetch('/api/threads/x/items', { schema }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(404);
    expect(apiErr.code).toBe('not_found');
    expect(apiErr.message).toBe('no such thread');
    expect(apiErr.retryable).toBe(false);
  });

  it('non-2xx with a non-JSON body → status fallback ApiError', async () => {
    mockFetch({ ok: false, status: 502, json: () => Promise.reject(new Error('not json')) });
    const err = await apiFetch('/x', { schema }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('http_error');
    expect((err as ApiError).status).toBe(502);
  });

  it('network failure → ApiConnectionError naming the base url', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const err = await apiFetch('/x', { schema }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiConnectionError);
    expect((err as ApiConnectionError).message).toContain('http://localhost:8787');
  });

  it('2xx that fails the contract schema → invalid_response ApiError', async () => {
    mockFetch({ json: () => Promise.resolve({ ok: 'yep' }) });
    const err = await apiFetch('/x', { schema }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('invalid_response');
  });

  it('2xx with a non-JSON body → invalid_response ApiError', async () => {
    mockFetch({ json: () => Promise.reject(new Error('empty')) });
    const err = await apiFetch('/x', { schema }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('invalid_response');
  });

  it('aborts propagate (no ApiConnectionError masking)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('The user aborted a request.', 'AbortError')),
    );
    const err = await apiFetch('/x', { schema }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('AbortError');
  });
});

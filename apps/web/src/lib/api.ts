import { z } from 'zod';
import {
  apiErrorSchema,
  createExamRequestSchema,
  createExamResponseSchema,
  createThreadRequestSchema,
  createThreadResponseSchema,
  dashboardDataSchema,
  examDtoSchema,
  exerciseDtoSchema,
  listExamsResponseSchema,
  listThreadsResponseSchema,
  localLoginRequestSchema,
  localUsersResponseSchema,
  meResponseSchema,
  memoryDiffResponseSchema,
  memoryFileResponseSchema,
  memoryLogResponseSchema,
  memoryTreeResponseSchema,
  okResponseSchema,
  reviewQueueResponseSchema,
  saveExamAnswersRequestSchema,
  startExamResponseSchema,
  startReviewResponseSchema,
  submitExerciseRequestSchema,
  submitExerciseResponseSchema,
  submitQuizRequestSchema,
  threadItemsResponseSchema,
  type CreateExamRequest,
  type CreateExamResponse,
  type CreateThreadRequest,
  type CreateThreadResponse,
  type DashboardData,
  type ExamAnswers,
  type ExamDto,
  type ExerciseDto,
  type ListExamsResponse,
  type ListThreadsResponse,
  type LocalLoginRequest,
  type LocalUsersResponse,
  type MeResponse,
  type MemoryDiffResponse,
  type MemoryFileResponse,
  type MemoryLogResponse,
  type MemoryTreeResponse,
  type OkResponse,
  type ReviewQueueResponse,
  type StartExamResponse,
  type StartReviewResponse,
  type SubmitExerciseRequest,
  type SubmitExerciseResponse,
  type SubmitQuizRequest,
  type ThreadItemsResponse,
  type ThreadMode,
} from '@eduagent/shared';

/**
 * Typed fetch wrapper for the agent host (plans/03 §7). Base URL comes from
 * NEXT_PUBLIC_SERVER_URL when set; otherwise it is derived at RUNTIME from
 * the page's own hostname + the default server port. Deriving (rather than
 * hardcoding localhost) keeps the session cookie same-site: a page opened on
 * 127.0.0.1 talking to localhost:8787 is cross-site, so the browser drops
 * the SameSite=Lax cookie and every call 401s (QA finding m4). Every call is
 * credentialed (the AUTH_MODE=local session cookie / Clerk JWT ride along)
 * and every response is zod-parsed against the shared contract schemas.
 */
const DEFAULT_SERVER_PORT = 8787;

export function serverBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SERVER_URL;
  if (configured) return configured.replace(/\/+$/, '');
  if (typeof window !== 'undefined') {
    return `http://${window.location.hostname}:${DEFAULT_SERVER_PORT}`;
  }
  return `http://localhost:${DEFAULT_SERVER_PORT}`;
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

/**
 * Scoped post-login 401 retry (QA finding m4): the calls fired right after a
 * successful login (useMe refetch, the onboarding wizard's POST /api/threads)
 * occasionally raced the freshly set session cookie. Inside this window a 401
 * gets ONE delayed retry; outside it, 401s fail immediately as before.
 */
const LOGIN_RETRY_WINDOW_MS = 10_000;
const LOGIN_RETRY_DELAY_MS = 300;
let lastLoginAt = 0;

/** Called by login flows after their response settles. */
export function markSessionEstablished(): void {
  lastLoginAt = Date.now();
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions<T>): Promise<T> {
  const { method = 'GET', body, schema, signal } = options;
  const doFetch = async (): Promise<Response> => {
    try {
      return await fetch(`${serverBaseUrl()}${path}`, {
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
  };

  let res = await doFetch();
  if (res.status === 401 && Date.now() - lastLoginAt < LOGIN_RETRY_WINDOW_MS) {
    await new Promise((resolve) => setTimeout(resolve, LOGIN_RETRY_DELAY_MS));
    res = await doFetch();
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

export async function localLogin(request: LocalLoginRequest): Promise<MeResponse> {
  const me = await apiFetch('/auth/local-login', {
    method: 'POST',
    body: localLoginRequestSchema.parse(request),
    schema: meResponseSchema,
  });
  markSessionEstablished();
  return me;
}

/** AUTH_MODE=local only — existing profiles for the login picker (404 in clerk mode). */
export function listLocalUsers(signal?: AbortSignal): Promise<LocalUsersResponse> {
  return apiFetch('/auth/local-users', { schema: localUsersResponseSchema, signal });
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

export function getExercise(exerciseId: string, signal?: AbortSignal): Promise<ExerciseDto> {
  return apiFetch(`/api/exercises/${encodeURIComponent(exerciseId)}`, {
    schema: exerciseDtoSchema,
    signal,
  });
}

/** Triggers the grading turn; the verdict arrives via WS `exercise.graded`. */
export function submitExercise(
  exerciseId: string,
  request: SubmitExerciseRequest,
): Promise<SubmitExerciseResponse> {
  return apiFetch(`/api/exercises/${encodeURIComponent(exerciseId)}/submit`, {
    method: 'POST',
    body: submitExerciseRequestSchema.parse(request),
    schema: submitExerciseResponseSchema,
  });
}

/**
 * All answers ship at once (client-checked verdicts included — mastery
 * evidence); short-answer verdicts come back via WS `quiz.graded`. The shared
 * contract defines no dedicated response schema, so the generic ok envelope
 * applies.
 */
export function submitQuiz(quizId: string, request: SubmitQuizRequest): Promise<OkResponse> {
  return apiFetch(`/api/quiz/${encodeURIComponent(quizId)}/submit`, {
    method: 'POST',
    body: submitQuizRequestSchema.parse(request),
    schema: okResponseSchema,
  });
}

// ---------------------------------------------------------------------------
// Exams (plans/03 §3.5, §7)
// ---------------------------------------------------------------------------

/** Fire-and-forget: generation runs on a forked thread server-side. */
export function createExam(request: CreateExamRequest): Promise<CreateExamResponse> {
  return apiFetch('/api/exams', {
    method: 'POST',
    body: createExamRequestSchema.parse(request),
    schema: createExamResponseSchema,
  });
}

/** Newest first. */
export function listExams(signal?: AbortSignal): Promise<ListExamsResponse> {
  return apiFetch('/api/exams', { schema: listExamsResponseSchema, signal });
}

/** `questions` stays null while the exam is a draft — never render a draft. */
export function getExam(examId: string, signal?: AbortSignal): Promise<ExamDto> {
  return apiFetch(`/api/exams/${encodeURIComponent(examId)}`, { schema: examDtoSchema, signal });
}

/** Idempotent while in_progress — safe to re-fetch the deadline on reconnect. */
export function startExam(examId: string): Promise<StartExamResponse> {
  return apiFetch(`/api/exams/${encodeURIComponent(examId)}/start`, {
    method: 'POST',
    schema: startExamResponseSchema,
  });
}

/** 15s autosave; 409 deadline_passed / invalid_state surface as ApiError. */
export function saveExamAnswers(examId: string, answers: ExamAnswers): Promise<OkResponse> {
  return apiFetch(`/api/exams/${encodeURIComponent(examId)}/answers`, {
    method: 'PUT',
    body: saveExamAnswersRequestSchema.parse({ answers }),
    schema: okResponseSchema,
  });
}

/**
 * Past the server grace the body is ignored and the last autosave is graded.
 * Re-POSTing a `submitted` exam retries a failed grading turn (409
 * invalid_state "being graded" while one is in flight).
 */
export function submitExam(examId: string, answers: ExamAnswers): Promise<OkResponse> {
  return apiFetch(`/api/exams/${encodeURIComponent(examId)}/submit`, {
    method: 'POST',
    body: saveExamAnswersRequestSchema.parse({ answers }),
    schema: okResponseSchema,
  });
}

// ---------------------------------------------------------------------------
// Dashboard · review · memory explorer (Phase 3)
// ---------------------------------------------------------------------------

export function getDashboard(signal?: AbortSignal): Promise<DashboardData> {
  return apiFetch('/api/dashboard', { schema: dashboardDataSchema, signal });
}

export function getReviewQueue(signal?: AbortSignal): Promise<ReviewQueueResponse> {
  return apiFetch('/api/review/queue', { schema: reviewQueueResponseSchema, signal });
}

/** 409 {error:"nothing_due"} when the queue is empty — surfaces as ApiError. */
export function startReview(): Promise<StartReviewResponse> {
  return apiFetch('/api/review/start', { method: 'POST', schema: startReviewResponseSchema });
}

/** 404 {error:"no_memory"} before onboarding — a designed state, not a crash. */
export function getMemoryTree(signal?: AbortSignal): Promise<MemoryTreeResponse> {
  return apiFetch('/api/memory/tree', { schema: memoryTreeResponseSchema, signal });
}

export function getMemoryFile(
  path: string,
  ref?: string,
  signal?: AbortSignal,
): Promise<MemoryFileResponse> {
  const query = new URLSearchParams({ path });
  if (ref) query.set('ref', ref);
  return apiFetch(`/api/memory/file?${query}`, { schema: memoryFileResponseSchema, signal });
}

export function getMemoryLog(
  options: { limit?: number; skip?: number } = {},
  signal?: AbortSignal,
): Promise<MemoryLogResponse> {
  const query = new URLSearchParams();
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  if (options.skip !== undefined) query.set('skip', String(options.skip));
  const suffix = query.size > 0 ? `?${query}` : '';
  return apiFetch(`/api/memory/log${suffix}`, { schema: memoryLogResponseSchema, signal });
}

export function getMemoryDiff(
  from: string,
  to: string,
  path?: string,
  signal?: AbortSignal,
): Promise<MemoryDiffResponse> {
  const query = new URLSearchParams({ from, to });
  if (path) query.set('path', path);
  return apiFetch(`/api/memory/diff?${query}`, { schema: memoryDiffResponseSchema, signal });
}

/** Plain href for the "Export my memory" button — the browser downloads the zip. */
export function memoryExportUrl(): string {
  return `${serverBaseUrl()}/api/memory/export`;
}

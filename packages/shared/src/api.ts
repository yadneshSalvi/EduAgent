import { z } from 'zod';
import { slugSchema } from './common';
import { timelineEntrySchema } from './dashboard';
import { diffStatsSchema } from './memory-commit';
import {
  exerciseDifficultySchema,
  uiCreateExamArgsSchema,
  uiGradeExamArgsSchema,
} from './mcp-tools';

/**
 * REST request/response bodies (`03` §7). Route-level auth (Clerk JWT or
 * AUTH_MODE=local cookie) is carried in headers/cookies, never in these bodies.
 */

export const okResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof okResponseSchema>;

/** Error envelope for non-2xx responses. */
export const apiErrorSchema = z.object({
  error: z.string().min(1),
  message: z.string().optional(),
  retryable: z.boolean().optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** POST /auth/demo-login — hosted-demo "Explore as Alex" (clerk mode only). */
export const demoLoginRequestSchema = z.object({ accessCode: z.string().min(1) });
export type DemoLoginRequest = z.infer<typeof demoLoginRequestSchema>;

/** Response: a Clerk sign-in token the web app consumes. */
export const demoLoginResponseSchema = z.object({ token: z.string().min(1) });
export type DemoLoginResponse = z.infer<typeof demoLoginResponseSchema>;

/** POST /auth/local-login — AUTH_MODE=local only: create-or-login profile. */
export const localLoginRequestSchema = z.object({
  handle: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits, and dashes'),
});
export type LocalLoginRequest = z.infer<typeof localLoginRequestSchema>;

/** GET /auth/me — current session resolved to the app profile. */
export const meResponseSchema = z.object({
  id: z.string().min(1),
  handle: z.string().min(1),
  displayName: z.string().min(1),
  timezone: z.string().min(1),
  /** true once the workspace has a committed profile.md. */
  onboarded: z.boolean(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/** PATCH /api/me */
export const updateMeRequestSchema = z.object({
  displayName: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
});
export type UpdateMeRequest = z.infer<typeof updateMeRequestSchema>;

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

export const threadModeSchema = z.enum(['learn', 'review', 'exam']);
export type ThreadMode = z.infer<typeof threadModeSchema>;

export const threadSummarySchema = z.object({
  id: z.string().min(1),
  mode: threadModeSchema,
  topicSlug: slugSchema.nullable(),
  trackSlug: slugSchema.nullable(),
  title: z.string(),
  status: z.enum(['active', 'archived']),
  /** Exam threads: the parent learn thread they were forked from. */
  forkedFromId: z.string().nullable(),
  createdAt: z.string().min(1),
  lastActiveAt: z.string().min(1),
});
export type ThreadSummary = z.infer<typeof threadSummarySchema>;

/** GET /api/threads?mode= */
export const listThreadsQuerySchema = z.object({ mode: threadModeSchema.optional() });
export type ListThreadsQuery = z.infer<typeof listThreadsQuerySchema>;

export const listThreadsResponseSchema = z.object({ threads: z.array(threadSummarySchema) });
export type ListThreadsResponse = z.infer<typeof listThreadsResponseSchema>;

/** POST /api/threads — ensure a thread for (mode, topic/track). */
export const createThreadRequestSchema = z.object({
  mode: threadModeSchema,
  topicSlug: slugSchema.optional(),
  trackSlug: slugSchema.optional(),
});
export type CreateThreadRequest = z.infer<typeof createThreadRequestSchema>;

export const createThreadResponseSchema = threadSummarySchema;
export type CreateThreadResponse = z.infer<typeof createThreadResponseSchema>;

/** One ItemMirror row (`02` §5) — payload stays opaque here; consumers narrow by `kind`. */
export const threadItemSchema = z.object({
  id: z.string().min(1),
  codexItemId: z.string().nullable(),
  role: z.enum(['user', 'agent', 'system']),
  kind: z.enum(['message', 'reasoning', 'exec', 'tool_call', 'quiz', 'exercise_ref']),
  payload: z.unknown(),
  createdAt: z.string().min(1),
});
export type ThreadItem = z.infer<typeof threadItemSchema>;

/** GET /api/threads/:id/items */
export const threadItemsResponseSchema = z.object({ items: z.array(threadItemSchema) });
export type ThreadItemsResponse = z.infer<typeof threadItemsResponseSchema>;

// ---------------------------------------------------------------------------
// Exercises & quizzes
// ---------------------------------------------------------------------------

export const exerciseStatusSchema = z.enum(['open', 'passed', 'failed', 'abandoned']);
export type ExerciseStatus = z.infer<typeof exerciseStatusSchema>;

export const exerciseAttemptSchema = z.object({
  id: z.string().min(1),
  code: z.string(),
  verdict: z.enum(['passed', 'failed', 'error']).nullable(),
  feedback: z.string().nullable(),
  createdAt: z.string().min(1),
  gradedAt: z.string().nullable(),
});
export type ExerciseAttempt = z.infer<typeof exerciseAttemptSchema>;

/** GET /api/exercises/:id */
export const exerciseDtoSchema = z.object({
  id: slugSchema,
  threadId: z.string().min(1),
  language: z.string().min(1),
  title: z.string().min(1),
  prompt: z.string().min(1),
  starterCode: z.string(),
  concepts: z.array(z.string()),
  difficulty: exerciseDifficultySchema,
  status: exerciseStatusSchema,
  createdAt: z.string().min(1),
  attempts: z.array(exerciseAttemptSchema).optional(),
});
export type ExerciseDto = z.infer<typeof exerciseDtoSchema>;

/** POST /api/exercises/:id/submit — triggers the grading turn; result arrives via WS. */
export const submitExerciseRequestSchema = z.object({ code: z.string().min(1) });
export type SubmitExerciseRequest = z.infer<typeof submitExerciseRequestSchema>;

export const submitExerciseResponseSchema = z.object({
  ok: z.literal(true),
  attemptId: z.string().min(1),
});
export type SubmitExerciseResponse = z.infer<typeof submitExerciseResponseSchema>;

/**
 * POST /api/quiz/:id/submit — all answers, including client-checked mcq /
 * predict_output verdicts (the agent needs them for mastery evidence). `short`
 * answers carry no verdict; the agent grades them via ui_grade_quiz.
 */
export const submitQuizRequestSchema = z.object({
  answers: z
    .array(
      z.object({
        question_id: z.string().min(1),
        answer: z.string(),
        verdict: z.enum(['correct', 'incorrect']).optional(),
      }),
    )
    .min(1),
});
export type SubmitQuizRequest = z.infer<typeof submitQuizRequestSchema>;

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

/** GET /api/review/queue */
export const reviewQueueResponseSchema = z.object({
  dueToday: z.number().int().min(0),
  overdue: z.number().int().min(0),
  items: z.array(
    z.object({
      topic: slugSchema,
      concept: slugSchema,
      due: z.string().min(1),
    }),
  ),
});
export type ReviewQueueResponse = z.infer<typeof reviewQueueResponseSchema>;

/** POST /api/review/start */
export const startReviewResponseSchema = z.object({ threadId: z.string().min(1) });
export type StartReviewResponse = z.infer<typeof startReviewResponseSchema>;

// ---------------------------------------------------------------------------
// Exams
// ---------------------------------------------------------------------------

export const examStatusSchema = z.enum(['draft', 'ready', 'in_progress', 'submitted', 'graded']);
export type ExamStatus = z.infer<typeof examStatusSchema>;

/** POST /api/exams */
export const createExamRequestSchema = z.object({
  trackSlug: slugSchema,
  durationMin: z.number().int().positive(),
});
export type CreateExamRequest = z.infer<typeof createExamRequestSchema>;

export const createExamResponseSchema = z.object({
  examId: z.string().min(1),
  status: examStatusSchema,
});
export type CreateExamResponse = z.infer<typeof createExamResponseSchema>;

/** The persisted `Exam.questions` payload — ui_create_exam args minus the token. */
export const examQuestionsSchema = uiCreateExamArgsSchema.omit({ session_token: true });
export type ExamQuestions = z.infer<typeof examQuestionsSchema>;

/** Answers keyed by question id (mcq option, short text, or code). */
export const examAnswersSchema = z.record(z.string(), z.string());
export type ExamAnswers = z.infer<typeof examAnswersSchema>;

/** The persisted `Exam.result` payload — ui_grade_exam args minus token/exam_id. */
export const examResultSchema = uiGradeExamArgsSchema.omit({
  session_token: true,
  exam_id: true,
});
export type ExamResult = z.infer<typeof examResultSchema>;

/**
 * GET /api/exams/:id — includes startedAt + durationMin so the client renders
 * the server-authoritative deadline (`03` §3.5).
 */
export const examDtoSchema = z.object({
  id: z.string().min(1),
  trackSlug: slugSchema,
  status: examStatusSchema,
  durationMin: z.number().int().positive(),
  questions: examQuestionsSchema.nullable(),
  answers: examAnswersSchema.nullable(),
  result: examResultSchema.nullable(),
  startedAt: z.string().nullable(),
  submittedAt: z.string().nullable(),
  gradedAt: z.string().nullable(),
  createdAt: z.string().min(1),
});
export type ExamDto = z.infer<typeof examDtoSchema>;

export const examSummarySchema = examDtoSchema.omit({
  questions: true,
  answers: true,
  result: true,
});
export type ExamSummary = z.infer<typeof examSummarySchema>;

/** GET /api/exams */
export const listExamsResponseSchema = z.object({ exams: z.array(examSummarySchema) });
export type ListExamsResponse = z.infer<typeof listExamsResponseSchema>;

/** POST /api/exams/:id/start */
export const startExamResponseSchema = z.object({
  startedAt: z.string().min(1),
  /** startedAt + durationMin; server adds a 30s grace on enforcement. */
  deadline: z.string().min(1),
});
export type StartExamResponse = z.infer<typeof startExamResponseSchema>;

/** PUT /api/exams/:id/answers (15s autosave) and POST /api/exams/:id/submit. */
export const saveExamAnswersRequestSchema = z.object({ answers: examAnswersSchema });
export type SaveExamAnswersRequest = z.infer<typeof saveExamAnswersRequestSchema>;

export const submitExamRequestSchema = saveExamAnswersRequestSchema;
export type SubmitExamRequest = z.infer<typeof submitExamRequestSchema>;

// ---------------------------------------------------------------------------
// Memory explorer + time machine (git-tracked content only — `03` §7)
// ---------------------------------------------------------------------------

export interface MemoryTreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: MemoryTreeNode[];
}

export const memoryTreeNodeSchema: z.ZodType<MemoryTreeNode> = z.lazy(() =>
  z.object({
    name: z.string().min(1),
    path: z.string().min(1),
    type: z.enum(['file', 'dir']),
    children: z.array(memoryTreeNodeSchema).optional(),
  }),
);

/** GET /api/memory/tree */
export const memoryTreeResponseSchema = z.object({ tree: z.array(memoryTreeNodeSchema) });
export type MemoryTreeResponse = z.infer<typeof memoryTreeResponseSchema>;

/** GET /api/memory/file?path=&ref= */
export const memoryFileQuerySchema = z.object({
  path: z.string().min(1),
  ref: z.string().min(1).optional(),
});
export type MemoryFileQuery = z.infer<typeof memoryFileQuerySchema>;

export const memoryFileResponseSchema = z.object({
  path: z.string().min(1),
  /** The ref the content was read at (defaults to HEAD). */
  ref: z.string().min(1),
  content: z.string(),
});
export type MemoryFileResponse = z.infer<typeof memoryFileResponseSchema>;

/** GET /api/memory/log?limit= */
export const memoryLogQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
});
export type MemoryLogQuery = z.infer<typeof memoryLogQuerySchema>;

export const memoryLogResponseSchema = z.object({ commits: z.array(timelineEntrySchema) });
export type MemoryLogResponse = z.infer<typeof memoryLogResponseSchema>;

/** GET /api/memory/diff?from=&to=&path?= */
export const memoryDiffQuerySchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  path: z.string().min(1).optional(),
});
export type MemoryDiffQuery = z.infer<typeof memoryDiffQuerySchema>;

export const memoryDiffResponseSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  diff: z.string(),
  stats: diffStatsSchema,
});
export type MemoryDiffResponse = z.infer<typeof memoryDiffResponseSchema>;

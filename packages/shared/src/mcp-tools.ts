import { z } from 'zod';
import { conceptRefSchema, masteryScoreSchema, slugSchema } from './common';

/**
 * MCP UI tool argument schemas (`03` §5). These schemas ARE the contract:
 * `packages/mcp-ui-tools` generates its tool definitions from them and the
 * UiToolRelay validates incoming calls with them.
 *
 * Every tool requires `session_token` — issued per-thread by the agent host
 * and injected into the thread's developer instructions (`01` §4.5).
 */
const sessionToken = z.string().min(1);

export const exerciseDifficultySchema = z.enum(['easy', 'medium', 'hard']);
export type ExerciseDifficulty = z.infer<typeof exerciseDifficultySchema>;

export const uiPushExerciseArgsSchema = z.object({
  session_token: sessionToken,
  /** Agent-supplied slug, e.g. "ex-014". */
  id: slugSchema,
  title: z.string().min(1),
  language: z.string().min(1),
  prompt_md: z.string().min(1),
  starter_code: z.string(),
  concepts: z.array(conceptRefSchema).min(1),
  difficulty: exerciseDifficultySchema,
  /** Hidden tests the agent already wrote under `.exercises/<id>/tests/`. Never sent to the browser. */
  tests_path: z.string().min(1),
});
export type UiPushExerciseArgs = z.infer<typeof uiPushExerciseArgsSchema>;

/** What the browser sees in `workbench.exercise` — no token, no hidden-tests path. */
export const exercisePayloadSchema = uiPushExerciseArgsSchema.omit({
  session_token: true,
  tests_path: true,
});
export type ExercisePayload = z.infer<typeof exercisePayloadSchema>;

export const quizQuestionTypeSchema = z.enum(['mcq', 'short', 'predict_output']);
export type QuizQuestionType = z.infer<typeof quizQuestionTypeSchema>;

/**
 * `answer` ships for `mcq`/`predict_output` so they check instantly client-side.
 * Accepted team decision (`03` §5): client-visible answers are fine for
 * learn/review; exams never ship answers. Do not "fix" this.
 */
export const quizQuestionSchema = z
  .object({
    id: z.string().min(1),
    type: quizQuestionTypeSchema,
    prompt_md: z.string().min(1),
    options: z.array(z.string().min(1)).min(2).optional(),
    answer: z.string().min(1).optional(),
  })
  .superRefine((q, ctx) => {
    if (q.type === 'mcq' && !q.options) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'mcq questions require at least 2 options',
      });
    }
  });
export type QuizQuestion = z.infer<typeof quizQuestionSchema>;

export const uiPushQuizArgsSchema = z.object({
  session_token: sessionToken,
  id: z.string().min(1),
  concepts: z.array(conceptRefSchema).min(1),
  questions: z.array(quizQuestionSchema).min(1),
});
export type UiPushQuizArgs = z.infer<typeof uiPushQuizArgsSchema>;

export const quizPayloadSchema = uiPushQuizArgsSchema.omit({ session_token: true });
export type QuizPayload = z.infer<typeof quizPayloadSchema>;

export const uiPushArtifactArgsSchema = z.object({
  session_token: sessionToken,
  id: z.string().min(1),
  title: z.string().min(1),
  /** Self-contained HTML; always rendered in a sandboxed iframe (`01` §7). */
  html: z.string().min(1),
});
export type UiPushArtifactArgs = z.infer<typeof uiPushArtifactArgsSchema>;

export const artifactPayloadSchema = uiPushArtifactArgsSchema.omit({ session_token: true });
export type ArtifactPayload = z.infer<typeof artifactPayloadSchema>;

export const exerciseVerdictSchema = z.enum(['passed', 'failed']);
export type ExerciseVerdict = z.infer<typeof exerciseVerdictSchema>;

export const uiGradeExerciseArgsSchema = z.object({
  session_token: sessionToken,
  exercise_id: slugSchema,
  verdict: exerciseVerdictSchema,
  feedback_md: z.string().min(1),
});
export type UiGradeExerciseArgs = z.infer<typeof uiGradeExerciseArgsSchema>;

export const gradeVerdictSchema = z.enum(['correct', 'partial', 'incorrect']);
export type GradeVerdict = z.infer<typeof gradeVerdictSchema>;

export const quizGradeResultSchema = z.object({
  question_id: z.string().min(1),
  verdict: gradeVerdictSchema,
  feedback_md: z.string().min(1),
});
export type QuizGradeResult = z.infer<typeof quizGradeResultSchema>;

export const uiGradeQuizArgsSchema = z.object({
  session_token: sessionToken,
  quiz_id: z.string().min(1),
  results: z.array(quizGradeResultSchema).min(1),
});
export type UiGradeQuizArgs = z.infer<typeof uiGradeQuizArgsSchema>;

/** One concept mastery delta with its evidence note (`03` §5 ui_record_assessment). */
export const conceptDeltaSchema = z.object({
  topic: slugSchema,
  concept: slugSchema,
  from: masteryScoreSchema,
  to: masteryScoreSchema,
  evidence: z.string().min(1),
});
export type ConceptDelta = z.infer<typeof conceptDeltaSchema>;

export const uiRecordAssessmentArgsSchema = z.object({
  session_token: sessionToken,
  concept_deltas: z.array(conceptDeltaSchema).min(1),
  misconceptions_opened: z.array(z.string().min(1)).optional(),
  misconceptions_resolved: z.array(z.string().min(1)).optional(),
});
export type UiRecordAssessmentArgs = z.infer<typeof uiRecordAssessmentArgsSchema>;

export const assessmentPayloadSchema = uiRecordAssessmentArgsSchema.omit({ session_token: true });
export type AssessmentPayload = z.infer<typeof assessmentPayloadSchema>;

export const examQuestionTypeSchema = z.enum(['coding', 'mcq', 'short']);
export type ExamQuestionType = z.infer<typeof examQuestionTypeSchema>;

/** Exam questions carry no answers — exams are agent-graded server-side (`03` §5). */
export const examQuestionSchema = z
  .object({
    id: z.string().min(1),
    type: examQuestionTypeSchema,
    prompt_md: z.string().min(1),
    concepts: z.array(conceptRefSchema).min(1),
    starter_code: z.string().optional(),
    language: z.string().min(1).optional(),
    options: z.array(z.string().min(1)).min(2).optional(),
    points: z.number().positive(),
  })
  .superRefine((q, ctx) => {
    if (q.type === 'mcq' && !q.options) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'mcq questions require at least 2 options',
      });
    }
    if (q.type === 'coding' && !q.language) {
      ctx.addIssue({
        code: 'custom',
        path: ['language'],
        message: 'coding questions require a language',
      });
    }
  });
export type ExamQuestion = z.infer<typeof examQuestionSchema>;

export const examSectionSchema = z.object({
  title: z.string().min(1),
  questions: z.array(examQuestionSchema).min(1),
});
export type ExamSection = z.infer<typeof examSectionSchema>;

/**
 * No exam id: the relay resolves the calling thread (via session token) to its
 * single `draft` Exam row (`03` §4).
 */
export const uiCreateExamArgsSchema = z.object({
  session_token: sessionToken,
  track: slugSchema,
  duration_min: z.number().int().positive(),
  sections: z.array(examSectionSchema).min(1),
});
export type UiCreateExamArgs = z.infer<typeof uiCreateExamArgsSchema>;

export const examQuestionGradeSchema = z.object({
  id: z.string().min(1),
  verdict: gradeVerdictSchema,
  points_awarded: z.number().min(0),
  feedback_md: z.string().min(1),
});
export type ExamQuestionGrade = z.infer<typeof examQuestionGradeSchema>;

export const uiGradeExamArgsSchema = z.object({
  session_token: sessionToken,
  exam_id: z.string().min(1),
  per_question: z.array(examQuestionGradeSchema).min(1),
  total: z.number().min(0),
  readiness_delta: z.number(),
});
export type UiGradeExamArgs = z.infer<typeof uiGradeExamArgsSchema>;

/** All UI tools by wire name — the source for MCP tool definitions and relay dispatch. */
export const uiToolArgSchemas = {
  ui_push_exercise: uiPushExerciseArgsSchema,
  ui_push_quiz: uiPushQuizArgsSchema,
  ui_push_artifact: uiPushArtifactArgsSchema,
  ui_grade_exercise: uiGradeExerciseArgsSchema,
  ui_grade_quiz: uiGradeQuizArgsSchema,
  ui_record_assessment: uiRecordAssessmentArgsSchema,
  ui_create_exam: uiCreateExamArgsSchema,
  ui_grade_exam: uiGradeExamArgsSchema,
} as const;
export type UiToolName = keyof typeof uiToolArgSchemas;
export type UiToolArgs = { [K in UiToolName]: z.infer<(typeof uiToolArgSchemas)[K]> };

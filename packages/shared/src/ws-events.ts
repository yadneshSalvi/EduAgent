import { z } from 'zod';
import { memoryCommitSchema } from './memory-commit';
import {
  artifactPayloadSchema,
  assessmentPayloadSchema,
  exercisePayloadSchema,
  exerciseVerdictSchema,
  quizGradeResultSchema,
  quizPayloadSchema,
} from './mcp-tools';

/**
 * Server→client WebSocket events (`03` §7), discriminated on `type`.
 *
 * Note on `memory.commit`: the commit payload nests under `commit` because its
 * documented shape carries its own `type` field (the commit type), which would
 * collide with the event discriminator if flattened.
 */
export const wsEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('turn.started'), threadId: z.string().min(1) }),
  z.object({ type: z.literal('message.delta'), itemId: z.string().min(1), text: z.string() }),
  z.object({ type: z.literal('message.completed'), itemId: z.string().min(1), text: z.string() }),
  z.object({ type: z.literal('reasoning.delta'), text: z.string() }),
  z.object({
    type: z.literal('activity'),
    kind: z.enum(['exec', 'tool']),
    label: z.string().min(1),
    status: z.enum(['started', 'completed', 'failed']),
  }),
  z.object({ type: z.literal('workbench.exercise'), exercise: exercisePayloadSchema }),
  z.object({ type: z.literal('workbench.quiz'), quiz: quizPayloadSchema }),
  z.object({ type: z.literal('workbench.artifact'), artifact: artifactPayloadSchema }),
  assessmentPayloadSchema.extend({ type: z.literal('assessment.recorded') }),
  z.object({
    type: z.literal('exercise.graded'),
    exerciseId: z.string().min(1),
    verdict: exerciseVerdictSchema,
    feedback: z.string(),
  }),
  z.object({
    type: z.literal('quiz.graded'),
    quizId: z.string().min(1),
    results: z.array(quizGradeResultSchema).min(1),
  }),
  z.object({ type: z.literal('exam.created'), examId: z.string().min(1) }),
  z.object({ type: z.literal('exam.graded'), examId: z.string().min(1) }),
  z.object({ type: z.literal('memory.commit'), commit: memoryCommitSchema }),
  z.object({ type: z.literal('turn.completed'), threadId: z.string().min(1) }),
  z.object({
    type: z.literal('turn.error'),
    message: z.string().min(1),
    retryable: z.boolean(),
  }),
]);
export type WsEvent = z.infer<typeof wsEventSchema>;
export type WsEventType = WsEvent['type'];
export type WsEventOf<T extends WsEventType> = Extract<WsEvent, { type: T }>;

/** Client→server WebSocket events (`03` §7). */
export const clientWsEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user.message'), text: z.string().min(1) }),
  z.object({ type: z.literal('ping') }),
]);
export type ClientWsEvent = z.infer<typeof clientWsEventSchema>;

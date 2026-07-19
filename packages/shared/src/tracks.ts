import { z } from 'zod';
import { isoDateSchema, slugSchema } from './common';
import { threadSummarySchema } from './api';
import { roadmapScheduleSchema, roadmapTopicSchema, studyDaySchema } from './learner-model/roadmap';
import { sessionModeSchema } from './learner-model/session-log';

export const trackGoalTypeSchema = z.enum(['interview', 'exam', 'mastery', 'explore']);
export const trackStatusSchema = z.enum([
  'intake',
  'generating',
  'active',
  'completed',
  'archived',
  'failed',
]);
export const trackIntentSchema = z.enum(['teach', 'revise', 'mistakes']);

export const trackIntakeSchema = z
  .object({
    subject: z.string().trim().min(1),
    goalType: trackGoalTypeSchema,
    sourceText: z.string().max(30_000).optional(),
    sourceKind: z.enum(['syllabus', 'job-description']).optional(),
    subtopics: z.string().optional(),
    currentLevel: z.enum(['beginner', 'intermediate', 'advanced']),
    style: z.enum(['explain-first', 'drill-first', 'mix']).optional(),
    priorKnowledge: z.string().optional(),
    targetDate: isoDateSchema.optional(),
    totalDays: z.number().int().min(5).max(60).optional(),
    studyDays: z.array(studyDaySchema).min(1).max(7),
    minutesPerDay: z.number().int().min(15).max(240),
  })
  .refine((intake) => intake.targetDate !== undefined || intake.totalDays !== undefined, {
    message: 'either targetDate or totalDays is required',
    path: ['totalDays'],
  })
  .refine((intake) => intake.sourceText === undefined || intake.sourceKind !== undefined, {
    message: 'sourceKind is required when sourceText is present',
    path: ['sourceKind'],
  });
export type TrackIntake = z.infer<typeof trackIntakeSchema>;

export const trackSummarySchema = z.object({
  id: z.string().min(1),
  slug: slugSchema,
  title: z.string().min(1),
  goalType: trackGoalTypeSchema,
  status: trackStatusSchema,
  accent: z.string(),
  createdAt: z.string().min(1),
  lastActiveAt: z.string().min(1),
  day: z
    .object({ head: z.number().int().positive(), total: z.number().int().positive() })
    .nullable(),
  completedDays: z.array(z.number().int().positive()),
  nextPlannedDate: isoDateSchema.nullable(),
  conceptSlugs: z.array(slugSchema),
  topicSlugs: z.array(slugSchema),
});
export type TrackSummary = z.infer<typeof trackSummarySchema>;

export const trackDetailSchema = trackSummarySchema.extend({
  targetDate: isoDateSchema.nullable(),
  planThreadId: z.string().min(1).nullable(),
  roadmap: z
    .object({
      schedule: roadmapScheduleSchema,
      days: z.array(
        z.object({
          day: z.number().int().positive(),
          title: z.string().min(1),
          status: z.enum(['complete', 'upcoming']),
          completedOn: isoDateSchema.nullable(),
          plannedDate: isoDateSchema.nullable(),
          topics: z.array(roadmapTopicSchema),
          subtopics: z.array(z.string().min(1)),
          sessionCount: z.number().int().min(0),
        }),
      ),
    })
    .nullable(),
  headDay: z.number().int().positive().nullable(),
  subtopicsDone: z.number().int().min(0),
  subtopicsTotal: z.number().int().min(0),
});
export type TrackDetail = z.infer<typeof trackDetailSchema>;

const trackThreadSessionSchema = z.object({
  kind: z.literal('thread'),
  thread: threadSummarySchema,
  roadmapDay: z.number().int().positive(),
  commitCount: z.number().int().min(0),
});
const trackLogSessionSchema = z.object({
  kind: z.literal('log'),
  file: z.string().min(1),
  date: isoDateSchema,
  title: z.string().min(1),
  roadmapDay: z.number().int().positive().nullable(),
  durationEstimate: z.union([z.string().min(1), z.number().positive()]),
  mode: sessionModeSchema,
});
export const trackSessionsSchema = z.object({
  sessions: z.array(
    z.discriminatedUnion('kind', [trackThreadSessionSchema, trackLogSessionSchema]),
  ),
});
export type TrackSessions = z.infer<typeof trackSessionsSchema>;

export const createTrackResponseSchema = z.object({
  track: trackSummarySchema,
  planThreadId: z.string().min(1),
});
export type CreateTrackResponse = z.infer<typeof createTrackResponseSchema>;

export const createTrackSessionSchema = z.object({
  day: z.number().int().positive(),
  intent: trackIntentSchema,
});
export const completeTrackDaySchema = z.object({ threadId: z.string().min(1).optional() });

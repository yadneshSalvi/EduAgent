import { z } from 'zod';
import { masteryScoreSchema } from './common';
import { masteryDeltaSchema, memoryCommitTypeSchema } from './memory-commit';

/**
 * One entry of the dashboard timeline / `GET /api/memory/log` — a parsed memory
 * commit as read from `git log` (`02` §6).
 */
export const timelineEntrySchema = z.object({
  sha: z.string().min(1),
  type: memoryCommitTypeSchema,
  /** `"general"` for topic-less commits. */
  topic: z.string().min(1),
  headline: z.string().min(1),
  bullets: z.array(z.string()),
  deltas: z.array(masteryDeltaSchema),
  date: z.string().min(1),
});
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

/** Everything `GET /api/dashboard` returns, in one payload (`02` §6). */
export const dashboardDataSchema = z.object({
  user: z.object({
    displayName: z.string().min(1),
    streakDays: z.number().int().min(0),
  }),
  /** From the latest session log's "next time" pointer; absent when there is none. */
  continueCta: z
    .object({
      label: z.string().min(1),
      topicSlug: z.string().min(1),
    })
    .optional(),
  readiness: z.array(
    z.object({
      track: z.string().min(1),
      displayName: z.string().min(1),
      score: z.number().min(0).max(100),
      delta7d: z.number(),
      targetDate: z.string().optional(),
      weakest: z.array(
        z.object({
          concept: z.string().min(1),
          name: z.string().min(1),
          effective: masteryScoreSchema,
        }),
      ),
    }),
  ),
  topics: z.array(
    z.object({
      topic: z.string().min(1),
      displayName: z.string().min(1),
      concepts: z.array(
        z.object({
          id: z.string().min(1),
          name: z.string().min(1),
          mastery: masteryScoreSchema,
          effective: masteryScoreSchema,
          /** true when `effective < mastery - 0.1` (`02` §4) — amber treatment in the UI. */
          fading: z.boolean(),
          lastAssessed: z.string().min(1),
          reviewCount: z.number().int().min(0),
        }),
      ),
    }),
  ),
  /** Top-N interesting concepts: past effective-mastery points + 14d projection. */
  decaySeries: z.array(
    z.object({
      concept: z.string().min(1),
      name: z.string().min(1),
      points: z.array(
        z.object({
          date: z.string().min(1),
          effective: masteryScoreSchema,
        }),
      ),
    }),
  ),
  timeline: z.array(timelineEntrySchema),
  reviewQueue: z.object({
    dueToday: z.number().int().min(0),
    overdue: z.number().int().min(0),
    nextConcepts: z.array(z.string()),
  }),
  /** 90-day activity heatmap strip. */
  activity: z.array(
    z.object({
      date: z.string().min(1),
      count: z.number().int().min(0),
    }),
  ),
});
export type DashboardData = z.infer<typeof dashboardDataSchema>;

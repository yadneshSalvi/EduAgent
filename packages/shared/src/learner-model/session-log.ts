import { z } from 'zod';
import { conceptRefSchema, isoDateSchema, slugSchema } from '../common';

/** Session modes: thread modes plus the first-ever `onboarding` sitting. */
export const sessionModeSchema = z.enum(['onboarding', 'learn', 'review', 'exam', 'plan']);
export type SessionMode = z.infer<typeof sessionModeSchema>;

/**
 * Frontmatter of `sessions/<date>-<slug>.md` (`02` §2.6). The body is the
 * ~10-line narrative summary. `next_time` is the machine-readable "next time"
 * pointer that drives the dashboard Continue CTA (`02` §6 continueCta).
 * `duration_estimate` is either minutes (number) or a human string like "25m".
 */
export const sessionLogFrontmatterSchema = z.object({
  date: isoDateSchema,
  mode: sessionModeSchema,
  topics: z.array(slugSchema).default([]),
  duration_estimate: z.union([z.string().min(1), z.number().positive()]),
  concepts_touched: z.array(conceptRefSchema).default([]),
  next_time: z.string().min(1).optional(),
  /** Track-session grouping metadata; optional for all historical logs. */
  track: slugSchema.optional(),
  roadmap_day: z.number().int().positive().optional(),
  title: z.string().min(1).optional(),
});
export type SessionLogFrontmatter = z.infer<typeof sessionLogFrontmatterSchema>;

import { z } from 'zod';
import { masteryScoreSchema, slugSchema } from './common';

/** Memory-commit types per the commit grammar `<type>(<topic>): <headline>` (`02` §3). */
export const memoryCommitTypeSchema = z.enum([
  'learn',
  'review',
  'exam',
  'misconception',
  'profile',
  'seed',
  'system',
]);
export type MemoryCommitType = z.infer<typeof memoryCommitTypeSchema>;

/**
 * Commit header line. The `(<topic>)` segment is optional — e.g.
 * `profile: initialize learner model` has no topic.
 */
export const MEMORY_COMMIT_HEADER_RE =
  /^(learn|review|exam|misconception|profile|seed|system)(?:\(([a-z0-9]+(?:-[a-z0-9]+)*)\))?: (.+)$/;

/**
 * Mastery deltas in the headline, exact form `conceptid A→B` (`02` §3).
 * Applied to the headline line only — body bullets may mention deltas freely.
 */
export const MASTERY_DELTA_RE = /([a-z0-9-]+) (\d\.\d{2})→(\d\.\d{2})/g;

export const masteryDeltaSchema = z.object({
  concept: slugSchema,
  from: masteryScoreSchema,
  to: masteryScoreSchema,
});
export type MasteryDelta = z.infer<typeof masteryDeltaSchema>;

/** Result of `GitService.parseCommit(message)` (`03` §3.3). */
export const parsedMemoryCommitSchema = z.object({
  type: memoryCommitTypeSchema,
  /** null when the header has no `(<topic>)` segment. */
  topic: slugSchema.nullable(),
  headline: z.string().min(1),
  /** Markdown bullets from the commit body (without the leading `- `). */
  bullets: z.array(z.string()),
  /** Deltas parsed from the headline via MASTERY_DELTA_RE. */
  deltas: z.array(masteryDeltaSchema),
});
export type ParsedMemoryCommit = z.infer<typeof parsedMemoryCommitSchema>;

export const diffStatsSchema = z.object({
  filesChanged: z.number().int().min(0),
  insertions: z.number().int().min(0),
  deletions: z.number().int().min(0),
});
export type DiffStats = z.infer<typeof diffStatsSchema>;

/**
 * A fully-resolved memory commit as broadcast in the `memory.commit` WS event
 * (`03` §7): parse result + sha, diff stats, and unified diff. `topic` falls
 * back to `"general"` for topic-less commits.
 */
export const memoryCommitSchema = parsedMemoryCommitSchema.extend({
  sha: z.string().min(1),
  topic: z.string().min(1),
  stats: diffStatsSchema,
  diff: z.string(),
});
export type MemoryCommit = z.infer<typeof memoryCommitSchema>;

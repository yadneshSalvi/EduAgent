import { z } from 'zod';

/** Kebab-case slug: concept ids, topic slugs, track slugs (`00_goals.md` §9). */
export const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'expected a kebab-case slug (e.g. "inner-join")');
export type Slug = z.infer<typeof slugSchema>;

/** Concept reference: `inner-join` within a topic, or `sql/inner-join` cross-topic (`02` §2.4). */
export const conceptRefSchema = z
  .string()
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)?$/,
    'expected "concept" or "topic/concept" in kebab-case',
  );
export type ConceptRef = z.infer<typeof conceptRefSchema>;

/**
 * Learner-model files are YAML/frontmatter; YAML 1.1 parsers (js-yaml, gray-matter)
 * turn bare dates/timestamps into Date instances. These schemas accept both and
 * always output ISO strings, so downstream code never sees a Date.
 */
export const isoDateSchema = z.preprocess(
  (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v),
  z.iso.date(),
);
/** ISO calendar date, e.g. `2026-07-17`. */
export type IsoDate = z.infer<typeof isoDateSchema>;

export const isoDateTimeSchema = z.preprocess(
  (v) => (v instanceof Date ? v.toISOString() : v),
  z.iso.datetime({ offset: true }),
);
/** ISO datetime with timezone, e.g. `2026-07-17T18:30:00Z`. */
export type IsoDateTime = z.infer<typeof isoDateTimeSchema>;

/** Mastery score, 0..1 (`00_goals.md` §9). */
export const masteryScoreSchema = z.number().min(0).max(1);
export type MasteryScore = z.infer<typeof masteryScoreSchema>;

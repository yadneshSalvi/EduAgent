import { z } from 'zod';
import { isoDateSchema, isoDateTimeSchema, masteryScoreSchema, slugSchema } from '../common';

export const confidenceSchema = z.enum(['low', 'medium', 'high']);
export type Confidence = z.infer<typeof confidenceSchema>;

export const conceptEvidenceSchema = z.object({
  date: isoDateSchema,
  note: z.string().min(1),
});
export type ConceptEvidence = z.infer<typeof conceptEvidenceSchema>;

/**
 * One concept node in `topics/<topic>/mastery.yaml` (`02` §2.2).
 *
 * Contract the agent must follow (taught by the `memory` skill; only the parts
 * expressible statically are enforced here): mastery moves at most ±0.35 per
 * assessment, every change needs an evidence entry (hence `.min(1)`), and
 * concepts are never deleted — only annotated.
 */
export const masteryConceptSchema = z.object({
  id: slugSchema,
  name: z.string().min(1),
  mastery: masteryScoreSchema,
  confidence: confidenceSchema,
  last_assessed: isoDateSchema,
  review_count: z.number().int().min(0),
  prereqs: z.array(slugSchema).default([]),
  evidence: z.array(conceptEvidenceSchema).min(1),
});
export type MasteryConcept = z.infer<typeof masteryConceptSchema>;

/** `topics/<topic>/mastery.yaml` — THE core learner-model file. */
export const masteryFileSchema = z.object({
  topic: slugSchema,
  display_name: z.string().min(1),
  updated: isoDateTimeSchema,
  concepts: z.array(masteryConceptSchema),
});
export type MasteryFile = z.infer<typeof masteryFileSchema>;

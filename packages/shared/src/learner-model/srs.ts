import { z } from 'zod';
import { isoDateSchema, slugSchema } from '../common';

/**
 * One item in `srs/queue.yaml` (`02` §2.5). Ease is SM-2 style and bounded by
 * the update rules in `02` §4: floor 1.3, cap 2.8.
 */
export const srsQueueItemSchema = z.object({
  concept: slugSchema,
  topic: slugSchema,
  due: isoDateSchema,
  interval_days: z.number().int().min(1),
  ease: z.number().min(1.3).max(2.8),
  lapses: z.number().int().min(0),
});
export type SrsQueueItem = z.infer<typeof srsQueueItemSchema>;

/** `srs/queue.yaml` — the spaced-repetition schedule. */
export const srsQueueFileSchema = z.object({
  items: z.array(srsQueueItemSchema).default([]),
});
export type SrsQueueFile = z.infer<typeof srsQueueFileSchema>;

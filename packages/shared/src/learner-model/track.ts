import { z } from 'zod';
import { isoDateSchema, slugSchema } from '../common';

/** One curriculum item in `tracks/<track>.yaml`; weight = importance for readiness (`02` §2.4). */
export const trackItemSchema = z.object({
  concept: slugSchema,
  topic: slugSchema,
  weight: z.number().positive(),
});
export type TrackItem = z.infer<typeof trackItemSchema>;

/** `tracks/<track>.yaml` — goal-oriented curriculum over topics. */
export const trackFileSchema = z.object({
  track: slugSchema,
  display_name: z.string().min(1),
  target_date: isoDateSchema.optional(),
  items: z.array(trackItemSchema).min(1),
});
export type TrackFile = z.infer<typeof trackFileSchema>;

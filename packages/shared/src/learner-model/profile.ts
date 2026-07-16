import { z } from 'zod';
import { slugSchema } from '../common';

/** Learner preferences inside `profile.md` frontmatter (`02` §2.1). All optional — the agent fills them in as it learns them. */
export const learnerPreferencesSchema = z
  .object({
    session_length: z.enum(['short', 'standard', 'deep']),
    style: z.enum(['socratic', 'direct']),
    humor: z.string().min(1),
  })
  .partial();
export type LearnerPreferences = z.infer<typeof learnerPreferencesSchema>;

/** Frontmatter of `profile.md`. The markdown body (free prose about the learner) is not schema-bound. */
export const profileFrontmatterSchema = z.object({
  name: z.string().min(1),
  goal: z.string().min(1),
  tracks: z.array(slugSchema).default([]),
  preferences: learnerPreferencesSchema.default({}),
  timezone: z.string().min(1).default('UTC'),
});
export type ProfileFrontmatter = z.infer<typeof profileFrontmatterSchema>;

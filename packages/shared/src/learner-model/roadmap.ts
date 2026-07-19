import { z } from 'zod';
import { isoDateSchema, slugSchema } from '../common';

/** Lowercase three-letter weekdays used by roadmap schedules. */
export const studyDaySchema = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

export const roadmapScheduleSchema = z
  .object({
    study_days: z.array(studyDaySchema).min(1).max(7),
    minutes_per_day: z.number().int().min(15).max(240),
    start_date: isoDateSchema,
  })
  .refine((schedule) => new Set(schedule.study_days).size === schedule.study_days.length, {
    message: 'study_days must not contain duplicates',
    path: ['study_days'],
  });

export const roadmapTopicSchema = z.object({
  topic: slugSchema,
  concepts: z.array(slugSchema).min(1),
});

export const roadmapDaySchema = z
  .object({
    day: z.number().int().positive(),
    title: z.string().min(1),
    status: z.enum(['complete', 'upcoming']),
    completed_on: isoDateSchema.optional(),
    topics: z.array(roadmapTopicSchema).min(1),
    subtopics: z.array(z.string().min(1)).min(2).max(5),
  })
  .superRefine((day, ctx) => {
    if (day.status === 'complete' && day.completed_on === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['completed_on'],
        message: 'required when status is complete',
      });
    }
    if (day.status === 'upcoming' && day.completed_on !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['completed_on'],
        message: 'must be absent when status is upcoming',
      });
    }
  });

/** Versioned day-by-day plan at `tracks/<slug>/roadmap.yaml`. */
export const roadmapFileSchema = z
  .object({
    track: slugSchema,
    created: isoDateSchema,
    schedule: roadmapScheduleSchema,
    days: z.array(roadmapDaySchema).min(5).max(60),
  })
  .superRefine((roadmap, ctx) => {
    roadmap.days.forEach((day, index) => {
      if (day.day !== index + 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['days', index, 'day'],
          message: `expected contiguous day ${index + 1}`,
        });
      }
    });
  });
export type RoadmapFile = z.infer<typeof roadmapFileSchema>;

/** YAML frontmatter for `tracks/<slug>/brief.md`. */
export const trackBriefFrontmatterSchema = z.object({
  track: slugSchema,
  goal_type: z.enum(['interview', 'exam', 'mastery', 'explore']),
  target_date: isoDateSchema.optional(),
  source: z.enum(['job-description', 'syllabus', 'self-described', 'none']),
});
export type TrackBriefFrontmatter = z.infer<typeof trackBriefFrontmatterSchema>;

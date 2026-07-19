import { describe, expect, it } from 'vitest';
import { parseTrackWizardState, schedulePreview, type TrackWizardState } from './track-wizard';

const BASE: TrackWizardState = {
  subject: '',
  goalType: 'explore',
  targetDate: '',
  sourceText: '',
  subtopics: [],
  totalDays: 5,
  studyDays: ['mon', 'wed', 'fri'],
  minutesPerDay: 30,
  level: 'new',
  style: undefined,
  priorKnowledge: '',
};

describe('track wizard validation', () => {
  it('requires only the subject because optional choices have safe defaults', () => {
    expect(parseTrackWizardState(BASE).success).toBe(false);
    const parsed = parseTrackWizardState({ ...BASE, subject: ' SQL fundamentals ' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toMatchObject({
        subject: 'SQL fundamentals',
        goalType: 'explore',
        currentLevel: 'beginner',
        totalDays: 5,
      });
      expect(parsed.data.sourceText).toBeUndefined();
      expect(parsed.data.priorKnowledge).toBeUndefined();
    }
  });

  it('maps interview source/style fields to the exact shared intake literals', () => {
    const parsed = parseTrackWizardState({
      ...BASE,
      subject: 'Backend interviews',
      goalType: 'interview',
      sourceText: 'Role requires SQL.',
      targetDate: '2026-09-01',
      level: 'comfortable',
      style: 'drill-first',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sourceKind).toBe('job-description');
      expect(parsed.data.currentLevel).toBe('intermediate');
      expect(parsed.data.style).toBe('drill-first');
      expect(parsed.data.targetDate).toBe('2026-09-01');
      expect(parsed.data.totalDays).toBeUndefined();
    }
  });

  it('computes a completion-paced weekday preview', () => {
    const result = schedulePreview(
      { totalDays: 3, studyDays: ['mon', 'wed', 'fri'], targetDate: '' },
      new Date(2026, 6, 20, 12),
    );
    expect(result.studyDays).toBe(3);
    expect(result.finishDate.toLocaleDateString('en-CA')).toBe('2026-07-24');
  });
});

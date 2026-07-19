import { trackIntakeSchema, type TrackIntake } from '@eduagent/shared';

export type StudyDay = TrackIntake['studyDays'][number];
export type LevelChoice = 'new' | 'rusty' | 'comfortable' | 'sharp';

export interface TrackWizardState {
  subject: string;
  goalType: TrackIntake['goalType'];
  targetDate: string;
  sourceText: string;
  subtopics: string[];
  totalDays: number;
  studyDays: StudyDay[];
  minutesPerDay: number;
  level: LevelChoice;
  style: TrackIntake['style'];
  priorKnowledge: string;
}

const LEVEL_MAP: Record<LevelChoice, TrackIntake['currentLevel']> = {
  new: 'beginner',
  rusty: 'beginner',
  comfortable: 'intermediate',
  sharp: 'advanced',
};

/** The UI owns friendly choices; this is the one boundary into the shared contract. */
export function parseTrackWizardState(state: TrackWizardState) {
  const sourceBranch = state.goalType === 'interview' || state.goalType === 'exam';
  const targetDate = sourceBranch && state.targetDate ? state.targetDate : undefined;
  return trackIntakeSchema.safeParse({
    subject: state.subject.trim(),
    goalType: state.goalType,
    ...(sourceBranch && state.sourceText.trim()
      ? {
          sourceText: state.sourceText.trim(),
          sourceKind: state.goalType === 'interview' ? 'job-description' : 'syllabus',
        }
      : {}),
    ...(!sourceBranch && state.subtopics.length > 0
      ? { subtopics: state.subtopics.join(', ') }
      : {}),
    currentLevel: LEVEL_MAP[state.level],
    ...(state.style ? { style: state.style } : {}),
    ...(state.priorKnowledge.trim() ? { priorKnowledge: state.priorKnowledge.trim() } : {}),
    ...(targetDate ? { targetDate } : { totalDays: state.totalDays }),
    studyDays: state.studyDays,
    minutesPerDay: state.minutesPerDay,
  });
}

const WEEKDAY: Record<number, StudyDay> = {
  0: 'sun',
  1: 'mon',
  2: 'tue',
  3: 'wed',
  4: 'thu',
  5: 'fri',
  6: 'sat',
};

export function schedulePreview(
  state: Pick<TrackWizardState, 'totalDays' | 'studyDays' | 'targetDate'>,
  today = new Date(),
): { studyDays: number; finishDate: Date } {
  const allowed = new Set(state.studyDays);
  const cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12);
  if (state.targetDate) {
    const target = new Date(`${state.targetDate}T12:00:00`);
    let count = 0;
    while (cursor <= target) {
      if (allowed.has(WEEKDAY[cursor.getDay()]!)) count++;
      cursor.setDate(cursor.getDate() + 1);
    }
    return { studyDays: count, finishDate: target };
  }

  let count = 0;
  while (count < state.totalDays) {
    if (allowed.has(WEEKDAY[cursor.getDay()]!)) count++;
    if (count < state.totalDays) cursor.setDate(cursor.getDate() + 1);
  }
  return { studyDays: state.totalDays, finishDate: cursor };
}

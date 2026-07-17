/**
 * SrsEngine (plans/03 §3.5): read-side derivations over `srs/queue.yaml` +
 * shared learning-math. The AGENT owns queue updates (memory skill, SM-2
 * rules); nothing here ever writes. Pure functions of (queue, today) so the
 * dashboard, review endpoints, and tests share one notion of "due".
 */
import {
  addDays,
  srsAfterFail,
  srsAfterPass,
  type IsoDate,
  type SrsQueueFile,
  type SrsQueueItem,
} from '@eduagent/shared';

export interface DueSummary {
  /** Items whose due date is exactly `today`. */
  dueToday: number;
  /** Items whose due date is before `today`. */
  overdue: number;
  /** All due-or-overdue items, soonest (most overdue) first, then by concept. */
  due: SrsQueueItem[];
  /** Future items, soonest first, then by concept (queue preview). */
  upcoming: SrsQueueItem[];
}

const byDueThenConcept = (a: SrsQueueItem, b: SrsQueueItem): number =>
  a.due.localeCompare(b.due) || a.concept.localeCompare(b.concept);

/** Splits the queue around `today` (a calendar date in the learner's timezone). */
export function dueSummary(queue: SrsQueueFile, today: IsoDate): DueSummary {
  const due = queue.items.filter((item) => item.due <= today).sort(byDueThenConcept);
  const upcoming = queue.items.filter((item) => item.due > today).sort(byDueThenConcept);
  return {
    dueToday: due.filter((item) => item.due === today).length,
    overdue: due.filter((item) => item.due < today).length,
    due,
    upcoming,
  };
}

/**
 * Where an item lands if reviewed today — both branches of the SM-2 rules
 * (dashboard "next review in N days" chips and review-summary projections).
 */
export function nextDueProjection(
  item: SrsQueueItem,
  today: IsoDate,
): { ifPassed: IsoDate; ifFailed: IsoDate } {
  const passed = srsAfterPass(item);
  const failed = srsAfterFail(item);
  return {
    ifPassed: addDays(today, passed.interval_days),
    ifFailed: addDays(today, failed.interval_days),
  };
}

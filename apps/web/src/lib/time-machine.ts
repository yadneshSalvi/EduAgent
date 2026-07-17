import type { MasteryDelta, TimelineEntry } from '@eduagent/shared';

/**
 * Time-machine range summary (plans/04 §7): "Between Jul 3 and Jul 15 you:
 * +6 concepts, inner-join 0.30→0.70, resolved 2 misconceptions" — computed
 * client-side from the parsed commits between ref A and ref B.
 */
export interface RangeSummary {
  commitCount: number;
  /** Net mastery movement per concept: first `from` → last `to` in the range. */
  deltas: MasteryDelta[];
  /** Concepts whose first delta in range started at 0 (newly planted). */
  conceptsAdded: number;
  misconceptionsOpened: number;
  misconceptionsResolved: number;
}

const RESOLVED_RE = /resolv/i;

/**
 * Summarizes the commits reachable from `to` but not from `from` — i.e. what
 * `git diff from..to` covers. `commits` is the full parsed log, newest first
 * (the /api/memory/log order); `from` is expected to be the older ref. A
 * reversed pair summarizes the same span (scrubbing must never explode).
 */
export function summarizeRange(
  commits: TimelineEntry[],
  fromSha: string,
  toSha: string,
): RangeSummary {
  let fromIndex = commits.findIndex((c) => c.sha === fromSha);
  let toIndex = commits.findIndex((c) => c.sha === toSha);
  const empty: RangeSummary = {
    commitCount: 0,
    deltas: [],
    conceptsAdded: 0,
    misconceptionsOpened: 0,
    misconceptionsResolved: 0,
  };
  if (fromIndex === -1 || toIndex === -1) return empty;
  if (toIndex > fromIndex) [fromIndex, toIndex] = [toIndex, fromIndex];
  // Newest-first: commits strictly after `from`, up to and including `to`.
  const range = commits.slice(toIndex, fromIndex);

  const first = new Map<string, number>();
  const last = new Map<string, number>();
  let misconceptionsOpened = 0;
  let misconceptionsResolved = 0;

  // Walk oldest→newest so first/last land in commit order.
  for (let i = range.length - 1; i >= 0; i--) {
    const commit = range[i]!;
    for (const delta of commit.deltas) {
      if (!first.has(delta.concept)) first.set(delta.concept, delta.from);
      last.set(delta.concept, delta.to);
    }
    if (commit.type === 'misconception') {
      misconceptionsOpened += 1;
    }
    if (RESOLVED_RE.test(commit.headline) || commit.bullets.some((b) => RESOLVED_RE.test(b))) {
      misconceptionsResolved += 1;
    }
  }

  const deltas: MasteryDelta[] = [...last.entries()]
    .map(([concept, to]) => ({ concept, from: first.get(concept) ?? 0, to }))
    .sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));

  return {
    commitCount: range.length,
    deltas,
    conceptsAdded: deltas.filter((delta) => delta.from === 0).length,
    misconceptionsOpened,
    misconceptionsResolved,
  };
}

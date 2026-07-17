import type { DiffStats, MasteryDelta, MemoryCommit } from '@eduagent/shared';
import { formatMastery } from './mastery';

/**
 * Formatting for memory-commit surfaces (toast, drawer, timeline). Memory
 * speaks terminal (plans/05 §1): mono, commit grammar, `0.40→0.72` deltas.
 */

/** `learn(sql)` — the mono type badge. Topic-less commits fall back to `"general"`
 *  in the WS payload (memory-commit.ts); render those as the bare type. */
export function commitBadge(commit: Pick<MemoryCommit, 'type' | 'topic'>): string {
  return commit.topic === 'general' ? commit.type : `${commit.type}(${commit.topic})`;
}

/** `inner-join 0.40→0.72` — exactly the commit-grammar delta form (02 §3). */
export function formatDelta(delta: MasteryDelta): string {
  return `${delta.concept} ${formatMastery(delta.from)}→${formatMastery(delta.to)}`;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** `3 files · +24 −6` */
export function formatDiffStats(stats: DiffStats): string {
  const files = `${stats.filesChanged} file${stats.filesChanged === 1 ? '' : 's'}`;
  return `${files} · +${stats.insertions} −${stats.deletions}`;
}

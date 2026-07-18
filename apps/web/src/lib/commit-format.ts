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

/** git's well-known empty-tree object — diff base for a root commit. */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Whether a memory.commit event has anything to SHOW the learner. The server
 * strips examiner material (`.exercises/**`, QA F1) from broadcast diffs, so
 * a commit that only touched it — e.g. the teach skill committing an
 * exercise's reference solution + hidden tests — arrives with an empty diff
 * and `0 files · +0 −0` stats. Those are journal housekeeping, not memory
 * events: don't toast them (the timeline still lists the commit headline).
 */
export function isLearnerVisibleCommit(
  commit: Pick<MemoryCommit, 'stats' | 'diff' | 'deltas'>,
): boolean {
  return (
    commit.stats.filesChanged > 0 || commit.diff.trim() !== '' || commit.deltas.length > 0
  );
}

/**
 * Commit-toast lifetime: generous enough to read the headline and delta chips
 * (and for a camera to linger); hovering pins it open. Override per-deploy
 * with NEXT_PUBLIC_COMMIT_TOAST_MS (baked at build time like all
 * NEXT_PUBLIC_* values).
 */
export const DEFAULT_COMMIT_TOAST_MS = 15_000;

export function commitToastDurationMs(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1000 ? Math.floor(parsed) : DEFAULT_COMMIT_TOAST_MS;
}

import type {
  MasteryFile,
  ProfileFrontmatter,
  SessionLogFrontmatter,
  SrsQueueFile,
  TrackFile,
} from '@eduagent/shared';

/** One `topics/<topic>/` directory, resolved (plans/02 §1). */
export interface TopicModel {
  topic: string;
  displayName: string;
  /** null when mastery.yaml is absent or unrecoverable. */
  mastery: MasteryFile | null;
  /** Titles of `## [OPEN]` entries in misconceptions.md. */
  openMisconceptions: string[];
}

export interface SessionSummary {
  /** Workspace-relative path, e.g. `sessions/2026-07-17-sql-joins.md`. */
  file: string;
  frontmatter: SessionLogFrontmatter;
  body: string;
}

/**
 * The parsed learner model — everything WorkspaceManager.readLearnerModel
 * recovers from the workspace files (plans/03 §3.2). Invalid files fall back
 * to their last-known-good HEAD version and are listed in `needsRepair`.
 */
export interface LearnerModel {
  /** null until onboarding writes profile.md. */
  profile: { frontmatter: ProfileFrontmatter; body: string } | null;
  tracks: TrackFile[];
  topics: TopicModel[];
  srs: SrsQueueFile;
  /** Most recent session log (filenames are date-prefixed, so max sorts last). */
  lastSession: SessionSummary | null;
  /** Workspace-relative paths whose on-disk state failed validation. */
  needsRepair: string[];
}

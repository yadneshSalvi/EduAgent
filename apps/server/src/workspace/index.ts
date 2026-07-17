/**
 * Workspace layer (plans/03 §3.2–3.4): per-user git repos ("Memory"), the
 * validated learner-model reader, the state digest, and the post-turn memory
 * pipeline. Boot wiring (task: index.ts) constructs WorkspaceManager +
 * MemoryPipeline and calls ensureSkillsInstalled() once.
 */
export {
  AGENT_GIT_AUTHOR,
  GitService,
  parseCommit,
  type CommitDiff,
  type GitCommitInfo,
  type GitStatusSummary,
} from './GitService.js';
export { WORKSPACE_INIT_COMMIT, WORKSPACE_TEMPLATE } from './template.js';
export {
  WorkspaceManager,
  type EnsureWorkspaceResult,
  type WorkspaceLogger,
} from './WorkspaceManager.js';
export {
  MemoryPipeline,
  type MemoryCommitEmitter,
  type MemoryPipelineDeps,
  type MemoryTurnContext,
} from './MemoryPipeline.js';
export { formatStateDigest, type DigestOptions } from './digest.js';
export { effectiveMastery, halfLifeDays, isFading } from './learning-math.js';
export type { LearnerModel, SessionSummary, TopicModel } from './model.js';

/**
 * Thread layer (plans/03 §3.1): ThreadManager ties the protocol client,
 * workspaces, memory pipeline, and WS gateway together per thread.
 */
export {
  ARCHIVED_SESSION_MESSAGE,
  DAILY_QUOTA_MESSAGE,
  DailyTurnQuotaError,
  GREETING_INPUT,
  maskExamArtifacts,
  ThreadManager,
  TURN_START_EVENT,
  type EnsureThreadResult,
  type ExamForkOptions,
  type ExamThreadService,
  type ThreadEventSink,
  type ThreadManagerDeps,
  type ThreadService,
  type TrackThreadService,
} from './ThreadManager.js';

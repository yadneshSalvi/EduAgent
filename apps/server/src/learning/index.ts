/**
 * Learning services (plans/03 §3.5).
 */
export { DashboardService, type DashboardServiceDeps } from './DashboardService.js';
export {
  DeadlinePassedError,
  ExamForkError,
  ExamService,
  ExamStateError,
  UnknownTrackError,
  type ExamServiceDeps,
} from './ExamService.js';
export {
  EXAM_GRACE_MS,
  EXAM_IGNORE_PATTERN,
  examDeadline,
  examExpired,
  examKeyDir,
  examWorkdir,
  parseExamConfig,
  type ExamConfig,
  type ExamTarget,
} from './exam-config.js';
export { ReviewService, NothingDueError, type ReviewServiceDeps } from './ReviewService.js';
export { dueSummary, nextDueProjection, type DueSummary } from './SrsEngine.js';

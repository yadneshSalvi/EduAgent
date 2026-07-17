/**
 * Learning services (plans/03 §3.5). Still to land here: ExamService (Phase 4).
 */
export { DashboardService, type DashboardServiceDeps } from './DashboardService.js';
export { ReviewService, NothingDueError, type ReviewServiceDeps } from './ReviewService.js';
export { dueSummary, nextDueProjection, type DueSummary } from './SrsEngine.js';

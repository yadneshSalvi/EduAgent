/**
 * Phase 3: the learning-math module now lives in @eduagent/shared per
 * plans/02 §4 (the dashboard charts need the same formulas). Re-exported here
 * so existing server imports keep working unchanged.
 */
export { effectiveMastery, halfLifeDays, isFading } from '@eduagent/shared';

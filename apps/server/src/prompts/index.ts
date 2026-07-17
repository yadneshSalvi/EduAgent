/**
 * Prompt layer (plans/03 §6). Layering: skills carry the stable playbooks
 * (installed at $DATA_DIR/.codex/skills by WorkspaceManager at boot);
 * thread-level developerInstructions (these builders) carry mode + session
 * token; the per-turn context envelope carries the fresh state digest.
 */
export { buildContextEnvelope, type ContextEnvelopeOptions } from './envelope.js';
export { buildLearnInstructions, type LearnModeOptions } from './modes/learn.js';
export { buildOnboardingInstructions, type OnboardingModeOptions } from './modes/onboarding.js';
export {
  installSkills,
  installedSkillPath,
  installedSkillsRoot,
  readSkillSource,
  skillSourcePath,
  SKILL_NAMES,
  type SkillInstallResult,
  type SkillName,
} from './skills.js';
export { LEARNER_VOICE_RULES } from './voice.js';
export {
  estimateTokens,
  MODE_INSTRUCTIONS_TOKEN_BUDGET,
  ONBOARDING_INSTRUCTIONS_TOKEN_BUDGET,
  STATE_DIGEST_TOKEN_BUDGET,
} from './tokens.js';

/**
 * The per-turn context envelope (plans/03 §6, plans/01 §4.0 fact 2): there
 * are no per-turn developer instructions, so fresh state rides as a labeled
 * prefix on the user input. ThreadManager does
 * `buildContextEnvelope(digest, opts) + userText`.
 */
export interface ContextEnvelopeOptions {
  /**
   * Workspace-relative paths of learner-model files whose on-disk state
   * failed validation (WorkspaceManager.readLearnerModel().needsRepair) —
   * adds a fix-it-first directive to the envelope.
   */
  needsRepair?: string[];
  /** Extra system-context lines (e.g. review mode's due list). */
  notes?: string[];
}

export function buildContextEnvelope(digest: string, opts: ContextEnvelopeOptions = {}): string {
  const lines = [
    '<eduagent-context>',
    'System-provided context (not written by the learner). This digest reflects',
    'the learner-model files on disk right now — trust it over recollection.',
    '',
    digest,
  ];
  if (opts.notes && opts.notes.length > 0) {
    lines.push('', ...opts.notes);
  }
  if (opts.needsRepair && opts.needsRepair.length > 0) {
    lines.push(
      '',
      `REPAIR FIRST: these learner-model files are invalid on disk: ${opts.needsRepair.join(', ')}.`,
      'Before anything else this turn, restore each to valid format per the memory skill',
      '(preserve all history/evidence; use git history for the last good version), then',
      'commit as `system: repair learner-model files`.',
    );
  }
  lines.push('</eduagent-context>', '', 'The learner says:', '');
  return lines.join('\n');
}

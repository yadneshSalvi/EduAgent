import { estimateTokens, STATE_DIGEST_TOKEN_BUDGET } from '../prompts/tokens.js';
import { effectiveMastery, isFading } from './learning-math.js';
import type { LearnerModel } from './model.js';

/**
 * Formats the compact labeled state digest injected into every turn's context
 * envelope (plans/03 §3.2). Deterministic given (model, now); hard-capped at
 * STATE_DIGEST_TOKEN_BUDGET tokens — list limits below keep realistic models
 * well under it, the final truncation is a guarantee, not the mechanism.
 */
export interface DigestOptions {
  now?: Date;
}

const MAX_TRACKS = 4;
const MAX_WEAK_CONCEPTS = 5;
const MAX_MISCONCEPTIONS = 4;
const MAX_DUE_PREVIEW = 3;

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

export function formatStateDigest(model: LearnerModel, opts: DigestOptions = {}): string {
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const lines: string[] = [`[LEARNER STATE ${today}]`];

  if (model.profile) {
    const p = model.profile.frontmatter;
    lines.push(`Learner: ${clip(p.name, 60)} — goal: ${clip(p.goal, 140)}`);
    const prefs = Object.entries(p.preferences)
      .map(([key, value]) => `${key}=${value}`)
      .join(' · ');
    if (prefs) lines.push(`Preferences: ${prefs} · timezone: ${p.timezone}`);
  } else if (model.needsRepair.includes('profile.md')) {
    // Unrecoverable profile ≠ new learner: without this distinction the agent
    // re-interviews someone it already knows (Phase 1 QA finding M1).
    lines.push(
      'Profile: profile.md exists but is invalid and unrecoverable — repair it; do NOT re-interview the learner.',
    );
  } else {
    lines.push('No profile yet — this learner has not completed onboarding.');
  }

  if (model.tracks.length > 0) {
    const shown = model.tracks
      .slice(0, MAX_TRACKS)
      .map(
        (t) => `${t.display_name} (${t.track}${t.target_date ? `, target ${t.target_date}` : ''})`,
      );
    const more = model.tracks.length - MAX_TRACKS;
    lines.push(`Tracks: ${shown.join(' · ')}${more > 0 ? ` (+${more} more)` : ''}`);
  }

  const concepts = model.topics.flatMap((topic) =>
    (topic.mastery?.concepts ?? []).map((c) => {
      const effective = effectiveMastery(c.mastery, c.review_count, c.last_assessed, now);
      return {
        ref: `${topic.topic}/${c.id}`,
        name: c.name,
        raw: c.mastery,
        effective,
        fading: isFading(c.mastery, effective),
      };
    }),
  );
  if (concepts.length > 0) {
    lines.push(
      `Concepts tracked: ${concepts.length}. Weakest by effective mastery (raw × time decay):`,
    );
    for (const c of [...concepts]
      .sort((a, b) => a.effective - b.effective)
      .slice(0, MAX_WEAK_CONCEPTS)) {
      lines.push(
        `- ${c.ref} (${clip(c.name, 40)}): effective ${c.effective.toFixed(2)}, raw ${c.raw.toFixed(2)}${c.fading ? ' — FADING, needs review' : ''}`,
      );
    }
  }

  const due = model.srs.items.filter((item) => item.due <= today);
  if (due.length > 0) {
    const overdue = due.filter((item) => item.due < today).length;
    const preview = [...due]
      .sort((a, b) => a.due.localeCompare(b.due))
      .slice(0, MAX_DUE_PREVIEW)
      .map((item) => `${item.topic}/${item.concept}`);
    lines.push(
      `Reviews due: ${due.length}${overdue > 0 ? ` (${overdue} overdue)` : ''} — next up: ${preview.join(', ')}`,
    );
  } else {
    lines.push('Reviews due: none');
  }

  const open = model.topics.flatMap((topic) =>
    topic.openMisconceptions.map((title) => `[${topic.topic}] ${clip(title, 110)}`),
  );
  if (open.length > 0) {
    lines.push('Open misconceptions:');
    for (const entry of open.slice(0, MAX_MISCONCEPTIONS)) lines.push(`- ${entry}`);
    if (open.length > MAX_MISCONCEPTIONS)
      lines.push(`- (+${open.length - MAX_MISCONCEPTIONS} more)`);
  }

  if (model.lastSession) {
    const fm = model.lastSession.frontmatter;
    const topics = fm.topics.length > 0 ? `, ${fm.topics.join('+')}` : '';
    lines.push(
      `Last session ${fm.date} (${fm.mode}${topics})${fm.next_time ? ` — next time: ${clip(fm.next_time, 160)}` : ''}`,
    );
  } else if (model.profile) {
    // A missing session log after onboarding must never read as "no learner
    // state" — everything above IS the state (Phase 1 QA finding M1).
    lines.push(
      'No session log yet: onboarding is done, this sitting is their first real lesson.',
    );
  }

  if (model.needsRepair.length > 0) {
    lines.push(
      `NEEDS REPAIR (invalid on disk, showing last-known-good): ${model.needsRepair.join(', ')}`,
    );
  }

  const digest = lines.join('\n');
  if (estimateTokens(digest) <= STATE_DIGEST_TOKEN_BUDGET) return digest;
  return `${digest.slice(0, STATE_DIGEST_TOKEN_BUDGET * 4 - 20)}\n[digest truncated]`;
}

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Skill sources live as real SKILL.md files next to this module
 * (prompts/skills/<name>/SKILL.md, plans/03 §6) and are installed ONCE at
 * $DATA_DIR/.codex/skills/<name>/SKILL.md — every workspace under
 * $DATA_DIR/workspaces inherits them via codex's ancestor-walk discovery
 * (plans/01 §4.0 fact 6, verified in docs/PROTOCOL_NOTES.md §11).
 */
export const SKILL_NAMES = ['teach', 'memory'] as const;
export type SkillName = (typeof SKILL_NAMES)[number];

const sourcesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'skills');

export function skillSourcePath(name: SkillName): string {
  return path.join(sourcesDir, name, 'SKILL.md');
}

export async function readSkillSource(name: SkillName): Promise<string> {
  return fs.readFile(skillSourcePath(name), 'utf8');
}

export interface SkillInstallResult {
  name: SkillName;
  path: string;
  action: 'installed' | 'updated' | 'unchanged';
}

/** Where a skill lands under the data dir. */
export function installedSkillPath(dataDir: string, name: SkillName): string {
  return path.join(dataDir, '.codex', 'skills', name, 'SKILL.md');
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Installs/refreshes both skills. Idempotent: content-hash comparison means
 * repeated boots touch nothing, while any edit to a source SKILL.md
 * overwrites the installed copy on the next boot.
 */
export async function installSkills(dataDir: string): Promise<SkillInstallResult[]> {
  const results: SkillInstallResult[] = [];
  for (const name of SKILL_NAMES) {
    const source = await readSkillSource(name);
    const target = installedSkillPath(dataDir, name);
    let existing: string | null = null;
    try {
      existing = await fs.readFile(target, 'utf8');
    } catch {
      existing = null;
    }
    if (existing !== null && sha256(existing) === sha256(source)) {
      results.push({ name, path: target, action: 'unchanged' });
      continue;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, source, 'utf8');
    results.push({ name, path: target, action: existing === null ? 'installed' : 'updated' });
  }
  return results;
}

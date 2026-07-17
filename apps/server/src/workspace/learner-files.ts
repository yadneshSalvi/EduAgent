import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { load as yamlLoad } from 'js-yaml';
import type { z } from 'zod';
import type { GitService } from './GitService.js';

/**
 * Parsing helpers for the learner-model files (plans/02 §2). Schemas come
 * from @eduagent/shared — this module only adds the read/validate/fallback
 * mechanics around them.
 */

export interface FrontmatterFile<T> {
  frontmatter: T;
  /** Markdown body with frontmatter stripped, trimmed. */
  body: string;
}

/** Parses a whole-file YAML document against a shared schema; throws on any failure. */
export function parseYamlFile<S extends z.ZodType>(schema: S, raw: string): z.infer<S> {
  return schema.parse(yamlLoad(raw));
}

/** Parses `---`-frontmatter markdown against a shared schema; throws on any failure. */
export function parseFrontmatterFile<S extends z.ZodType>(
  schema: S,
  raw: string,
): FrontmatterFile<z.infer<S>> {
  const parsed = matter(raw);
  return { frontmatter: schema.parse(parsed.data), body: parsed.content.trim() };
}

/** Titles of `## [OPEN] …` entries in a misconceptions.md log (plans/02 §2.3). */
export function parseOpenMisconceptions(raw: string): string[] {
  return raw.split('\n').flatMap((line) => {
    const match = /^##\s*\[OPEN\]\s*(.+)$/.exec(line.trim());
    return match?.[1] ? [match[1].trim()] : [];
  });
}

export interface ValidatedRead<T> {
  /** Parsed value — from disk, or from HEAD when the disk copy is broken; null if unrecoverable/absent. */
  value: T | null;
  /** True when the on-disk state is damaged (invalid content, or a tracked file deleted). */
  needsRepair: boolean;
}

/**
 * Reads + validates one learner-model file with the last-known-good fallback
 * (plans/03 §3.2): a broken disk copy falls back to `git show HEAD:<path>` and
 * flags the file for repair. A file absent from both disk and HEAD is simply
 * absent (e.g. profile.md before onboarding) — not a repair case.
 */
export async function readValidated<T>(
  workspaceDir: string,
  git: GitService,
  relPath: string,
  parse: (raw: string) => T,
): Promise<ValidatedRead<T>> {
  let diskRaw: string | null = null;
  try {
    diskRaw = await fs.readFile(path.join(workspaceDir, relPath), 'utf8');
  } catch {
    diskRaw = null;
  }
  if (diskRaw !== null) {
    try {
      return { value: parse(diskRaw), needsRepair: false };
    } catch {
      // fall through to last-known-good
    }
  }
  const headRaw = await git.fileAtRef('HEAD', relPath);
  if (headRaw !== null) {
    try {
      return { value: parse(headRaw), needsRepair: true };
    } catch {
      return { value: null, needsRepair: true };
    }
  }
  return { value: null, needsRepair: diskRaw !== null };
}

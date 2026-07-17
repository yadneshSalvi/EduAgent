/**
 * Minimal unified-diff parser for the Diff Drawer: turns the `diff` string of
 * a `memory.commit` event into per-file original/modified documents that
 * Monaco's DiffEditor can render. Only hunk content is reconstructed (context
 * + removed lines vs context + added lines) — that is exactly what a commit
 * diff view should show.
 */
export interface FileDiff {
  /** Post-image path (pre-image path for deletions), without a/ b/ prefixes. */
  path: string;
  original: string;
  modified: string;
  insertions: number;
  deletions: number;
}

/** Same text on both sides so Monaco renders it as an unchanged gap row. */
const HUNK_SEPARATOR = '···';

function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//, '');
}

export function parseUnifiedDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  // Git diffs end with a newline; without this it would read as a stray
  // empty context line on both sides of the last hunk.
  const lines = diff.replace(/\n$/, '').split('\n');
  let current: FileDiff | null = null;
  let originalLines: string[] = [];
  let modifiedLines: string[] = [];
  let inHunk = false;

  const flush = () => {
    if (!current) return;
    current.original = originalLines.join('\n');
    current.modified = modifiedLines.join('\n');
    files.push(current);
    current = null;
    originalLines = [];
    modifiedLines = [];
    inHunk = false;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      // `diff --git a/<path> b/<path>` — take the b-side path.
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      current = {
        path: match?.[2] ?? line.slice('diff --git '.length),
        original: '',
        modified: '',
        insertions: 0,
        deletions: 0,
      };
      continue;
    }
    if (!current) continue;

    if (line.startsWith('--- ')) {
      const path = line.slice(4).trim();
      if (path !== '/dev/null' && current.path === '') current.path = stripPrefix(path);
      continue;
    }
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim();
      if (path !== '/dev/null') current.path = stripPrefix(path);
      continue;
    }
    if (line.startsWith('@@')) {
      if (inHunk) {
        originalLines.push(HUNK_SEPARATOR);
        modifiedLines.push(HUNK_SEPARATOR);
      }
      inHunk = true;
      continue;
    }
    if (!inHunk) continue; // index/mode/similarity headers

    if (line.startsWith('+')) {
      modifiedLines.push(line.slice(1));
      current.insertions++;
    } else if (line.startsWith('-')) {
      originalLines.push(line.slice(1));
      current.deletions++;
    } else if (line.startsWith(' ') || line === '') {
      originalLines.push(line.slice(1));
      modifiedLines.push(line.slice(1));
    }
    // `\ No newline at end of file` and anything else: ignore.
  }
  flush();
  return files;
}

/** Monaco language id from a learner-model file path. */
export function languageForPath(path: string): string {
  if (/\.ya?ml$/.test(path)) return 'yaml';
  if (/\.md$/.test(path)) return 'markdown';
  if (/\.json$/.test(path)) return 'json';
  return 'plaintext';
}

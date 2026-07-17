'use client';

import { useMemo } from 'react';
import { load as yamlLoad } from 'js-yaml';
import { masteryFileSchema, type MasteryFile } from '@eduagent/shared';
import { Markdown } from '@/components/chat/markdown';
import { MasteryBar } from '@/components/shared/mastery-bar';
import { formatShortDate } from '@/lib/dashboard-data';
import { formatMastery, masteryColor } from '@/lib/mastery';

/**
 * The memory explorer's file viewer (plans/04 §7): markdown rendered via the
 * chat Markdown component (frontmatter split into a YAML block), mastery
 * files get inline MasteryBars above the raw YAML, everything else renders
 * as a highlighted code block. Memory speaks terminal; prose speaks scholar.
 */

/** Splits `---\n…\n---\n` frontmatter off a markdown document. */
export function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  if (!match) return { frontmatter: null, body: content };
  return { frontmatter: match[1] ?? null, body: content.slice(match[0].length) };
}

function fence(content: string, lang: string): string {
  return `\`\`\`${lang}\n${content.replace(/\n$/, '')}\n\`\`\``;
}

function MasteryPanel({ file }: { file: MasteryFile }) {
  return (
    <section aria-label={`${file.display_name} mastery`} className="flex flex-col gap-3 rounded-lg border bg-surface-2/40 p-4">
      <header className="flex items-baseline justify-between gap-3">
        <h3 className="text-body font-medium">{file.display_name}</h3>
        <span className="font-mono text-caption text-muted-foreground">
          updated {formatShortDate(file.updated)}
        </span>
      </header>
      <ul className="flex flex-col gap-3">
        {file.concepts.map((concept) => (
          <li key={concept.id} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-body-sm">{concept.name}</span>
              <span className="numeric shrink-0 font-mono text-caption">
                <span style={{ color: masteryColor(concept.mastery) }}>
                  {formatMastery(concept.mastery)}
                </span>{' '}
                <span className="text-muted-foreground">
                  · {concept.review_count} review{concept.review_count === 1 ? '' : 's'} · last{' '}
                  {formatShortDate(concept.last_assessed)}
                </span>
              </span>
            </div>
            <MasteryBar value={concept.mastery} aria-label={`${concept.name} mastery`} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function FileViewer({ path, content }: { path: string; content: string }) {
  const mastery = useMemo(() => {
    if (!/^topics\/[^/]+\/mastery\.ya?ml$/.test(path)) return null;
    try {
      const parsed = masteryFileSchema.safeParse(yamlLoad(content));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }, [path, content]);

  if (/\.md$/.test(path)) {
    const { frontmatter, body } = splitFrontmatter(content);
    return (
      <div className="flex flex-col gap-4 p-6">
        {frontmatter ? <Markdown content={fence(frontmatter, 'yaml')} /> : null}
        <Markdown content={body} />
      </div>
    );
  }

  if (/\.ya?ml$/.test(path)) {
    return (
      <div className="flex flex-col gap-4 p-6">
        {mastery ? <MasteryPanel file={mastery} /> : null}
        <Markdown content={fence(content, 'yaml')} />
      </div>
    );
  }

  const lang = /\.json$/.test(path) ? 'json' : 'text';
  return (
    <div className="p-6">
      <Markdown content={fence(content, lang)} />
    </div>
  );
}

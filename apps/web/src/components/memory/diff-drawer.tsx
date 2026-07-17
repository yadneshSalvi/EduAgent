'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { GitCommitHorizontal, X } from 'lucide-react';
import type { MemoryCommit } from '@eduagent/shared';
import { DeltaBar } from './delta-bar';
import { commitBadge, formatDiffStats, shortSha } from '@/lib/commit-format';
import { MONACO_FONT_FAMILY, defineEduAgentTheme } from '@/lib/monaco-theme';
import { languageForPath, parseUnifiedDiff } from '@/lib/unified-diff';
import { cn } from '@/lib/utils';

/**
 * The Diff Drawer (plans/05 §6.1, steps 2–3) — the product's signature
 * surface. Bottom sheet to 70vh on a hero spring, 40% scrim. Left rail:
 * commit meta (short sha, bullets, animated DeltaBars). Right: Monaco
 * DiffEditor, inline mode, our diff token colors. Header, serif italic:
 * "EduAgent updated its memory of you."
 */
const MonacoDiff = dynamic(() => import('@monaco-editor/react').then((m) => m.DiffEditor), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center font-mono text-caption text-muted-foreground">
      loading diff…
    </div>
  ),
});

export const DIFF_DRAWER_DEFAULT_HEADER = 'EduAgent updated its memory of you.';

interface DiffDrawerProps {
  commit: MemoryCommit | null;
  onClose: () => void;
  /** Onboarding "memory born" moment overrides the thesis line. */
  headerLine?: string;
}

export function DiffDrawer({ commit, onClose, headerLine }: DiffDrawerProps) {
  const reducedMotion = useReducedMotion();
  const closeRef = useRef<HTMLButtonElement>(null);

  const files = useMemo(() => (commit ? parseUnifiedDiff(commit.diff) : []), [commit]);
  const [activeIndex, setActiveIndex] = useState(0);
  useEffect(() => setActiveIndex(0), [commit?.sha]);
  const activeFile = files[Math.min(activeIndex, Math.max(files.length - 1, 0))];

  // Esc closes; page scroll locks while open (05 §9 keyboard reach).
  useEffect(() => {
    if (!commit) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [commit, onClose]);

  return (
    <AnimatePresence>
      {commit ? (
        <div
          className="fixed inset-0 z-[60]"
          role="dialog"
          aria-modal="true"
          aria-label="Memory commit diff"
        >
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/40"
          />
          <motion.div
            initial={reducedMotion ? { opacity: 0 } : { y: '100%' }}
            animate={reducedMotion ? { opacity: 1 } : { y: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { y: '100%' }}
            // Hero class (05 §5): gentle spring, no bounce past the resting point.
            transition={
              reducedMotion
                ? { duration: 0.2 }
                : { type: 'spring', stiffness: 300, damping: 34, mass: 0.9 }
            }
            className="absolute inset-x-0 bottom-0 flex h-[70vh] flex-col overflow-hidden rounded-t-xl border-t bg-surface shadow-overlay"
          >
            <header className="flex h-14 shrink-0 items-center gap-4 border-b px-5 lg:px-6">
              <p className="min-w-0 truncate font-display text-lead italic">
                {headerLine ?? DIFF_DRAWER_DEFAULT_HEADER}
              </p>
              <div className="flex-1" />
              <span className="hidden items-center gap-2 font-mono text-caption text-muted-foreground sm:flex">
                <span className="rounded-sm bg-accent-soft px-1.5 py-0.5 text-primary">
                  {commitBadge(commit)}
                </span>
                <GitCommitHorizontal className="size-3.5" aria-hidden />
                {shortSha(commit.sha)}
              </span>
              <button
                ref={closeRef}
                type="button"
                onClick={onClose}
                aria-label="Close diff drawer"
                className="rounded-md p-1.5 text-muted-foreground transition-colors duration-150 hover:bg-surface-2 hover:text-foreground"
              >
                <X className="size-4" aria-hidden />
              </button>
            </header>

            <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[300px_1fr]">
              {/* Left rail — the commit, in commit grammar. Memory speaks terminal. */}
              <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto border-b p-5 md:border-b-0 md:border-r">
                <p className="text-body font-medium leading-snug">{commit.headline}</p>
                {commit.bullets.length > 0 ? (
                  <ul className="flex flex-col gap-1.5">
                    {commit.bullets.map((bullet, index) => (
                      <li
                        key={index}
                        className="border-l-2 border-border pl-3 text-body-sm text-muted-foreground"
                      >
                        {bullet}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {commit.deltas.length > 0 ? (
                  <div className="flex flex-col gap-2.5">
                    <p className="font-mono text-caption uppercase tracking-wide text-muted-foreground/80">
                      mastery deltas
                    </p>
                    {commit.deltas.map((delta, index) => (
                      <DeltaBar key={delta.concept} delta={delta} delayMs={250 + index * 120} />
                    ))}
                  </div>
                ) : null}
                <p className="mt-auto pt-2 font-mono text-caption text-muted-foreground">
                  {formatDiffStats(commit.stats)}
                </p>
              </aside>

              {/* Right — the diff itself, first-class and beautiful (00 §8). */}
              <div className="flex min-h-0 min-w-0 flex-col">
                {files.length > 1 ? (
                  <div className="flex shrink-0 gap-1 overflow-x-auto border-b px-3 py-2">
                    {files.map((file, index) => (
                      <button
                        key={file.path}
                        type="button"
                        onClick={() => setActiveIndex(index)}
                        className={cn(
                          'shrink-0 rounded-sm px-2 py-1 font-mono text-caption transition-colors duration-150',
                          index === activeIndex
                            ? 'bg-accent-soft text-primary'
                            : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
                        )}
                      >
                        {file.path}
                        <span className="ml-1.5 text-success">+{file.insertions}</span>{' '}
                        <span className="text-danger">−{file.deletions}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
                <div className="min-h-0 flex-1">
                  {activeFile ? (
                    <MonacoDiff
                      key={`${commit.sha}:${activeFile.path}`}
                      original={activeFile.original}
                      modified={activeFile.modified}
                      language={languageForPath(activeFile.path)}
                      theme="eduagent-dark"
                      beforeMount={defineEduAgentTheme}
                      height="100%"
                      options={{
                        readOnly: true,
                        renderSideBySide: false,
                        minimap: { enabled: false },
                        scrollBeyondLastLine: false,
                        lineNumbers: 'on',
                        folding: false,
                        renderOverviewRuler: false,
                        fontSize: 13,
                        fontFamily: MONACO_FONT_FAMILY,
                        padding: { top: 12, bottom: 12 },
                        hideUnchangedRegions: { enabled: false },
                        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
                        overviewRulerLanes: 0,
                        contextmenu: false,
                      }}
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center font-mono text-caption text-muted-foreground">
                      no file changes in this commit
                    </div>
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}

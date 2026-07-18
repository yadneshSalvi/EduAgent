'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  Database,
  Download,
  FileCode2,
  GitCommitHorizontal,
  GraduationCap,
  LayoutDashboard,
  Loader2,
  RotateCcw,
  Search,
  Settings,
  Timer,
  type LucideIcon,
} from 'lucide-react';
import { createThread, memoryExportUrl } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * ⌘K command palette + go-to chords (plans/04 §11): navigate, start learning
 * a topic, start review, take an exam, open memory. `g` then d/l/r/e/m jumps
 * between screens when focus is not in an editable. Mounted once in the shell
 * layout via CommandPaletteProvider; the sidebar's ⌘K button opens it too.
 */

interface Command {
  id: string;
  group: 'Go to' | 'Actions';
  label: string;
  icon: LucideIcon;
  /** Extra match terms so e.g. "sql" finds "Start learning SQL". */
  keywords?: string;
  /** Right-aligned hint, e.g. the go-to chord. */
  hint?: string;
  run: () => void | Promise<void>;
}

const CommandPaletteContext = createContext<{ open: () => void } | null>(null);

export function useCommandPalette() {
  return useContext(CommandPaletteContext);
}

/** True when a keypress belongs to an editable surface, not the shortcut layer. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  // Monaco's hidden textarea is how editor keypresses arrive.
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

const GOTO_CHORDS: Record<string, { href: string; label: string }> = {
  d: { href: '/app', label: 'Dashboard' },
  l: { href: '/app/learn', label: 'Learn' },
  r: { href: '/app/review', label: 'Review' },
  e: { href: '/app/exam', label: 'Exam' },
  m: { href: '/app/memory', label: 'Memory' },
};

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  // ⌘K everywhere (incl. inputs — standard palette behavior); g-chords only
  // outside editables so typing "gd" in chat never navigates.
  const chordAt = useRef<number>(0);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((current) => !current);
        return;
      }
      if (open || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === 'g') {
        chordAt.current = Date.now();
        return;
      }
      const chord = GOTO_CHORDS[key];
      if (chord && Date.now() - chordAt.current < 900) {
        event.preventDefault();
        chordAt.current = 0;
        router.push(chord.href);
        return;
      }
      chordAt.current = 0;
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, router]);

  const context = useMemo(() => ({ open: () => setOpen(true) }), []);

  return (
    <CommandPaletteContext.Provider value={context}>
      {children}
      <AnimatePresence>
        {open ? <PaletteDialog onClose={() => setOpen(false)} /> : null}
      </AnimatePresence>
    </CommandPaletteContext.Provider>
  );
}

function PaletteDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const reducedMotion = useReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Restore focus to the opener when the palette closes (05 §9).
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => openerRef.current?.focus();
  }, []);

  const navigate = useCallback(
    (href: string) => {
      onClose();
      if (pathname !== href) router.push(href);
    },
    [onClose, pathname, router],
  );

  const startLearning = useCallback(
    async (id: string, topicSlug: string) => {
      setBusyId(id);
      setError(null);
      try {
        const thread = await createThread({ mode: 'learn', topicSlug });
        onClose();
        router.push(`/app/learn/${thread.id}`);
      } catch (err) {
        setBusyId(null);
        setError(
          err instanceof Error ? err.message : "The tutor didn't answer — try again in a moment.",
        );
      }
    },
    [onClose, router],
  );

  const commands = useMemo<Command[]>(
    () => [
      {
        id: 'go-dashboard',
        group: 'Go to',
        label: 'Dashboard',
        icon: LayoutDashboard,
        keywords: 'home overview readiness',
        hint: 'g d',
        run: () => navigate('/app'),
      },
      {
        id: 'go-learn',
        group: 'Go to',
        label: 'Learn',
        icon: GraduationCap,
        keywords: 'tutor lesson topics',
        hint: 'g l',
        run: () => navigate('/app/learn'),
      },
      {
        id: 'go-review',
        group: 'Go to',
        label: 'Review',
        icon: RotateCcw,
        keywords: 'queue spaced repetition due',
        hint: 'g r',
        run: () => navigate('/app/review'),
      },
      {
        id: 'go-exam',
        group: 'Go to',
        label: 'Exam',
        icon: Timer,
        keywords: 'test assessment',
        hint: 'g e',
        run: () => navigate('/app/exam'),
      },
      {
        id: 'go-memory',
        group: 'Go to',
        label: 'Memory',
        icon: GitCommitHorizontal,
        keywords: 'explorer commits history diff',
        hint: 'g m',
        run: () => navigate('/app/memory'),
      },
      {
        id: 'go-settings',
        group: 'Go to',
        label: 'Settings',
        icon: Settings,
        keywords: 'profile account',
        run: () => navigate('/app/settings'),
      },
      {
        id: 'learn-sql',
        group: 'Actions',
        label: 'Start learning SQL',
        icon: Database,
        keywords: 'sql joins queries topic',
        run: () => startLearning('learn-sql', 'sql'),
      },
      {
        id: 'learn-python',
        group: 'Actions',
        label: 'Start learning Python',
        icon: FileCode2,
        keywords: 'python code topic',
        run: () => startLearning('learn-python', 'python'),
      },
      {
        id: 'start-review',
        group: 'Actions',
        label: 'Start review',
        icon: RotateCcw,
        keywords: 'session due queue',
        run: () => navigate('/app/review'),
      },
      {
        id: 'take-exam',
        group: 'Actions',
        label: 'Take an exam',
        icon: Timer,
        keywords: 'fork memory test',
        run: () => navigate('/app/exam'),
      },
      {
        id: 'export-memory',
        group: 'Actions',
        label: 'Export my memory',
        icon: Download,
        keywords: 'download git repository archive',
        run: () => {
          onClose();
          window.location.assign(memoryExportUrl());
        },
      },
    ],
    [navigate, onClose, startLearning],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return commands;
    return commands.filter((command) =>
      `${command.label} ${command.keywords ?? ''}`.toLowerCase().includes(needle),
    );
  }, [commands, query]);

  const active = filtered[Math.min(activeIndex, Math.max(0, filtered.length - 1))];

  const runCommand = (command: Command | undefined) => {
    if (!command || busyId !== null) return;
    void command.run();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (filtered.length === 0) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next =
        (Math.min(activeIndex, filtered.length - 1) + delta + filtered.length) % filtered.length;
      setActiveIndex(next);
      listRef.current
        ?.querySelector(`[data-index="${next}"]`)
        ?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      runCommand(active);
      return;
    }
    // The input is the palette's focus home; keep Tab from escaping the dialog.
    if (event.key === 'Tab') event.preventDefault();
  };

  let renderedGroup: string | null = null;

  return (
    <div className="fixed inset-0 z-50" role="presentation" onKeyDown={onKeyDown}>
      <motion.div
        className="absolute inset-0 bg-black/40"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.16 }}
        onClick={onClose}
        aria-hidden
      />
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="absolute inset-x-4 top-[18vh] mx-auto max-w-xl overflow-hidden rounded-lg border bg-surface shadow-(--shadow-overlay)"
        initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -10, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.99 }}
        transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
      >
        <div className="flex items-center gap-3 border-b px-4">
          {busyId !== null ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden />
          ) : (
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-activedescendant={active ? `command-${active.id}` : undefined}
            aria-label="Search commands"
            placeholder="Where to? Try “sql”, “review”, “memory”…"
            value={query}
            disabled={busyId !== null}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            className="h-12 w-full bg-transparent text-body outline-none placeholder:text-muted-foreground disabled:opacity-60"
          />
          <kbd className="rounded-sm border bg-surface-2 px-1.5 py-0.5 font-mono text-caption text-muted-foreground">
            esc
          </kbd>
        </div>

        <ul
          id="command-palette-list"
          ref={listRef}
          role="listbox"
          aria-label="Commands"
          className="max-h-[46vh] overflow-y-auto p-2"
        >
          {filtered.length === 0 ? (
            <li className="px-3 py-6 text-center text-body-sm text-muted-foreground">
              Nothing matches “{query}” — try a screen name or a topic.
            </li>
          ) : (
            filtered.map((command, index) => {
              const Icon = command.icon;
              const isActive = index === activeIndex;
              const groupHeader =
                command.group !== renderedGroup ? (
                  <li
                    role="presentation"
                    className="px-3 pb-1 pt-2 font-mono text-caption uppercase tracking-wide text-muted-foreground"
                  >
                    {command.group}
                  </li>
                ) : null;
              renderedGroup = command.group;
              return (
                <div key={command.id} role="presentation" className="contents">
                  {groupHeader}
                  <li
                    id={`command-${command.id}`}
                    role="option"
                    aria-selected={isActive}
                    data-index={index}
                  >
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={() => runCommand(command)}
                      onMouseMove={() => setActiveIndex(index)}
                      className={cn(
                        'flex h-11 w-full items-center gap-3 rounded-md px-3 text-left text-body-sm transition-colors duration-120',
                        isActive ? 'bg-accent-soft text-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {busyId === command.id ? (
                        <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden />
                      ) : (
                        <Icon
                          className={cn(
                            'size-4 shrink-0',
                            isActive ? 'text-primary' : 'text-muted-foreground',
                          )}
                          aria-hidden
                        />
                      )}
                      <span className="flex-1 truncate font-medium">{command.label}</span>
                      {command.hint ? (
                        <kbd className="rounded-sm border bg-surface-2 px-1.5 py-0.5 font-mono text-caption text-muted-foreground">
                          {command.hint}
                        </kbd>
                      ) : null}
                    </button>
                  </li>
                </div>
              );
            })
          )}
        </ul>

        {error ? (
          <p role="alert" className="border-t px-4 py-2.5 text-body-sm text-danger">
            {error}
          </p>
        ) : null}
      </motion.div>
    </div>
  );
}

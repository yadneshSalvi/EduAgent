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
import { AnimatePresence } from 'motion/react';
import { useQueryClient } from '@tanstack/react-query';
import type { MemoryCommit } from '@eduagent/shared';
import { parseWsFrame } from '@/hooks/use-turn-stream';
import { userSocketUrl } from '@/lib/api';
import { CommitToast } from './commit-toast';
import { DiffDrawer } from './diff-drawer';

/**
 * App-wide memory-commit surface (plans/04 §1, §3): owns the user-level
 * socket (`/ws/user`) so commits toast from anywhere in /app, plus the toast
 * queue and the Diff Drawer. Thread sockets forward their commits through
 * `publishCommit` — the sha set dedupes the two paths.
 */
interface MemoryCommitContextValue {
  /** Queue a commit toast (deduped by sha across user + thread sockets). */
  publishCommit: (commit: MemoryCommit) => void;
  /** Open the Diff Drawer directly (timeline "view diff", exam results…). */
  openDrawer: (commit: MemoryCommit) => void;
}

const MemoryCommitContext = createContext<MemoryCommitContextValue | null>(null);

export function useMemoryCommits(): MemoryCommitContextValue {
  const ctx = useContext(MemoryCommitContext);
  if (!ctx) throw new Error('useMemoryCommits must be used inside <MemoryCommitProvider>');
  return ctx;
}

const MAX_TOASTS = 3;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;

export function MemoryCommitProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<MemoryCommit[]>([]);
  const [drawerCommit, setDrawerCommit] = useState<MemoryCommit | null>(null);
  const seenShas = useRef(new Set<string>());
  const queryClient = useQueryClient();

  const publishCommit = useCallback(
    (commit: MemoryCommit) => {
      if (seenShas.current.has(commit.sha)) return;
      seenShas.current.add(commit.sha);
      setToasts((current) => [...current.slice(-(MAX_TOASTS - 1)), commit]);
      // Server state moved (plans/04 §2): memory.commit invalidates the
      // dashboard payload and every memory-explorer query.
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['memory'] });
      void queryClient.invalidateQueries({ queryKey: ['review', 'queue'] });
    },
    [queryClient],
  );

  const dismiss = useCallback((sha: string) => {
    setToasts((current) => current.filter((commit) => commit.sha !== sha));
  }, []);

  const openDrawer = useCallback(
    (commit: MemoryCommit) => {
      setDrawerCommit(commit);
      dismiss(commit.sha);
    },
    [dismiss],
  );

  // User-level socket: quiet capped-backoff reconnects; commits surface even
  // from the dashboard. 4401 (unauthenticated) stops the loop.
  useEffect(() => {
    let disposed = false;
    let attempt = 0;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      ws = new WebSocket(userSocketUrl());
      ws.onopen = () => {
        attempt = 0;
      };
      ws.onmessage = (messageEvent) => {
        if (disposed) return;
        const event = parseWsFrame(messageEvent.data);
        if (event?.type === 'memory.commit') publishCommit(event.commit);
      };
      ws.onclose = (closeEvent) => {
        if (disposed || closeEvent.code === 4401) return;
        attempt++;
        const backoff = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
        timer = setTimeout(connect, backoff * (0.75 + Math.random() * 0.5));
      };
    };
    connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [publishCommit]);

  const value = useMemo(() => ({ publishCommit, openDrawer }), [publishCommit, openDrawer]);

  return (
    <MemoryCommitContext.Provider value={value}>
      {children}

      {/* Toast viewport — bottom-right (plans/04 §1). aria-live on the
          container so newly appended toasts announce (m5); the ticking delta
          numbers inside are aria-hidden with static meter labels, so each
          commit announces once, not per animation frame. */}
      <div
        role="region"
        aria-label="Memory commits"
        aria-live="polite"
        className="pointer-events-none fixed bottom-5 right-5 z-50 flex flex-col items-end gap-3"
      >
        <AnimatePresence initial={false}>
          {toasts.map((commit) => (
            <CommitToast
              key={commit.sha}
              commit={commit}
              onOpen={() => openDrawer(commit)}
              onDismiss={() => dismiss(commit.sha)}
            />
          ))}
        </AnimatePresence>
      </div>

      <DiffDrawer commit={drawerCommit} onClose={() => setDrawerCommit(null)} />
    </MemoryCommitContext.Provider>
  );
}

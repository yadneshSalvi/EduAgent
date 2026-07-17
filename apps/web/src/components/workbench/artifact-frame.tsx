'use client';

import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ArtifactPayload } from '@eduagent/shared';
import { cn } from '@/lib/utils';

/**
 * Artifact tab (plans/04 §3): agent-authored self-contained HTML in a
 * sandboxed iframe — `allow-scripts` only, never same-origin (plans/01 §7).
 * Title bar + refresh (remounts the frame); shimmer until the doc loads;
 * overflowing content scrolls inside the frame.
 */
export function ArtifactFrame({ artifact }: { artifact: ArtifactPayload | null }) {
  if (!artifact) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="font-serif italic text-body text-muted-foreground">No artifact yet.</p>
        <p className="max-w-[36ch] text-body-sm text-muted-foreground">
          When a picture beats prose — a join diagram, a live demo — the tutor renders it here.
        </p>
      </div>
    );
  }
  return <ArtifactDocument key={artifact.id} artifact={artifact} />;
}

function ArtifactDocument({ artifact }: { artifact: ArtifactPayload }) {
  // Bumping generation remounts the iframe — a clean re-run of its scripts.
  const [generation, setGeneration] = useState(0);
  const [loaded, setLoaded] = useState(false);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
        <span className="min-w-0 flex-1 truncate font-mono text-caption text-muted-foreground">
          {artifact.title}
        </span>
        <button
          type="button"
          aria-label="Reload artifact"
          onClick={() => {
            setLoaded(false);
            setGeneration((n) => n + 1);
          }}
          className="rounded-sm p-1 text-muted-foreground transition-colors duration-150 hover:bg-surface-2 hover:text-foreground"
        >
          <RefreshCw className="size-3.5" aria-hidden />
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {!loaded ? (
          <div aria-hidden className="absolute inset-0 animate-pulse bg-surface-2/60" />
        ) : null}
        <iframe
          key={generation}
          title={artifact.title}
          sandbox="allow-scripts"
          srcDoc={artifact.html}
          onLoad={() => setLoaded(true)}
          className={cn(
            'h-full w-full border-0 bg-surface transition-opacity duration-200',
            loaded ? 'opacity-100' : 'opacity-0',
          )}
        />
      </div>
    </div>
  );
}

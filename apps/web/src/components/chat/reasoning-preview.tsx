'use client';

import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';

/**
 * Reasoning preview (plans/05 §6.3): one muted italic line while the agent
 * thinks; collapses (Micro class) when the first real token lands — the
 * reducer clears the text on message.delta, AnimatePresence does the exit.
 */
const NEAR_BOTTOM_PX = 32;

export function ReasoningPreview({ text }: { text: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const followsBottomRef = useRef(true);

  useEffect(() => {
    const container = containerRef.current;
    if (container && followsBottomRef.current) container.scrollTop = container.scrollHeight;
  }, [text]);

  return (
    <AnimatePresence initial={false}>
      {text !== '' ? (
        <motion.div
          ref={containerRef}
          key="reasoning"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          onScroll={() => {
            const container = containerRef.current;
            if (!container) return;
            followsBottomRef.current =
              container.scrollHeight - container.scrollTop - container.clientHeight <
              NEAR_BOTTOM_PX;
          }}
          className="max-h-48 overflow-y-auto"
        >
          <p className="whitespace-pre-wrap break-words font-serif italic text-body-sm text-muted-foreground">
            {text}
          </p>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

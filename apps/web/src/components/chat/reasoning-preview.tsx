'use client';

import { AnimatePresence, motion } from 'motion/react';

/**
 * Reasoning preview (plans/05 §6.3): one muted italic line while the agent
 * thinks; collapses (Micro class) when the first real token lands — the
 * reducer clears the text on message.delta, AnimatePresence does the exit.
 */
const MAX_VISIBLE = 140;

export function ReasoningPreview({ text }: { text: string }) {
  const shown = text.length > MAX_VISIBLE ? `…${text.slice(-MAX_VISIBLE)}` : text;
  return (
    <AnimatePresence initial={false}>
      {text !== '' ? (
        <motion.p
          key="reasoning"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          className="truncate font-serif italic text-body-sm text-muted-foreground"
        >
          {shown}
        </motion.p>
      ) : null}
    </AnimatePresence>
  );
}

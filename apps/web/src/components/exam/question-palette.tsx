'use client';

import type { PaletteItem } from '@/lib/exam';
import { cn } from '@/lib/utils';

/**
 * The question palette (plans/04 §6): one dot per question — answered fills
 * accent, flagged carries a warn corner dot — living in the sticky exam
 * header. Clicking jumps to the question.
 */
export function QuestionPalette({
  items,
  onJump,
}: {
  items: PaletteItem[];
  onJump: (questionId: string) => void;
}) {
  return (
    <nav aria-label="Question palette" className="flex flex-wrap items-center gap-1.5">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onJump(item.id)}
          title={`Question ${item.number}${item.answered ? ' · answered' : ' · unanswered'}${item.flagged ? ' · flagged' : ''}`}
          aria-label={`Go to question ${item.number}${item.answered ? ', answered' : ', unanswered'}${item.flagged ? ', flagged' : ''}`}
          className={cn(
            'relative flex size-7 items-center justify-center rounded-sm border font-mono text-caption transition-colors duration-150',
            item.answered
              ? 'border-primary/50 bg-accent-soft text-primary'
              : 'text-muted-foreground hover:border-primary/50 hover:text-foreground',
          )}
        >
          <span className="numeric">{item.number}</span>
          {item.flagged ? (
            <span
              aria-hidden
              className="absolute -right-0.5 -top-0.5 size-2 rounded-full border border-surface bg-warn"
            />
          ) : null}
        </button>
      ))}
    </nav>
  );
}

'use client';

import { Markdown } from './markdown';

/**
 * The in-flight agent message: memoized markdown blocks + the streaming caret
 * (the only looping animation besides the fading pulse, plans/05 §5). The
 * caret is drawn by CSS on the last paragraph — see .streaming-md in
 * globals.css.
 */
export function StreamingMessage({ text }: { text: string }) {
  return (
    <div className="streaming-md">
      <Markdown content={text} />
    </div>
  );
}

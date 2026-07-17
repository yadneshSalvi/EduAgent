/**
 * Splits markdown into standalone blocks (fence-aware) so streaming messages
 * re-render only the LAST block per token — earlier blocks stay memoized and
 * shiki never re-highlights finished code (plans/04 §3, §12).
 */
export function splitMarkdownBlocks(markdown: string): string[] {
  const lines = markdown.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    if (current.length === 0) return;
    const text = current.join('\n');
    if (text.trim() !== '') blocks.push(text);
    current = [];
  };

  for (const line of lines) {
    const fenceMarker = /^\s*(```+|~~~+)/.exec(line)?.[1];
    if (fence === null && fenceMarker) {
      flush();
      fence = fenceMarker.slice(0, 3);
      current.push(line);
      continue;
    }
    if (fence !== null) {
      current.push(line);
      if (fenceMarker?.startsWith(fence)) {
        fence = null;
        flush();
      }
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

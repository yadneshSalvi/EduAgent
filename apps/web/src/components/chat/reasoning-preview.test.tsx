import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageBubble } from './message-bubble';
import { ReasoningPreview } from './reasoning-preview';

describe('reasoning rendering', () => {
  const fullText = `Opening thought ${'with enough detail '.repeat(12)}\n\nClosing thought.`;

  it('shows the full streamed text with wrapping and no truncate class', () => {
    const html = renderToStaticMarkup(<ReasoningPreview text={fullText} />);
    expect(html).toContain('Opening thought');
    expect(html).toContain('Closing thought.');
    expect(html).toContain('whitespace-pre-wrap');
    expect(html).toContain('break-words');
    expect(html).not.toMatch(/class="[^"]*\btruncate\b/);
  });

  it('renders historical reasoning collapsed with the complete text available', () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        message={{ id: 'reasoning-1', role: 'agent', kind: 'reasoning', text: fullText }}
      />,
    );
    expect(html).toContain('· thinking');
    expect(html).toContain('Closing thought.');
    expect(html).toContain('<details');
    expect(html).not.toContain('<details open');
  });
});

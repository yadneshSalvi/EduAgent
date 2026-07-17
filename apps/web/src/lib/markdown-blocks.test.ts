import { describe, expect, it } from 'vitest';
import { splitMarkdownBlocks } from './markdown-blocks';

describe('splitMarkdownBlocks', () => {
  it('splits paragraphs on blank lines', () => {
    expect(splitMarkdownBlocks('one\n\ntwo\n\n\nthree')).toEqual(['one', 'two', 'three']);
  });

  it('keeps fenced code (with blank lines inside) as a single block', () => {
    const md = 'intro\n\n```sql\nSELECT 1;\n\nSELECT 2;\n```\n\noutro';
    expect(splitMarkdownBlocks(md)).toEqual(['intro', '```sql\nSELECT 1;\n\nSELECT 2;\n```', 'outro']);
  });

  it('keeps an unterminated fence open (streaming mid-code-block)', () => {
    const md = 'text\n\n```python\ndef f():\n    return';
    expect(splitMarkdownBlocks(md)).toEqual(['text', '```python\ndef f():\n    return']);
  });

  it('keeps multi-line list/paragraph runs together', () => {
    const md = '- a\n- b\n- c\n\nnext';
    expect(splitMarkdownBlocks(md)).toEqual(['- a\n- b\n- c', 'next']);
  });

  it('drops whitespace-only blocks and handles empty input', () => {
    expect(splitMarkdownBlocks('')).toEqual([]);
    expect(splitMarkdownBlocks('\n\n  \n')).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { cn } from './utils';

describe('cn', () => {
  it('merges conditional classes', () => {
    expect(cn('a', { b: false }, 'c')).toBe('a c');
  });

  it('resolves conflicting tailwind utilities (last wins)', () => {
    expect(cn('px-2 py-1', 'px-4')).toBe('py-1 px-4');
  });

  it('keeps custom type-scale sizes separate from text colors', () => {
    // Without the extended font-size group these collide and one gets dropped.
    expect(cn('text-body-sm', 'text-primary-foreground')).toBe(
      'text-body-sm text-primary-foreground',
    );
    expect(cn('text-caption text-muted-foreground')).toBe('text-caption text-muted-foreground');
  });

  it('resolves conflicts within the custom type scale (last wins)', () => {
    expect(cn('text-body-sm', 'text-body')).toBe('text-body');
    expect(cn('text-h3', 'text-h2')).toBe('text-h2');
  });
});

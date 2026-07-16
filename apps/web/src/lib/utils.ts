import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge must be taught our custom type scale (globals.css @theme):
 * by default it can't tell `text-body` (font-size) from `text-primary-foreground`
 * (color), lumps them into one conflict group, and silently drops one.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        { text: ['caption', 'body-sm', 'body', 'lead', 'h4', 'h3', 'h2', 'h1', 'display'] },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each workspace that has tests ships its own vitest.config.ts; globs that
    // match nothing are fine, so placeholder workspaces are skipped.
    projects: ['apps/*/vitest.config.ts', 'packages/*/vitest.config.ts'],
  },
});

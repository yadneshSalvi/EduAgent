import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'server',
    // Generates the Prisma client and builds a migrated template SQLite db
    // that each test file copies into its own throwaway file (test/helpers).
    globalSetup: './test/global-setup.ts',
    testTimeout: 15_000,
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'mcp-ui-tools',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});

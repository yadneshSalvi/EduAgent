import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      'data/**',
      'plans/**',
      'docs/**',
      // Vendored monaco AMD bundle (apps/web/scripts/vendor-monaco.mjs).
      'apps/web/public/monaco/**',
      // Phase 0 spike harness + captured fixtures are owned by the protocol
      // spike task and intentionally not held to lint rules.
      'scripts/spike-appserver.mjs',
      'scripts/fixtures/**',
      // Emitted verbatim by `codex app-server generate-ts` — never hand-edited.
      'packages/shared/src/protocol/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  prettier,
);

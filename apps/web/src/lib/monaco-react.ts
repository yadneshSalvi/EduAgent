'use client';

import { loader } from '@monaco-editor/react';

/**
 * Single import point for Monaco components: configures the loader to our
 * vendored copy (public/monaco/vs, synced by scripts/vendor-monaco.mjs)
 * before any editor can mount, replacing the library-default jsdelivr CDN
 * load — editors and diff views need zero external network (plans/06 5b).
 * Always reach Monaco through this module, never '@monaco-editor/react'.
 */
loader.config({ paths: { vs: '/monaco/vs' } });

export { DiffEditor, Editor as MonacoEditor } from '@monaco-editor/react';

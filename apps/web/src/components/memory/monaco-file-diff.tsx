'use client';

import { useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { MONACO_FONT_FAMILY, defineEduAgentTheme } from '@/lib/monaco-theme';

/**
 * One file rendered in the Monaco DiffEditor, inline mode, our theme —
 * shared by the Diff Drawer and the memory explorer's time machine.
 */
const MonacoDiff = dynamic(() => import('@monaco-editor/react').then((m) => m.DiffEditor), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center font-mono text-caption text-muted-foreground">
      loading diff…
    </div>
  ),
});

/** What our unmount cleanup needs from the diff editor (QA finding F6). */
interface DisposableDiffEditor {
  getModel(): { original: { dispose(): void }; modified: { dispose(): void } } | null;
  setModel(model: null): void;
}

/**
 * @monaco-editor/react's own cleanup disposes the text models while they are
 * still attached to the widget, logging "TextModel got disposed before
 * DiffEditorWidget model got reset" on every close/file switch. keepCurrent*
 * stops the library from touching the models; our cleanup runs first (parents
 * unwind before children on unmount), detaches them, THEN disposes — so
 * nothing leaks and the widget never sees a dead model.
 */
export function MonacoFileDiff({
  original,
  modified,
  language,
}: {
  original: string;
  modified: string;
  language: string;
}) {
  const editorRef = useRef<DisposableDiffEditor | null>(null);
  useEffect(
    () => () => {
      const editor = editorRef.current;
      editorRef.current = null;
      if (!editor) return;
      try {
        const model = editor.getModel();
        editor.setModel(null);
        model?.original.dispose();
        model?.modified.dispose();
      } catch {
        // already disposed by the library — nothing left to release
      }
    },
    [],
  );
  return (
    <MonacoDiff
      original={original}
      modified={modified}
      language={language}
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      onMount={(editor) => {
        editorRef.current = editor;
      }}
      theme="eduagent-dark"
      beforeMount={defineEduAgentTheme}
      height="100%"
      options={{
        readOnly: true,
        renderSideBySide: false,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        lineNumbers: 'on',
        folding: false,
        renderOverviewRuler: false,
        fontSize: 13,
        fontFamily: MONACO_FONT_FAMILY,
        padding: { top: 12, bottom: 12 },
        hideUnchangedRegions: { enabled: false },
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        overviewRulerLanes: 0,
        contextmenu: false,
      }}
    />
  );
}

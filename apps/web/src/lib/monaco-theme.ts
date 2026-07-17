/**
 * Monaco theme on the 05 §2 dark tokens (hex — Monaco can't read CSS vars).
 * Shared by the Diff Drawer's DiffEditor and the workbench exercise editor;
 * defineTheme is idempotent so every mount can call it.
 */
export function defineEduAgentTheme(monaco: typeof import('monaco-editor')) {
  monaco.editor.defineTheme('eduagent-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#12151D',
      'editorGutter.background': '#12151D',
      'editor.lineHighlightBackground': '#1A1E2880',
      'editorLineNumber.foreground': '#8B93A766',
      'editorLineNumber.activeForeground': '#8B93A7',
      'diffEditor.insertedTextBackground': '#2EA04326',
      'diffEditor.removedTextBackground': '#F851491F',
      'diffEditor.insertedLineBackground': '#2EA04318',
      'diffEditor.removedLineBackground': '#F8514912',
      'scrollbarSlider.background': '#252A3780',
      'scrollbarSlider.hoverBackground': '#252A37',
    },
  });
}

export const MONACO_FONT_FAMILY =
  "var(--font-jetbrains-mono), 'JetBrains Mono', ui-monospace, Menlo, monospace";

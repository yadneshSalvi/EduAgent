import type { Highlighter } from 'shiki';

/**
 * Lazy shiki singleton (dynamic import — the wasm engine + grammars only load
 * once a code block actually renders, plans/04 §12). Highlighted HTML per
 * (code, lang) is rendered by memoized CodeBlock components so streaming never
 * re-highlights finished blocks.
 */
const THEME = 'github-dark-default';
const LANGS = [
  'sql',
  'python',
  'javascript',
  'typescript',
  'json',
  'yaml',
  'markdown',
  'bash',
  'diff',
  'html',
  'css',
];

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= import('shiki').then(({ createHighlighter }) =>
    createHighlighter({ themes: [THEME], langs: LANGS }),
  );
  return highlighterPromise;
}

export async function highlightCode(code: string, lang?: string): Promise<string> {
  const highlighter = await getHighlighter();
  const loaded = highlighter.getLoadedLanguages();
  const language = lang && loaded.includes(lang) ? lang : 'text';
  return highlighter.codeToHtml(code, { lang: language, theme: THEME });
}

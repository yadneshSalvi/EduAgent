'use client';

import { Children, isValidElement, memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { splitMarkdownBlocks } from '@/lib/markdown-blocks';
import { highlightCode } from '@/lib/shiki';
import { cn } from '@/lib/utils';

/**
 * Streaming-safe markdown (plans/04 §3): content is split into fence-aware
 * blocks and each block is memoized, so a token appended to the last paragraph
 * never re-renders (or re-highlights) earlier blocks.
 */

const CodeBlock = memo(function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    highlightCode(code, lang)
      .then((result) => {
        if (active) setHtml(result);
      })
      .catch(() => {
        // keep the plain <pre> fallback
      });
    return () => {
      active = false;
    };
  }, [code, lang]);

  if (html) {
    // Shiki output is trusted generated markup (escaped source, span tokens).
    return <div className="chat-codeblock" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return (
    <div className="chat-codeblock">
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
});

function extractCode(children: ReactNode): { code: string; lang?: string } {
  const child = Children.toArray(children).find(isValidElement) as
    | React.ReactElement<{ className?: string; children?: ReactNode }>
    | undefined;
  const className = child?.props.className ?? '';
  const lang = /language-([\w-]+)/.exec(className)?.[1];
  const code = String(child?.props.children ?? '').replace(/\n$/, '');
  return { code, lang };
}

const components: Components = {
  pre({ children }) {
    const { code, lang } = extractCode(children);
    return <CodeBlock code={code} lang={lang} />;
  },
  a({ children, href }) {
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  },
};

const MarkdownBlock = memo(function MarkdownBlock({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {content}
    </ReactMarkdown>
  );
});

export const Markdown = memo(function Markdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  const blocks = useMemo(() => splitMarkdownBlocks(content), [content]);
  return (
    <div className={cn('chat-prose', className)}>
      {blocks.map((block, index) => (
        <MarkdownBlock key={index} content={block} />
      ))}
    </div>
  );
});

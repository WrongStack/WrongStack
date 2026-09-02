/**
 * Markdown for the Console — the same stack the main WebUI chat uses
 * (react-markdown + GFM + highlight.js), with a custom fenced-code frame:
 * language badge, line count and a copy button. Inline code stays inline.
 *
 * Prose styling lives in `.markdown-body` in `index.css`, because these
 * elements are emitted by the renderer and cannot carry utility classes.
 */
import type * as React from 'react';
import { isValidElement, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { CopyButton } from './primitives.js';

/** Flatten a React children tree to plain text, for the copy button. */
function childrenToText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(childrenToText).join('');
  if (isValidElement(node)) {
    return childrenToText((node.props as { children?: React.ReactNode }).children);
  }
  return '';
}

const components = {
  a: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="w-full overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
  pre: ({ children }: { children?: React.ReactNode }) => {
    // The inner <code> carries `language-xxx`; unwrap it so we own the frame.
    const code = Array.isArray(children) ? children[0] : children;
    const props = isValidElement(code)
      ? (code.props as { className?: string; children?: React.ReactNode })
      : undefined;
    const language = /language-(\w+)/.exec(props?.className ?? '')?.[1];
    const text = childrenToText(props?.children).replace(/\n$/, '');
    const lines = text === '' ? 0 : text.split('\n').length;
    return (
      <div className="my-2 border border-border bg-muted/40" data-testid="markdown-code">
        <div className="flex items-center gap-2 border-b border-border px-2 py-1">
          <span
            data-testid="markdown-code-lang"
            className="text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground"
          >
            {language ?? 'text'}
          </span>
          <span className="tabular text-[10px] text-muted-foreground">
            {lines} line{lines === 1 ? '' : 's'}
          </span>
          <CopyButton value={text} className="ml-auto" />
        </div>
        <pre>{children}</pre>
      </div>
    );
  },
};

export const Markdown = memo(function Markdown({ text }: { text: string }): React.ReactElement {
  return (
    <div className="markdown-body" data-testid="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

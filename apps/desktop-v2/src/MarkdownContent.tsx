import { Image as ImageIcon } from 'lucide-react';
import { Children, isValidElement, memo, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { CopyButton } from './CopyButton';
import { useDesktopText } from './desktop-i18n';
import { markdownTarget } from './markdown-target';
import './syntax-highlight.css';

// Code with a named language is highlighted, as in the WebUI; unnamed code stays plain.
const REHYPE_PLUGINS = [rehypeHighlight];

function textContent(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) =>
      typeof child === 'string' || typeof child === 'number'
        ? String(child)
        : isValidElement<{ children?: ReactNode }>(child)
          ? textContent(child.props.children)
          : '',
    )
    .join('');
}
function CodeBlock({ children }: { children?: ReactNode }) {
  const { t } = useDesktopText();
  const child = Children.toArray(children)[0];
  const language = isValidElement<{ className?: string }>(child)
    ? child.props.className?.match(/language-([\w+-]+)/)?.[1]
    : undefined;
  return (
    <div className="markdown-code-block">
      <div className="code-block-toolbar">
        <span>{language ?? t('copy.codeLanguage')}</span>
        <CopyButton text={textContent(children)} label={t('copy.code')} />
      </div>
      <pre>{children}</pre>
    </div>
  );
}
const elements = [
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'em',
  'del',
  'blockquote',
  'pre',
  'code',
  'ol',
  'ul',
  'li',
  'a',
  'hr',
  'br',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'input',
  'img',
  // Only the highlighter makes spans: raw HTML in a message is skipped before this list applies.
  'span',
];
export const MarkdownContent = memo(function MarkdownContent({
  text,
  onLink,
}: {
  text: string;
  onLink?: (url: string) => void;
}) {
  return (
    <div className="markdown-content">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={REHYPE_PLUGINS}
        skipHtml
        allowedElements={elements}
        urlTransform={(url) => (markdownTarget(url) ? url : '')}
        components={{
          pre: CodeBlock,
          a: ({ href, children }) =>
            href && markdownTarget(href) ? (
              <a
                href={href}
                onClick={(event) => {
                  event.preventDefault();
                  onLink?.(href);
                }}
                title={href}
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: ({ src, alt }) => (
            <span className="markdown-image">
              <ImageIcon size={14} />
              {alt || 'Image'}
              {typeof src === 'string' && markdownTarget(src) && (
                <button type="button" className="text-link" onClick={() => onLink?.(src)}>
                  Open image
                </button>
              )}
            </span>
          ),
          table: ({ children }) => (
            <div className="markdown-table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
});

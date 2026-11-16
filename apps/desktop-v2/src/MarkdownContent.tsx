import { Image as ImageIcon } from 'lucide-react';
import {
  Children,
  isValidElement,
  memo,
  type ReactNode,
  useCallback,
  useMemo,
  useRef,
} from 'react';
import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { CopyButton } from './CopyButton';
import { useDesktopText } from './desktop-i18n';
import { markdownTarget } from './markdown-target';
import './syntax-highlight.css';

// Code with a named language is highlighted, as in the WebUI; unnamed code stays plain.
const REHYPE_PLUGINS = [rehypeHighlight];
const REMARK_PLUGINS = [remarkGfm];

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
/**
 * Splits a streaming message into completed blocks and the block still being written, as the
 * WebUI does with its stable prefix. A block ends at a blank line outside an open code fence,
 * so completed blocks never change and each keeps its own cached parse across stream frames.
 */
export function splitStreamBlocks(text: string): [blocks: string[], tail: string] {
  const blocks: string[] = [];
  let start = 0;
  let fenceOpen = false;
  let offset = 0;
  for (const line of text.split('\n')) {
    const end = offset + line.length + 1;
    if (/^\s*(```|~~~)/.test(line)) fenceOpen = !fenceOpen;
    else if (!fenceOpen && line.trim() === '' && end <= text.length) {
      if (offset > start) blocks.push(text.slice(start, end));
      start = end;
    }
    offset = end;
  }
  return [blocks, text.slice(start)];
}

type LinkHandler = ((url: string) => void) | undefined;

/** One parse of `text`; re-parses only when the text changes, never for a new link handler. */
const ParsedMarkdown = memo(function ParsedMarkdown({
  text,
  link,
}: {
  text: string;
  link: (url: string) => void;
}) {
  const { t } = useDesktopText();
  const components = useMemo(
    () => ({
      pre: CodeBlock,
      a: ({ href, children }: { href?: string | undefined; children?: ReactNode }) =>
        href && markdownTarget(href) ? (
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault();
              link(href);
            }}
            title={href}
          >
            {children}
          </a>
        ) : (
          <span>{children}</span>
        ),
      img: ({ src, alt }: { src?: unknown; alt?: string | undefined }) => (
        <span className="markdown-image">
          <ImageIcon size={14} />
          {alt || t('shellText.image')}
          {typeof src === 'string' && markdownTarget(src) && (
            <button type="button" className="text-link" onClick={() => link(src)}>
              {t('shellText.openImage')}
            </button>
          )}
        </span>
      ),
      table: ({ children }: { children?: ReactNode }) => (
        <div className="markdown-table">
          <table>{children}</table>
        </div>
      ),
    }),
    [link, t],
  );
  return (
    <Markdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      skipHtml
      allowedElements={elements}
      urlTransform={urlTransform}
      components={components}
    >
      {text}
    </Markdown>
  );
});
function urlTransform(url: string) {
  return markdownTarget(url) ? url : '';
}

/**
 * Markdown with links routed to `onLink`. The handler is read when a link is clicked, so a
 * parent that passes a new function on every render (every keystroke, every stream frame)
 * no longer re-parses and re-highlights the whole message. While `streaming`, only the
 * completed paragraphs go through the parser; the paragraph still being written is plain text.
 */
export const MarkdownContent = memo(function MarkdownContent({
  text,
  onLink,
  streaming = false,
}: {
  text: string;
  onLink?: LinkHandler;
  streaming?: boolean | undefined;
}) {
  const current = useRef<LinkHandler>(onLink);
  current.current = onLink;
  const link = useCallback((url: string) => current.current?.(url), []);
  const [blocks, tail] = useMemo(
    () => (streaming ? splitStreamBlocks(text) : [[text], '']),
    [streaming, text],
  );
  return (
    <div className="markdown-content">
      {blocks.map((block, index) => (
        // A completed block never changes while the answer streams; its index is its identity.
        <ParsedMarkdown key={index} text={block} link={link} />
      ))}
      {tail && <p className="markdown-stream-tail">{tail}</p>}
    </div>
  );
});

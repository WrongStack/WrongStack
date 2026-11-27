import { Image as ImageIcon } from 'lucide-react';
import {
  Children,
  isValidElement,
  memo,
  type ReactNode,
  useCallback,
  useLayoutEffect,
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
type StreamBlocks = {
  readonly text: string;
  readonly blocks: readonly string[];
  readonly tail: string;
  readonly lineStart: number;
  readonly fenceOpen: boolean;
};

const emptyStream: StreamBlocks = {
  text: '',
  blocks: [],
  tail: '',
  lineStart: 0,
  fenceOpen: false,
};

/** Complete blocks retain their identity while the provider appends to the current block. */
export function scanStreamBlocks(text: string, previous = emptyStream): StreamBlocks {
  if (previous.text === text) return previous;
  const base = text.startsWith(previous.text) ? previous : emptyStream;
  let blocks: string[] | undefined;
  let start = base.text.length - base.tail.length;
  let lineStart = base.lineStart;
  let fenceOpen = base.fenceOpen;
  // Begin the newline search after the old input, even when its last line is incomplete.
  let newline = text.indexOf('\n', base.text.length);
  while (newline !== -1) {
    const line = text.slice(lineStart, newline);
    const end = newline + 1;
    if (/^\s*(```|~~~)/.test(line)) fenceOpen = !fenceOpen;
    else if (!fenceOpen && line.trim() === '') {
      if (lineStart > start) {
        blocks ??= [...base.blocks];
        blocks.push(text.slice(start, end));
      }
      start = end;
    }
    lineStart = end;
    newline = text.indexOf('\n', end);
  }
  return { text, blocks: blocks ?? base.blocks, tail: text.slice(start), lineStart, fenceOpen };
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
  const committed = useRef<StreamBlocks | undefined>(undefined);
  const scanned = useMemo(
    () => (streaming ? scanStreamBlocks(text, committed.current) : undefined),
    [streaming, text],
  );
  useLayoutEffect(() => {
    committed.current = scanned;
  }, [scanned]);
  const blocks = scanned?.blocks;
  const completed = useMemo(
    () => blocks?.map((block, index) => <ParsedMarkdown key={index} text={block} link={link} />),
    [blocks, link],
  );
  return (
    <div className="markdown-content">
      {streaming ? completed : <ParsedMarkdown key={0} text={text} link={link} />}
      {scanned?.tail && <p className="markdown-stream-tail">{scanned.tail}</p>}
    </div>
  );
});

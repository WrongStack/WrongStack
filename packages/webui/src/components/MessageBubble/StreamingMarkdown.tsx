import { memo, useMemo } from 'react';
import { LazyMarkdown as ReactMarkdown } from './LazyMarkdown.js';
import remarkGfm from 'remark-gfm';
import { markdownComponents, rehypePlugins } from './utils.js';

/**
 * Split a streaming message into a STABLE prefix and a volatile tail.
 *
 * The prefix ends at the last blank line that is not inside an open code
 * fence — it only advances when a paragraph completes, so a memoized
 * markdown render of it stays cached across stream frames. Splitting inside
 * an unclosed fence would make the prefix render a broken half code-block,
 * hence the fence-parity tracking.
 *
 * Exported for tests.
 */
export function splitStableStreamPrefix(text: string): [prefix: string, tail: string] {
  let lastSafe = -1;
  let fenceOpen = false;
  let offset = 0;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenceOpen = !fenceOpen;
    else if (!fenceOpen && offset > 0 && line.trim() === '') lastSafe = offset + line.length + 1;
    offset += line.length + 1;
  }
  if (lastSafe <= 0 || lastSafe >= text.length) return ['', text];
  return [text.slice(0, lastSafe), text.slice(lastSafe)];
}

/** Memoized full-pipeline markdown — re-parses only when `text` changes. */
const StableMarkdownPrefix = memo(function StableMarkdownPrefix({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={rehypePlugins}
      components={markdownComponents}
    >
      {text}
    </ReactMarkdown>
  );
});

/**
 * Markdown renderer for messages that are still streaming. Feeding the whole
 * growing string through remark on every coalesced frame makes long replies
 * progressively jankier (the full AST is rebuilt each time). Instead the
 * stable prefix goes through the real pipeline behind a memo (re-parsed only
 * when a paragraph completes) and the tail renders as plain text. The final
 * non-streaming render (in MessageBubble) parses the complete message once.
 */
export function StreamingMarkdown({ text }: { text: string }) {
  const [prefix, tail] = useMemo(() => splitStableStreamPrefix(text), [text]);
  return (
    <>
      {prefix ? <StableMarkdownPrefix text={prefix} /> : null}
      {tail ? <span className="whitespace-pre-wrap break-words">{tail}</span> : null}
    </>
  );
}

import { Check, Copy, FileCode2 } from 'lucide-react';
import type React from 'react';
import { isValidElement, useCallback, useMemo, useState } from 'react';
import rehypeHighlight from 'rehype-highlight';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';

export { copyToClipboard };

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function downloadTextFile(filename: string, text: string): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function fileExtensionFor(toolName: string | undefined): string {
  const t = (toolName ?? '').toLowerCase();
  if (/bash|shell|exec|run/.test(t)) return 'log';
  if (/grep|search|find/.test(t)) return 'txt';
  return 'txt';
}

export function formatToolDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

/**
 * Pull a trailing exit code out of a tool result for the ledger header chip.
 * Matches the same shapes the ToolResult shell parses ("exit code: N",
 * "[exit 1]", "exit=0"). Returns undefined when none is present so the chip
 * is only shown when it carries real information — a bash command that
 * succeeded quietly gets a green status dot, not a redundant "exit 0".
 */
export function extractExitCode(result: string | undefined): number | undefined {
  if (!result) return undefined;
  const m = result.match(/(?:^|\n)\s*(?:\[?exit(?:\s*code)?\]?\s*[:=]?\s*)(\d+)\s*$/i);
  return m ? Number(m[1]) : undefined;
}

/** Rehype plugins for react-markdown — syntax highlighting via highlight.js. */
export const rehypePlugins = [rehypeHighlight];

/**
 * Recover the source text from a react-markdown code node. Syntax-highlighting
 * rehype plugins replace parts of `children` with nested React elements, so
 * String(children) would leak values such as "[object Object]" to the clipboard.
 */
function codeNodeText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(codeNodeText).join('');
  if (isValidElement<{ children?: React.ReactNode }>(node)) {
    return codeNodeText(node.props.children);
  }
  return '';
}

/** A copy button that shows a checkmark for 1.5s after successful copy.
 *  Used inside code block headers for better UX feedback. */
function CodeCopyButton({ text }: { text: string }) {
  const { t } = useAppTranslation();
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [text]);
  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors',
        'hover:bg-muted-foreground/10',
        copied ? 'text-success' : 'text-muted-foreground hover:text-foreground',
      )}
      title={copied ? t('common:action.copied') : t('common:action.copy')}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      <span>{copied ? t('common:action.copied') : t('common:action.copy')}</span>
    </button>
  );
}

export const markdownComponents = {
  // NOTE: <nextsteps> is parsed and rendered in MessageBubble/index.tsx
  // (post-render, via parseNextSteps + NextStepsBar). We do NOT register a
  // custom component here for two reasons:
  //   1. react-markdown v10's micromark parser doesn't actually dispatch
  //      <nextsteps> (or any underscored tag) to the components map — they
  //      fall through as raw HTML, which is exactly what the previous code
  //      was trying (and failing) to catch.
  //   2. The MessageBubble path strips the block before passing content to
  //      react-markdown, so this handler is unreachable in practice.
  // Leaving the comment here so future contributors know this was a
  // deliberate decision, not an oversight.

  code({
    inline,
    className,
    children,
    ...props
  }: {
    inline?: boolean | undefined;
    className?: string | undefined;
    children?: React.ReactNode | undefined;
  }) {
    const match = /language-(\w+)/.exec(className ?? '');
    const codeText = codeNodeText(children).replace(/\n$/, '');
    if (inline || !match) {
      return (
        <code
          className={cn(
            'rounded border border-border/60 px-1.5 py-0.5 text-[0.85em] font-mono',
            className,
          )}
          {...props}
        >
          {children}
        </code>
      );
    }
    const lines = useMemo(() => codeText.split('\n'), [codeText]);
    const hasLineNumbers = lines.length > 1;
    return (
      <div className="not-prose relative my-3 rounded-lg border border-border overflow-hidden group/codeblock">
        {/* Header: language badge + copy button */}
        <div className="flex items-center justify-between px-3 py-1 border-b border-border text-xs">
          <div className="flex items-center gap-2">
            <FileCode2 className="h-3 w-3 text-muted-foreground" />
            <span className="font-mono text-muted-foreground font-medium">{match[1]}</span>
            {lines.length > 0 && (
              <span className="text-[10px] text-muted-foreground/75 tabular-nums">
                {lines.length} line{lines.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
          <CodeCopyButton text={codeText} />
        </div>
        {/* Code body — with/without line numbers */}
        {hasLineNumbers ? (
          <div className="flex max-h-[40rem] overflow-auto">
            {/* Line number gutter */}
            <pre
              aria-hidden
              className="text-xs font-mono leading-[1.55] py-3 pl-3 pr-2 text-muted-foreground/65 select-none border-r border-border/30 tabular-nums text-right shrink-0"
            >
              {lines.map((_, i) => (
                <div key={i}>{i + 1}</div>
              ))}
            </pre>
            {/* Highlighted code */}
            <pre className="overflow-x-auto py-3 px-3 text-xs leading-[1.55] font-mono flex-1">
              <code className={cn('hljs', className)} {...props}>
                {children}
              </code>
            </pre>
          </div>
        ) : (
          <pre className="overflow-x-auto p-3 text-xs leading-relaxed font-mono max-h-[40rem]">
            <code className={cn('hljs', className)} {...props}>
              {children}
            </code>
          </pre>
        )}
        {/* Fade-out gradient at bottom when scrollable — only visible on hover.
            Uses foreground-based opacity for correct appearance in both modes. */}
        <div
          className="pointer-events-none absolute bottom-8 left-0 right-0 h-8 opacity-0 group-hover/codeblock:opacity-100 transition-opacity"
          style={{
            background:
              'linear-gradient(to top, hsl(var(--foreground) / 0.08), transparent)',
          }}
        />
      </div>
    );
  },

  table({ className, children, ...props }: React.ComponentPropsWithoutRef<'table'>) {
    return (
      <div className="not-prose my-3 w-full max-w-full overflow-x-auto rounded-lg border border-border/80 bg-card/40 shadow-sm scrollbar-thin">
        <table
          className={cn(
            'w-full min-w-full table-auto border-collapse text-left text-xs',
            className,
          )}
          {...props}
        >
          {children}
        </table>
      </div>
    );
  },

  thead({ className, children, ...props }: React.ComponentPropsWithoutRef<'thead'>) {
    return (
      <thead
        className={cn('border-b border-border/80 bg-muted/60 text-foreground font-semibold', className)}
        {...props}
      >
        {children}
      </thead>
    );
  },

  tbody({ className, children, ...props }: React.ComponentPropsWithoutRef<'tbody'>) {
    return (
      <tbody
        className={cn('divide-y divide-border/40 text-foreground/90', className)}
        {...props}
      >
        {children}
      </tbody>
    );
  },

  tr({ className, children, ...props }: React.ComponentPropsWithoutRef<'tr'>) {
    return (
      <tr
        className={cn('transition-colors hover:bg-muted/30 even:bg-muted/10', className)}
        {...props}
      >
        {children}
      </tr>
    );
  },

  th({ className, children, ...props }: React.ComponentPropsWithoutRef<'th'>) {
    return (
      <th
        className={cn(
          'px-3 py-2 text-xs font-semibold text-foreground whitespace-nowrap',
          className,
        )}
        {...props}
      >
        {children}
      </th>
    );
  },

  td({ className, children, ...props }: React.ComponentPropsWithoutRef<'td'>) {
    return (
      <td
        className={cn(
          'px-3 py-2 text-xs text-foreground/90 break-words align-top',
          className,
        )}
        {...props}
      >
        {children}
      </td>
    );
  },
};

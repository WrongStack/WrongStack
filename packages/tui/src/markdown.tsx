import { Box, Text } from './ink.js';
import type React from 'react';
import { detectTable, renderTable } from './markdown-table.js';
import { theme } from './theme.js';

// Lightweight markdown renderer for assistant prose. Handles inline emphasis
// (**bold**, *italic*, `code`, ~~strike~~) plus block constructs (ATX headings,
// bullet / numbered lists, blockquotes) and defers GitHub tables to the
// existing box-drawing table renderer. Fenced code blocks are handled upstream
// by AssistantBody before this sees the text.
//
// Like the syntax highlighter, emphasis is expressed as Ink <Text> props
// (bold/italic/color), never raw ANSI, so width measurement stays correct.

export interface InlineToken {
  text: string;
  bold?: boolean | undefined;
  italic?: boolean | undefined;
  code?: boolean | undefined;
  strike?: boolean | undefined;
  /** Markdown link target (the URL part of [text](url)). */
  link?: boolean | undefined;
}

/**
 * Memoization cache for parseInline. Lines of assistant prose are frequently
 * identical across re-renders (the same heading, bullet prefix, or repeated
 * prose), and the char-by-char + indexOf parsing is O(n²) per line. Caching
 * turns repeated lines into O(1) lookups.
 *
 * Count-only eviction is not enough here: the cache is process-global and its
 * keys plus token strings can outlive transcript eviction, so a few unusually
 * large one-off lines could retain far more memory than thousands of normal
 * prose lines. Keep both entry and approximate character budgets, and skip
 * entries larger than the whole cache budget because they are poor reuse
 * candidates anyway. The character budget deliberately approximates retained
 * memory by counting both source and token text, so emphasis content is
 * conservatively counted twice and may be evicted slightly earlier.
 */
const _parseCache = new Map<string, { tokens: InlineToken[]; chars: number }>();
const _PARSE_CACHE_MAX_ENTRIES = 5000;
const _PARSE_CACHE_MAX_CHARS = 512 * 1024;
let _parseCacheChars = 0;

/**
 * Conservative cache weight: source-key characters plus token-text characters.
 * Token text intentionally overlaps the key for matched spans; over-counting is
 * safer than under-counting retained string storage and metadata.
 */
function parsedEntryChars(text: string, tokens: InlineToken[]): number {
  return text.length + tokens.reduce((sum, token) => sum + token.text.length, 0);
}

function evictParseCache(incomingChars: number): void {
  while (
    _parseCache.size >= _PARSE_CACHE_MAX_ENTRIES ||
    _parseCacheChars + incomingChars > _PARSE_CACHE_MAX_CHARS
  ) {
    const oldest = _parseCache.keys().next().value;
    if (oldest === undefined) break;
    const entry = _parseCache.get(oldest);
    _parseCache.delete(oldest);
    if (entry) _parseCacheChars -= entry.chars;
  }
}

/**
 * Parse one line of prose into inline-emphasis tokens. Markers are stripped
 * (this is display text, not length-preserving). `_..._` is intentionally NOT
 * treated as italic so snake_case / file_names aren't mangled. An unterminated
 * marker is emitted literally so no text is ever lost.
 *
 * Results are memoized: repeated calls with the same text return the identical
 * cached array, eliminating redundant parsing on every TUI re-render.
 */
export function parseInline(text: string): InlineToken[] {
  const cached = _parseCache.get(text);
  if (cached) {
    // Refresh insertion order so eviction is genuinely least-recently-used.
    _parseCache.delete(text);
    _parseCache.set(text, cached);
    return cached.tokens;
  }

  const tokens: InlineToken[] = [];
  let plain = '';
  let i = 0;
  const flush = () => {
    if (plain) {
      tokens.push({ text: plain });
      plain = '';
    }
  };
  while (i < text.length) {
    const ch = text[i] ?? '';
    const two = text.slice(i, i + 2);

    // `inline code` — highest precedence, no inner parsing.
    if (ch === '`') {
      const close = text.indexOf('`', i + 1);
      if (close > i) {
        flush();
        tokens.push({ text: text.slice(i + 1, close), code: true });
        i = close + 1;
        continue;
      }
    }
    // **bold**
    if (two === '**') {
      const close = text.indexOf('**', i + 2);
      if (close > i) {
        flush();
        tokens.push({ text: text.slice(i + 2, close), bold: true });
        i = close + 2;
        continue;
      }
    }
    // ~~strike~~
    if (two === '~~') {
      const close = text.indexOf('~~', i + 2);
      if (close > i) {
        flush();
        tokens.push({ text: text.slice(i + 2, close), strike: true });
        i = close + 2;
        continue;
      }
    }
    // *italic* — single asterisk only (the `**` case is handled above).
    if (ch === '*' && text[i + 1] !== '*') {
      const close = text.indexOf('*', i + 1);
      if (close > i + 1) {
        flush();
        tokens.push({ text: text.slice(i + 1, close), italic: true });
        i = close + 1;
        continue;
      }
    }
    // [text](url) — Markdown link. Renders the link text in accent color
    // so URLs are visually distinct from surrounding prose. The URL itself
    // is not shown (terminal links are not clickable in most terminals).
    if (ch === '[') {
      const textEnd = text.indexOf(']', i + 1);
      if (textEnd > i && text[textEnd + 1] === '(') {
        const urlEnd = text.indexOf(')', textEnd + 2);
        if (urlEnd > textEnd) {
          flush();
          const linkText = text.slice(i + 1, textEnd);
          tokens.push({ text: linkText, link: true });
          i = urlEnd + 1;
          continue;
        }
      }
    }
    // Bare URLs (http/https) — highlight in accent color so they're
    // distinguishable from prose without wrapping in link syntax.
    if (text.startsWith('http://', i) || text.startsWith('https://', i)) {
      let urlEnd = i + 8;
      while (urlEnd < text.length) {
        const c = text[urlEnd];
        const urlChars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._~:/?#@!" + String.fromCharCode(36) + String.fromCharCode(38) + "+,;=-%[]()'*";
        if (c !== undefined && urlChars.includes(c)) {
          urlEnd++;
        } else {
          break;
        }
      }
      const trailing = text.slice(i, urlEnd);
      const stripped = trailing.replace(/[.,;!?)]+$/, '');
      urlEnd = i + stripped.length;
      if (urlEnd > i + 8) {
        flush();
        tokens.push({ text: stripped, link: true });
        i = urlEnd;
        continue;
      }
    }
    plain += ch;
    i += 1;
  }
  flush();

  const chars = parsedEntryChars(text, tokens);
  if (chars <= _PARSE_CACHE_MAX_CHARS) {
    evictParseCache(chars);
    _parseCache.set(text, { tokens, chars });
    _parseCacheChars += chars;
  }
  return tokens;
}

function InlineLine({ tokens, dim }: { tokens: InlineToken[]; dim?: boolean | undefined }): React.ReactElement {
  if (tokens.length === 0) return <Text> </Text>;
  return (
    <Text>
      {tokens.map((t, j) => (
        <Text
          key={j}
          color={t.code ? theme.accent : t.link ? theme.accent : 'white'}
          bold={Boolean(t.bold)}
          italic={Boolean(t.italic)}
          strikethrough={Boolean(t.strike)}
          dimColor={Boolean(dim)}
        >
          {t.text}
        </Text>
      ))}
    </Text>
  );
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const BULLET_RE = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED_RE = /^(\s*)(\d+)\.\s+(.*)$/;
const QUOTE_RE = /^>\s?(.*)$/;

/**
 * Render assistant prose with markdown emphasis + block formatting. Tables are
 * routed through the existing box-drawing renderer; everything else is parsed
 * line-by-line.
 *
 * `contentWidth` is the real inner width of the panel that wraps this view
 * (the assistant entry's left-border + paddingLeft). When provided, tables
 * are sized against it so they don't overflow the panel; otherwise we fall
 * back to `termWidth`, which is correct for callers without a bordered
 * container. Non-table prose is unaffected — Ink handles its soft wrap.
 *
 * `tableWidth` is the width available for tables. When provided, tables are
 * sized to this value; otherwise falls back to `contentWidth ?? termWidth`.
 * This allows precise control over table sizing independent of prose width.
 *
 * `panelBackground` is the background color of the surrounding panel. When
 * provided, table rows are padded with trailing spaces colored with this
 * background so any empty space on the right of a narrow table is filled
 * with the panel background rather than showing the terminal background.
 */
export function MarkdownView({
  text,
  termWidth,
  contentWidth,
  tableWidth,
}: {
  text: string;
  termWidth: number;
  /** Real inner width of the surrounding panel. Defaults to `termWidth`. */
  contentWidth?: number | undefined;
  /** Width available for tables. Defaults to `contentWidth ?? termWidth`. */
  tableWidth?: number | undefined;
}): React.ReactElement {
  const lines = text.split('\n');
  const rows: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  // Tables are the only width-sensitive path here; size them to the real
  // content area so a 2-col-chrome border (assistant panel) doesn't push
  // the last cell off the right edge and force an Ink wrap.
  const tableBudget = Math.max(20, tableWidth ?? contentWidth ?? termWidth);
  while (i < lines.length) {
    // GitHub table block → existing renderer.
    const tableEnd = detectTable(lines, i);
    if (tableEnd > i) {
      // Tables use box-drawing characters rendered on the terminal background
      // (no panel background since assistant entries are now transparent).
      const tableText = renderTable(lines.slice(i, tableEnd), tableBudget);
      rows.push(
        <Box key={`t${key++}`} width={tableBudget} backgroundColor="transparent">
          <Text>{tableText}</Text>
        </Box>,
      );
      i = tableEnd;
      continue;
    }
    const line = lines[i] ?? '';
    i += 1;

    const heading = line.match(HEADING_RE);
    if (heading) {
      rows.push(
        <Text key={`h${key++}`} bold color={theme.accent}>
          {heading[2] ?? ''}
        </Text>,
      );
      continue;
    }
    const quote = line.match(QUOTE_RE);
    if (quote && line.startsWith('>')) {
      const qContent = quote[1] ?? '';
      rows.push(
        <Box key={`q${key++}`} flexDirection="row">
          <Text dimColor>{'  '}</Text>
          {/[\u2500-\u257F]/.test(qContent) ? (
            // Box-drawing characters inside blockquotes also need transparent
            // background to avoid inheriting the message panel background.
            <Box flexDirection="row" backgroundColor="transparent">
              {[...qContent].slice(0, (contentWidth ?? termWidth) - 2).map((ch, ci) => (
                <Text key={ci} dimColor>{ch}</Text>
              ))}
            </Box>
          ) : (
            <InlineLine tokens={parseInline(qContent)} dim />
          )}
        </Box>,
      );
      continue;
    }
    const bullet = line.match(BULLET_RE);
    if (bullet) {
      rows.push(
        <Box key={`b${key++}`} flexDirection="row">
          <Text color={theme.accent}>{`${bullet[1] ?? ''}• `}</Text>
          <InlineLine tokens={parseInline(bullet[2] ?? '')} />
        </Box>,
      );
      continue;
    }
    const numbered = line.match(NUMBERED_RE);
    if (numbered) {
      rows.push(
        <Box key={`n${key++}`} flexDirection="row">
          <Text color={theme.accent}>{`${numbered[1] ?? ''}${numbered[2]}. `}</Text>
          <InlineLine tokens={parseInline(numbered[3] ?? '')} />
        </Box>,
      );
      continue;
    }

    // Box-drawing characters (U+2500–U+257F) have East Asian Width
    // "Ambiguous" and are often measured as 2-column by terminal width
    // libraries (including Ink's internal measurement). Rendering them
    // character-by-character inside a row prevents incorrect wrapping.
    if (/[\u2500-\u257F]/.test(line)) {
      const maxW = contentWidth ?? termWidth;
      const chars = [...line].slice(0, maxW);
      // Box-drawing characters (U+2500-U+257F) inherit the message panel
      // background, making them visually unclear. Wrap in a transparent box
      // so they render on the terminal default background, matching tables.
      rows.push(
        <Box key={`bx${key++}`} width={maxW} backgroundColor="transparent" flexDirection="row">
          {chars.map((ch, ci) => (
            <Text key={ci}>{ch}</Text>
          ))}
        </Box>,
      );
      continue;
    }

    rows.push(<InlineLine key={`p${key++}`} tokens={parseInline(line)} />);
  }
  // Constrain prose to contentWidth so Ink wraps at the correct boundary,
  // not at the full terminal width. Tables already get an explicit width via
  // the <Box width={tableBudget}> wrapper around each row.
  return <Box flexDirection="column" width={Math.max(20, tableBudget)}>{rows}</Box>;
}

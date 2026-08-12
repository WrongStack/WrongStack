import type React from 'react';
import { memo } from 'react';
import { detectLang, type Lang } from '../../highlight.js';
import { Box } from '../../ink.js';
import { MarkdownView } from '../../markdown.js';
import { CodeBlock } from './code-block.js';
import type { BodySegment } from './types.js';

/**
 * Width of the left border glyph in a single-border panel. Used to adjust
 * content width calculations where the border is a separate UI element.
 */
export const MESSAGE_PANEL_BORDER_WIDTH = 1;

/**
 * Horizontal columns consumed by every bordered message panel
 * (border glyph + paddingLeft). Exported so tests can assert consistency.
 */
export const MESSAGE_PANEL_CHROME_WIDTH = 2;

/**
 * Margin on each side of bordered panels, in columns. Prevents the
 * last character of a full-width line from wrapping at the terminal edge
 * and leaking into scrollback. Content inside the panel is narrower by
 * twice this value (left + right).
 */
export const MESSAGE_PANEL_MARGIN = 2;

/**
 * Compute the real inner content width of an assistant panel.
 * termWidth - chrome (border+padding) only — no margin since panels are now full-width.
 */
export function assistantContentWidth(termWidth: number): number {
  return Math.max(1, termWidth - MESSAGE_PANEL_CHROME_WIDTH);
}

/**
 * Split assistant text into prose and ```fenced``` code segments, in order.
 * Pure + testable. An unterminated fence treats the remainder as code.
 */
export function splitFencedBlocks(text: string): BodySegment[] {
  const lines = text.split('\n');
  const segs: BodySegment[] = [];
  let prose: string[] = [];
  let code: string[] | null = null;
  let lang: Lang = 'plain';
  const flushProse = () => {
    if (prose.length > 0) {
      segs.push({ type: 'prose', text: prose.join('\n') });
      prose = [];
    }
  };
  for (const line of lines) {
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      if (code === null) {
        flushProse();
        code = [];
        lang = detectLang(fence[1] ?? '');
      } else {
        segs.push({ type: 'code', text: code.join('\n'), lang });
        code = null;
        lang = 'plain';
      }
      continue;
    }
    if (code !== null) code.push(line);
    else prose.push(line);
  }
  if (code !== null) segs.push({ type: 'code', text: code.join('\n'), lang });
  flushProse();
  return segs;
}

/**
 * Assistant message body: prose (with markdown tables) interleaved with
 * highlighted code blocks.
 */
function AssistantBodyImpl({
  text,
  termWidth,
  contentWidth,
}: {
  text: string;
  termWidth: number;
  /** Real inner width of the surrounding panel. Defaults to `termWidth`. */
  contentWidth?: number | undefined;
}): React.ReactElement {
  const segments = splitFencedBlocks(text);
  const inner = contentWidth ?? termWidth;
  return (
    <Box flexDirection="column">
      {segments.map((seg, i) =>
        seg.type === 'code' ? (
          <CodeBlock key={i} code={seg.text} lang={seg.lang ?? 'plain'} contentWidth={inner} />
        ) : (
          <MarkdownView
            key={i}
            text={seg.text}
            termWidth={inner}
            tableWidth={termWidth - MESSAGE_PANEL_CHROME_WIDTH}
          />
        ),
      )}
    </Box>
  );
}

/**
 * Assistant message body, split into fenced/prose segments.
 *
 * Memoized on its primitive props so a streaming re-render only re-splits when
 * the text itself grows.
 */
export const AssistantBody = memo(AssistantBodyImpl);

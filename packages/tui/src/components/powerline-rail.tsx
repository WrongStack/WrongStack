import type React from 'react';
import { isValidElement } from 'react';
import { Text } from '../ink.js';
import { displayWidth } from '../terminal-width.js';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';

const RAIL_BACKGROUNDS = [theme.surfaceRaised, theme.surface] as const;

export function visibleNodeText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(visibleNodeText).join('');
  if (isValidElement(node)) {
    const props = node.props as { children?: React.ReactNode; text?: unknown };
    if (props.children !== undefined) return visibleNodeText(props.children);
    if (typeof props.text === 'string') return props.text;
    return '';
  }
  return '';
}

export interface PowerlineRailProps {
  segments: React.ReactElement[];
  budget: number;
  monochrome?: boolean | undefined;
  /** Override the filler background for per-line tonal layering. */
  fillBg?: string | undefined;
}

/**
 * Full-cell status segments with Powerline-style transitions. The default
 * Unicode profile uses font-safe half-circles/triangles; Nerd Font mode swaps
 * in the canonical Powerline private-use glyphs.
 */
export function PowerlineRail({
  segments,
  budget,
  monochrome = false,
  fillBg,
}: PowerlineRailProps): React.ReactElement {
  // Empty line: render just the filler background so the row still has the
  // correct layered tone and keeps the layout height stable.
  if (segments.length === 0) {
    if (monochrome || !fillBg) return <Text> </Text>;
    return <Text backgroundColor={fillBg}>{' '.repeat(Math.max(1, budget))}</Text>;
  }

  const widths = segments.map((segment) => displayWidth(visibleNodeText(segment)) + 2);
  let used = monochrome ? 2 : 1;
  let keep = 0;
  for (const width of widths) {
    const transition = keep > 0 ? 3 : 0;
    const end = monochrome ? 1 : 1;
    if (keep > 0 && used + transition + width + end > budget) break;
    used += transition + width;
    keep += 1;
  }
  keep = Math.max(1, keep);
  const visible = segments.slice(0, keep);
  const dropped = segments.length - keep;

  // Full-width background: after the last rendered element, fill remaining
  // width so the line spans the entire terminal rather than stopping at
  // the last chip.
  const renderedWidth =
    used +
    1 + // segmentEnd glyph
    (dropped > 0 ? displayWidth(` +${dropped}`) : 0);
  const fillerWidth = budget - renderedWidth;

  if (monochrome) {
    return (
      <Text>
        <Text dimColor>{glyphs.segmentStart}</Text>
        {visible.map((segment, index) => (
          <Text key={index}>
            {index > 0 ? <Text dimColor>{' › '}</Text> : null}
            <Text>{' '}{segment}{' '}</Text>
          </Text>
        ))}
        {dropped > 0 ? <Text dimColor>{` › +${dropped}`}</Text> : null}
        <Text dimColor>{glyphs.segmentEnd}</Text>
      </Text>
    );
  }

  // Fill background used for the filler and the trailing-end gap. Computed once
  // so segmentEnd gets the same background as the filler that follows it.
  const fillBackground = fillBg ?? RAIL_BACKGROUNDS[(keep - 1) % RAIL_BACKGROUNDS.length]!;

  return (
    <Text>
      <Text color={RAIL_BACKGROUNDS[0]} backgroundColor={fillBackground}>
        {glyphs.segmentStart}
      </Text>
      {visible.map((segment, index) => {
        const bg = RAIL_BACKGROUNDS[index % RAIL_BACKGROUNDS.length]!;
        const nextBg = RAIL_BACKGROUNDS[(index + 1) % RAIL_BACKGROUNDS.length]!;
        const isLast = index === visible.length - 1;
        return (
          <Text key={index}>
            <Text backgroundColor={bg} color={theme.textPrimary}>{' '}{segment}{' '}</Text>
            {isLast ? (
              <Text color={bg} backgroundColor={fillBackground}>
                {glyphs.segmentEnd}
              </Text>
            ) : (
              <Text color={bg} backgroundColor={nextBg}>{' '}{glyphs.segmentTransition}{' '}</Text>
            )}
          </Text>
        );
      })}
      {dropped > 0 ? <Text color={theme.textMuted}>{` +${dropped}`}</Text> : null}
      {fillerWidth > 0 ? (
        <Text backgroundColor={fillBackground}>
          {' '.repeat(fillerWidth)}
        </Text>
      ) : null}
    </Text>
  );
}

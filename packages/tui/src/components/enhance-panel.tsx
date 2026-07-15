import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from '../ink.js';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';

export type EnhanceDecision = 'refined' | 'english' | 'original' | 'edit' | 'cancel';

export interface RefiningPanelProps {
  /** Prompt currently being rewritten. */
  original: string;
  /** Time spent in the refiner request so far. */
  elapsedMs: number;
  /** Small animation frame; visual only and never presented as progress. */
  pulseFrame?: number | undefined;
}

export interface EnhancePanelProps {
  /** The user's original message. */
  original: string;
  /** Refined in the user's original language. */
  refined: string;
  /** Refined in English. */
  english: string;
  /** Time the refiner call took before this preview opened. */
  durationMs?: number | undefined;
  /** Auto-send countdown in milliseconds. */
  delayMs: number;
  /**
   * Default language for refinement ('original' or 'english').
   * Controls which version is shown as "RECOMMENDED" and auto-selected
   * on Enter / countdown expiry. Defaults to 'original'.
   */
  enhanceLanguage?: 'original' | 'english' | undefined;
  /** Called once with the chosen action (by key press or countdown expiry). */
  onDecision: (decision: EnhanceDecision) => void;
  /**
   * Called every second with the remaining seconds. The statusline owns the
   * changing countdown so this comparison panel stays visually stable.
   */
  onTick?: ((remaining: number) => void) | undefined;
}

function normalizePreviewText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function formatRefinementDuration(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 1000) return `${Math.round(safe)}ms`;
  if (safe < 60_000) return `${(safe / 1000).toFixed(1)}s`;
  const minutes = Math.floor(safe / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

/** A scanning activity pulse. It deliberately does not imply completion %. */
export function refinementPulse(frame: number, width = 14): string {
  if (width <= 0) return '';
  const cells = Array.from({ length: width }, () => '·');
  const cycle = Math.max(1, width * 2 - 2);
  const phase = ((Math.max(0, frame) % cycle) + cycle) % cycle;
  const index = phase < width ? phase : cycle - phase;
  cells[index] = '●';
  return cells.join('');
}

/**
 * Word-aware, bounded preview rows for the live-region panels. Whitespace is
 * collapsed and the final row receives an ellipsis when content remains.
 */
export function wrapRefinementPreview(text: string, width: number, maxLines: number): string[] {
  if (width <= 0 || maxLines <= 0) return [];
  let remaining = normalizePreviewText(text);
  if (!remaining) return [''];

  const rows: string[] = [];
  while (remaining && rows.length < maxLines) {
    if (remaining.length <= width) {
      rows.push(remaining);
      remaining = '';
      break;
    }
    let cut = remaining.lastIndexOf(' ', width);
    if (cut < Math.floor(width * 0.55)) cut = width;
    const row = remaining.slice(0, cut).trimEnd();
    remaining = remaining.slice(cut).trimStart();
    rows.push(row);
  }

  if (remaining && rows.length > 0) {
    const last = rows.length - 1;
    const row = rows[last] ?? '';
    rows[last] = `${row.slice(0, Math.max(0, width - 1))}…`;
  }
  return rows;
}

function useTerminalColumns(): number {
  const { stdout } = useStdout();
  const [columns, setColumns] = useState(stdout?.columns ?? 90);
  useEffect(() => {
    const handleResize = () => setColumns(stdout?.columns ?? 90);
    handleResize();
    process.stdout.on('resize', handleResize);
    return () => {
      process.stdout.off('resize', handleResize);
    };
  }, [stdout]);
  return columns;
}

function PreviewBlock({
  title,
  text,
  color,
  width,
  maxLines,
  recommended = false,
}: {
  title: string;
  text: string;
  color: string;
  width: number;
  maxLines: number;
  recommended?: boolean | undefined;
}): React.ReactElement {
  const rows = wrapRefinementPreview(text, Math.max(8, width - 4), maxLines);
  const padded = Array.from({ length: maxLines }, (_, index) => rows[index] ?? '');
  return (
    <Box
      width={width}
      height={maxLines + 1}
      flexShrink={0}
      flexDirection="column"
      {...(recommended && theme.supportsBackground ? { backgroundColor: theme.surfaceRaised } : {})}
    >
      <Box height={1}>
        <Text color={color} bold={recommended}>
          {recommended ? `${glyphs.success} ` : ''}
          {title}
        </Text>
      </Box>
      {padded.map((row, index) => (
        <Box key={`${title}-${index}`} height={1}>
          <Text color={color}>{recommended ? '▎' : '│'}</Text>
          <Text color={recommended ? theme.textPrimary : theme.textMuted}> {row}</Text>
        </Box>
      ))}
    </Box>
  );
}

function KeyHint({ keyName, label, color }: { keyName: string; label: string; color: string }) {
  return (
    <Text>
      <Text
        color={color}
        bold
        {...(theme.supportsBackground ? { backgroundColor: theme.surfaceRaised } : {})}
      >
        {' '}
        {keyName}{' '}
      </Text>
      <Text color={theme.textMuted}> {label}</Text>
    </Text>
  );
}

/** Live refiner call state: stable height, real elapsed time, cancellable. */
export function RefiningPanel({
  original,
  elapsedMs,
  pulseFrame = 0,
}: RefiningPanelProps): React.ReactElement {
  const columns = useTerminalColumns();
  const previewWidth = Math.max(18, columns - 8);
  const preview = wrapRefinementPreview(original, previewWidth, columns >= 60 ? 2 : 1);
  const activityLabel =
    columns >= 78
      ? 'clarifying intent · preserving constraints · preparing variants'
      : columns >= 52
        ? 'clarifying intent · preserving constraints'
        : 'clarifying intent';

  return (
    <Box
      alignSelf="stretch"
      width="100%"
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.brand}
      paddingX={1}
    >
      <Box height={1}>
        <Text color={theme.brand} bold>
          {glyphs.brain} PROMPT REFINER
        </Text>
        {columns >= 48 ? <Text color={theme.textMuted}> / REFINING</Text> : null}
        <Box flexGrow={1} />
        <Text color={theme.brand}>● WORKING</Text>
        <Text color={theme.textMuted}> {formatRefinementDuration(elapsedMs)}</Text>
      </Box>

      <Box height={1} marginTop={1}>
        <Text color={theme.brand}>{refinementPulse(pulseFrame, columns >= 70 ? 18 : 10)}</Text>
        <Text color={theme.textMuted}> {activityLabel}</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.textMuted}>REQUEST</Text>
        {preview.map((line, index) => (
          <Box key={`refining-preview-${index}`} height={1}>
            <Text color={theme.brand}>▎</Text>
            <Text color={theme.textSecondary}> {line}</Text>
          </Box>
        ))}
      </Box>

      <Box height={1} marginTop={1}>
        <Text color={theme.textMuted}>Esc cancels and returns to edit</Text>
      </Box>
    </Box>
  );
}

/**
 * Completed prompt-refinement comparison. The original and recommended
 * versions sit side-by-side on wide terminals and stack on narrow ones. The
 * countdown remains in the statusline, keeping this panel stable in inline
 * mode while still making auto-send behavior explicit.
 */
export function EnhancePanel({
  original,
  refined,
  english,
  durationMs = 0,
  delayMs,
  enhanceLanguage = 'original',
  onDecision,
  onTick,
}: EnhancePanelProps): React.ReactElement {
  const columns = useTerminalColumns();

  // If the user set refine-language → english, the English version is the
  // recommended choice (auto-send + Enter). Otherwise the original-language
  // refined version is recommended.
  const preferredDecision: 'refined' | 'english' =
    enhanceLanguage === 'english' ? 'english' : 'refined';
  const recommendedText = preferredDecision === 'english' ? english : refined;
  const secondaryText = preferredDecision === 'english' ? refined : english;
  const recommendedLabel =
    preferredDecision === 'english' ? 'RECOMMENDED (ENGLISH)' : 'RECOMMENDED';
  const secondaryLabel = preferredDecision === 'english' ? 'ORIGINAL LANGUAGE' : 'ENGLISH OPTION';

  const totalSecs = Math.max(1, Math.ceil(delayMs / 1000));
  const remainingRef = useRef(totalSecs);
  const decideRef = useRef(onDecision);
  decideRef.current = onDecision;
  const tickRef = useRef(onTick);
  tickRef.current = onTick;

  useEffect(() => {
    tickRef.current?.(remainingRef.current);
    const id = setInterval(() => {
      const remaining = remainingRef.current - 1;
      remainingRef.current = remaining;
      tickRef.current?.(remaining);
      if (remaining <= 0) {
        clearInterval(id);
        // Auto-send the preferred language version
        decideRef.current(preferredDecision);
      }
    }, 1000);
    return () => clearInterval(id);
  }, []);

  useInput((input, key) => {
    if (key.return) onDecision(preferredDecision);
    else if (key.escape) onDecision('cancel');
    else if (input?.toLowerCase() === 'e') onDecision('english');
    else if (input?.toLowerCase() === 't') onDecision('edit');
  });

  const innerWidth = Math.max(26, columns - 4);
  const sideBySide = columns >= 88;
  const comparisonGap = sideBySide ? 1 : 0;
  const comparisonWidth = sideBySide ? Math.floor((innerWidth - comparisonGap) / 2) : innerWidth;
  const comparisonLines = sideBySide ? 3 : 2;
  const englishLines = columns >= 70 ? 2 : 1;
  const completionSummary =
    columns >= 72
      ? 'Intent clarified · constraints preserved · two sendable variants'
      : columns >= 48
        ? 'Intent clarified · constraints preserved'
        : 'Intent clarified';

  return (
    <Box
      alignSelf="stretch"
      width="100%"
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
    >
      <Box height={1}>
        <Text color={theme.accent} bold>
          {glyphs.brain} REFINEMENT READY
        </Text>
        <Box flexGrow={1} />
        <Text color={theme.success}>
          {glyphs.success} ready in {formatRefinementDuration(durationMs)}
        </Text>
      </Box>
      <Box height={1}>
        <Text color={theme.textMuted}>{completionSummary}</Text>
        <Box flexGrow={1} />
        {columns >= 72 ? <Text color={theme.warn}>{glyphs.auto} AUTO-SEND ARMED</Text> : null}
      </Box>

      <Box flexDirection={sideBySide ? 'row' : 'column'} gap={comparisonGap} marginTop={1}>
        <PreviewBlock
          title="BEFORE"
          text={original}
          color={theme.textMuted}
          width={comparisonWidth}
          maxLines={comparisonLines}
        />
        <PreviewBlock
          title={recommendedLabel}
          text={recommendedText}
          color={theme.accent}
          width={comparisonWidth}
          maxLines={comparisonLines}
          recommended
        />
      </Box>

      <Box marginTop={1}>
        <PreviewBlock
          title={secondaryLabel}
          text={secondaryText}
          color={preferredDecision === 'english' ? theme.textMuted : theme.success}
          width={innerWidth}
          maxLines={englishLines}
        />
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {columns >= 72 ? (
          <Box height={1} gap={2}>
            <KeyHint
              keyName="Enter"
              label={preferredDecision === 'english' ? 'use English' : 'use refined'}
              color={theme.accent}
            />
            <KeyHint keyName="E" label="English" color={theme.success} />
            <KeyHint keyName="T" label="edit" color={theme.warn} />
            <KeyHint keyName="Esc" label="cancel" color={theme.error} />
          </Box>
        ) : (
          <>
            <Box height={1} gap={2}>
              <KeyHint
                keyName="Enter"
                label={preferredDecision === 'english' ? 'use English' : 'use refined'}
                color={theme.accent}
              />
              <KeyHint keyName="E" label="English" color={theme.success} />
            </Box>
            <Box height={1} gap={2}>
              <KeyHint keyName="T" label="edit" color={theme.warn} />
              <KeyHint keyName="Esc" label="cancel" color={theme.error} />
            </Box>
          </>
        )}
        <Box height={1} marginTop={1}>
          <Text color={theme.textMuted}>
            {columns >= 70
              ? `${glyphs.auto} Recommended version sends when the status-bar timer ends`
              : `${glyphs.auto} Auto-send · see status bar`}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

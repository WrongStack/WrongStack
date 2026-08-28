import type React from 'react';
import { useState, useMemo } from 'react';
import { useTerminalSize } from '../hooks/use-terminal-size.js';
import { Box, Text, useInput } from '../ink.js';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';
import { formatRefinementDuration } from './enhance-panel.js';

/**
 * What the user chose on a failed refinement. `retry` re-runs on the same
 * model with a longer window; `fallback` re-runs on the resolved fallback ref;
 * `pick` re-runs on an explicitly-chosen provider/model (ephemeral — the
 * session model is untouched); `original` sends the raw text as-is; `edit`
 * loads the text back into the input for hand-editing.
 */
export type RefineFailureDecision =
  | { kind: 'retry' }
  | { kind: 'fallback' }
  | { kind: 'pick'; providerId: string; model: string }
  | { kind: 'original' }
  | { kind: 'edit' };

export interface RefineFailureModel {
  providerId: string;
  model: string;
  label?: string | undefined;
}

export function filterRefineModels<T extends RefineFailureModel>(
  models: readonly T[],
  query: string,
): readonly T[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return models;
  return models.filter(
    (candidate) =>
      candidate.providerId.toLowerCase().includes(normalized) ||
      candidate.model.toLowerCase().includes(normalized) ||
      candidate.label?.toLowerCase().includes(normalized),
  );
}

interface RefineFailurePanelProps {
  /** The user's original message (sent as-is if they decline recovery). */
  original: string;
  /** Short failure reason from the refiner (provider error / timeout / empty). */
  error?: string | undefined;
  /** Total time spent across attempts so far. */
  elapsedMs?: number | undefined;
  /** One-key "retry with another model" offer (provider/model), if resolved. */
  fallbackRef?: string | undefined;
  /** Provider/model candidates for the inline "pick another model" list. */
  models: RefineFailureModel[];
  onDecision: (decision: RefineFailureDecision) => void;
}

const PICK_WINDOW = 8;

function useColumns(): number {
  return useTerminalSize({ fallbackColumns: 90 }).columns;
}

/**
 * Recovery panel shown when a refinement fails. Two views: the default option
 * list (retry / fallback / pick / send-as-is / edit) and — when the user opens
 * "pick another model" — an inline scroll list of provider/models with a
 * type-to-filter search box.
 * Everything resolves through `onDecision`; no session state is mutated here.
 */
export function RefineFailurePanel({
  original,
  error,
  elapsedMs = 0,
  fallbackRef,
  models,
  onDecision,
}: RefineFailurePanelProps): React.ReactElement {
  const columns = useColumns();
  const [view, setView] = useState<'options' | 'pick'>('options');
  const [cursor, setCursor] = useState(0);
  const [query, setQuery] = useState('');
  const filteredModels = useMemo(() => filterRefineModels(models, query), [models, query]);
  const width = Math.max(30, columns - 4);
  const canPick = models.length > 0;
  const canFallback = !!fallbackRef;

  useInput((input, key) => {
    if (view === 'pick') {
      // Layered Esc: clear query first, then go back to options
      if (key.escape) {
        if (query) {
          setQuery('');
          return;
        }
        setView('options');
        setQuery('');
        setCursor(0);
        return;
      }
      if (key.downArrow) {
        const n = filteredModels.length;
        if (n > 0) setCursor((c) => Math.min(c + 1, n - 1));
        return;
      }
      if (key.upArrow) {
        setCursor((c) => Math.max(c - 1, 0));
        return;
      }
      if (key.return) {
        const chosen = filteredModels[cursor];
        if (chosen)
          onDecision({ kind: 'pick', providerId: chosen.providerId, model: chosen.model });
        return;
      }
      // Backspace/Delete → remove last char of the search query
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
        setCursor(0);
        return;
      }
      // Printable ASCII → extend the search query
      if (input && input.length === 1 && input.charCodeAt(0) >= 0x20 && input.charCodeAt(0) < 0x7f) {
        setQuery((q) => q + input);
        setCursor(0);
        return;
      }
      return;
    }
    // Options view.
    if (key.return) {
      onDecision({ kind: 'retry' });
      return;
    }
    if (key.escape) {
      onDecision({ kind: 'original' });
      return;
    }
    const ch = input?.toLowerCase();
    if (ch === 'm' && canFallback) onDecision({ kind: 'fallback' });
    else if (ch === 'p' && canPick) {
      setCursor(0);
      setQuery('');
      setView('pick');
    } else if (ch === 's') onDecision({ kind: 'original' });
    else if (ch === 'e') onDecision({ kind: 'edit' });
  });

  if (view === 'pick') {
    const total = filteredModels.length;
    const start = Math.max(
      0,
      Math.min(cursor - Math.floor(PICK_WINDOW / 2), total - PICK_WINDOW),
    );
    const windowStart = Math.max(0, start);
    const visible = filteredModels.slice(windowStart, windowStart + PICK_WINDOW);
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
            {glyphs.brain} RETRY REFINEMENT ON
          </Text>
          <Box flexGrow={1} />
          <Text color={theme.textMuted}>
            {query ? `${total}/${models.length}` : `${models.length}`} model
            {(query ? total : models.length) === 1 ? '' : 's'}
          </Text>
        </Box>
        <Box height={1} marginTop={1}>
          <Text color={theme.textMuted}>
            {query ? `🔍 ${query} ` : '🔍 type to filter'}
          </Text>
        </Box>
        {total === 0 ? (
          <Box height={1} marginTop={1}>
            <Text color={theme.textMuted}>(no models match &quot;{query}&quot;)</Text>
          </Box>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {visible.map((m, i) => {
              const idx = windowStart + i;
              const selected = idx === cursor;
              const label = m.label && m.label !== m.model ? `  ${m.label}` : '';
              return (
                <Box key={`${m.providerId}/${m.model}`} height={1}>
                  <Text color={selected ? theme.accent : theme.textMuted}>
                    {selected ? '▸ ' : '  '}
                  </Text>
                  <Text color={selected ? theme.textPrimary : theme.textSecondary}>
                    {`${m.providerId}/${m.model}`}
                  </Text>
                  <Text color={theme.textMuted}>{label}</Text>
                </Box>
              );
            })}
          </Box>
        )}
        <Box height={1} marginTop={1}>
          <Text color={theme.textMuted}>
            ↑/↓ choose · Enter refine · {query ? 'Esc clear · ' : ''}Esc back
          </Text>
        </Box>
      </Box>
    );
  }

  const preview = original.replace(/\s+/g, ' ').trim();
  const previewShown = preview.length > width - 6 ? `${preview.slice(0, width - 7)}…` : preview;

  return (
    <Box
      alignSelf="stretch"
      width="100%"
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.error}
      paddingX={1}
    >
      <Box height={1}>
        <Text color={theme.error} bold>
          {glyphs.warning} REFINEMENT FAILED
        </Text>
        <Box flexGrow={1} />
        <Text color={theme.textMuted}>after {formatRefinementDuration(elapsedMs)}</Text>
      </Box>
      {error ? (
        <Box height={1}>
          <Text color={theme.textMuted}>
            {error.length > width ? `${error.slice(0, width - 1)}…` : error}
          </Text>
        </Box>
      ) : null}

      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.textMuted}>YOUR MESSAGE</Text>
        <Box height={1}>
          <Text color={theme.brand}>▎</Text>
          <Text color={theme.textSecondary}> {previewShown}</Text>
        </Box>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Box height={1} gap={2}>
          <Text>
            <Text color={theme.accent} bold>
              {' '}
              Enter{' '}
            </Text>
            <Text color={theme.textMuted}> retry (more time)</Text>
          </Text>
          {canFallback ? (
            <Text>
              <Text color={theme.success} bold>
                {' '}
                M{' '}
              </Text>
              <Text color={theme.textMuted}> {fallbackRef}</Text>
            </Text>
          ) : null}
        </Box>
        <Box height={1} gap={2}>
          {canPick ? (
            <Text>
              <Text color={theme.warn} bold>
                {' '}
                P{' '}
              </Text>
              <Text color={theme.textMuted}> another model…</Text>
            </Text>
          ) : null}
          <Text>
            <Text color={theme.textPrimary} bold>
              {' '}
              S{' '}
            </Text>
            <Text color={theme.textMuted}> send as-is</Text>
          </Text>
          <Text>
            <Text color={theme.warn} bold>
              {' '}
              E{' '}
            </Text>
            <Text color={theme.textMuted}> edit</Text>
          </Text>
        </Box>
        <Box height={1} marginTop={1}>
          <Text color={theme.textMuted}>Esc sends your message as-is</Text>
        </Box>
      </Box>
    </Box>
  );
}

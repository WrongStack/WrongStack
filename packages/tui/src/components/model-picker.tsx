import type React from 'react';
import { Box, Text } from '../ink.js';
import { colorForFamily, UI_COLORS } from './provider-colors.js';

export interface ProviderOption {
  id: string;
  family: string;
  /** Model ids the picker offers in step 2 for this provider. */
  models: string[];
  /** Optional dim hint shown next to the model list (e.g. "from saved config"). */
  modelsLabel?: string | undefined;
  modelDetails?:
    | Record<
        string,
        {
          name?: string | undefined;
          description?: string | undefined;
          tools?: boolean | undefined;
          vision?: boolean | undefined;
          reasoning?: boolean | undefined;
          maxContext?: number | undefined;
          maxOutput?: number | undefined;
          inputCost?: number | undefined;
          outputCost?: number | undefined;
          cacheReadCost?: number | undefined;
          knowledge?: string | undefined;
          releaseDate?: string | undefined;
        }
      >
    | undefined;
}

interface ModelPickerProps {
  step: 'provider' | 'model';
  providerOptions: ProviderOption[];
  /** All model options for the current provider. */
  modelOptions: string[];
  /** Filtered/searched model options (may differ when searchQuery is active). */
  filteredOptions: string[];
  selected: number;
  pickedProviderId?: string | undefined;
  /** Current search query (step 2 only). */
  searchQuery?: string | undefined;
  /** Status hint (e.g. error from a failed switch attempt) shown at the bottom. */
  hint?: string | undefined;
  /**
   * Overlay title. Defaults to 'Switch model' (the /model command); generic
   * `requestModelPick` callers pass their own (e.g. "Add council voter").
   */
  titleLabel?: string | undefined;
  columns?: number | undefined;
  maxRows?: number | undefined;
}

const MAX_VISIBLE = 10;

/** Compute the visible window, keeping `selected` centered when possible. */
function getVisibleWindow(selected: number, total: number): { start: number; end: number } {
  const half = Math.floor(MAX_VISIBLE / 2);
  let start = selected - half;
  let end = start + MAX_VISIBLE;
  if (start < 0) {
    start = 0;
    end = Math.min(total, MAX_VISIBLE);
  }
  if (end > total) {
    end = total;
    start = Math.max(0, end - MAX_VISIBLE);
  }
  return { start, end };
}

/**
 * Two-step Ink overlay for the TUI's `/model` command.
 *   Step 1: pick a provider that has a key.
 *   Step 2: pick a model bound to that provider (type to filter).
 *
 * Driven entirely by props — App owns cursor state, key events, and search.
 */
export function ModelPicker({
  step,
  providerOptions,
  filteredOptions,
  selected,
  pickedProviderId,
  searchQuery,
  hint,
  titleLabel,
  columns = 0,
  maxRows,
}: ModelPickerProps): React.ReactElement {
  const title = titleLabel ?? 'Switch model';
  if (step === 'provider') {
    const focused = providerOptions[Math.max(0, Math.min(selected, providerOptions.length - 1))];
    const longest = providerOptions.reduce(
      (value, provider) => Math.max(value, provider.id.length),
      0,
    );
    const listWidth = Math.max(38, Math.min(56, longest + 24));
    const split = columns >= listWidth + 42 && Boolean(focused);
    const list = (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={UI_COLORS.border}
        paddingX={1}
        {...(split ? { width: listWidth, flexShrink: 0 } : {})}
      >
        <Text color={UI_COLORS.title} bold>
          {`━━ ${title} — Step 1/2: Pick provider ━━`}
        </Text>
        <Text dimColor>↑/↓ navigate · Enter select · Esc cancel · Ctrl+C exit</Text>
        {providerOptions.length === 0 ? (
          <Text dimColor>(no providers with keys — add one via `wstack auth`)</Text>
        ) : (
          <Box flexDirection="column" minHeight={providerOptions.length}>
            {providerOptions.map((p, i) => {
              const isSelected = i === selected;
              const famColor = colorForFamily(p.family);
              return (
                <Text
                  key={p.id}
                  inverse={isSelected}
                  {...(isSelected ? { color: UI_COLORS.focused } : {})}
                >
                  {isSelected ? '› ' : '  '}
                  <Text bold color={isSelected ? undefined : famColor}>
                    {p.id.padEnd(split ? Math.max(1, listWidth - 23) : 28)}
                  </Text>
                  <Text color={isSelected ? undefined : famColor} dimColor={!isSelected}>
                    {' '}
                    [{p.family}]
                  </Text>
                  <Text dimColor>
                    {' '}
                    {p.models.length} model{p.models.length === 1 ? '' : 's'}
                  </Text>
                </Text>
              );
            })}
          </Box>
        )}
        {hint ? <Text color={UI_COLORS.hint}>{hint}</Text> : null}
      </Box>
    );
    if (!split || !focused) return list;
    // Fixed line budget for the model preview so the detail panel height never
    // changes as the user navigates between providers with different model
    // counts — mirrors the padding idiom Step 2 uses for its scroll window.
    const previewBudget = Math.max(3, (maxRows ?? 14) - 8);
    const previewModels = focused.models.slice(0, previewBudget);
    return (
      <Box flexDirection="row">
        {list}
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={UI_COLORS.border}
          paddingX={1}
          flexGrow={1}
        >
          <Text color={UI_COLORS.title} bold>
            {focused.id}
          </Text>
          <Text>
            <Text dimColor>family: </Text>
            {focused.family}
          </Text>
          <Text>
            <Text dimColor>models: </Text>
            {focused.models.length}
          </Text>
          <Text>
            <Text dimColor>source: </Text>
            {focused.modelsLabel ?? 'provider catalog/config'}
          </Text>
          <Text> </Text>
          <Text dimColor>
            available models
            {focused.models.length > previewBudget
              ? ` (${focused.models.length} — first ${previewBudget} shown)`
              : ''}
          </Text>
          {previewModels.length > 0 ? (
            previewModels.map((m) => (
              <Text key={m} wrap="truncate-end">
                {m}
              </Text>
            ))
          ) : (
            <Text dimColor>(none)</Text>
          )}
          {/* Pad remaining slots so every provider's panel is the same height.
           * When the preview is empty the "(none)" line above already occupies
           * one budget slot, so the padding budget shrinks to match. */}
          {Array.from({
            length: previewBudget - (previewModels.length > 0 ? previewModels.length : 1),
          }).map((_, i) => (
            <Text key={`pad-${i}`}> </Text>
          ))}
        </Box>
      </Box>
    );
  }

  // ── Step 2: model picker with scroll window + search ───────────────────────
  const total = filteredOptions.length;
  const { start, end } = getVisibleWindow(selected, total);
  const visibleItems = filteredOptions.slice(start, end);

  const searchHint = searchQuery
    ? ` | filter:"${searchQuery}" → ${total} match${total === 1 ? '' : 'es'}`
    : total > MAX_VISIBLE
      ? ` (${total} models — type to filter)`
      : '';

  const focusedModel = filteredOptions[Math.max(0, Math.min(selected, filteredOptions.length - 1))];
  const longestModel = filteredOptions.reduce((value, model) => Math.max(value, model.length), 0);
  const modelListWidth = Math.max(38, Math.min(62, longestModel + 7));
  const split = columns >= modelListWidth + 42 && Boolean(focusedModel);
  const modelList = (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={UI_COLORS.border}
      paddingX={1}
      {...(split ? { width: modelListWidth, flexShrink: 0 } : {})}
    >
      <Text color={UI_COLORS.title} bold>
        {`━━ ${title} — Step 2/2: Pick model `}({pickedProviderId}
        {searchHint}){' ━━'}
      </Text>
      <Text dimColor>↑/↓ navigate · Enter select · Esc back · Ctrl+C exit · type to filter</Text>
      {total === 0 ? (
        <Text dimColor>
          {searchQuery
            ? `(no models match "${searchQuery}")`
            : '(no models known for this provider)'}
        </Text>
      ) : (
        <Box flexDirection="column" minHeight={MAX_VISIBLE + 2}>
          {start > 0 && <Text dimColor>▲ {start} above</Text>}
          {visibleItems.map((id, vi) => {
            const absoluteIndex = start + vi;
            const isSelected = absoluteIndex === selected;
            return (
              <Text
                key={id}
                inverse={isSelected}
                {...(isSelected ? { color: UI_COLORS.selectedModel } : {})}
              >
                {isSelected ? '› ' : '  '}
                {id}
              </Text>
            );
          })}
          {/* Pad remaining slots so old longer list never leaves ghost text */}
          {Array.from({ length: MAX_VISIBLE - visibleItems.length }).map((_, i) => (
            <Text key={`pad-${i}`}> </Text>
          ))}
          {end < total && <Text dimColor>▼ {total - end} below</Text>}
        </Box>
      )}
      {hint ? <Text color={UI_COLORS.hint}>{hint}</Text> : null}
    </Box>
  );
  if (!split || !focusedModel) return modelList;
  const provider = providerOptions.find((option) => option.id === pickedProviderId);
  const detail = provider?.modelDetails?.[focusedModel];
  return (
    <Box flexDirection="row">
      {modelList}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={UI_COLORS.border}
        paddingX={1}
        flexGrow={1}
      >
        <Text color={UI_COLORS.selectedModel} bold wrap="truncate-end">
          {focusedModel}
        </Text>
        <Text>
          <Text dimColor>provider: </Text>
          {pickedProviderId ?? 'unknown'}
        </Text>
        <Text>
          <Text dimColor>family: </Text>
          {provider?.family ?? 'unknown'}
        </Text>
        <Text>
          <Text dimColor>catalog size: </Text>
          {provider?.models.length ?? filteredOptions.length}
        </Text>
        <Text>
          <Text dimColor>context/output: </Text>
          {formatTokens(detail?.maxContext)} / {formatTokens(detail?.maxOutput)}
        </Text>
        <Text>
          <Text dimColor>capabilities: </Text>
          {[
            detail?.tools ? 'tools' : null,
            detail?.vision ? 'vision' : null,
            detail?.reasoning ? 'reasoning' : null,
          ]
            .filter(Boolean)
            .join(', ') || 'not reported'}
        </Text>
        <Text>
          <Text dimColor>cost in/out/cache: </Text>
          {formatCost(detail?.inputCost)} / {formatCost(detail?.outputCost)} /{' '}
          {formatCost(detail?.cacheReadCost)}
        </Text>
        {detail?.knowledge ? (
          <Text>
            <Text dimColor>knowledge: </Text>
            {detail.knowledge}
          </Text>
        ) : null}
        {detail?.releaseDate ? (
          <Text>
            <Text dimColor>released: </Text>
            {detail.releaseDate}
          </Text>
        ) : null}
        <Text>
          <Text dimColor>filter: </Text>
          {searchQuery || '(none)'}
        </Text>
        <Text> </Text>
        <Text dimColor>Enter switches the active session to this provider/model pair.</Text>
      </Box>
    </Box>
  );
}

function formatTokens(value: number | undefined): string {
  if (!value) return 'unknown';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

function formatCost(value: number | undefined): string {
  return value === undefined ? '?' : `$${value}`;
}

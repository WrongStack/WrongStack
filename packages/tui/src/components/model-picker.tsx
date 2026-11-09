import type React from 'react';
import { useTerminalSize } from '../hooks/use-terminal-size.js';
import { Box, Text } from '../ink.js';
import { truncateDisplay } from '../terminal-width.js';
import { EFFORT_KEEP, type ModelEffortChoice } from './model-picker-effort.js';
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
          /**
           * Effort vocabulary this model documents (models.dev
           * `reasoning_options`). Drives the ←/→ effort strip in step 2;
           * absent/empty on a model whose levels are undocumented, which the
           * strip reads as "offer the full canonical set".
           */
          effortLevels?: readonly string[] | undefined;
          /**
           * Documented "no effort control" (`reasoningConfig.effortSupported
           * === false` upstream): no effort strip even though the model
           * reasons. Absent means undocumented (see `effortLevels`).
           */
          effortControlSupported?: false | undefined;
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
  /**
   * Effort choices for the focused model, led by `default`. Empty when the
   * model does not reason (or in 'pick' purpose) — the strip is then hidden
   * and ←/→ are inert.
   */
  effortOptions?: readonly ModelEffortChoice[] | undefined;
  /** Currently highlighted entry of {@link effortOptions}. */
  effortChoice?: string | undefined;
}

const MAX_VISIBLE = 10;

/** Compute the visible window, keeping `selected` centered when possible. */
function getVisibleWindow(
  selected: number,
  total: number,
  limit = MAX_VISIBLE,
): { start: number; end: number } {
  const half = Math.floor(limit / 2);
  let start = selected - half;
  let end = start + limit;
  if (start < 0) {
    start = 0;
    end = Math.min(total, limit);
  }
  if (end > total) {
    end = total;
    start = Math.max(0, end - limit);
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
  columns: columnsOverride,
  maxRows,
  effortOptions = [],
  effortChoice = EFFORT_KEEP,
}: ModelPickerProps): React.ReactElement {
  const terminal = useTerminalSize();
  const columns = columnsOverride || terminal.columns;
  const rowBudget = maxRows ?? Math.max(8, terminal.rows - 6);
  const compact = columns < 76 || rowBudget < 16;
  // Border, title, navigation, both scroll markers, optional status hint.
  const visibleLimit = Math.max(1, Math.min(MAX_VISIBLE, rowBudget - 6 - (hint ? 1 : 0)));
  const title = titleLabel ?? 'Switch model';
  if (step === 'provider') {
    const focused = providerOptions[Math.max(0, Math.min(selected, providerOptions.length - 1))];
    const longest = providerOptions.reduce(
      (value, provider) => Math.max(value, provider.id.length),
      0,
    );
    const listWidth = Math.max(38, Math.min(56, longest + 24));
    const split =
      columnsOverride !== undefined && !compact && columns >= listWidth + 42 && Boolean(focused);
    const providerWindow = getVisibleWindow(selected, providerOptions.length, visibleLimit);
    const list = (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={UI_COLORS.border}
        paddingX={1}
        {...(split ? { width: listWidth, flexShrink: 0 } : {})}
      >
        <Text color={UI_COLORS.title} bold wrap="truncate-end">
          {compact ? `${title} · Step 1/2` : `━━ ${title} — Step 1/2: Pick provider ━━`}
        </Text>
        <Text dimColor wrap="truncate-end">
          ↑↓ · Enter select · Esc cancel
        </Text>
        {providerOptions.length === 0 ? (
          <Text dimColor>(no providers with keys — add one via `wstack auth`)</Text>
        ) : (
          <Box flexDirection="column">
            {providerWindow.start > 0 ? <Text dimColor>▲ {providerWindow.start} above</Text> : null}
            {providerOptions.slice(providerWindow.start, providerWindow.end).map((p, i) => {
              const isSelected = providerWindow.start + i === selected;
              const famColor = colorForFamily(p.family);
              return (
                <Text
                  key={p.id}
                  wrap="truncate-end"
                  inverse={isSelected}
                  {...(isSelected ? { color: UI_COLORS.focused } : {})}
                >
                  {isSelected ? '› ' : '  '}
                  <Text bold color={isSelected ? undefined : famColor}>
                    {(p.id === 'acp' ? 'ACP coding agents' : p.id).padEnd(
                      split ? Math.max(1, listWidth - 23) : 28,
                    )}
                  </Text>
                  <Text color={isSelected ? undefined : famColor} dimColor={!isSelected}>
                    {' '}
                    [{p.family}]
                  </Text>
                  <Text dimColor>
                    {' '}
                    {p.models.length} {p.id === 'acp' ? 'agent' : 'model'}
                    {p.models.length === 1 ? '' : 's'}
                  </Text>
                </Text>
              );
            })}
            {providerWindow.end < providerOptions.length ? (
              <Text dimColor>▼ {providerOptions.length - providerWindow.end} below</Text>
            ) : null}
          </Box>
        )}
        {hint ? (
          <Text color={UI_COLORS.hint} wrap="truncate-end">
            {hint}
          </Text>
        ) : null}
      </Box>
    );
    if (!split || !focused) return list;
    // Use a compact catalog-sized preview, not all spare terminal rows. Size
    // against the whole provider list so moving the selection stays stable.
    const largestCatalog = providerOptions.reduce(
      (largest, provider) => Math.max(largest, provider.models.length),
      0,
    );
    const previewBudget = Math.max(1, Math.min(MAX_VISIBLE, largestCatalog, rowBudget - 10));
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
          maxHeight={rowBudget}
          overflow="hidden"
        >
          <Text color={UI_COLORS.title} bold wrap="truncate-end">
            {focused.id}
          </Text>
          <Text wrap="truncate-end">
            <Text dimColor>family: </Text>
            {focused.family}
          </Text>
          <Text wrap="truncate-end">
            <Text dimColor>models: </Text>
            {focused.models.length}
          </Text>
          <Text wrap="truncate-end">
            <Text dimColor>source: </Text>
            {focused.modelsLabel ?? 'provider catalog/config'}
          </Text>
          <Text> </Text>
          <Text dimColor wrap="truncate-end">
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
  const { start, end } = getVisibleWindow(selected, total, visibleLimit);
  const visibleItems = filteredOptions.slice(start, end);

  const searchHint = searchQuery
    ? ` | filter:"${searchQuery}" → ${total} match${total === 1 ? '' : 'es'}`
    : total > MAX_VISIBLE
      ? ` (${total} models — type to filter)`
      : '';

  const focusedModel = filteredOptions[Math.max(0, Math.min(selected, filteredOptions.length - 1))];
  // Built as a string, not JSX children: a conditional segment inline in JSX
  // loses the separating space to whitespace collapsing.
  const navHint = compact
    ? `↑↓ · Enter select · Esc back${effortOptions.length > 0 ? ' · ←→ effort' : ''}`
    : [
        '↑/↓ navigate',
        ...(effortOptions.length > 0 ? ['←/→ effort'] : []),
        'Enter select',
        'Esc back',
        'Ctrl+C exit',
        'type to filter',
      ].join(' · ');
  const longestModel = filteredOptions.reduce((value, model) => Math.max(value, model.length), 0);
  // The focused row carries an effort chip ("  ‹ medium ›"). Its width is added
  // to the fixed list width rather than eaten from it: a bordered Box with a
  // hard `width` clips, it does not grow, so a chip sized in after the fact
  // would truncate the model id it belongs to.
  const effortChipWidth =
    effortOptions.length > 0
      ? effortOptions.reduce((value, option) => Math.max(value, option.length), 0) + 6
      : 0;
  const modelListWidth = Math.max(38, Math.min(62, longestModel + 7) + effortChipWidth);
  const split =
    columnsOverride !== undefined &&
    !compact &&
    columns >= modelListWidth + 42 &&
    Boolean(focusedModel);
  const modelList = (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={UI_COLORS.border}
      paddingX={1}
      {...(split ? { width: modelListWidth, flexShrink: 0 } : {})}
    >
      <Text color={UI_COLORS.title} bold wrap="truncate-end">
        {compact
          ? `${title} · Step 2/2 (${pickedProviderId}${searchHint})`
          : `━━ ${title} — Step 2/2: Pick model (${pickedProviderId}${searchHint}) ━━`}
      </Text>
      <Text dimColor wrap="truncate-end">
        {pickedProviderId === 'acp'
          ? `/acp config ${focusedModel ?? '<agent>'} · model / effort`
          : navHint}
      </Text>
      {total === 0 ? (
        <Text dimColor>
          {searchQuery
            ? `(no models match "${searchQuery}")`
            : '(no models known for this provider)'}
        </Text>
      ) : (
        <Box flexDirection="column" minHeight={visibleLimit + 2}>
          {start > 0 && <Text dimColor>▲ {start} above</Text>}
          {visibleItems.map((id, vi) => {
            const absoluteIndex = start + vi;
            const isSelected = absoluteIndex === selected;
            return (
              <Text
                key={id}
                wrap="truncate-end"
                inverse={isSelected}
                {...(isSelected ? { color: UI_COLORS.selectedModel } : {})}
              >
                {isSelected ? '› ' : '  '}
                {truncateDisplay(
                  pickedProviderId === 'acp' ? `ACP · ${id}` : id,
                  Math.max(
                    1,
                    (split ? modelListWidth : columns) - 6 - (isSelected ? effortChipWidth : 0),
                  ),
                )}
                {isSelected && effortOptions.length > 0 ? `  ‹ ${effortChoice} ›` : ''}
              </Text>
            );
          })}
          {/* Pad remaining slots so old longer list never leaves ghost text */}
          {Array.from({ length: visibleLimit - visibleItems.length }).map((_, i) => (
            <Text key={`pad-${i}`}> </Text>
          ))}
          {end < total && <Text dimColor>▼ {total - end} below</Text>}
        </Box>
      )}
      {hint ? (
        <Text color={UI_COLORS.hint} wrap="truncate-end">
          {hint}
        </Text>
      ) : null}
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
        maxHeight={rowBudget}
        overflow="hidden"
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
          <Text dimColor>effort (←/→): </Text>
          {effortOptions.length === 0 ? (
            <Text dimColor>not adjustable for this model</Text>
          ) : (
            effortOptions.map((option, index) => (
              <Text key={option}>
                {index > 0 ? <Text dimColor> · </Text> : null}
                <Text
                  bold={option === effortChoice}
                  dimColor={option !== effortChoice}
                  {...(option === effortChoice ? { color: UI_COLORS.selectedModel } : {})}
                >
                  {option === effortChoice ? `[${option}]` : option}
                </Text>
              </Text>
            ))
          )}
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
        <Text dimColor>
          {effortOptions.length > 0 && effortChoice !== EFFORT_KEEP
            ? `Enter switches to this provider/model and saves reasoning effort "${effortChoice}".`
            : 'Enter switches the active session to this provider/model pair.'}
        </Text>
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

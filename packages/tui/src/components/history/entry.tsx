import type { TodoItem } from '@wrongstack/core/agent';
import { hasOpenTodos } from '@wrongstack/core/utils';
import type { ParsedNextStep } from '@wrongstack/tools/next-steps';
import { parseNextSteps } from '@wrongstack/tools/next-steps';
import React, { useEffect, useMemo } from 'react';
import { MEMORY_GATE_DEFAULTS } from '../../history-entry.js';
import { Box, Text } from '../../ink.js';
import { sanitizeTerminalText } from '../../terminal-width.js';
import { theme } from '../../theme.js';
import { fmtRatioPct } from '../status-bar-format.js';
import { AssistantBody, assistantContentWidth } from './assistant.js';
import { Banner } from './banner.js';
import {
  brainRiskColor,
  brainStatusStyle,
  brainTierColor,
  councilHeadline,
  councilSeatLine,
  formatScoreTerms,
  MAX_MEMORY_PROOF_ROWS,
  memoryLifecycleStyle,
  NoticeCard,
} from './entry-helpers.js';
import { ToolEntry } from './tool-entry.js';
import type { HistoryEntry } from './types.js';
import { fmtTok } from './utils.js';
import { INFO_PREFIX, USER_LABEL } from './wrap-geometry.js';

export { councilHeadline, councilSeatLine } from './entry-helpers.js';

// ── Entry ──

export const Entry = React.memo(function Entry({
  entry,
  termWidth,
  termHeight,
  setSuggestions,
  autonomyMode,
  multiDiffSummaryThreshold,
  todos,
  showModelReasoning,
  showSageMemoryInject,
}: {
  entry: HistoryEntry;
  termWidth: number;
  /** Available managed-history rows; used by height-aware entries such as the banner. */
  termHeight?: number | undefined;
  /** Store parsed next steps in the shared suggestion store so /next 1 works. */
  setSuggestions?: ((steps: string[]) => void) | undefined;
  /** Current autonomy mode — when 'auto', first step shows an auto marker. */
  autonomyMode?: string | undefined;
  /** User-tunable cutoff for the multi-file diff summary footer. Passes
   *  through to `formatMultiDiffSummary`; `undefined` means "use default". */
  multiDiffSummaryThreshold?: number | undefined;
  /** Live todo list. When non-empty (pending/in_progress), the NEXT STEPS
   *  panel is hidden and the store is not written — same rule as the host
   *  callback (b0970387), so the two paths agree. */
  todos?: readonly TodoItem[] | undefined;
  /**
   * Show the "Model Reasoning" blocks in chat history. When false,
   * `kind: 'thinking'` entries render as an empty fragment. Default: true.
   */
  showModelReasoning?: boolean | undefined;
  /**
   * Show SAGE Memory Inject blocks in tool results. When false,
   * the `SageMemoryBlock` panel is hidden even when memory was injected.
   * Default: false.
   */
  showSageMemoryInject?: boolean | undefined;
}): React.ReactElement | null {
  // Whether the agent still has open (pending/in_progress) todos. While it
  // does, finishing them takes priority over offering `<nextsteps>` — both
  // the host callback (execution.ts → parseSuggestionsFromOutput) and this
  // render path gate on the same condition (b0970387) so they never disagree
  // about whether suggestions are available.
  const openTodos = hasOpenTodos(todos);

  // Whether this entry is the final assistant message of its turn. Mid-turn
  // prose — text the model wrote on its way to a tool call — keeps its
  // `<nextsteps>` block stripped from the body but never surfaces a panel or
  // writes the suggestion store; offering suggestions while the turn is still
  // in flight lets `/next` and auto-submit pivot away from unfinished work.
  // Every construction site sets the flag, so an entry without it (an older
  // persisted shape, a path we missed) shows no suggestions rather than
  // silently leaking mid-turn ones.
  const isFinalTurnEntry = entry.kind === 'assistant' && entry.final === true;

  // Parse next steps from assistant text — computed once, used only in
  // the assistant case. Must live at the top level (hooks rules).
  // Always parse (even when todos are open) so `stripped` is available and
  // the raw `<nextsteps>` block never leaks into the message body; only the
  // panel rendering and the store write are gated below.
  const nextSteps = useMemo(() => {
    if (entry.kind !== 'assistant') return { steps: [] as ParsedNextStep[], stripped: '' };
    // strict=true retained for compatibility; parser accepts canonical <nextsteps> only.
    return parseNextSteps(entry.text, true);
  }, [entry.kind, (entry as never as { text?: string }).text]);

  // Store parsed next steps in the shared suggestion store (for /next and
  // auto-submit countdown). Strict=true accepts 💡 headings or <nextsteps> XML tags
  // (consistent with what the TUI renders in the message body).
  // Skipped while todos are open — mirrors parseSuggestionsFromOutput, so the
  // store isn't repopulated here right after the host callback cleared it.
  // NOTE: Only assistant entries should have <nextsteps> — subagents return
  // task results, not suggestions, so we skip parsing for subagent entries.
  useEffect(() => {
    if (!setSuggestions) return;
    if (entry.kind !== 'assistant') return;
    if (openTodos) return;
    if (!isFinalTurnEntry) return;
    const text = (entry as never as { text?: string }).text ?? '';
    const { texts } = parseNextSteps(text, true);
    if (texts.length > 0) setSuggestions(texts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    entry.kind,
    (entry as never as { text?: string }).text,
    openTodos,
    isFinalTurnEntry,
    setSuggestions,
  ]);

  switch (entry.kind) {
    case 'user':
      return (
        <Box
          marginX={0}
          borderStyle="single"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor={theme.user}
          paddingLeft={1}
        >
          <Text>
            <Text bold color={theme.user}>
              {USER_LABEL}
            </Text>
            <Text color="white">{sanitizeTerminalText(entry.text)}</Text>
            {entry.queued ? <Text dimColor>{' (queued)'}</Text> : null}
            {entry.pasteContent ? (
              <>
                {entry.text ? '\n' : null}
                <Text dimColor>
                  {'  ↳ '}
                  {sanitizeTerminalText(entry.pasteContent)}
                </Text>
              </>
            ) : null}
          </Text>
        </Box>
      );
    case 'thinking': {
      // Hidden when the user disables model reasoning display.
      if (showModelReasoning === false) return null;
      const contentWidth = assistantContentWidth(termWidth);
      return (
        <Box
          flexDirection="column"
          marginX={0}
          marginY={1}
          borderStyle="single"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor={theme.textSecondary}
          paddingLeft={1}
        >
          <Box flexDirection="row">
            <Text bold color={theme.textSecondary}>
              {'⟳ Model Reasoning'}
            </Text>
            <Text color={theme.textSecondary}>{'  (model reasoning…)'}</Text>
          </Box>
          <Box width={contentWidth}>
            <Text color={theme.textSecondary}>{sanitizeTerminalText(entry.text)}</Text>
          </Box>
        </Box>
      );
    }
    case 'assistant': {
      const contentWidth = assistantContentWidth(termWidth);
      const { steps, stripped } = nextSteps;
      // Panel only when there are steps, no open todos (mirrors the host
      // callback — suggestions are suppressed mid-task), and this is the
      // turn's final message (mid-turn prose never offers suggestions).
      const hasNext = steps.length > 0 && !openTodos && isFinalTurnEntry;
      return (
        <Box flexDirection="column">
          <Box
            flexDirection="column"
            marginX={0}
            marginY={1}
            borderStyle="single"
            borderTop={false}
            borderRight={false}
            borderBottom={false}
            borderColor={theme.assistant}
            paddingLeft={1}
          >
            <Box flexDirection="row">
              <Text bold color={theme.assistant}>
                {'💬 ASSISTANT'}
              </Text>
            </Box>
            <AssistantBody text={stripped} termWidth={termWidth} contentWidth={contentWidth} />
          </Box>
          {hasNext && (
            <Box
              flexDirection="column"
              marginX={0}
              marginY={1}
              borderStyle="single"
              borderTop={false}
              borderRight={false}
              borderBottom={false}
              borderColor={theme.accent}
              paddingLeft={1}
            >
              <Box flexDirection="row" marginBottom={1}>
                <Text bold color={theme.accent}>
                  {'💡 NEXT STEPS  '}
                </Text>
                <Text dimColor>(use /next 1, /next 1 2 3 to select)</Text>
              </Box>
              {steps.map((s, i) => (
                <Box key={s.index} flexDirection="row" marginTop={0}>
                  <Text>
                    <Text bold color={theme.accent}>{`  ${s.index}. `}</Text>
                    <Text>{sanitizeTerminalText(s.text)}</Text>
                    {s.auto ? (
                      <Text color="cyan" dimColor>
                        {' '}
                        auto
                      </Text>
                    ) : null}
                    {autonomyMode === 'auto' && i === 0 ? <Text color="cyan">{'  ⏩'}</Text> : null}
                  </Text>
                </Box>
              ))}
            </Box>
          )}
        </Box>
      );
    }
    case 'tool': {
      return (
        <ToolEntry
          entry={entry}
          termWidth={termWidth}
          multiDiffSummaryThreshold={multiDiffSummaryThreshold}
          showSageMemoryInject={showSageMemoryInject}
        />
      );
    }
    case 'memory-activation': {
      // Only a FAILED run gets its own card. A successful one is already on
      // screen as the SAGE memory panel under the tool result — showing the
      // injector's arithmetic beside it said the same thing twice, so the
      // numbers moved onto that panel's header and the full decision proof
      // (scores against their gates, the searched query, reject buckets)
      // lives in the context panel, which also keeps the runs that injected
      // nothing. The proof render below stays for the error path and for
      // sessions replayed from before this split.
      if (!entry.error) return null;
      const rejected = Object.entries(entry.rejected)
        .filter(([, count]) => count > 0)
        .map(([reason, count]) => `${reason} ${count}`)
        .join(' · ');
      // On a failed run, `injectedIds` is empty (nothing made it through the
      // gate), so filtering activated by it would blank the proof card. Show
      // every activated candidate instead — the operator still wants to see
      // what was considered before the rejection, with score vs gates.
      const injected =
        entry.outcome === 'error'
          ? entry.activated
          : entry.activated.filter((memory) => entry.injectedIds.includes(memory.id));
      const shown = injected.slice(0, MAX_MEMORY_PROOF_ROWS);
      const overflow = injected.length - shown.length;
      // Entries rehydrated from a session recorded before the proof fields
      // existed carry neither thresholds nor score terms. Fall back to the
      // shipped defaults rather than crashing the whole transcript render.
      const thresholds = entry.thresholds ?? MEMORY_GATE_DEFAULTS;
      return (
        <Box flexDirection="column" borderStyle="single" borderColor="magenta" paddingX={1}>
          <Box flexDirection="row">
            <Text bold color="magenta">
              {'🧠 MEMORY INJECTOR  '}
            </Text>
            <Text color="cyan">{entry.trigger}</Text>
            <Text dimColor>
              {`  ${entry.activated.length} activated → ${entry.injectedIds.length} injected / ${entry.candidates} · ctx ${fmtRatioPct(entry.contextPressure)} · +${entry.injectedChars} chars`}
            </Text>
          </Box>
          {entry.error ? <Text color="red">{`error: ${entry.error}`}</Text> : null}
          {/* The searched text, not the user's message. When task-aware
              planning is on this carries todo/Kanban text, which is usually
              the real reason an "unrelated" memory matched. */}
          {entry.queryPreview ? (
            <Text dimColor wrap="truncate-end">
              {`query: ${entry.queryPreview}`}
            </Text>
          ) : null}
          {shown.map((memory) => {
            const scorePass = memory.score >= thresholds.minScore;
            const relationPass = memory.relationStrength >= thresholds.relationFloor;
            const reason = memory.activationReasons[0] ?? 'no recorded reason';
            return (
              <Box key={memory.id} flexDirection="column">
                <Text wrap="truncate-end">
                  <Text color="green">{`${memory.id} `}</Text>
                  <Text color={scorePass ? 'green' : 'red'}>
                    {`${memory.score.toFixed(2)} ${scorePass ? '✓' : '✗'} ${thresholds.minScore.toFixed(2)}`}
                  </Text>
                  <Text dimColor>{' · relation '}</Text>
                  <Text color={relationPass ? 'green' : 'red'}>
                    {`${memory.relationStrength.toFixed(2)} ${relationPass ? '✓' : '✗'} ${thresholds.relationFloor.toFixed(2)}`}
                  </Text>
                  <Text dimColor>{` · ${reason}`}</Text>
                </Text>
                <Text dimColor wrap="truncate-end">
                  {`  ${formatScoreTerms(memory.scoreTerms ?? [])}`}
                </Text>
              </Box>
            );
          })}
          {overflow > 0 ? <Text dimColor>{`  +${overflow} more injected`}</Text> : null}
          {rejected ? <Text dimColor>{`filtered: ${rejected}`}</Text> : null}
        </Box>
      );
    }
    case 'memory-lifecycle': {
      const style = memoryLifecycleStyle(entry.action);
      return (
        <Box flexDirection="row">
          <Text bold color={style.color}>{`${style.icon} MEMORY  `}</Text>
          <Text color={style.color}>{entry.label}</Text>
          {entry.detail ? <Text dimColor>{`  · ${entry.detail}`}</Text> : null}
        </Box>
      );
    }
    case 'info': {
      return (
        <Text dimColor>
          <Text>{INFO_PREFIX}</Text>
          {sanitizeTerminalText(entry.text)}
        </Text>
      );
    }
    case 'warn':
      // Compact single-line tag for warnings. Previously rendered as a
      // full-bordered NoticeCard that took 4+ lines — now a one-liner so
      // common warnings (retries, rate-limits) don't dominate the history.
      return (
        <Box flexDirection="row" marginY={0}>
          <Text>
            <Text bold color={theme.warn}>
              {'⚠ '}
            </Text>
            <Text color={theme.warn}>{sanitizeTerminalText(entry.text)}</Text>
          </Text>
        </Box>
      );
    case 'error':
      return (
        <NoticeCard
          icon="✗"
          label="ERROR"
          color={theme.error}
          text={entry.text}
          termWidth={termWidth}
        />
      );
    case 'turn-summary':
      return (
        <Box
          marginX={0}
          borderStyle="single"
          borderColor={theme.textMuted}
          backgroundColor={theme.surfaceRaised}
          paddingX={1}
        >
          <Text>
            <Text color={theme.brandPrimary}>{'📋 '}</Text>
            <Text color={theme.textSecondary}>{sanitizeTerminalText(entry.text)}</Text>
          </Text>
        </Box>
      );
    case 'model-switch': {
      const shrink =
        entry.fromContext !== undefined &&
        entry.toContext !== undefined &&
        entry.toContext > 0 &&
        entry.toContext < entry.fromContext;
      const accent = shrink ? theme.warn : theme.accent;
      const ctxChip = (ctx: number | undefined): string =>
        ctx && ctx > 0 ? `${fmtTok(ctx)} ctx` : '';
      const fromRef =
        entry.fromProvider && entry.fromModel
          ? `${entry.fromProvider} / ${entry.fromModel}`
          : undefined;
      const toRef = `${entry.toProvider} / ${entry.toModel}`;
      const fromChip = ctxChip(entry.fromContext);
      const toChip = ctxChip(entry.toContext);
      const pct =
        shrink && entry.requestTokens && entry.requestTokens > 0 && entry.toContext
          ? fmtRatioPct(entry.requestTokens / entry.toContext)
          : undefined;
      return (
        <Box
          flexDirection="column"
          marginX={0}
          marginY={1}
          borderStyle="round"
          borderColor={accent}
          paddingX={1}
        >
          <Text bold color={accent}>
            {'🔄 MODEL SWITCHED'}
          </Text>
          {fromRef ? (
            <Text>
              <Text dimColor>{'  from  '}</Text>
              <Text dimColor>{fromRef}</Text>
              {fromChip ? <Text dimColor>{`   ${fromChip}`}</Text> : null}
            </Text>
          ) : null}
          <Text>
            <Text dimColor>{fromRef ? '  to    ' : '  now   '}</Text>
            <Text bold color={theme.assistant}>
              {toRef}
            </Text>
            {toChip ? (
              <Text color={shrink ? theme.warn : theme.success}>{`   ${toChip}`}</Text>
            ) : null}
          </Text>
          <Text color={theme.success}>
            {entry.runActive
              ? '  ✓ active for next LLM request · current run continues'
              : '  ✓ active for next LLM request'}
          </Text>
          {shrink ? (
            <Text color={theme.warn}>
              {`  ⚠ smaller window: ${fmtTok(entry.fromContext as number)} → ${fmtTok(
                entry.toContext as number,
              )}${
                pct !== undefined
                  ? ` · request ≈ ${fmtTok(entry.requestTokens as number)} (${pct} of new window)`
                  : ''
              }`}
            </Text>
          ) : null}
        </Box>
      );
    }
    case 'brain': {
      const statusStyle = brainStatusStyle(entry.status);
      const riskColor = brainRiskColor(entry.risk);
      // Shared left indent so nested details visually nest under the header.
      const indentWidth = 2;
      return (
        <Box
          flexDirection="column"
          marginX={0}
          marginY={1}
          borderStyle="single"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor={theme.monitor.agents}
          paddingLeft={1}
        >
          <Box flexDirection="row" gap={1}>
            <Text bold color={theme.monitor.agents}>
              {'✦ BRAIN'}
            </Text>
            <Text color={statusStyle.color}>{statusStyle.icon}</Text>
            <Text dimColor>{entry.source}</Text>
            <Text dimColor>·</Text>
            <Text bold color={riskColor}>
              {entry.risk}
            </Text>
            {/* Which tier decided. A free rule hit and a multi-model council
                call are otherwise the same line in the transcript. */}
            {entry.tier ? (
              <>
                <Text dimColor>·</Text>
                <Text
                  dimColor={brainTierColor(entry.tier) === undefined}
                  color={brainTierColor(entry.tier)}
                >
                  {entry.tier}
                </Text>
              </>
            ) : null}
          </Box>
          <Box paddingLeft={indentWidth}>
            <Text color={theme.textPrimary}>{entry.question}</Text>
          </Box>
          {entry.decision ? (
            <Box paddingLeft={indentWidth} marginTop={1}>
              <Text>
                <Text bold color={statusStyle.color}>
                  {'↳ Decision: '}
                </Text>
                <Text color={theme.textPrimary}>{entry.decision}</Text>
              </Text>
            </Box>
          ) : null}
          {entry.rationale ? (
            <Box paddingLeft={indentWidth} marginTop={1}>
              <Text dimColor>{entry.rationale}</Text>
            </Box>
          ) : null}
          {entry.outcome ? (
            <Box paddingLeft={indentWidth} marginTop={1}>
              <Text>
                <Text bold color={statusStyle.color}>
                  {'✓ Outcome: '}
                </Text>
                <Text color={theme.textPrimary}>{entry.outcome}</Text>
              </Text>
            </Box>
          ) : null}
          {entry.council ? (
            <Box flexDirection="column" paddingLeft={indentWidth} marginTop={1}>
              <Text dimColor>{councilHeadline(entry.council)}</Text>
              {entry.council.seats.map((seat) => (
                <Text
                  key={seat.seatId}
                  dimColor={!seat.changed}
                  color={seat.changed ? theme.warn : undefined}
                >
                  {councilSeatLine(seat)}
                </Text>
              ))}
              {(entry.council.warnings ?? []).map((warning) => (
                <Text key={warning} color={theme.warn}>
                  {`   ⚠ ${warning}`}
                </Text>
              ))}
            </Box>
          ) : null}
        </Box>
      );
    }
    case 'confirm':
      return (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={theme.warn}
          paddingX={1}
          marginY={1}
        >
          <Text bold color={theme.warn}>
            {'⚠ Confirm: '}
            {entry.toolName}
          </Text>
          <Text dimColor>Waiting for y / n / a / d...</Text>
        </Box>
      );
    case 'banner':
      return (
        <Banner
          entry={entry}
          termWidth={termWidth}
          {...(termHeight === undefined ? {} : { termHeight })}
        />
      );
    case 'subagent': {
      // Quiet single-line fleet/delegate chrome: no heavy colored rail and no
      // vertical margin that punches holes between history items. Role color
      // stays on the icon + label only.
      const lines = sanitizeTerminalText(entry.text).split('\n');
      return (
        <Box flexDirection="column" marginX={0} marginY={0} paddingLeft={0}>
          <Text>
            <Text color={theme.borderSubtle}>│ </Text>
            <Text color={entry.agentColor}>{sanitizeTerminalText(entry.icon)}</Text>
            <Text> </Text>
            <Text bold color={entry.agentColor}>
              {sanitizeTerminalText(entry.agentLabel)}
            </Text>
            <Text> </Text>
            <Text color={theme.textSecondary}>{lines[0] ?? ''}</Text>
            {entry.detail ? (
              <>
                <Text color={theme.textMuted}>{'  ·  '}</Text>
                <Text color={theme.textMuted}>{sanitizeTerminalText(entry.detail)}</Text>
              </>
            ) : null}
          </Text>
          {lines.slice(1).map((line, i) => (
            <Text key={i}>
              <Text color={theme.borderSubtle}>│ </Text>
              <Text color={theme.textMuted}>{line}</Text>
            </Text>
          ))}
        </Box>
      );
    }
  }
});

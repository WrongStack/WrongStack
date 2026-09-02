import type React from 'react';
import { Box, Text } from '../ink.js';
import { theme } from '../theme.js';
import { normalizeTuiThinkingWord } from '../thinking-word.js';
import { glyphs } from '../ui-glyphs.js';
import {
  KeyCap,
  MonitorShell,
  SectionLabel,
  truncatePanelText,
  useMonitorSize,
} from './monitor-shell.js';
import {
  fmtElapsed,
  fmtMemory,
  fmtRatioPct,
  renderMeter,
  truncateChip,
} from './status-bar-format.js';
import type { StatusBarProps } from './status-bar-types.js';
import { STATUSLINE_ITEMS } from './statusline-picker.js';

/** Compact token formatting — mirrors the pattern from status-bar.tsx. */
function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Detailed status panel showing all status line information in a structured
 * read-only view. Toggle via F12 picker's detail option or Esc to close.
 */
export function StatuslineDetailPanel(
  props: StatusBarProps & { onClose: () => void },
): React.ReactElement {
  const {
    model,
    version,
    state,
    queueCount = 0,
    yolo,
    autonomy,
    startedAt,
    projectName,
    workingDir,
    git,
    context,
    todos,
    plan,
    tasks,
    fleet,
    subagentCount = 0,
    processCount = 0,
    brain,
    mailbox,
    goalSummary,
    modeLabel,
    hint,
    sessionCount,
    toolCount,
    tokenSavingMode,
    sideEffectCount = 0,
    debugStreamStats,
    enhanceCountdown,
    nextStepsAutoSubmitCountdown,
    nextStepsAutoSubmitLabel,
    autoProceedCountdown,
    breakerCountdown,
    indexState,
    sessionId,
    thinkingWord,
  } = props;

  const size = useMonitorSize();
  const contentW = size.contentWidth;

  const elapsedMs = startedAt != null ? Date.now() - startedAt : 0;
  const stateLabel = stateChipLabel(state, fleet?.running ?? 0, thinkingWord);
  const ctxRatio = context ? context.used / context.max : 0;
  const ctxPct = context ? fmtRatioPct(ctxRatio) : '—';

  function chipRow(
    label: string,
    value: string,
    chipColor = theme.textPrimary,
  ): React.ReactElement {
    return (
      <Box key={label}>
        <Text color={theme.textMuted}>{label.padEnd(16)}</Text>
        <Text color={chipColor}>{truncatePanelText(value, Math.max(10, contentW - 18))}</Text>
      </Box>
    );
  }

  return (
    <MonitorShell
      accent={theme.accent}
      icon={glyphs.terminal}
      title="STATUS DETAIL"
      kicker={size.columns >= 78 ? 'all status fields' : undefined}
      right={
        <Text color={theme.textMuted}>
          {STATUSLINE_ITEMS.length} chips · {props.visibleChips?.length ?? 0} visible
        </Text>
      }
      footer={
        <Box gap={2}>
          <KeyCap keyName="Esc" label="close" color={theme.error} />
        </Box>
      }
      grow
    >
      <Box flexDirection="column" marginTop={1} gap={1}>
        {/* ── Runtime ── */}
        <SectionLabel color={theme.warn}>RUNTIME</SectionLabel>
        {chipRow('Version', version ? `WS v${version}` : '—')}
        {chipRow('State', stateLabel)}
        {chipRow('Model', model)}
        {chipRow(
          'Context',
          context
            ? `${ctxPct} ${renderMeter(Math.min(ctxRatio, 1), 8)} of ${fmtTok(context.max)}`
            : '—',
        )}
        {queueCount > 0 ? chipRow('Queue', String(queueCount)) : null}
        {processCount > 0 ? chipRow('Processes', `${processCount} active`) : null}
        {breakerCountdown
          ? chipRow('Breaker', `${Math.ceil(breakerCountdown.remainingMs / 1000)}s`)
          : null}
        {hint ? chipRow('Hint', hint, theme.warn) : null}
        {indexState
          ? chipRow(
              'Index',
              indexState.indexing
                ? `indexing ${indexState.currentFile}/${indexState.totalFiles}`
                : indexState.circuit?.state === 'open'
                  ? 'paused'
                  : indexState.ready
                    ? 'ready'
                    : 'idle',
            )
          : null}
        {indexState?.server
          ? chipRow(
              'Index server',
              indexState.server.status === 'connected'
                ? `${indexState.server.health?.status === 'healthy' ? 'healthy' : 'connected'}${indexState.server.pid ? ` · PID ${indexState.server.pid}` : ''}`
                : indexState.server.status === 'offline'
                  ? 'disconnected'
                  : indexState.server.status === 'error' && indexState.server.lastError
                    ? `error · ${indexState.server.lastError}`
                    : indexState.server.status,
              indexState.server.status === 'connected'
                ? theme.success
                : indexState.server.status === 'error' ||
                    indexState.server.status === 'unresponsive'
                  ? theme.error
                  : theme.warn,
            )
          : null}
        {indexState?.server?.health
          ? chipRow(
              'Server health',
              `${indexState.server.health.status}${indexState.server.health.latencyMs != null ? ` · RTT ${indexState.server.health.latencyMs}ms` : ''} · missed ${indexState.server.health.missedHeartbeats}`,
              indexState.server.health.status === 'healthy'
                ? theme.success
                : indexState.server.health.status === 'unresponsive'
                  ? theme.error
                  : theme.warn,
            )
          : null}
        {indexState?.server?.health?.server
          ? chipRow(
              'Server process',
              `RAM ${fmtMemory(indexState.server.health.server.memory.rss)} · heap ${fmtMemory(indexState.server.health.server.memory.heapUsed)}/${fmtMemory(indexState.server.health.server.memory.heapTotal)} · up ${fmtElapsed(indexState.server.health.server.uptimeMs)}`,
            )
          : null}
        {indexState?.server?.health?.server
          ? chipRow(
              'Server load',
              `${indexState.server.health.server.clients} clients · ${indexState.server.health.server.activeRequests} req · writes ${indexState.server.health.server.activeWrites}/${indexState.server.health.server.queuedWrites}q · ${indexState.server.health.server.pendingExternalFiles} pending · watcher ${indexState.server.health.server.watchingExternal ? `${indexState.server.health.server.watchingClients ?? '?'} owners` : 'off'}`,
            )
          : null}
        {indexState?.server?.health?.server?.clientLeaseTimeoutMs != null
          ? chipRow(
              'Client lease',
              `${fmtElapsed(indexState.server.health.server.oldestClientIdleMs ?? 0)} idle / ${fmtElapsed(indexState.server.health.server.clientLeaseTimeoutMs)} timeout`,
            )
          : null}

        {/* ── Session ── */}
        <SectionLabel color={theme.textMuted}>SESSION</SectionLabel>
        {chipRow('Session', sessionId?.slice(0, 12) ?? '—')}
        {startedAt != null ? chipRow('Elapsed', fmtElapsed(elapsedMs)) : null}
        {projectName ? chipRow('Project', projectName, theme.accent) : null}
        {workingDir ? chipRow('Working dir', truncateChip(workingDir, 40), theme.accent) : null}
        {yolo ? chipRow('YOLO', 'ON', 'red') : null}
        {autonomy && autonomy !== 'off'
          ? chipRow('Autonomy', autonomy.toUpperCase(), autonomy === 'eternal' ? 'red' : 'yellow')
          : null}
        {git ? chipRow('Git branch', git.branch, 'magenta') : null}
        {modeLabel ? chipRow('Mode', modeLabel) : null}
        {sessionCount != null && sessionCount > 0
          ? chipRow('Sessions', String(sessionCount))
          : null}
        {toolCount != null ? chipRow('Tools', String(toolCount)) : null}
        {tokenSavingMode !== undefined && tokenSavingMode !== 'off'
          ? chipRow('Token saving', tokenSavingMode, 'yellow')
          : null}
        {autoProceedCountdown != null ? chipRow('Auto-proceed', `${autoProceedCountdown}s`) : null}
        {nextStepsAutoSubmitCountdown != null
          ? chipRow(
              'Next-steps auto',
              `${nextStepsAutoSubmitCountdown}s${nextStepsAutoSubmitLabel ? ` · ${truncateChip(nextStepsAutoSubmitLabel, 28)}` : ''}`,
            )
          : null}

        {/* ── Work ── */}
        <SectionLabel color={theme.success}>WORK</SectionLabel>
        {todos && (todos.pending > 0 || todos.inProgress > 0 || todos.completed > 0)
          ? chipRow('Todos', `⌛${todos.inProgress} ☐${todos.pending} ✓${todos.completed}`)
          : null}
        {plan && (plan.open > 0 || plan.inProgress > 0 || plan.done > 0)
          ? chipRow(
              'Plan',
              `⌛${plan.inProgress} ☐${plan.open} ✓${plan.done}${plan.scope ? ` [${plan.scope}]` : ''}`,
            )
          : null}
        {tasks && (tasks.pending > 0 || tasks.inProgress > 0)
          ? chipRow(
              'Tasks',
              `⌛${tasks.inProgress} ☐${tasks.pending}${tasks.blocked > 0 ? ` ⊘${tasks.blocked}` : ''}${tasks.completed > 0 ? ` ✓${tasks.completed}` : ''}${tasks.failed > 0 ? ` ✗${tasks.failed}` : ''}${tasks.scope ? ` [${tasks.scope}]` : ''}`,
            )
          : null}
        {fleet || subagentCount > 0
          ? chipRow(
              'Fleet agents',
              fleet
                ? `▶${fleet.running} ☐${fleet.pending} ·${fleet.idle} ✓${fleet.completed}`
                : `${subagentCount} agent${subagentCount === 1 ? '' : 's'}`,
            )
          : null}
        {goalSummary
          ? chipRow(
              'Goal',
              `${truncateChip(goalSummary.goal, 48)} [${goalSummary.goalState}] iter ${goalSummary.iterations}`,
            )
          : null}
        {enhanceCountdown != null ? chipRow('Enhance', `auto-send in ${enhanceCountdown}s`) : null}
        {debugStreamStats
          ? chipRow(
              'Debug stream',
              `#${debugStreamStats.chunkCount} · ${debugStreamStats.lastChunkSize}B · +${debugStreamStats.lastDeltaMs}ms`,
            )
          : null}
        {sideEffectCount > 0 ? chipRow('Side effects', String(sideEffectCount)) : null}

        {/* ── Connectivity ── */}
        {mailbox ? (
          <>
            <SectionLabel color={theme.warn}>CONNECTIVITY</SectionLabel>
            {chipRow(
              'Mailbox unread',
              String(mailbox.unread),
              mailbox.unread > 0 ? 'yellow' : 'green',
            )}
            {chipRow('Online agents', String(mailbox.onlineAgents))}
            {mailbox.lastSubject
              ? chipRow(
                  'Last message',
                  `${mailbox.lastFrom ? `${mailbox.lastFrom}: ` : ''}${truncateChip(mailbox.lastSubject, 40)}`,
                )
              : null}
          </>
        ) : null}
        {brain ? (
          <>
            <SectionLabel color={theme.warn}>BRAIN</SectionLabel>
            {chipRow(
              'State',
              brain.state,
              brain.state === 'denied' ? 'red' : brain.state === 'deciding' ? 'yellow' : 'green',
            )}
          </>
        ) : null}
      </Box>
    </MonitorShell>
  );
}

/** Recreate the state label logic from status-bar.tsx without coupling to the full chip renderer. */
function stateChipLabel(
  state: 'idle' | 'running' | 'streaming' | 'aborting',
  fleetRunning: number,
  thinkingWord?: string | undefined,
): string {
  if (state === 'idle' && fleetRunning > 0) return `agents ▶${fleetRunning}`;
  if (state === 'idle') return 'idle';
  if (state === 'aborting') return 'aborting…';
  return `${normalizeTuiThinkingWord(thinkingWord)}…`;
}

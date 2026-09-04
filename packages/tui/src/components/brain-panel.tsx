import type React from 'react';
import type { BrainLogEntry, BrainRiskLevel } from '../brain-contracts.js';
import { Box, Text, useStdout } from '../ink.js';

export type { BrainLogEntry, BrainRiskLevel } from '../brain-contracts.js';

import {
  BRAIN_READONLY_ROW_KINDS,
  type BrainDenyIsTerminal,
  type BrainHeuristicKey,
  type BrainPanelRow,
  type BrainPanelSettings,
  type BrainTerminalPolicyValue,
  type BrainTraceContent,
  brainPanelRows,
  personaLabel,
} from './brain-panel-model.js';

export interface BrainPanelProps {
  riskLevel: BrainRiskLevel;
  log: BrainLogEntry[];
  selected: number;
  hint?: string | undefined;
  /** Settings editor state — absent on hosts without a BrainPanelHost (legacy view). */
  view?: 'settings' | 'log' | undefined;
  settings?: BrainPanelSettings | undefined;
  row?: number | undefined;
  busy?: boolean | undefined;
}

const CHROME_ROWS = 14;

const RISK_DESCS: Record<BrainRiskLevel, string> = {
  off: 'Human decides everything',
  low: 'Auto-decide low risk only',
  medium: 'Auto-decide up to medium risk',
  high: 'Auto-decide up to high risk',
  all: 'Auto-decide everything',
};

const RISK_COLORS: Record<BrainRiskLevel, string> = {
  off: 'gray',
  low: 'green',
  medium: 'yellow',
  high: 'red',
  all: 'magenta',
};

const TERMINAL_POLICY_DESCS: Record<BrainTerminalPolicyValue, string> = {
  conservative: 'accept a recommended option at low/medium risk, else deny',
  'deny-all': 'never auto-accept — every headless escalation denies',
  'continue-on-recommended': 'accept a recommended option at ANY risk',
};

const DENY_TERMINAL_DESCS: Record<BrainDenyIsTerminal, string> = {
  never: 'a deny always falls through to escalation',
  'when-decided': 'a real refusal is terminal, infra failures fall through',
  always: 'any deny ends the decision (a dead pool then denies)',
};

const TRACE_CONTENT_DESCS: Record<BrainTraceContent, string> = {
  none: 'metadata only — no question/context text on disk',
  redacted: 'free text truncated',
  full: 'full content — required for replayable fixtures',
};

const HEURISTIC_META: Record<BrainHeuristicKey, { label: string; dim: string }> = {
  lowRiskAutoAnswer: {
    label: 'low-risk auto',
    dim: 'auto-answer low-risk asks that carry a recommendation',
  },
  blockedResolved: {
    label: 'blocked-resolved',
    dim: 'blocked + a resolution marker in context → continue',
  },
  deadlockSkip: { label: 'deadlock-skip', dim: 'deadlock + failed work units → skip and continue' },
  retryExhausted: {
    label: 'retry-exhausted',
    dim: 'demonstrably exhausted retries → mark failed, move on',
  },
  continuePing: {
    label: 'continue-ping',
    dim: 'bare continue ping with no alternative → continue',
  },
};

function fmtMs(ms: number | undefined, fallback: string): string {
  if (ms === undefined) return fallback;
  return ms % 60_000 === 0 ? `${ms / 60_000}m` : `${ms / 1000}s`;
}

/** One settings row → label + value strings. */
function rowText(
  row: BrainPanelRow,
  s: BrainPanelSettings,
): { label: string; value: string; dim?: string } {
  switch (row.kind) {
    case 'mode':
      return {
        label: 'Mode',
        value: s.mode.toUpperCase(),
        dim:
          s.mode === 'headless'
            ? 'never blocks on you (terminal policy)'
            : 'escalations prompt you',
      };
    case 'risk':
      return {
        label: 'Risk ceiling',
        value: s.riskLevel.toUpperCase(),
        dim: RISK_DESCS[s.riskLevel],
      };
    case 'strategy':
      return {
        label: 'Pool strategy',
        value: s.strategy,
        dim: 'fallback = ordered, round-robin = rotate',
      };
    case 'timeout':
      return { label: 'Decision timeout', value: fmtMs(s.decisionTimeoutMs, 'default (15s)') };
    case 'humanTimeout':
      return {
        label: 'Human timeout',
        value: fmtMs(s.humanTimeoutMs, 'off'),
        dim: s.humanTimeoutMs ? 'then terminal policy' : 'wait indefinitely',
      };
    case 'poolModel': {
      const label = s.pool[row.index] ?? '';
      const resolved = s.poolResolved.some((r) => r === label || r.endsWith(`/${label}`));
      return {
        label: `  ${row.index + 1}.`,
        value: label,
        dim: resolved ? 'd = remove' : 'UNRESOLVED — falls back to session model',
      };
    }
    case 'poolAdd':
      return {
        label: s.pool.length === 0 ? 'Decision model' : '  +',
        value: s.pool.length === 0 ? 'session model' : 'add model…',
        dim: s.pool.length === 0 ? 'Enter = pick a dedicated model' : 'Enter',
      };
    case 'councilToggle':
      return {
        label: 'Council',
        value: s.councilEnabled ? 'ON' : 'off',
        dim: s.councilEnabled
          ? s.voters.length === 0 && s.councilSeats.length > 0
            ? `seats from pool: ${s.councilSeats.join(', ')} · Enter = pick voters`
            : 'multi-LLM vote on high-stakes questions · Enter = add voter'
          : 'Enter = enable + pick voters · ←/→ toggle',
      };
    case 'councilMinRisk':
      return {
        label: '  risk floor',
        value: s.councilMinRisk,
        dim: 'council convenes at/above this risk',
      };
    case 'voter': {
      const v = s.voters[row.index];
      // Show the lens NAME, not the raw id: with six built-ins plus ad-hoc
      // lenses, "user-advocate" alone says less than "User Advocate", and a
      // custom lens is a whole sentence that only the catalog can shorten.
      const lens = personaLabel(s, v?.persona);
      return {
        label: `  ${row.index + 1}.`,
        value: v?.label ?? '',
        dim: `${lens}${v?.veto ? ' · VETO' : ''}${v?.weight ? ` · w=${v.weight}` : ''}  (p persona · v veto · d remove)`,
      };
    }
    case 'voterAdd':
      return { label: '  +', value: 'add voter…', dim: 'Enter' };
    case 'judge': {
      // A derived judge that is also a seated voter re-states its own vote
      // with the deciding weight — surface it rather than showing a bare
      // "auto".
      const note = s.judgeConfigured
        ? ''
        : s.judgeIsVoter
          ? ' (derived · also a voter)'
          : ' (derived)';
      return {
        label: '  judge',
        value: s.judgeLabel ? `${s.judgeLabel}${note}` : 'auto',
        dim: 'Enter = pick · d = auto',
      };
    }
    case 'councilQuorum':
      return {
        label: '  quorum',
        value: String(s.councilQuorum ?? 0.5),
        dim: 'fraction of seats that must return a valid vote',
      };
    case 'councilApproval':
      return {
        label: '  approval',
        value: String(s.councilApproval ?? 0.5),
        dim: 'winning weight must exceed this fraction, else the judge decides',
      };
    case 'councilDistinctness':
      return {
        label: '  distinctness',
        value: s.councilDistinctness,
        dim:
          s.councilDistinctness === 'none'
            ? 'off — a same-model panel agrees with itself and is never reported'
            : `warn when seats do not use distinct ${s.councilDistinctness}s`,
      };
    case 'councilTimeout':
      return {
        label: '  seat timeout',
        value:
          s.councilPerCallTimeoutMs === undefined ? 'default' : `${s.councilPerCallTimeoutMs}ms`,
        dim: 'per-seat completion budget (default = the decision timeout, else 45s)',
      };
    case 'councilConcurrency':
      return {
        label: '  concurrency',
        value:
          s.councilMaxConcurrency === undefined ? 'default (3)' : String(s.councilMaxConcurrency),
        dim: 'seats polled at once, 1..8 — higher is faster and burstier',
      };
    case 'councilVoterMaxTokens':
      return {
        label: '  voter tokens',
        value:
          s.councilVoterMaxTokens === undefined
            ? 'default (2000)'
            : String(s.councilVoterMaxTokens),
        dim: 'output budget per seat — reasoning models think from this budget',
      };
    case 'councilDeliberationRounds': {
      const rounds = s.councilDeliberationRounds;
      return {
        label: '  rounds',
        value: rounds === undefined ? 'default (2)' : rounds === 1 ? '1 (off)' : String(rounds),
        // Naming the multiplier here is the point: "3 seats" reads as three
        // calls, and with deliberation on it is three per round.
        dim: 'deliberation rounds — each one costs another call PER SEAT',
      };
    }
    case 'councilJudgeMaxTokens':
      return {
        label: '  judge tokens',
        value: s.councilJudgeMaxTokens === undefined ? 'default' : String(s.councilJudgeMaxTokens),
        dim: 'output budget for the tie-breaker call',
      };
    case 'ledgerToggle':
      return {
        label: 'Ledger',
        value: s.ledgerEnabled ? 'ON' : 'off',
        dim: 'records decisions + outcomes, feeds them back into prompts',
      };
    case 'autoDeny':
      return {
        label: '  auto-deny',
        value:
          s.autoDenyAfterFailures === undefined
            ? 'default (3)'
            : s.autoDenyAfterFailures === 0
              ? 'off'
              : String(s.autoDenyAfterFailures),
        dim: 'deny after N observed consecutive failures',
      };
    case 'terminalPolicy':
      return {
        label: 'Terminal policy',
        value: s.terminalPolicy,
        dim: TERMINAL_POLICY_DESCS[s.terminalPolicy],
      };
    case 'heuristic': {
      const meta = HEURISTIC_META[row.key];
      return {
        label: `  ${meta.label}`,
        value: s.heuristics[row.key] ? 'ON' : 'off',
        dim:
          row.key === 'blockedResolved' && s.heuristics.blockedResolvedMarkers?.length
            ? `${meta.dim} · markers: ${s.heuristics.blockedResolvedMarkers.join(', ')}`
            : meta.dim,
      };
    }
    case 'llmMaxTokens':
      return {
        label: 'LLM max tokens',
        value: String(s.llmMaxTokens),
        dim: 'output budget per decision call',
      };
    case 'llmRejectUncertain':
      return {
        label: '  reject uncertain',
        value: s.llmRejectUncertain ? 'ON' : 'off',
        dim: 'treat an empty/hedging answer as "could not decide"',
      };
    case 'llmMinConfidence':
      return {
        label: '  min confidence',
        value: s.llmMinConfidence === 0 ? 'off' : s.llmMinConfidence.toFixed(2),
        dim: 'reject answers below this self-reported confidence',
      };
    case 'llmDenyIsTerminal':
      return {
        label: '  deny terminal',
        value: s.llmDenyIsTerminal,
        dim: DENY_TERMINAL_DESCS[s.llmDenyIsTerminal],
      };
    case 'cacheToggle':
      return {
        label: 'Decision cache',
        value: s.cacheEnabled ? 'ON' : 'off',
        dim: 'replay a previous council/LLM verdict for an identical question',
      };
    case 'cacheTtl':
      return { label: '  ttl', value: fmtMs(s.cacheTtlMs, '5m'), dim: 'entry lifetime' };
    case 'cacheMaxEntries':
      return { label: '  max entries', value: String(s.cacheMaxEntries), dim: 'live entry cap' };
    case 'cacheStats':
      return {
        label: '  stats',
        value: `${s.cacheHits} hit / ${s.cacheMisses} miss`,
        dim: `${s.cacheSize} live entries · read-only`,
      };
    case 'traceToggle':
      return {
        label: 'Replay trace',
        value: s.traceEnabled ? 'ON' : 'off',
        dim: 'per-decision JSONL of every tier, pool call and council vote',
      };
    case 'traceContent':
      return {
        label: '  content',
        value: s.traceContent,
        dim: TRACE_CONTENT_DESCS[s.traceContent],
      };
    case 'tracePath':
      return {
        label: '  path',
        value: s.tracePath ?? 'default',
        dim: '<project>/.wrongstack/brain-trace.jsonl · read-only',
      };
    case 'circuit':
      return {
        label: 'LLM circuit',
        value: s.circuitState ?? 'n/a',
        dim: `${s.circuitFailures ?? 0} consecutive failures · read-only`,
      };
    case 'rulesSummary':
      return {
        label: 'Rules',
        value: s.ruleCount === 0 ? 'none' : `${s.ruleCount} configured`,
        dim: 'deterministic table, evaluated before any provider call · read-only',
      };
    case 'ruleErrors':
      return {
        label: '  rule errors',
        value: `${s.ruleErrors.length} dropped`,
        dim: s.ruleErrors.join(' · '),
      };
    default:
      return { label: '', value: '' };
  }
}

export function BrainPanel({
  riskLevel,
  log,
  selected,
  hint,
  view,
  settings,
  row,
  busy,
}: BrainPanelProps): React.ReactElement {
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 24;

  const editable = settings !== undefined;
  const activeView = editable ? (view ?? 'settings') : 'log';

  // Window the log entries: reserve ~7 rows for the risk header + chrome.
  const maxVisible = Math.max(4, termRows - CHROME_ROWS);
  const total = log.length;
  const windowStart =
    total <= maxVisible
      ? 0
      : Math.max(0, Math.min(selected - Math.floor(maxVisible / 2), total - maxVisible));
  const windowEnd = Math.min(windowStart + maxVisible, total);
  const above = windowStart;
  const below = total - windowEnd;

  const headerHint =
    activeView === 'settings'
      ? '↑/↓ row · ←/→ change · Enter pick/toggle · d remove · Tab log · Esc close'
      : editable
        ? '↑/↓ navigate log · Tab settings · Esc close'
        : '↑/↓ navigate log · ←/→ change risk · Esc close';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta">
        {`━━ Brain ━━${busy ? '  …' : ''}`}
      </Text>
      <Text dimColor>{headerHint}</Text>

      {activeView === 'settings' && settings ? (
        <Box marginTop={1} flexDirection="column">
          {brainPanelRows(settings).map((r, i) => {
            const focused = i === (row ?? 0);
            const readOnly = BRAIN_READONLY_ROW_KINDS.has(r.kind);
            const { label, value, dim } = rowText(r, settings);
            const key = `${r.kind}-${'index' in r ? r.index : 'key' in r ? r.key : 0}`;
            return (
              <Text key={key} wrap="truncate-end">
                {focused ? <Text color="magenta">{'› '}</Text> : '  '}
                <Text bold={focused} dimColor={readOnly}>
                  {label.padEnd(18)}
                </Text>
                <Text
                  color={
                    r.kind === 'risk'
                      ? RISK_COLORS[settings.riskLevel]
                      : focused && !readOnly
                        ? 'cyan'
                        : undefined
                  }
                  bold={r.kind === 'risk' || r.kind === 'mode'}
                  inverse={focused}
                  dimColor={readOnly}
                >
                  {value}
                </Text>
                {dim ? <Text dimColor>{`  ${dim}`}</Text> : null}
              </Text>
            );
          })}
          <Box marginTop={1}>
            <Text dimColor>changes apply live and persist to the active profile config</Text>
          </Box>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {/* ── Risk ceiling section (legacy/log view) ── */}
          <Box>
            <Text bold>Risk ceiling: </Text>
            <Text color={RISK_COLORS[riskLevel]} bold>
              {riskLevel.toUpperCase()}
            </Text>
            <Text dimColor>{`  ${RISK_DESCS[riskLevel]}`}</Text>
          </Box>

          {/* ── Recent decisions section ── */}
          <Box marginTop={1} flexDirection="column">
            <Text bold color="blue">
              Recent decisions
            </Text>
            {total === 0 ? (
              <Text dimColor> No decisions recorded yet this session.</Text>
            ) : (
              <>
                {above > 0 ? <Text dimColor>{`  ↑ ${above} more`}</Text> : null}
                {log.slice(windowStart, windowEnd).map((entry, i) => {
                  const index = windowStart + i;
                  const focused = index === selected;
                  return (
                    <Text
                      key={`${entry.kind}-${i}`}
                      inverse={focused}
                      {...(focused ? { color: 'magenta' } : {})}
                      wrap="truncate-end"
                    >
                      {focused ? '› ' : '  '}
                      <Text dimColor>{entry.age.padEnd(8)}</Text>
                      <Text color="cyan">{entry.kind.padEnd(12)}</Text>
                      <Text>
                        {entry.question.length > 60
                          ? `${entry.question.slice(0, 57)}…`
                          : entry.question}
                      </Text>
                      {entry.outcome ? (
                        <Text
                          dimColor
                        >{` → ${entry.outcome.length > 20 ? `${entry.outcome.slice(0, 17)}…` : entry.outcome}`}</Text>
                      ) : null}
                    </Text>
                  );
                })}
                {below > 0 ? <Text dimColor>{`  ↓ ${below} more`}</Text> : null}
              </>
            )}
          </Box>
        </Box>
      )}

      {hint ? (
        <Box marginTop={1}>
          <Text dimColor>{hint}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

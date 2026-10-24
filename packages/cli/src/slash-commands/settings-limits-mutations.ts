import {
  clampLimit,
  formatLimitRange,
  LIMIT_BOUNDS,
  LIMITS_BUDGET_KEYS,
  LIMITS_SCALAR_KEYS,
  type LimitsBudgetKey,
  type LimitsConfig,
  type LimitsScalarKey,
  limitValueError,
} from '@wrongstack/contracts/types';
import { color } from '@wrongstack/core/utils';

import { persistConfigSetting } from '../settings-menu.js';

/** CLI spelling of each scalar limit (`/settings limits <name> …`). */
const SCALAR_CLI_NAMES: Record<LimitsScalarKey, string> = {
  responseOutputTokens: 'response-output-tokens',
  toolOutputPreviewBytes: 'tool-output-preview-bytes',
  fetchBytes: 'fetch-bytes',
  projectInstructionsChars: 'project-instructions-chars',
  memoryInjectChars: 'memory-inject-chars',
  historyMessages: 'history-messages',
  subagentResultChars: 'subagent-result-chars',
};

const BUDGET_CLI_NAMES: Record<LimitsBudgetKey, string> = {
  maxIterations: 'subagent-max-iterations',
  maxToolCalls: 'subagent-max-tool-calls',
  timeoutMs: 'subagent-timeout-ms',
};

const DESCRIPTIONS: Record<LimitsScalarKey | LimitsBudgetKey, string> = {
  responseOutputTokens: 'output tokens per model response',
  toolOutputPreviewBytes: 'inline preview of large tool output (full output stays on disk)',
  fetchBytes: 'bytes of a fetched web page',
  projectInstructionsChars: 'characters of AGENTS.md / CLAUDE.md',
  memoryInjectChars: 'characters of auto-injected SAGE memory',
  historyMessages: 'messages kept in the live conversation',
  subagentResultChars: 'characters of a subagent result shown inline',
  maxIterations: 'default subagent iterations',
  maxToolCalls: 'default subagent tool calls',
  timeoutMs: 'default subagent timeout (ms)',
};

/**
 * One row: value (or unset), what it limits, and its allowed range. A stored
 * value outside the range (a hand-edited config.json) is shown with the value
 * actually applied, since the runtime pulls it into range on read.
 */
function renderLimitRow(
  cliName: string,
  key: LimitsScalarKey | LimitsBudgetKey,
  value: number | undefined,
): string {
  let shown = value === undefined ? color.dim('unset') : color.cyan(String(value));
  const applied = clampLimit(key, value);
  if (value !== undefined && applied !== value) {
    shown += color.amber(` (out of range, applied as ${applied ?? 'unset'})`);
  }
  return `  ${cliName.padEnd(30)} ${shown}   ${color.dim(`${DESCRIPTIONS[key]} · ${formatLimitRange(key)}`)}`;
}

/** Render `/settings limits` — every limit, whether the user set it, and its range. */
export function renderLimitsView(limits: LimitsConfig | undefined): string {
  const lines = [
    `${color.bold('Limits')}  ${color.dim('unset = no limit (the model / catalog decides)')}`,
  ];
  for (const key of LIMITS_SCALAR_KEYS) {
    lines.push(renderLimitRow(SCALAR_CLI_NAMES[key], key, limits?.[key]));
  }
  for (const key of LIMITS_BUDGET_KEYS) {
    lines.push(renderLimitRow(BUDGET_CLI_NAMES[key], key, limits?.subagentDefaultBudget?.[key]));
  }
  lines.push(color.dim('  Set: /settings limits <name> <n>    Clear: /settings limits <name> off'));
  return lines.join('\n');
}

function findKey(
  name: string,
): { kind: 'scalar'; key: LimitsScalarKey } | { kind: 'budget'; key: LimitsBudgetKey } | undefined {
  const lower = name.toLowerCase();
  for (const key of LIMITS_SCALAR_KEYS) {
    if (SCALAR_CLI_NAMES[key] === lower || key.toLowerCase() === lower)
      return { kind: 'scalar', key };
  }
  for (const key of LIMITS_BUDGET_KEYS) {
    if (BUDGET_CLI_NAMES[key] === lower) return { kind: 'budget', key };
  }
  return undefined;
}

/**
 * `/settings limits [<name> <n|off>]`. Limits are user config only (denied to
 * in-project config), so writes always go to the active profile.
 */
export async function executeLimitsSettings(
  sub: string,
  rest: string[],
  persistDeps: Parameters<typeof persistConfigSetting>[0],
  current: LimitsConfig | undefined,
): Promise<{ message: string } | undefined> {
  if (sub !== 'limits') return undefined;
  const [name, raw] = rest;
  if (!name) return { message: renderLimitsView(current) };

  const target = findKey(name);
  if (!target) {
    const names = [
      ...LIMITS_SCALAR_KEYS.map((k) => SCALAR_CLI_NAMES[k]),
      ...LIMITS_BUDGET_KEYS.map((k) => BUDGET_CLI_NAMES[k]),
    ];
    return {
      message: `${color.red('Unknown limit')}: "${name}". Known: ${names.join(', ')}`,
    };
  }
  if (raw === undefined) {
    return {
      message: `${color.amber('Usage:')} /settings limits ${name} <n>|off   ${color.dim(`(${formatLimitRange(target.key)}; off = no limit)`)}`,
    };
  }

  const clear = ['off', 'none', 'unset', 'default'].includes(raw.toLowerCase());
  const trimmed = raw.trim();
  const n = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  const error = clear ? null : limitValueError(target.key, n);
  if (error) {
    return {
      message: `${color.red('Invalid value')}: "${raw}" — ${error}, or "off" for no limit.  ${color.dim(LIMIT_BOUNDS[target.key].why)}`,
    };
  }

  await persistConfigSetting({ ...persistDeps, forceGlobal: true }, (cfg) => {
    const limits = { ...((cfg.limits as Record<string, unknown> | undefined) ?? {}) };
    if (target.kind === 'scalar') {
      if (clear) delete limits[target.key];
      else limits[target.key] = n;
    } else {
      const budget = {
        ...((limits.subagentDefaultBudget as Record<string, unknown> | undefined) ?? {}),
      };
      if (clear) delete budget[target.key];
      else budget[target.key] = n;
      if (Object.keys(budget).length > 0) limits.subagentDefaultBudget = budget;
      else delete limits.subagentDefaultBudget;
    }
    // Always write the block (possibly `{}`): the store merges top-level keys
    // shallowly, so a deleted `limits` would leave the old one live.
    cfg.limits = limits;
  });

  const label =
    target.kind === 'scalar' ? SCALAR_CLI_NAMES[target.key] : BUDGET_CLI_NAMES[target.key];
  return {
    message: `${color.green('✓')} limit ${label} → ${clear ? color.dim('unset (no limit)') : color.cyan(String(n))}   ${color.dim(DESCRIPTIONS[target.key])}`,
  };
}

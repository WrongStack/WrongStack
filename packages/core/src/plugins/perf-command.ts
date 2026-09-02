/**
 * `/perf` — the one-click performance ratchet from the terminal.
 *
 * The command's whole job is to hand the agent a round it cannot fake: the
 * right prompt for the mode, the target the user named, the metric they care
 * about, and the profiling commands that actually exist for this repository's
 * stack. Everything past that is the prompt's contract — measure, change one
 * thing, re-measure, keep or revert.
 *
 * `/perf log` is deliberately *not* a model call: reading the ledger is a
 * deterministic question with a deterministic answer, and spending a turn on it
 * would be the same kind of waste the ratchet exists to find.
 *
 * @module plugins/perf-command
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setSessionSubagentsAllowed } from '../coordination/session-subagent-policy.js';
// Types come from their owning modules, not the root barrel. Importing
// `../index.js` here would enrol this file in ARCH-CYCLE-TYPE-14 — the
// frozen core/plugins/tools type SCC whose exception is explicit that no new
// members are allowed.
import type { Context } from '../core/context.js';
import type { SlashCommand } from '../types/slash-command.js';
import {
  DEFAULT_PERF_MODE,
  isPerfModeId,
  PERF_MODE_IDS,
  PERF_MODES,
  type PerfModeId,
} from '../performance/perf-modes.js';
import { parsePerfLog, summarizePerfLog } from '../performance/perf-log.js';
import { detectPerfStacks, renderStackGuidance } from '../performance/perf-stack.js';
import { isPerfMetricId, PERF_METRICS, type PerfMetricId } from '../performance/perf-types.js';
import type { PromptUsageStore } from '../storage/prompt-usage-store.js';
import type { PromptLoader } from '../types/prompt.js';

export const PERF_LOG_FILENAME = 'PERF_LOG.md';

interface ParsedPerfArgs {
  mode: PerfModeId | 'log' | 'help';
  /** Free-form target: a package, path, endpoint, or symptom. */
  target: string;
  metric?: PerfMetricId;
  /** Suppress the injected profiling-command block. */
  noStack: boolean;
  /** A `--metric=` value that is not a known metric id. */
  badMetric?: string;
}

/**
 * Parse `/perf [mode] [--metric=<id>] [--no-stack] [free-form target]`.
 *
 * A bare `/perf` is the ratchet: the default has to be the mode that actually
 * changes the code, because a default that only produces a report trains people
 * to stop after the report.
 */
export function parsePerfArgs(args: string): ParsedPerfArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let mode: ParsedPerfArgs['mode'] = DEFAULT_PERF_MODE;
  let metric: PerfMetricId | undefined;
  let badMetric: string | undefined;
  let noStack = false;
  const rest: string[] = [];

  for (const [index, token] of tokens.entries()) {
    if (index === 0) {
      if (token === 'log' || token === 'help' || token === '--help' || token === '-h') {
        mode = token === 'log' ? 'log' : 'help';
        continue;
      }
      if (isPerfModeId(token)) {
        mode = token;
        continue;
      }
      // Not a mode — the user went straight to a target, e.g. `/perf packages/sage`.
    }
    if (token === '--no-stack') {
      noStack = true;
      continue;
    }
    const metricFlag = /^--metric=(.+)$/.exec(token);
    if (metricFlag) {
      const value = metricFlag[1] as string;
      if (isPerfMetricId(value)) metric = value;
      else badMetric = value;
      continue;
    }
    const scopeFlag = /^--scope=(.+)$/.exec(token);
    if (scopeFlag) {
      rest.push(scopeFlag[1] as string);
      continue;
    }
    rest.push(token);
  }

  return {
    mode,
    target: rest.join(' '),
    ...(metric === undefined ? {} : { metric }),
    ...(badMetric === undefined ? {} : { badMetric }),
    noStack,
  };
}

/**
 * Assemble the message the agent actually receives.
 *
 * Order matters: the prompt's own contract first, then the user's narrowing,
 * then the machine facts. A target appended after the rules reads as a
 * constraint on them; the same text placed first reads as the whole task.
 */
export function buildPerfRunText(
  promptContent: string,
  parts: {
    target?: string | undefined;
    metric?: string | undefined;
    stackGuidance?: string | undefined;
  },
): string {
  const sections = [promptContent];
  if (parts.target) {
    sections.push(
      `## User-selected target\nStay within this package, path, endpoint, or symptom for this round: ${parts.target}`,
    );
  }
  if (parts.metric && isPerfMetricId(parts.metric)) {
    const spec = PERF_METRICS[parts.metric];
    sections.push(
      `## Metric under optimisation\n${spec.label} (${spec.unit}, ${spec.better} is better) — ${spec.description}\n` +
        'Optimise for this metric. If a change improves something else while making this one worse, that is a regression for this round.',
    );
  }
  if (parts.stackGuidance) sections.push(parts.stackGuidance);
  return sections.join('\n\n');
}

function helpText(): string {
  const modes = PERF_MODE_IDS.map((id) => `  /perf ${id.padEnd(9)} ${PERF_MODES[id].summary}`).join(
    '\n',
  );
  return [
    'Run one measure-change-measure performance round, or the read-only analysis',
    'that feeds it.',
    '',
    'Usage:',
    '  /perf                            Ratchet round across the project',
    '  /perf packages/sage              Ratchet round, restricted to a target',
    '  /perf audit packages/tui         Read-only audit of a target',
    '  /perf cpu --metric=p99-latency-ms  Name the metric that matters',
    '  /perf log                        Print the PERF_LOG.md ledger (no model call)',
    '',
    'Modes:',
    modes,
    '',
    'Flags:',
    '  --metric=<id>   One of: ' + Object.keys(PERF_METRICS).join(', '),
    '  --scope=<path>  Same as passing the path directly',
    '  --no-stack      Omit the detected profiling commands from the prompt',
    '',
    'Nothing counts unless it was measured, and anything not measurably better',
    'gets reverted — including changes the agent is proud of.',
  ].join('\n');
}

async function readLedger(projectRoot: string): Promise<string> {
  const file = path.join(projectRoot, PERF_LOG_FILENAME);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return [
      `No ${PERF_LOG_FILENAME} in this project yet.`,
      '',
      'Run `/perf` to start a ratchet round — the first round records the baseline',
      'that every later round is measured against.',
    ].join('\n');
  }
  const lines = summarizePerfLog(parsePerfLog(text));
  if (lines.length === 0) {
    return `${PERF_LOG_FILENAME} exists but records no rounds yet. Run \`/perf\` to add one.`;
  }
  return [
    `${PERF_LOG_FILENAME} — ${lines.length} round(s):`,
    '',
    ...lines.map((l) => `  ${l}`),
  ].join('\n');
}

/**
 * Build the `/perf` slash command.
 *
 * Mirrors `/bughunt`: one round, subagents off, usage recorded, and the prompt
 * handed to the model as the next user turn.
 */
export function buildPerfCommand(
  getLoader: () => PromptLoader | null,
  getUsage: () => PromptUsageStore | null,
): SlashCommand {
  return {
    name: 'perf',
    aliases: ['ratchet'],
    category: 'Run',
    description: 'Run one measure-change-measure performance round (or an audit).',
    argsHint: '[ratchet|audit|triage|memory|io|cpu|guard|contract|log] [target] [--metric=<id>]',
    help: helpText(),
    async run(args: string, ctx: Context) {
      const parsed = parsePerfArgs(args);
      if (parsed.mode === 'help') return { message: helpText() };

      const projectRoot = ctx?.projectRoot ?? ctx?.cwd ?? process.cwd();
      if (parsed.mode === 'log') return { message: await readLedger(projectRoot) };

      if (parsed.badMetric) {
        return {
          message: `Unknown metric "${parsed.badMetric}". Expected one of: ${Object.keys(PERF_METRICS).join(', ')}.`,
        };
      }

      const loader = getLoader();
      if (!loader) return { message: 'Prompt library not available.' };
      const mode = PERF_MODES[parsed.mode];
      const entry = await loader.find(mode.slug);
      if (!entry) {
        return {
          message: `Builtin prompt "${mode.slug}" is unavailable. Rebuild or reinstall the prompt dataset.`,
        };
      }

      // A ratchet round attributes one measured delta to one change. Fanning it
      // out across subagents makes the attribution impossible to defend, so the
      // mutating modes run single-threaded like a bug-hunt round does.
      if (mode.mutating) {
        try {
          await setSessionSubagentsAllowed(ctx, false);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return { message: `${mode.label} could not start: ${reason}` };
        }
      }

      try {
        await getUsage()?.record(entry.slug);
      } catch {
        // Usage tracking must never block a round.
      }

      let stackGuidance: string | undefined;
      if (!parsed.noStack) {
        try {
          stackGuidance = renderStackGuidance(await detectPerfStacks(projectRoot));
        } catch {
          // Detection is a convenience; a round without it is still a round.
        }
      }

      const runText = buildPerfRunText(entry.content, {
        target: parsed.target,
        metric: parsed.metric,
        stackGuidance,
      });

      const where = parsed.target ? `for: ${parsed.target}` : 'across the current project';
      const metricNote = parsed.metric ? ` — optimising ${PERF_METRICS[parsed.metric].label}` : '';
      return { message: `${mode.label} started ${where}${metricNote}.`, runText };
    },
  };
}

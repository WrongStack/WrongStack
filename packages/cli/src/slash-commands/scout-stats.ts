import type { SessionEvent, SlashCommand } from '@wrongstack/contracts/types';
import { color } from '@wrongstack/core/utils';
import type { SlashCommandContext } from './command-context.js';

/**
 * `/scout-stats` — does the Scout identity behave the way its prompt asks?
 *
 * Measured from session journals at read time (nothing is recorded for it):
 * every `llm_request` carries the identity variant it ran under, and tool
 * calls are journaled as `tool_call_start` events. Two behaviours are the
 * point of Scout, so they lead the report next to the other variants:
 *
 * - discovery — how often `tool_search` comes back empty, and how often a tool
 *   it surfaced is then called through `tool_use`;
 * - delegation — the share of runs that hand work to a subagent, against runs
 *   that did a lot of tool work alone.
 */

/** Tool calls in one run, without a delegation, that count as "worked alone". */
export const SOLO_HEAVY_TOOL_CALLS = 8;

const DELEGATION_TOOLS = new Set(['delegate', 'spawn_subagent']);
const SEARCH_TOTAL = /^tool_search \(total=(\d+)/;

export interface VariantUsage {
  variant: string;
  sessions: number;
  runs: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  /** Calls routed through the `tool_use` gateway (schema was not direct). */
  lazyCalls: number;
  searches: number;
  emptySearches: number;
  /** `tool_use` calls whose target an earlier search in the run returned. */
  searchedThenUsed: number;
  delegations: number;
  runsWithDelegation: number;
  /** Runs with at least {@link SOLO_HEAVY_TOOL_CALLS} tool calls and no delegation. */
  soloHeavyRuns: number;
}

interface RunTally {
  variant: string | undefined;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  lazyCalls: number;
  searches: number;
  emptySearches: number;
  searchedThenUsed: number;
  delegations: number;
  searchIds: Set<string>;
  surfaced: Set<string>;
}

function newRun(): RunTally {
  return {
    variant: undefined,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    lazyCalls: 0,
    searches: 0,
    emptySearches: 0,
    searchedThenUsed: 0,
    delegations: 0,
    searchIds: new Set(),
    surfaced: new Set(),
  };
}

function emptyUsage(variant: string): VariantUsage {
  return {
    variant,
    sessions: 0,
    runs: 0,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    lazyCalls: 0,
    searches: 0,
    emptySearches: 0,
    searchedThenUsed: 0,
    delegations: 0,
    runsWithDelegation: 0,
    soloHeavyRuns: 0,
  };
}

/** Tool names a `tool_search` result listed, read from its rendered text. */
function surfacedNames(content: string): string[] {
  return [...content.matchAll(/"name":"([^"]+)"/g)].map((match) => match[1] ?? '');
}

/**
 * Aggregate journals per identity variant. A run starts at each `user_input`
 * and belongs to the variant of its first `llm_request`; a journal written
 * before requests recorded their variant is reported as `unrecorded`.
 */
export function summarizeVariantUsage(
  sessions: readonly (readonly SessionEvent[])[],
): VariantUsage[] {
  const byVariant = new Map<string, VariantUsage>();
  for (const events of sessions) {
    const seen = new Set<string>();
    let run: RunTally | undefined;
    const flush = () => {
      if (!run || (run.requests === 0 && run.toolCalls === 0)) return;
      const variant = run.variant ?? 'unrecorded';
      const usage = byVariant.get(variant) ?? emptyUsage(variant);
      byVariant.set(variant, usage);
      if (!seen.has(variant)) {
        seen.add(variant);
        usage.sessions++;
      }
      usage.runs++;
      usage.requests += run.requests;
      usage.inputTokens += run.inputTokens;
      usage.outputTokens += run.outputTokens;
      usage.toolCalls += run.toolCalls;
      usage.lazyCalls += run.lazyCalls;
      usage.searches += run.searches;
      usage.emptySearches += run.emptySearches;
      usage.searchedThenUsed += run.searchedThenUsed;
      usage.delegations += run.delegations;
      if (run.delegations > 0) usage.runsWithDelegation++;
      else if (run.toolCalls >= SOLO_HEAVY_TOOL_CALLS) usage.soloHeavyRuns++;
    };
    for (const event of events) {
      if (event.type === 'user_input') {
        flush();
        run = newRun();
        continue;
      }
      run ??= newRun();
      if (event.type === 'llm_request') {
        run.requests++;
        run.variant ??= event.systemVariant;
      } else if (event.type === 'llm_response') {
        run.inputTokens += event.usage.input;
        run.outputTokens += event.usage.output;
      } else if (event.type === 'tool_call_start') {
        run.toolCalls++;
        if (DELEGATION_TOOLS.has(event.name)) run.delegations++;
        if (event.name === 'tool_search') {
          run.searches++;
          run.searchIds.add(event.id);
        } else if (event.name === 'tool_use') {
          run.lazyCalls++;
          const target = (event.input as { tool?: unknown } | null)?.tool;
          if (typeof target === 'string' && run.surfaced.has(target)) run.searchedThenUsed++;
          if (target === 'delegate' || target === 'spawn_subagent') run.delegations++;
        }
      } else if (event.type === 'tool_result' && run.searchIds.has(event.id)) {
        if (typeof event.content !== 'string') continue;
        const total = SEARCH_TOTAL.exec(event.content)?.[1];
        if (total === '0') run.emptySearches++;
        for (const name of surfacedNames(event.content)) run.surfaced.add(name);
      }
    }
    flush();
  }
  return [...byVariant.values()].sort((a, b) => b.runs - a.runs);
}

const percent = (part: number, whole: number) =>
  whole > 0 ? `${Math.round((part / whole) * 100)}%` : '-';

/** One block per variant; Scout first, since the command exists to judge it. */
export function formatVariantUsage(usage: readonly VariantUsage[], sessionCount: number): string {
  if (usage.length === 0) return `No runs found in the last ${sessionCount} session(s).`;
  const ordered = [...usage].sort(
    (a, b) => Number(b.variant === 'scout') - Number(a.variant === 'scout'),
  );
  const lines = [color.bold(`Identity variants — last ${sessionCount} session(s)`), ''];
  for (const u of ordered) {
    const tokensPerRun = u.runs > 0 ? Math.round((u.inputTokens + u.outputTokens) / u.runs) : 0;
    lines.push(
      color.bold(`${u.variant}`) +
        color.dim(`  ${u.sessions} session(s), ${u.runs} run(s), ${u.requests} request(s)`),
      `  tokens/run       ${tokensPerRun.toLocaleString('en-US')}`,
      `  tool calls       ${u.toolCalls} (${percent(u.lazyCalls, u.toolCalls)} via tool_use)`,
      `  tool_search      ${u.searches} — empty ${percent(u.emptySearches, u.searches)}, found→used ${u.searchedThenUsed}`,
      `  delegation       ${u.delegations} call(s); ${percent(u.runsWithDelegation, u.runs)} of runs delegated`,
      `  solo-heavy runs  ${u.soloHeavyRuns} (≥${SOLO_HEAVY_TOOL_CALLS} tool calls, no delegation)`,
      '',
    );
  }
  if (usage.some((u) => u.variant === 'unrecorded')) {
    lines.push(
      color.dim('`unrecorded` = journals written before requests recorded their variant.'),
    );
  }
  return lines.join('\n').trimEnd();
}

const DEFAULT_SESSIONS = 20;
const MAX_SESSIONS = 200;

export function buildScoutStatsCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'scout-stats',
    category: 'Inspect',
    description:
      'Compare the Scout identity with the other prompt variants: discovery and delegation.',
    help:
      'Usage: /scout-stats [sessions]\n\n' +
      `Reads the last N session journals of this project (default ${DEFAULT_SESSIONS}, max ${MAX_SESSIONS})\n` +
      'and reports, per system-prompt variant: tokens per run, how often tool_search\n' +
      'came back empty and how often a found tool was then called, the share of\n' +
      'runs that delegated, and runs that did heavy tool work alone.',
    async run(args) {
      const store = opts.sessionStore;
      if (!store) return { message: 'Session store not available in this context.' };
      const requested = Number.parseInt(args.trim(), 10);
      const limit = Number.isFinite(requested)
        ? Math.min(Math.max(requested, 1), MAX_SESSIONS)
        : DEFAULT_SESSIONS;
      const summaries = await store.list(limit);
      const journals: SessionEvent[][] = [];
      let unreadable = 0;
      for (const summary of summaries) {
        try {
          journals.push((await store.load(summary.id)).events);
        } catch {
          unreadable++;
        }
      }
      const report = formatVariantUsage(summarizeVariantUsage(journals), journals.length);
      return {
        message:
          unreadable > 0
            ? `${report}\n${color.dim(`${unreadable} session(s) could not be read.`)}`
            : report,
      };
    },
  };
}

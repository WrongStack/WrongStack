import { buildLiveNextStepsGateBlock } from '../core/agent-response.js';
import type { AgentContext } from '../types/context.js';
import { SYSTEM_BLOCK_SOURCE, type SystemBlockSource } from '../core/system-prompt-builder.js';
import type { TextBlock } from '../types/blocks.js';
import type { Tool } from '../types/tool.js';
import { buildCompletedWorkLedgerBlock } from './context-evidence.js';
import {
  estimateTextTokens,
  estimateToolDefTokens,
  estimateToolInputTokens,
  estimateToolResultTokens,
} from './token-estimate.js';

/**
 * Real, per-category token accounting for the live context window — the data
 * behind an honest `/context` display. Every number is measured from the actual
 * assembled inputs (`ctx.systemPrompt`, `ctx.tools`, `ctx.messages`) using the
 * same 3.5-chars/token estimator the compactor and live bar use, so the total
 * here reconciles with the context-fill bar. It replaces the hardcoded fake
 * percentages the TUI dashboard used to show.
 */
export interface ContextBreakdown {
  system: {
    total: number;
    /** Tokens attributed to each system-prompt section (see SystemBlockSource). */
    bySource: Record<SystemBlockSource | 'other', number>;
  };
  tools: {
    total: number;
    builtin: number;
    mcp: number;
    /** Number of tool definitions in the request. */
    count: number;
    /** MCP tool tokens grouped by originating server. */
    mcpByServer: Record<string, number>;
  };
  history: {
    total: number;
    /** User/assistant/system text only. */
    text: number;
    /** Serialized tool_use arguments. Optional for backward-compatible UI snapshots. */
    toolInputs?: number | undefined;
    /** tool_result output content. */
    toolResults: number;
    /** Preserved provider reasoning/thinking blocks. */
    thinking?: number | undefined;
    /** Images and future/unknown content block kinds. */
    other?: number | undefined;
    messageCount: number;
  };
  volatile: {
    /** Completed-work ledger, appended to `system` at request time. */
    ledger: number;
    /** Next-steps gate, appended to `system` at request time. */
    nextsteps: number;
    total: number;
  };
  /** system.total + tools.total + history.total + volatile.total. */
  total: number;
  effectiveMaxContext: number;
  /** total / effectiveMaxContext — may exceed 1 before compaction fires. */
  usedPct: number;
  /**
   * Non-fatal build warnings encountered during breakdown computation.
   * Empty when everything succeeded; populated when volatile blocks
   * (ledger, nextsteps) threw during construction and were silently omitted.
   */
  warnings: string[];
}

const SYSTEM_BLOCK_SOURCES = [
  'identity',
  'tool-usage',
  'environment',
  'skills',
  'mode',
  'plan',
  'leader-after-task',
  'contributor',
  'ledger',
  'glossary',
  'peers',
  'nextsteps',
  'other',
] as const satisfies readonly (SystemBlockSource | 'other')[];

/**
 * Compile-time guard: every `SystemBlockSource` must appear above, or blocks
 * tagged with the missing source accumulate onto an uninitialised key and turn
 * the whole category into `NaN`. Widening the union without touching the list
 * fails here rather than silently at runtime.
 */
type _EverySourceListed =
  Exclude<SystemBlockSource | 'other', (typeof SYSTEM_BLOCK_SOURCES)[number]> extends never
    ? true
    : [
        'missing from SYSTEM_BLOCK_SOURCES',
        Exclude<SystemBlockSource | 'other', (typeof SYSTEM_BLOCK_SOURCES)[number]>,
      ];
const _everySourceListed: _EverySourceListed = true;
void _everySourceListed;

function emptyBySource(): Record<SystemBlockSource | 'other', number> {
  const out = {} as Record<SystemBlockSource | 'other', number>;
  for (const key of SYSTEM_BLOCK_SOURCES) out[key] = 0;
  return out;
}

/** An MCP-proxied tool, identified by capability first then the `mcp__` prefix. */
function isMcpTool(tool: Tool): boolean {
  return (tool.capabilities?.includes('mcp.proxy') ?? false) || tool.name.startsWith('mcp__');
}

/** Server segment of a `mcp__<server>__<tool>` name, or a generic bucket. */
function mcpServerOf(tool: Tool): string {
  const parts = tool.name.split('__');
  return parts.length >= 3 && parts[0] === 'mcp' ? (parts[1] ?? 'mcp') : 'mcp';
}

function safeBuild(
  fn: () => TextBlock | undefined,
  warn: (e: unknown) => void = () => {},
): TextBlock | undefined {
  try {
    return fn();
  } catch (e) {
    warn(e);
    return undefined;
  }
}

/**
 * Mirror the denominator the agent loop (`currentMaxContext`) and the
 * auto-compaction middleware use: an explicit `effectiveMaxContext` override
 * wins, then the provider window, then a safe default. Inline-replicated here
 * to keep this module free of an `execution/`/`core/` runtime dependency for
 * the denominator (the builders it already imports are the only exception).
 */
function resolveEffectiveMaxContext(ctx: AgentContext): number {
  const metaLimit = ctx.meta?.['effectiveMaxContext'];
  const providerMax = ctx.provider.capabilities.maxContext;
  return typeof metaLimit === 'number' && metaLimit > 0
    ? metaLimit
    : typeof providerMax === 'number' && providerMax > 0
      ? providerMax
      : 200_000;
}

/**
 * Compute the real per-category token breakdown of a live context. Safe to call
 * interactively (e.g. from `/context`): it walks the full message array once, so
 * it is O(messages·blocks), not the O(1) cached path the per-turn bar uses.
 */
export function getContextBreakdown(ctx: AgentContext): ContextBreakdown {
  // --- System prompt: attributed per section via the builder's WeakMap tag ---
  const bySource = emptyBySource();
  let systemTotal = 0;
  for (const block of ctx.systemPrompt) {
    const tokens = estimateTextTokens(block.text);
    systemTotal += tokens;
    bySource[SYSTEM_BLOCK_SOURCE.get(block) ?? 'other'] += tokens;
  }

  // --- Tool definitions: builtin vs MCP (grouped by server) ---
  let toolsBuiltin = 0;
  let toolsMcp = 0;
  const mcpByServer: Record<string, number> = {};
  for (const tool of ctx.tools) {
    const tokens = estimateToolDefTokens(tool);
    if (isMcpTool(tool)) {
      toolsMcp += tokens;
      const server = mcpServerOf(tool);
      mcpByServer[server] = (mcpByServer[server] ?? 0) + tokens;
    } else {
      toolsBuiltin += tokens;
    }
  }

  // --- Conversation history: account every block kind separately so a large
  //     tool input or preserved-thinking chain cannot hide in the "text" line. ---
  let histText = 0;
  let histToolInputs = 0;
  let histToolResults = 0;
  let histThinking = 0;
  let histOther = 0;
  for (const msg of ctx.messages) {
    if (typeof msg.content === 'string') {
      histText += estimateTextTokens(msg.content);
      continue;
    }
    for (const b of msg.content) {
      switch (b.type) {
        case 'text':
          histText += estimateTextTokens(b.text);
          break;
        case 'tool_use':
          histToolInputs += estimateToolInputTokens(b.input);
          break;
        case 'tool_result':
          histToolResults += estimateToolResultTokens(b.content);
          break;
        case 'thinking': {
          // The canonical message estimator serializes the whole block so
          // opaque signatures/provider metadata count toward the wire budget.
          let str: string;
          try {
            str = JSON.stringify(b) ?? '';
          } catch {
            str = String(b);
          }
          histThinking += estimateTextTokens(str);
          break;
        }
        default: {
          let str: string;
          try {
            str = JSON.stringify(b) ?? '';
          } catch {
            str = String(b);
          }
          histOther += estimateTextTokens(str);
        }
      }
    }
  }

  // --- Volatile per-turn blocks: re-derived (they live in the request, not
  //     in ctx.systemPrompt) and tagged by construction. ---
  const warnings: string[] = [];
  const warn = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(msg);
  };
  const ledgerBlock = safeBuild(() => buildCompletedWorkLedgerBlock(ctx), warn);
  const nextstepsBlock = safeBuild(() => buildLiveNextStepsGateBlock(ctx), warn);
  const ledger = ledgerBlock ? estimateTextTokens(ledgerBlock.text) : 0;
  const nextsteps = nextstepsBlock ? estimateTextTokens(nextstepsBlock.text) : 0;

  const toolsTotal = toolsBuiltin + toolsMcp;
  const historyTotal = histText + histToolInputs + histToolResults + histThinking + histOther;
  const volatileTotal = ledger + nextsteps;
  const total = systemTotal + toolsTotal + historyTotal + volatileTotal;
  const effectiveMaxContext = resolveEffectiveMaxContext(ctx);

  return {
    system: { total: systemTotal, bySource },
    tools: {
      total: toolsTotal,
      builtin: toolsBuiltin,
      mcp: toolsMcp,
      count: ctx.tools.length,
      mcpByServer,
    },
    history: {
      total: historyTotal,
      text: histText,
      toolInputs: histToolInputs,
      toolResults: histToolResults,
      thinking: histThinking,
      other: histOther,
      messageCount: ctx.messages.length,
    },
    volatile: { ledger, nextsteps, total: volatileTotal },
    total,
    effectiveMaxContext,
    usedPct: effectiveMaxContext > 0 ? total / effectiveMaxContext : 0,
    warnings,
  };
}

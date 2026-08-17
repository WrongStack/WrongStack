import * as fs from 'node:fs/promises';
import type { Context, SystemBlockSource } from '@wrongstack/core/agent';
import type { Config, ContextWindowPolicy, SlashCommand } from '@wrongstack/core/types';
import {
  CONTEXT_WINDOW_MODE_PINNED_META_KEY,
  formatContextWindowModeList,
  getContextWindowMode,
  resolveContextWindowPolicy,
} from '@wrongstack/core/types';
import {
  atomicWrite,
  type ContextBreakdown,
  color,
  getContextBreakdown,
  repairToolUseAdjacency,
} from '@wrongstack/core/utils';
import { activeProfileConfigPath } from '../profile-config-path.js';
import type { SlashCommandContext } from './command-context.js';
import { countToolResults, countToolUses, countTurnPairs, estimateTokens } from './helpers.js';

export function buildContextCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'context',
    category: 'Inspect',
    aliases: ['ctx'],
    description: 'Show context window summary.',
    help: [
      'Usage:',
      '  /context           Show counts: messages, est. tokens, tool calls, todos, read files.',
      '  /context detail    As above, plus model, cwd, projectRoot, and the file list.',
      '  /context repair    Repair orphan tool_use/tool_result blocks after manual compaction.',
      '  /context limit     Show effective context window for this session.',
      '  /context limit <tokens> Set effective context window for this session (e.g. 220k).',
      '  /context limit <tokens> --persist Persist as the FALLBACK window for models',
      '                     whose window nothing published. The models.dev per-model',
      '                     window still wins when it exists — to cap one provider on',
      '                     purpose set providers.<id>.capabilities.maxContext.',
      '  /context thresholds <warn> <soft> <hard> Set compaction thresholds (percent or decimal).',
      '  /context thresholds <warn> <soft> <hard> --persist Persist thresholds to config.',
      '  /context mode      List context-window modes.',
      '  /context mode <id> Switch context-window mode for this session.',
      '  /context cache     Prompt-cache report: hit ratio, $ saved, per-provider, and each provider’s cache mechanism.',
    ].join('\n'),
    async run(args, ctx) {
      if (!ctx) {
        opts.renderer.writeWarning('No agent context available.');
        return { message: 'No agent context available.' };
      }
      const trimmed = args.trim();

      if (trimmed === 'mode' || trimmed === 'modes') {
        const active = readPolicy(ctx)?.id ?? 'balanced';
        const msg = `${color.bold('Context Window Modes')}\n${formatContextWindowModeList(active)}`;
        opts.renderer.write(`${msg}\n`);
        return { message: msg };
      }

      if (trimmed === 'repair') {
        const before = ctx.messages.length;
        const repaired = repairToolUseAdjacency(ctx.messages);
        if (repaired.report.changed) {
          ctx.state.replaceMessages(repaired.messages);
        }
        const msg = repaired.report.changed
          ? [
              `${color.green('Context repaired')}`,
              `  messages:     ${before} -> ${ctx.messages.length}`,
              `  tool_use:     removed ${repaired.report.removedToolUses.length}`,
              `  tool_result:  removed ${repaired.report.removedToolResults.length}`,
              `  empty msgs:   removed ${repaired.report.removedMessages}`,
            ].join('\n')
          : 'Context repair: no orphan tool_use/tool_result blocks found.';
        opts.renderer.write(`${msg}\n`);
        return { message: msg };
      }

      if (trimmed === 'limit') {
        const limit = readEffectiveLimit(ctx, opts);
        const msg =
          limit > 0
            ? `Effective context window: ${limit.toLocaleString()} tokens`
            : 'Effective context window: unknown (auto-compaction may be disabled).';
        opts.renderer.write(`${msg}\n`);
        return { message: msg };
      }

      if (trimmed.startsWith('limit ')) {
        const persist = hasPersistFlag(trimmed);
        const raw = stripPersistFlag(trimmed.slice('limit '.length)).trim();
        const limit = parseTokenCount(raw);
        if (!limit) {
          const msg = `Invalid context limit "${raw}". Use a positive token count, e.g. 220k or 220000.`;
          opts.renderer.write(`${color.red(msg)}\n`);
          return { message: msg };
        }
        ctx.meta['effectiveMaxContext'] = limit;
        const effective = opts.onContextLimit?.(limit) ?? limit;
        if (persist) {
          const error = await persistContextConfig(opts, { effectiveMaxContext: limit });
          if (error) {
            opts.renderer.write(`${color.red(error)}\n`);
            return { message: error };
          }
        }
        const msg = `${color.green('Effective context window set:')} ${effective.toLocaleString()} tokens${persist ? ' (persisted)' : ''}`;
        opts.renderer.write(`${msg}\n`);
        return { message: msg };
      }

      if (trimmed.startsWith('thresholds ')) {
        const persist = hasPersistFlag(trimmed);
        const thresholdArgs = stripPersistFlag(trimmed.slice('thresholds '.length)).trim();
        const parts = thresholdArgs.split(/\s+/).filter(Boolean);
        if (parts.length !== 3) {
          const msg =
            'Usage: /context thresholds <warn> <soft> <hard> (examples: 60% 75% 90% or 0.6 0.75 0.9)';
          opts.renderer.write(`${color.red(msg)}\n`);
          return { message: msg };
        }
        const thresholds = parts.map(parseThreshold);
        if (thresholds.some((v): v is null => v === null)) {
          const msg = 'Invalid thresholds. Use percentages (60%) or decimals between 0 and 1.';
          opts.renderer.write(`${color.red(msg)}\n`);
          return { message: msg };
        }
        const [warn, soft, hard] = thresholds as [number, number, number];
        if (!(warn < soft && soft < hard)) {
          const msg = 'Invalid thresholds: require warn < soft < hard.';
          opts.renderer.write(`${color.red(msg)}\n`);
          return { message: msg };
        }
        const base = readPolicy(ctx) ?? resolveContextWindowPolicy({});
        const policy = { ...base, thresholds: { warn, soft, hard } };
        ctx.meta['contextWindowMode'] = policy.id;
        ctx.meta['contextWindowPolicy'] = policy;
        // The user tuned thresholds for this session — later window changes
        // (model switch) must not overwrite them.
        ctx.meta[CONTEXT_WINDOW_MODE_PINNED_META_KEY] = true;
        if (persist) {
          const error = await persistContextConfig(opts, {
            warnThreshold: warn,
            softThreshold: soft,
            hardThreshold: hard,
          });
          if (error) {
            opts.renderer.write(`${color.red(error)}\n`);
            return { message: error };
          }
        }
        const msg = `${color.green('Context thresholds set:')} warn ${pct(warn)}, soft ${pct(soft)}, hard ${pct(hard)}${persist ? ' (persisted)' : ''}`;
        opts.renderer.write(`${msg}\n`);
        return { message: msg };
      }

      if (trimmed.startsWith('mode ')) {
        const id = trimmed.slice('mode '.length).trim();
        const mode = getContextWindowMode(id);
        if (!mode) {
          const msg = `Unknown context mode "${id}". Use /context mode to list modes.`;
          opts.renderer.write(`${color.red(msg)}\n`);
          return { message: msg };
        }
        const policy = resolveContextWindowPolicy({}, mode.id, readEffectiveLimit(ctx, opts));
        ctx.meta['contextWindowMode'] = policy.id;
        ctx.meta['contextWindowPolicy'] = policy;
        // The user picked this mode for the session — later window changes
        // (model switch) must not overwrite it.
        ctx.meta[CONTEXT_WINDOW_MODE_PINNED_META_KEY] = true;
        const msg = [
          `${color.green('Context mode set:')} ${policy.id} (${policy.name})`,
          `  thresholds: warn ${pct(policy.thresholds.warn)}, soft ${pct(policy.thresholds.soft)}, hard ${pct(policy.thresholds.hard)}`,
          `  preserve:   last ${policy.preserveK} user/assistant messages`,
          `  elide:      old tool results >= ${policy.eliseThreshold.toLocaleString()} tokens`,
        ].join('\n');
        opts.renderer.write(`${msg}\n`);
        return { message: msg };
      }

      if (trimmed === 'cache') {
        const msg = renderCacheReport(ctx);
        opts.renderer.write(`${msg}\n`);
        return { message: msg };
      }

      const messages = ctx.messages;
      const detailed = trimmed === 'detail';
      const policy = readPolicy(ctx);
      const breakdown = safeBreakdown(ctx);
      const caps = ctx.provider?.capabilities;
      const realUsage = ctx.lastRealInputTokens;
      const lines = [
        `${color.bold('Context Window')}`,
        `  messages:    ${messages.length} total (${countTurnPairs(messages)} user+assistant pairs)`,
        `  tokens (est): ${estimateTokens(messages).toLocaleString()} (≈ chars/3.5)`,
        // The provider's authoritative prompt-token count from the last
        // response — a REAL number, not an estimate. Absent before the first call.
        ...(typeof realUsage === 'number' && realUsage > 0
          ? [`  tokens (real): ${realUsage.toLocaleString()} (provider-reported, last request)`]
          : []),
        // The RESOLVED window, not raw models.dev: session wiring writes the
        // resolved value back onto provider.capabilities, so labelling this
        // "(models.dev)" misattributed config/family fallbacks to the catalog.
        `  window:      ${(caps?.maxContext ?? 0).toLocaleString()} ctx${
          caps?.maxOutput ? ` / ${caps.maxOutput.toLocaleString()} output` : ''
        } (resolved)`,
        `  mode:        ${policy ? `${policy.id} (${policy.name})` : 'balanced'}`,
        `  limit:       ${formatLimit(readEffectiveLimit(ctx, opts))}`,
        `  system prompt: ${ctx.systemPrompt.length} block${ctx.systemPrompt.length !== 1 ? 's' : ''}`,
        `  tools:       ${countToolUses(messages)} calls made, ${countToolResults(messages)} results in history`,
        `  read files:  ${ctx.readFiles.size} files`,
        `  todos:       ${ctx.todos.filter((t) => t.status === 'in_progress').length} in_progress / ${ctx.todos.filter((t) => t.status === 'pending').length} pending / ${ctx.todos.filter((t) => t.status === 'completed').length} completed`,
      ];
      if (breakdown) {
        lines.push('', ...renderBreakdown(breakdown, detailed));
      } else if (messages.length > 0 || (ctx.tools?.length ?? 0) > 0) {
        lines.push('', `  ${color.dim('breakdown: unavailable (see logs)')}`);
      }
      const cache = ctx.tokenCounter?.cacheStats();
      if (cache && (cache.readTokens > 0 || cache.writeTokens > 0)) {
        const saved = cache.savedUsd > 0 ? `  ·  saved ~$${cache.savedUsd.toFixed(2)}` : '';
        lines.push(
          `  cache-hit: ${(cache.hitRatio * 100).toFixed(1)}%  ·  read ${cache.readTokens.toLocaleString('en-US')}, write ${cache.writeTokens.toLocaleString('en-US')}${saved} (session cumulative)`,
        );
        // Per-provider split — only meaningful once the session spanned >1 provider.
        const perProvider = readProviderCacheLedger(ctx);
        if (perProvider.length > 1) {
          for (const p of perProvider) {
            lines.push(
              `    ${p.provider.padEnd(16)} ${(p.hitRatio * 100).toFixed(1)}% hit  ·  read ${p.cacheRead.toLocaleString('en-US')}, write ${p.cacheWrite.toLocaleString('en-US')}`,
            );
          }
        }
      }
      if (detailed) {
        lines.push(
          `  thresholds:  warn ${pct(policy?.thresholds.warn ?? 0.6)}, soft ${pct(policy?.thresholds.soft ?? 0.75)}, hard ${pct(policy?.thresholds.hard ?? 0.9)}`,
          `  model:       ${ctx.model}`,
          `  cwd:         ${ctx.cwd}`,
          `  projectRoot: ${ctx.projectRoot}`,
          `  file mtimes: ${ctx.fileMtimes.size} tracked`,
        );
        if (ctx.readFiles.size > 0) lines.push(`  file list:   ${[...ctx.readFiles].join(', ')}`);
      }
      const msg = lines.join('\n');
      opts.renderer.write(`${msg}\n`);
      return { message: msg };
    },
  };
}

function readPolicy(ctx: Context): ContextWindowPolicy | null {
  const policy = ctx.meta?.['contextWindowPolicy'];
  return policy && typeof policy === 'object' ? (policy as ContextWindowPolicy) : null;
}

interface ProviderCacheRow {
  provider: string;
  cacheRead: number;
  cacheWrite: number;
  hitRatio: number;
}

/** Read the per-provider cache ledger attached to ctx.meta by session wiring. */
function readProviderCacheLedger(ctx: Context): ProviderCacheRow[] {
  const ledger = ctx.meta?.['providerCacheLedger'] as
    | { perProvider?: () => ProviderCacheRow[] }
    | undefined;
  try {
    return ledger?.perProvider?.() ?? [];
  } catch {
    return [];
  }
}

/** Human label for how a provider does prompt caching, from its capabilities. */
function cacheMechanismLabel(providerId: string, cacheControl: string | undefined): string {
  const id = providerId.toLowerCase();
  if (cacheControl === 'native') return 'native cache_control breakpoints (ttl-tunable)';
  if (id.includes('google') || id.includes('gemini')) {
    return 'implicit (auto) + explicit cachedContents (opt-in)';
  }
  // AI Gateway caches with its own `caching: "auto"` request flag and picks the
  // mechanism per routed upstream — it never sends a prompt_cache_key.
  if (id.includes('gateway')) return 'automatic (Gateway-managed, per routed upstream)';
  if (cacheControl === 'auto') return 'automatic + prompt_cache_key routing';
  return 'none / provider-managed';
}

/** `/context cache` — consolidated prompt-cache report. */
function renderCacheReport(ctx: Context): string {
  const lines: string[] = [`${color.bold('Prompt Cache Report')}`];
  const cache = ctx.tokenCounter?.cacheStats();
  if (cache && (cache.readTokens > 0 || cache.writeTokens > 0)) {
    lines.push(
      `  hit ratio: ${(cache.hitRatio * 100).toFixed(1)}%`,
      `  tokens:    read ${K(cache.readTokens)}, write ${K(cache.writeTokens)}`,
    );
    if (cache.savedUsd > 0) {
      lines.push(`  saved:     ~$${cache.savedUsd.toFixed(2)} vs the full input rate`);
    }
  } else {
    lines.push('  No cached tokens yet this session.');
  }

  const providerId =
    typeof ctx.provider === 'object'
      ? ((ctx.provider as { id?: string }).id ?? 'provider')
      : String(ctx.provider);
  const caps = (ctx.provider as { capabilities?: { cacheControl?: string } } | undefined)
    ?.capabilities;
  lines.push(
    `  ${color.dim('active:')} ${providerId} — ${cacheMechanismLabel(providerId, caps?.cacheControl)}`,
  );

  const perProvider = readProviderCacheLedger(ctx);
  if (perProvider.length > 0) {
    lines.push(`  ${color.dim('by provider:')}`);
    for (const p of perProvider) {
      lines.push(
        `    ${p.provider.padEnd(16)} ${(p.hitRatio * 100).toFixed(1)}% hit  ·  read ${K(p.cacheRead)}, write ${K(p.cacheWrite)}`,
      );
    }
  }
  return lines.join('\n');
}

function safeBreakdown(ctx: Context): ContextBreakdown | null {
  try {
    return getContextBreakdown(ctx);
  } catch (err) {
    if (process.env['DEBUG_WS']) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'context.breakdown_failed',
          message: String(err),
          timestamp: Date.now(),
        }),
      );
    }
    return null;
  }
}

const K = (n: number): string => n.toLocaleString('en-US');
const PCT = (n: number, total: number): string =>
  total > 0 ? `${((n / total) * 100).toFixed(1)}%` : '0.0%';

const SOURCE_LABELS: Record<SystemBlockSource | 'other', string> = {
  identity: 'identity (system.md)',
  'tool-usage': 'tool-usage prose',
  environment: 'environment',
  skills: 'skills',
  mode: 'mode',
  plan: 'plan',
  'leader-after-task': 'leader-after-task (post-tool summary)',
  contributor: 'contributor',
  ledger: 'completed-work ledger',
  glossary: 'project jargon dictionary',
  peers: 'fleet peer awareness',
  nextsteps: 'next-steps gate',
  other: 'other (untagged)',
};

/**
 * Real per-category token breakdown for `/context`. Replaces the old fabricated
 * fixed-percentage split — every number is measured from the assembled request.
 */
function renderBreakdown(bd: ContextBreakdown, detailed: boolean): string[] {
  const limit = bd.effectiveMaxContext;
  const overBy = Math.max(0, bd.total - limit);
  const headerSuffix =
    overBy > 0
      ? `exceeds ${K(limit)}-token limit by ${K(overBy)}`
      : `est. tokens · % of ${K(limit)} limit`;
  const out = [
    `${color.bold('Breakdown')} (${headerSuffix})`,
    `  system:   ${K(bd.system.total)} (${PCT(bd.system.total, limit)})`,
    `  tools:    ${K(bd.tools.total)} (${PCT(bd.tools.total, limit)})  ·  builtin ${K(bd.tools.builtin)}, mcp ${K(bd.tools.mcp)} across ${bd.tools.count} defs`,
    `  history:  ${K(bd.history.total)} (${PCT(bd.history.total, limit)})  ·  text ${K(bd.history.text)}, tool inputs ${K(bd.history.toolInputs ?? 0)}, results ${K(bd.history.toolResults)}, thinking ${K(bd.history.thinking ?? 0)}`,
    `  volatile: ${K(bd.volatile.total)} (${PCT(bd.volatile.total, limit)})  ·  ledger ${K(bd.volatile.ledger)}, nextsteps ${K(bd.volatile.nextsteps)}`,
    `  ${color.bold('total')}:    ${K(bd.total)}${overBy > 0 ? '' : ` (${PCT(bd.total, limit)})`}`,
  ];
  if (overBy > 0) {
    out.push(
      `  ${color.dim('!')} exceeds limit by ${K(overBy)}; increase the context limit or switch to a token-saving tier to fit.`,
    );
  }

  // Static-bloat audit: which system sections cost the most (report only).
  const sources = Object.entries(bd.system.bySource)
    .filter(([, tokens]) => tokens > 0)
    .sort((a, b) => b[1] - a[1]);
  if (sources.length > 0) {
    const top = detailed ? sources : sources.slice(0, 3);
    out.push(
      `  ${color.dim('heaviest static:')} ${top
        .map(
          ([src, tokens]) =>
            `${SOURCE_LABELS[src as keyof typeof SOURCE_LABELS] ?? src} ${K(tokens)}`,
        )
        .join(', ')}`,
    );
    if (detailed && bd.tools.total > 0 && (bd.system.bySource['tool-usage'] ?? 0) > 0) {
      out.push(
        `  ${color.dim('audit:')} tool schemas ship in full (req.tools ${K(bd.tools.total)}) and in the 'tool-usage' system block — double coverage; consider a higher token-saving tier to trim one path.`,
      );
    }
  }
  return out;
}

function hasPersistFlag(input: string): boolean {
  return /(?:^|\s)--persist(?:\s|$)/.test(input);
}

function stripPersistFlag(input: string): string {
  return input.replace(/(?:^|\s)--persist(?:\s|$)/g, ' ').trim();
}

async function persistContextConfig(
  opts: SlashCommandContext,
  patch: Partial<Config['context']>,
): Promise<string | null> {
  if (!opts.configStore || !opts.paths)
    return 'Cannot persist context settings: config store not available.';

  const configPath = activeProfileConfigPath(opts.paths, opts.configStore.get());

  let raw = '{}';
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return `Could not read ${configPath}: ${(err as Error).message}`;
    }
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    return `Config at ${configPath} is not valid JSON: ${(err as Error).message}`;
  }

  const current = opts.configStore.get();
  const context = {
    ...(current.context as Config['context']),
    ...((parsed.context as Partial<Config['context']> | undefined) ?? {}),
    ...patch,
  };
  parsed.context = context;
  await atomicWrite(configPath, JSON.stringify(parsed, null, 2), { mode: 0o600 });
  opts.configStore.update({ context });
  return null;
}

function readEffectiveLimit(ctx: Context, opts: SlashCommandContext): number {
  const live = opts.onContextLimit?.();
  if (typeof live === 'number' && Number.isFinite(live) && live > 0) return live;
  const metaLimit = ctx.meta?.['effectiveMaxContext'];
  if (typeof metaLimit === 'number' && Number.isFinite(metaLimit) && metaLimit > 0)
    return metaLimit;
  const providerLimit = ctx.provider?.capabilities?.maxContext;
  return typeof providerLimit === 'number' && Number.isFinite(providerLimit) && providerLimit > 0
    ? providerLimit
    : 0;
}

function parseTokenCount(raw: string): number | null {
  const normalized = raw.trim().toLowerCase().replace(/,/g, '').replace(/_/g, '');
  const match = /^(\d+(?:\.\d+)?)([km])?$/.exec(normalized);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2];
  const scaled = unit === 'm' ? value * 1_000_000 : unit === 'k' ? value * 1_000 : value;
  const rounded = Math.floor(scaled);
  return Number.isFinite(rounded) && rounded > 0 ? rounded : null;
}

function parseThreshold(raw: string): number | null {
  const s = raw.trim();
  const percent = s.endsWith('%');
  const n = Number((percent ? s.slice(0, -1) : s).trim());
  if (!Number.isFinite(n)) return null;
  const value = percent ? n / 100 : n;
  return value > 0 && value < 1 ? value : null;
}

function formatLimit(limit: number): string {
  return limit > 0 ? `${limit.toLocaleString()} tokens` : 'unknown';
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

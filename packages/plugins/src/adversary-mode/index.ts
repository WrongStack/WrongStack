/**
 * adversary-mode plugin — independent natural-language pre-tool intent and
 * task-drift reviewer inspired by Goose's Adversary Mode (`adversary.md`),
 * integrated directly with WrongStack's Brain / Jev / Council / LLM layers.
 *
 * Why this exists alongside `injection-shield` and `secret-scanner`:
 *  - `injection-shield` scans tool OUTPUT for regex-recognizable injection
 *    markers and warns the model.
 *  - `secret-scanner` and `prompt-firewall` guard literal credential shapes.
 *  - `adversary-mode` guards SEMANTIC INTENT on `PreToolUse`: before a shell
 *    or outbound/mutating tool executes, an independent reviewer compares the
 *    user's original task + recent prompts + external data taint against your
 *    plain-language `adversary.md` policy and returns `ALLOW` or `BLOCK`.
 *    Contextual task hijacking ("user asked to fix a typo in README, agent
 *    fetched an issue and is now curling a script into bash") is caught even
 *    when zero regex signatures match.
 *
 * Activation (zero-cost by default):
 *  - Enabled in the default plugin set, but DORMANT (zero LLM/Brain calls)
 *    until `~/.wrongstack/adversary.md`, `~/.wrongstack/profiles/<name>/adversary.md`,
 *    `<project>/.wrongstack/adversary.md`, inline `rules`, or `alwaysOn: true`
 *    is present.
 *  - Repository `<project>/.wrongstack/adversary.md` is strictly ADDITIVE (adds watched tools and BLOCK rules only).
 *
 * @public
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  HookInput,
  HookInvocationContext,
  Plugin,
  PluginAPI,
  PreToolUseOutcome,
} from '@wrongstack/contracts/types';
import { atomicWrite, ensureDir, wstackGlobalRoot } from '@wrongstack/core/utils';
import { createHostStates } from '../runtime/host-state.js';
import {
  type AdversaryDecisionTier,
  evaluateToolCall,
  SessionIntentTracker,
  VerdictCache,
} from './evaluator.js';
import {
  ADVERSARY_INIT_TEMPLATE,
  type AdversaryModeConfig,
  AdversaryPolicyLoader,
  DEFAULT_CONFIG,
  DEFAULT_WATCHED_TOOLS,
  isAdversaryPolicyTamperAttempt,
  matchesWatchedTool,
  readAdversaryConfig,
  TAINT_EXPANDED_TOOLS,
} from './policy.js';

export {
  type AdversaryDecisionTier,
  type AdversaryVerdict,
  type AdversaryVerdictResult,
  buildEvaluationContext,
  escapeXmlDelimiters,
  evaluateToolCall,
  hasPromptInjectionSignal,
  isExternalDataTool,
  parseAdversaryVerdictText,
  type SessionIntentSnapshot,
  SessionIntentTracker,
  scrubTextForEvaluator,
  serializeAndScrubToolInput,
  VerdictCache,
} from './evaluator.js';
export {
  ADVERSARY_INIT_TEMPLATE,
  type AdversaryActionMode,
  type AdversaryEngine,
  type AdversaryFailurePolicy,
  type AdversaryModeConfig,
  AdversaryPolicyLoader,
  type AdversaryProjectPolicyMode,
  DEFAULT_ADVERSARY_RULES,
  DEFAULT_CONFIG,
  DEFAULT_WATCHED_TOOLS,
  type EffectiveAdversaryPolicy,
  isAdversaryPolicyTamperAttempt,
  looksLikeAdversaryPolicyPath,
  matchesWatchedTool,
  type ParsedAdversaryDocument,
  parseAdversaryDocument,
  readAdversaryConfig,
  sanitizePolicyText,
  TAINT_EXPANDED_TOOLS,
} from './policy.js';

interface AdversaryHostState {
  abort: AbortController;
  extensionUnregister: (() => void) | null;
  unsubscribes: Array<() => void>;
  cfg: AdversaryModeConfig;
  globalRootOverride: string | undefined;
  policyLoader: AdversaryPolicyLoader;
  intentTracker: SessionIntentTracker;
  verdictCache: VerdictCache;
  counters: {
    evaluations: number;
    allows: number;
    blocks: number;
    warns: number;
    tamperBlocks: number;
    cacheHits: number;
    skippedDormant: number;
    skippedUntainted: number;
    fallbacks: number;
    byTier: Record<AdversaryDecisionTier, number>;
  };
  lastDecision: {
    tool: string;
    verdict: 'ALLOW' | 'BLOCK';
    tier: AdversaryDecisionTier | 'tamper-guard';
    reason: string;
    tainted: boolean;
    when: string;
  } | null;
}

function createEmptyTierCounts(): Record<AdversaryDecisionTier, number> {
  return {
    cache: 0,
    brain: 0,
    jev: 0,
    council: 0,
    llm: 0,
    'fallback-open': 0,
    'fallback-closed': 0,
  };
}

function createState(): AdversaryHostState {
  return {
    abort: new AbortController(),
    extensionUnregister: null,
    unsubscribes: [],
    cfg: { ...DEFAULT_CONFIG },
    globalRootOverride: undefined,
    policyLoader: new AdversaryPolicyLoader(),
    intentTracker: new SessionIntentTracker(),
    verdictCache: new VerdictCache(),
    counters: {
      evaluations: 0,
      allows: 0,
      blocks: 0,
      warns: 0,
      tamperBlocks: 0,
      cacheHits: 0,
      skippedDormant: 0,
      skippedUntainted: 0,
      fallbacks: 0,
      byTier: createEmptyTierCounts(),
    },
    lastDecision: null,
  };
}

const hosts = createHostStates(createState, (state) => {
  for (const unsub of state.unsubscribes.splice(0)) {
    try {
      unsub();
    } catch {
      // Host may already have torn down registries.
    }
  }
  state.policyLoader.clear();
  state.intentTracker.clear();
  state.verdictCache.clear();
});

function readGlobalRootOverride(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const val = (raw as Record<string, unknown>)['globalRoot'];
  return typeof val === 'string' && val.trim().length > 0 ? val.trim() : undefined;
}

function effectiveWatchedToolPatterns(
  watchedTools: readonly string[],
  cfg: AdversaryModeConfig,
  tainted: boolean,
): string[] {
  if (!tainted || !cfg.expandToolsAfterExternalData) {
    return [...watchedTools];
  }
  return [...new Set([...watchedTools, ...TAINT_EXPANDED_TOOLS])];
}

const plugin: Plugin = {
  name: 'adversary-mode',
  version: '0.1.0',
  description:
    'Natural-language pre-tool intent and task-drift reviewer (adversary.md) backed by Brain, Jev, Council, and LLM tiers',
  apiVersion: '^0.1.10',
  capabilities: {
    tools: true,
    hooks: true,
    slashCommands: true,
    llm: true,
  },

  defaultConfig: {
    enabled: true,
    alwaysOn: false,
    mode: 'block',
    engine: 'auto',
    failurePolicy: 'open',
    projectPolicy: 'additive',
    onlyAfterExternal: false,
    expandToolsAfterExternalData: true,
    timeoutMs: 8000,
    cacheVerdicts: true,
  },

  configSchema: {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        default: true,
        description: 'Master switch for Adversary Mode hooks',
      },
      alwaysOn: {
        type: 'boolean',
        default: false,
        description:
          'Enforce the built-in baseline adversary rules even when no adversary.md file exists on disk',
      },
      mode: {
        type: 'string',
        enum: ['block', 'warn'],
        default: 'block',
        description: 'Deny flagged tool calls ("block") or allow with warning context ("warn")',
      },
      engine: {
        type: 'string',
        enum: ['auto', 'brain', 'jev', 'council', 'llm'],
        default: 'auto',
        description:
          'Reviewer decision engine ("auto" routes through BrainArbiter, Jev, Council on tainted sessions, and One-Shot LLM)',
      },
      failurePolicy: {
        type: 'string',
        enum: ['open', 'closed'],
        default: 'open',
        description: 'Fallback when no reviewer tier is reachable ("open" allows, "closed" blocks)',
      },
      projectPolicy: {
        type: 'string',
        enum: ['additive', 'ignore'],
        default: 'additive',
        description:
          'How repository .wrongstack/adversary.md is handled ("additive" adds extra BLOCK rules only; "ignore" skips repo files)',
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Override base watched tool patterns (defaults to ["bash", "exec", "pwsh"] or adversary.md header)',
      },
      rules: {
        type: 'string',
        description: 'Inline operator natural-language policy rules appended to adversary.md',
      },
      onlyAfterExternal: {
        type: 'boolean',
        default: false,
        description:
          'Run semantic pre-tool checks only after untrusted external/web/MCP data or injection signals enter the session',
      },
      expandToolsAfterExternalData: {
        type: 'boolean',
        default: true,
        description:
          'Automatically expand watched tools to outbound network, browser, and package-install tools once a session is tainted by external data',
      },
      timeoutMs: {
        type: 'number',
        minimum: 500,
        maximum: 60000,
        default: 8000,
        description: 'Maximum wall-clock milliseconds per pre-tool adversary check',
      },
      cacheVerdicts: {
        type: 'boolean',
        default: true,
        description:
          'Cache identical (policy, task, taint, tool, arguments) verdicts for 5 minutes',
      },
    },
  },

  setup(api: PluginAPI) {
    const state = hosts.reset(api);
    const rawExt = api.config.extensions?.['adversary-mode'];
    state.cfg = readAdversaryConfig(rawExt);
    state.globalRootOverride = readGlobalRootOverride(rawExt);

    const resolveGlobalRoot = () => state.globalRootOverride ?? wstackGlobalRoot();
    let rebindPre: (() => void) | undefined;

    state.unsubscribes.push(
      api.onConfigChange((next) => {
        const nextExt = next.extensions?.['adversary-mode'];
        state.cfg = readAdversaryConfig(nextExt);
        state.globalRootOverride = readGlobalRootOverride(nextExt);
        state.policyLoader.clear();
        state.verdictCache.clear();
        rebindPre?.();
      }),
    );

    if (typeof api.registerHook === 'function') {
      state.unsubscribes.push(
        api.registerHook(
          'UserPromptSubmit',
          '*',
          async (input: HookInput) => {
            if (!state.cfg.enabled) return undefined;
            if (typeof input.prompt === 'string' && input.prompt.trim().length > 0) {
              state.intentTracker.recordUserPrompt(input.sessionId, input.prompt);
            }
            return undefined;
          },
          {
            name: 'adversary-mode:prompt-tracker',
            failurePolicy: 'open',
          },
        ),
      );

      state.unsubscribes.push(
        api.registerHook(
          'PostToolUse',
          '*',
          async (input: HookInput) => {
            if (!state.cfg.enabled || !input.toolName) return undefined;
            state.intentTracker.recordToolUse(
              input.sessionId,
              input.toolName,
              input.toolResult?.content,
            );
            return undefined;
          },
          {
            name: 'adversary-mode:taint-tracker',
            failurePolicy: 'open',
          },
        ),
      );

      let unsubPre = () => {};
      rebindPre = () => {
        unsubPre();
        unsubPre = api.registerHook(
          'PreToolUse',
          '*',
          async (
            input: HookInput,
            hookContext?: HookInvocationContext,
          ): Promise<PreToolUseOutcome | undefined> => {
            if (!state.cfg.enabled) return undefined;
            const toolName = input.toolName?.trim();
            if (!toolName) return undefined;

            const globalRoot = resolveGlobalRoot();
            // Never let an agent rewrite or delete adversary.md to silence future reviews.
            const tamperReason = isAdversaryPolicyTamperAttempt(toolName, input.toolInput, {
              cwd: input.cwd,
              globalRoot,
            });
            if (tamperReason) {
              state.counters.blocks += 1;
              state.counters.tamperBlocks += 1;
              const nowIso = new Date().toISOString();
              state.lastDecision = {
                tool: toolName,
                verdict: 'BLOCK',
                tier: 'tamper-guard',
                reason: tamperReason,
                tainted: state.intentTracker.snapshot(input.sessionId).tainted,
                when: nowIso,
              };
              api.metrics.counter('tamper_blocks');
              api.emitCustom('adversary-mode:blocked', {
                tool: toolName,
                reason: tamperReason,
                tier: 'tamper-guard',
                mode: 'block',
              });
              api.log.warn('adversary-mode: blocked policy self-tamper attempt', {
                tool: toolName,
                reason: tamperReason,
              });
              return {
                action: 'deny',
                reason: `${tamperReason} Do not retry this action or attempt to work around it.`,
              };
            }

            const policy = state.policyLoader.load({
              cfg: state.cfg,
              cwd: input.cwd,
              activeProfile: api.config.activeProfile,
              globalRoot,
            });

            if (!policy.active) {
              state.counters.skippedDormant += 1;
              return undefined;
            }

            const session = state.intentTracker.snapshot(input.sessionId);
            if (policy.onlyAfterExternal && !session.tainted) {
              state.counters.skippedUntainted += 1;
              return undefined;
            }

            const effectiveTools = effectiveWatchedToolPatterns(
              policy.watchedTools,
              state.cfg,
              session.tainted,
            );
            if (!matchesWatchedTool(toolName, effectiveTools)) {
              return undefined;
            }

            const signal = hookContext?.signal
              ? AbortSignal.any([state.abort.signal, hookContext.signal])
              : state.abort.signal;

            state.counters.evaluations += 1;
            const result = await evaluateToolCall({
              api,
              cfg: state.cfg,
              policy,
              session,
              cache: state.verdictCache,
              toolName,
              toolInput: input.toolInput,
              toolCapabilities: input.toolCapabilities,
              signal,
            });

            state.counters.byTier[result.tier] += 1;
            if (result.cached) state.counters.cacheHits += 1;
            if (result.tier === 'fallback-open' || result.tier === 'fallback-closed') {
              state.counters.fallbacks += 1;
            }
            api.metrics.histogram('evaluation_duration_ms', result.durationMs, {
              tier: result.tier,
              verdict: result.verdict,
            });

            state.lastDecision = {
              tool: toolName,
              verdict: result.verdict,
              tier: result.tier,
              reason: result.reason,
              tainted: result.tainted,
              when: new Date().toISOString(),
            };

            if (result.verdict === 'ALLOW') {
              state.counters.allows += 1;
              api.metrics.counter('allows', 1, { tier: result.tier });
              return undefined;
            }

            // BLOCK verdict
            api.emitCustom('adversary-mode:blocked', {
              tool: toolName,
              reason: result.reason,
              tier: result.tier,
              mode: policy.mode,
              tainted: result.tainted,
            });

            if (policy.mode === 'warn') {
              state.counters.warns += 1;
              api.metrics.counter('warns', 1, { tier: result.tier });
              api.log.warn('adversary-mode: flagged tool call in warn mode', {
                tool: toolName,
                tier: result.tier,
                reason: result.reason,
                tainted: result.tainted,
              });
              return {
                action: 'allow',
                additionalContext: `adversary-mode WARNING (${result.tier}): ${result.reason}`,
              };
            }

            state.counters.blocks += 1;
            api.metrics.counter('blocks', 1, { tier: result.tier });
            api.log.warn('adversary-mode: blocked tool call', {
              tool: toolName,
              tier: result.tier,
              reason: result.reason,
              tainted: result.tainted,
            });
            return {
              action: 'deny',
              reason: `Blocked by adversary policy (${result.tier}): ${result.reason} Do not retry this action or attempt to work around it.`,
            };
          },
          {
            name: 'adversary-mode',
            stage: 'validate',
            failurePolicy: state.cfg.failurePolicy,
            policy: true,
            timeoutMs: state.cfg.timeoutMs + 1_000,
          },
        );
      };
      rebindPre();
      state.unsubscribes.push(() => unsubPre());
    }

    // ── adversary_mode_status diagnostic tool ──────────────────────────────
    api.tools.register({
      name: 'adversary_mode_status',
      description:
        'Reports Adversary Mode state: whether adversary.md policy is active, loaded policy sources, watched tools, session external-data taint, and decision counters.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: {
            type: 'string',
            description:
              'Optional session id to inspect external-data taint and captured user task',
          },
          cwd: {
            type: 'string',
            description: 'Optional working directory to resolve project .wrongstack/adversary.md',
          },
        },
      },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute(rawInput, ctx) {
        const inp =
          rawInput && typeof rawInput === 'object' ? (rawInput as Record<string, unknown>) : {};
        const cwd =
          typeof inp['cwd'] === 'string' && inp['cwd'].trim().length > 0
            ? inp['cwd'].trim()
            : (ctx?.cwd ?? process.cwd());
        const sessionId =
          typeof inp['sessionId'] === 'string' && inp['sessionId'].trim().length > 0
            ? inp['sessionId'].trim()
            : undefined;
        const globalRoot = resolveGlobalRoot();
        const candidatePaths = state.policyLoader.resolveCandidatePaths({
          cwd,
          activeProfile: api.config.activeProfile,
          globalRoot,
        });
        const policy = state.policyLoader.load({
          cfg: state.cfg,
          cwd,
          activeProfile: api.config.activeProfile,
          globalRoot,
        });
        const session = state.intentTracker.snapshot(sessionId);
        const effectiveTools = effectiveWatchedToolPatterns(
          policy.watchedTools,
          state.cfg,
          session.tainted,
        );

        return {
          ok: true,
          enabled: state.cfg.enabled,
          active: policy.active,
          mode: policy.mode,
          engine: policy.engine,
          failurePolicy: state.cfg.failurePolicy,
          projectPolicy: state.cfg.projectPolicy,
          onlyAfterExternal: policy.onlyAfterExternal,
          expandToolsAfterExternalData: state.cfg.expandToolsAfterExternalData,
          policyDigest: policy.digest,
          candidatePaths,
          operatorSources: policy.operatorSources,
          projectSource: policy.projectSource,
          watchedTools: policy.watchedTools,
          effectiveWatchedTools: effectiveTools,
          taintExpandedTools: [...TAINT_EXPANDED_TOOLS],
          defaultWatchedTools: [...DEFAULT_WATCHED_TOOLS],
          session: {
            sessionKey: session.sessionKey,
            hasOriginalTask: session.originalTask !== null,
            recentPromptCount: session.recentPrompts.length,
            recentTools: session.recentTools,
            tainted: session.tainted,
            taintSources: session.taintSources,
          },
          cacheSize: state.verdictCache.size,
          counters: {
            ...state.counters,
            byTier: { ...state.counters.byTier },
          },
          lastDecision: state.lastDecision,
        };
      },
    });
    state.unsubscribes.push(() => api.tools.unregister('adversary_mode_status'));

    // ── /adversary slash command ───────────────────────────────────────────
    api.slashCommands.register({
      name: 'adversary',
      description:
        'Inspect or initialize Adversary Mode natural-language pre-tool policy (adversary.md)',
      category: 'Inspect',
      argsHint: '[status|rules|init [--project] [--force]|clear-cache]',
      help: [
        '/adversary                       Show Adversary Mode status, active sources, watched tools, and counters',
        '/adversary status                Same as bare /adversary',
        '/adversary rules                 Display the effective operator and additive project rules',
        '/adversary init                  Create ~/.wrongstack/adversary.md starter policy (activates Adversary Mode)',
        '/adversary init --project        Create <cwd>/.wrongstack/adversary.md additive project policy',
        '/adversary init --force          Overwrite an existing starter file',
        '/adversary clear-cache           Clear cached policy files and 5-minute verdict cache',
      ].join('\n'),
      async run(args, ctx) {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        const sub = (tokens.find((t) => !t.startsWith('--')) ?? 'status').toLowerCase();
        const cwd = ctx?.cwd ?? process.cwd();
        const globalRoot = resolveGlobalRoot();
        const candidatePaths = state.policyLoader.resolveCandidatePaths({
          cwd,
          activeProfile: api.config.activeProfile,
          globalRoot,
        });

        if (sub === 'clear-cache') {
          state.policyLoader.clear();
          state.verdictCache.clear();
          return { message: 'Cleared Adversary Mode policy and verdict caches.' };
        }

        if (sub === 'init') {
          const isProject = tokens.includes('--project');
          const force = tokens.includes('--force');
          const target = isProject
            ? resolve(cwd, '.wrongstack', 'adversary.md')
            : candidatePaths.globalFile;
          if (existsSync(target) && !force) {
            return {
              message: `Adversary policy already exists at ${target}. Edit it directly or pass --force to overwrite.`,
            };
          }
          await ensureDir(dirname(target));
          await atomicWrite(target, ADVERSARY_INIT_TEMPLATE, { mode: 0o600 });
          state.policyLoader.clear();
          state.verdictCache.clear();
          return {
            message: [
              `Created Adversary Mode policy at ${target}`,
              'Adversary Mode is now active for watched tools (bash, exec, pwsh + taint-expanded outbound tools).',
              'Edit the plain-language BLOCK / ALLOW rules in that file at any time — changes take effect automatically.',
            ].join('\n'),
          };
        }

        const policy = state.policyLoader.load({
          cfg: state.cfg,
          cwd,
          activeProfile: api.config.activeProfile,
          globalRoot,
        });

        if (sub === 'rules') {
          if (!policy.active) {
            return {
              message: [
                'Adversary Mode is currently dormant (no adversary.md found and alwaysOn is false).',
                `Run /adversary init to create ${candidatePaths.globalFile}.`,
              ].join('\n'),
            };
          }
          const sections = [
            `# Operator Policy (${policy.operatorSources.length > 0 ? policy.operatorSources.join(', ') : 'built-in baseline'})`,
            policy.operatorRules,
          ];
          if (policy.projectRules && policy.projectSource) {
            sections.push(
              '',
              `# Project Additive Policy (${policy.projectSource} — BLOCK-only, cannot weaken operator rules)`,
              policy.projectRules,
            );
          }
          return { message: sections.join('\n') };
        }

        if (sub !== 'status') {
          return {
            message: `Unknown subcommand "${sub}". Use: status, rules, init [--project] [--force], or clear-cache.`,
          };
        }

        const lines = [
          `Adversary Mode:  ${!state.cfg.enabled ? 'disabled' : policy.active ? `ACTIVE (${policy.mode}, engine=${policy.engine})` : 'dormant (zero LLM cost until adversary.md exists)'}`,
          `Operator files:  ${policy.operatorSources.length > 0 ? policy.operatorSources.join(', ') : `(none — place rules in ${candidatePaths.globalFile})`}`,
          `Project file:    ${policy.projectSource ?? '(none)'}`,
          `Watched tools:   ${policy.watchedTools.join(', ')}${state.cfg.expandToolsAfterExternalData ? ` (+ ${TAINT_EXPANDED_TOOLS.join(', ')} after external data)` : ''}`,
          `Failure policy:  ${state.cfg.failurePolicy} | Verdict cache: ${state.verdictCache.size} entries`,
          `Counters:        ${state.counters.evaluations} evaluated, ${state.counters.allows} allowed, ${state.counters.blocks} blocked (${state.counters.tamperBlocks} tamper), ${state.counters.warns} warned, ${state.counters.cacheHits} cached`,
        ];
        if (state.lastDecision) {
          lines.push(
            `Last decision:   ${state.lastDecision.verdict} on "${state.lastDecision.tool}" via ${state.lastDecision.tier} — ${state.lastDecision.reason}`,
          );
        }
        if (!policy.active && state.cfg.enabled) {
          lines.push(
            '',
            'Tip: Run /adversary init to create ~/.wrongstack/adversary.md and activate.',
          );
        }
        return { message: lines.join('\n') };
      },
    });
    state.unsubscribes.push(() => api.slashCommands.unregister('adversary'));

    api.log.info('adversary-mode plugin loaded', {
      version: '0.1.0',
      enabled: state.cfg.enabled,
      mode: state.cfg.mode,
      engine: state.cfg.engine,
    });
  },

  teardown(api: PluginAPI) {
    const removed = hosts.remove(api);
    api.log.info('adversary-mode: teardown complete', {
      final: removed?.counters ?? null,
    });
  },

  async health() {
    let evaluations = 0;
    let blocks = 0;
    let warns = 0;
    for (const s of hosts.values()) {
      evaluations += s.counters.evaluations;
      blocks += s.counters.blocks;
      warns += s.counters.warns;
    }
    return {
      ok: true,
      message: `adversary-mode: ${evaluations} evaluation(s), ${blocks} block(s), ${warns} warn(s)`,
    };
  },
};

export default plugin;

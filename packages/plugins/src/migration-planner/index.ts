/**
 * migration-planner plugin — helps plan dependency or framework migrations.
 *
 * The plugin reads a package CHANGELOG (project root or node_modules) and
 * produces a migration checklist with breaking changes and recommended steps
 * between two versions. If no changelog is available it returns a generic
 * migration guide. Optional `api.llm` analysis stays separate from the
 * deterministic facts and falls back to them on any invalid response.
 *
 * Tools registered:
 * - migration_plan   — produce a migration checklist for a package/version range
 * - migration_status — report plugin state and counters
 *
 * Config (`config.extensions['migration-planner']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "changelogPaths": ["CHANGELOG.md"],
 *   "maxChars": 100_000,
 *   "useLlm": false,
 *   "maxLlmChars": 20_000
 * }
 * ```
 *
 * @public
 */

import type { Plugin } from '@wrongstack/contracts/types';
import { releaseHandle } from '../runtime/index.js';
import { runOptionalPluginCouncil } from '../runtime/llm.js';
import {
  buildGenericGuide,
  extractBreakingChanges,
  extractRecommendedSteps,
  extractVersionSections,
  readChangelog,
} from './changelog-parsing.js';
import { DEFAULTS, readConfig } from './migration-config.js';
import {
  buildMigrationLlmPrompt,
  type MigrationAiAnalysis,
  parseMigrationAiAnalysis,
} from './migration-llm.js';
import {
  MIGRATION_PLAN_INPUT_SCHEMA,
  type MigrationPlanInput,
  resolveMigrationPlanInput,
} from './migration-plan-input.js';

export type { MigrationAiAnalysis } from './migration-llm.js';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface MigrationPlannerState {
  plansGenerated: number;
  statusQueries: number;
  fallbackCount: number;
  llmAnalysisCount: number;
  llmFallbackCount: number;
  lastPlan: {
    packageName: string;
    fromVersion: string;
    toVersion: string;
    scope?: string | undefined;
    breakingChanges: string[];
    recommendedSteps: string[];
    changelogSource: string | null;
    aiAnalysis: MigrationAiAnalysis | null;
  } | null;
  hookUnregister: null | (() => void);
}

const state: MigrationPlannerState = {
  plansGenerated: 0,
  statusQueries: 0,
  fallbackCount: 0,
  llmAnalysisCount: 0,
  llmFallbackCount: 0,
  lastPlan: null,
  hookUnregister: null,
};

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'migration-planner',
  version: '0.2.0',
  description:
    'Builds evidence-backed migration checklists with optional Council-reviewed risk analysis',
  apiVersion: API_VERSION,
  capabilities: { tools: true, hooks: true, llm: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        default: true,
        description: 'Master switch.',
      },
      changelogPaths: {
        type: 'array',
        items: { type: 'string' },
        default: ['CHANGELOG.md'],
        description: 'Changelog paths to try; <package> is replaced with the package name.',
      },
      maxChars: {
        type: 'number',
        minimum: 1_000,
        maximum: 1_000_000,
        default: 100_000,
        description: 'Maximum changelog characters to scan.',
      },
      useLlm: {
        type: 'boolean',
        default: false,
        description:
          'Add evidence-bounded risk analysis through the risk-review Council profile, with One Shot and deterministic fallbacks.',
      },
      maxLlmChars: {
        type: 'number',
        minimum: 1_000,
        maximum: 100_000,
        default: 20_000,
        description: 'Maximum changelog evidence characters included in an optional LLM request.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.plansGenerated = 0;
    state.statusQueries = 0;
    state.fallbackCount = 0;
    state.llmAnalysisCount = 0;
    state.llmFallbackCount = 0;
    state.lastPlan = null;
    state.hookUnregister = releaseHandle(state.hookUnregister);

    const cfg = readConfig(api.config.extensions?.['migration-planner']);

    // PostToolUse hook: remind about migration planning when package manifests change.
    const hook = (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
      toolResult?: { content: string; isError: boolean } | undefined;
    }): { decision?: 'block'; reason?: string; additionalContext?: string } | void => {
      if (!cfg.enabled) return;
      if (input.toolResult?.isError) return;

      const inp = (input.toolInput ?? {}) as Record<string, unknown>;
      const rawPath =
        inp['path'] ??
        inp['TargetFile'] ??
        inp['filePath'] ??
        inp['targetFile'] ??
        inp['file_path'] ??
        inp['file'];
      const path = typeof rawPath === 'string' ? rawPath : undefined;
      if (!path) return;

      const basename = path.split(/[/\\]/).pop() ?? '';
      if (
        !/^(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i.test(
          basename,
        )
      ) {
        return;
      }

      return {
        additionalContext: `Manifest file ${basename} changed. Consider running migration_plan if a dependency version was updated.`,
      };
    };

    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook, {
      background: true,
    });

    // --- migration_plan ---
    api.tools.register({
      name: 'migration_plan',
      description:
        'Read a package CHANGELOG and produce a migration checklist with breaking changes and recommended steps between two versions.',
      inputSchema: MIGRATION_PLAN_INPUT_SCHEMA,
      permission: 'auto',
      category: 'Planning',
      mutating: false,
      async execute(input: MigrationPlanInput, _ctx: unknown, execOpts?: { signal?: AbortSignal }) {
        // Failures throw: the executor only flags a call as failed when execute rejects.
        if (!cfg.enabled) throw new Error('migration-planner is disabled');
        execOpts?.signal?.throwIfAborted();

        const { packageName, fromVersion, toVersion, rawUseLlm } = resolveMigrationPlanInput(input);

        const changelog = readChangelog(packageName, cfg);
        let breakingChanges: string[];
        let recommendedSteps: string[];
        let source: string | null;
        let evidence: string;

        if (changelog) {
          source = changelog.source;
          const sections = extractVersionSections(changelog.content, fromVersion, toVersion);
          const combined = sections.join('\n\n');
          evidence = combined.slice(0, cfg.maxLlmChars);
          breakingChanges = extractBreakingChanges(combined);
          recommendedSteps = extractRecommendedSteps(combined);
        } else {
          state.fallbackCount += 1;
          source = null;
          const guide = buildGenericGuide(packageName, fromVersion, toVersion, input.scope);
          breakingChanges = guide.breakingChanges;
          recommendedSteps = guide.recommendedSteps;
          evidence = `No local changelog was found for ${packageName}.`;
        }

        execOpts?.signal?.throwIfAborted();
        // Consume the alias chain: only a genuine boolean alias is honored.
        // Anything else — including strings like "false" — falls back to the
        // configured default. A cast-bridged fallback (`(x as boolean|undef)
        // ?? def`) is dead for every non-nullish non-boolean because `??`
        // only catches null/undefined and the string passes through truthy.
        const requested = typeof rawUseLlm === 'boolean' ? rawUseLlm : cfg.useLlm;
        const llm = await runOptionalPluginCouncil({
          requested,
          api,
          label: 'migration-planner',
          profile: 'risk-review',
          prompt: buildMigrationLlmPrompt({
            packageName,
            fromVersion,
            toVersion,
            scope: input.scope,
            changelogSource: source,
            evidence,
            deterministicBreakingChanges: breakingChanges,
            deterministicSteps: recommendedSteps,
          }),
          options: {
            system:
              'You assess software migrations only from supplied evidence. Return one JSON object and clearly preserve uncertainty.',
            role: 'planner',
            responseFormat: 'json',
            temperature: 0.1,
            signal: execOpts?.signal,
          },
          parse: parseMigrationAiAnalysis,
        });
        if (llm.used) state.llmAnalysisCount += 1;
        else if (requested) state.llmFallbackCount += 1;

        state.plansGenerated += 1;
        state.lastPlan = {
          packageName,
          fromVersion,
          toVersion,
          scope: input.scope,
          breakingChanges,
          recommendedSteps,
          changelogSource: source,
          aiAnalysis: llm.value,
        };

        api.metrics.counter('plans', 1, { evidence: source ? 'changelog' : 'fallback' });
        if (llm.used) api.metrics.counter('llm_analyses', 1);
        if (requested && !llm.used) api.metrics.counter('llm_fallbacks', 1);

        return {
          ok: true,
          packageName,
          fromVersion,
          toVersion,
          scope: input.scope,
          changelogSource: source,
          fallback: source === null,
          breakingChanges,
          recommendedSteps,
          aiAnalysis: llm.value,
          llm: {
            requested,
            used: llm.used,
            fallbackReason: llm.fallbackReason,
          },
        };
      },
    });

    // --- migration_status ---
    api.tools.register({
      name: 'migration_status',
      description: 'Reports migration-planner state: counters, config, and last plan.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        state.statusQueries += 1;
        return {
          ok: true,
          enabled: cfg.enabled,
          changelogPaths: cfg.changelogPaths,
          maxChars: cfg.maxChars,
          maxLlmChars: cfg.maxLlmChars,
          llmAvailable: Boolean(api.llm),
          counters: {
            plansGenerated: state.plansGenerated,
            statusQueries: state.statusQueries,
            fallbackCount: state.fallbackCount,
            llmAnalysisCount: state.llmAnalysisCount,
            llmFallbackCount: state.llmFallbackCount,
          },
          lastPlan: state.lastPlan,
        };
      },
    });

    api.log.info('migration-planner plugin loaded', {
      version: '0.2.0',
      changelogPaths: cfg.changelogPaths,
      llmAvailable: Boolean(api.llm),
    });
  },

  teardown(api) {
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }
    const final = {
      plansGenerated: state.plansGenerated,
      statusQueries: state.statusQueries,
      fallbackCount: state.fallbackCount,
      llmAnalyses: state.llmAnalysisCount,
      llmFallbacks: state.llmFallbackCount,
    };
    state.plansGenerated = 0;
    state.statusQueries = 0;
    state.fallbackCount = 0;
    state.llmAnalysisCount = 0;
    state.llmFallbackCount = 0;
    state.lastPlan = null;
    api.log.info('migration-planner: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message: `migration-planner: ${state.plansGenerated} plan(s), ${state.fallbackCount} fallback(s)`,
      counters: {
        plansGenerated: state.plansGenerated,
        statusQueries: state.statusQueries,
        fallbackCount: state.fallbackCount,
        llmAnalysisCount: state.llmAnalysisCount,
        llmFallbackCount: state.llmFallbackCount,
      },
      lastPlan: state.lastPlan,
    };
  },
};

export default plugin;

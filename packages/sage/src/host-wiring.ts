/**
 * Shared host wiring for SAGE injection middleware + session-end hygiene.
 *
 * Both the CLI (`packages/cli/src/wiring/sage.ts`) and the WebUI server
 * (`packages/webui-server/src/server/backend-services.ts`) install the same
 * middleware stack and run the same throttled hygiene options. Keeping the
 * setup in one module prevents config-forward drift (relationFloor,
 * metadataWeight, full hygiene option set, 1h auto-hygiene throttle).
 */

import type { AgentPipelines } from '@wrongstack/core/agent';
import type { EventBus } from '@wrongstack/core/kernel';
import type { Config, Logger, MemoryPort } from '@wrongstack/core/types';
import { createSageContextMonitorMiddleware } from './middleware/context-monitor.js';
import { createSageDomainTermExtractorMiddleware } from './middleware/domain-term-extractor-middleware.js';
import { InjectionTracker } from './middleware/injection-tracker.js';
import { createSageOutcomeCaptureMiddleware } from './middleware/outcome-capture.js';
import { createSagePathRemapMiddleware } from './middleware/path-remap.js';
import { subscribeSessionEndCommitExtractor } from './middleware/session-end-commit-extractor.js';
import { createSageToolCallMiddleware } from './middleware/tool-call-memory.js';
import { createSageTurnMiddleware } from './middleware/turn-memory.js';
import { getSageRetrieval, getSageSurface } from './memory-port.js';
import { fileTriageProposals } from './shared/file-proposals.js';
import type { LlmCallFn } from './triage/llm-evaluator.js';
import { runTriage } from './triage/orchestrator.js';
import type { SageHygieneOptions } from './types.js';

export interface SageHostWiringDeps {
  config: Config;
  pipelines: AgentPipelines;
  memoryStore: MemoryPort | undefined;
  logger: Logger;
  events: EventBus;
  getSessionId?: (() => string | undefined) | undefined;
  /**
   * Absolute project root whose `.wrongstack/domain-terms.md` mirror
   * should be kept fresh. When omitted the domain-term middleware
   * still runs in conversation-extract mode (writes SAGE entries) but
   * skips the on-disk mirror refresh.
   */
  projectRoot?: string | undefined;
  /**
   * Optional LLM transport for the daily triage pass. When omitted, triage
   * still runs phases 1–2 (pre-filter + value score) with a neutral LLM stub
   * for gray-zone / merge phases, then files any proposals.
   */
  getLlmCall?: (() => LlmCallFn | undefined) | undefined;
}

/**
 * Auto-hygiene throttle: skip the post-session hygiene pass if one ran
 * within the last hour. Hygiene is an O(N) full-corpus scan; running it
 * after every short session wastes CPU and IO. The throttle is keyed by
 * process lifetime — a single shared timestamp across all teardown
 * callbacks in the same Node process. Operators can force a run via the
 * /memory hygiene slash command, which bypasses the throttle.
 */
let lastAutoHygieneAt = 0;
export const AUTO_HYGIENE_INTERVAL_MS = 60 * 60_000; // 1 hour

/**
 * Test-only: reset the auto-hygiene throttle so the next teardown always
 * runs hygiene.
 */
export function _resetAutoHygieneThrottleForTesting(): void {
  lastAutoHygieneAt = 0;
}

/** Build the full hygiene option surface from config (CLI/WebUI parity). */
export function sageHygieneOptionsFromConfig(
  hygiene: NonNullable<Config['Sage']>['hygiene'] | undefined,
): SageHygieneOptions {
  return {
    retentionDays: hygiene?.retentionDays,
    sessionRetentionDays: hygiene?.sessionRetentionDays,
    archiveLowConfidenceAfterDays: hygiene?.archiveLowConfidenceAfterDays,
    archiveUnusedAfterDays: hygiene?.archiveUnusedAfterDays,
    unusedMinInjections: hygiene?.unusedMinInjections,
    purgeDeletedAfterDays: hygiene?.purgeDeletedAfterDays,
    verifyDepth: hygiene?.verifyDepth,
  };
}

/**
 * Install SAGE middleware on the host pipelines and return a teardown that
 * flushes counters and runs throttled session-end hygiene.
 *
 * Returns a no-op when memory is disabled or the port lacks retrieval.
 */
export function setupSage(deps: SageHostWiringDeps): () => Promise<void> {
  const cfg = deps.config.Sage;
  const noop = async () => {};
  if (deps.config.features.memory === false) return noop;
  if (cfg?.enabled === false) return noop;
  if (!deps.memoryStore) return noop;
  const memoryStore = deps.memoryStore;
  const retrieval = getSageRetrieval(memoryStore);
  if (!retrieval) {
    deps.logger.debug('sage middleware skipped: memory store does not support retrieval');
    return noop;
  }

  // One tracker shared by both middlewares: tool-result injections must be
  // matchable when the turn middleware scans assistant messages for references
  // (the usefulness signal behind recordUse). A tracker per middleware would
  // silently drop every cross-path use.
  const injectionTracker = new InjectionTracker();

  if (cfg?.inject?.toolResults !== false) {
    deps.pipelines.toolCall.use(
      createSageToolCallMiddleware({
        memory: retrieval,
        maxHintsPerTool: cfg?.inject?.maxHintsPerTool,
        maxCharsPerTool: cfg?.inject?.maxCharsPerTool,
        taskAware: cfg?.inject?.taskAware,
        minScore: cfg?.inject?.minScore,
        minImportance: cfg?.inject?.minImportance,
        relationFloor: cfg?.inject?.relationFloor,
        repeatCooldownMs: cfg?.inject?.repeatCooldownMs,
        verifyOnMutation: cfg?.hygiene?.autoOnFileChange,
        triggers: cfg?.inject?.triggers,
        tracker: injectionTracker,
        events: deps.events,
        getSessionId: deps.getSessionId,
      }),
    );
  }
  if (cfg?.capture?.toolOutcomes || cfg?.capture?.errorPatterns) {
    deps.pipelines.toolCall.use(
      createSageOutcomeCaptureMiddleware({
        memory: memoryStore,
        toolOutcomes: cfg.capture?.toolOutcomes === true,
        errorPatterns: cfg.capture?.errorPatterns === true,
      }),
    );
  }
  // Always-on (cheap): remap anchors after successful mv / git mv so file notes
  // track renames without waiting for existence-only hygiene to mark them stale.
  deps.pipelines.toolCall.use(
    createSagePathRemapMiddleware({
      memory: memoryStore,
    }),
  );
  // Turn-level injection is deliberately opt-in. The default retrieval path
  // is tool-result injection, after a concrete path/query supplies context.
  if (cfg?.inject?.turnContext === true) {
    deps.pipelines.request.use(
      createSageTurnMiddleware({
        memory: retrieval,
        maxMemories: cfg?.inject?.maxTurnMemories,
        maxChars: cfg?.inject?.maxCharsPerTurn,
        minScore: cfg?.inject?.minScore,
        metadataWeight: cfg?.retrieval?.metadataWeight,
        tracker: injectionTracker,
        getSessionId: deps.getSessionId,
      }),
    );
  }
  // Domain-term auto-extract is always-on when a SAGE port is present.
  if (deps.memoryStore) {
    deps.pipelines.request.use(
      createSageDomainTermExtractorMiddleware({
        memory: deps.memoryStore,
        projectRoot: deps.projectRoot,
      }),
    );
  }
  deps.pipelines.request.use(
    createSageContextMonitorMiddleware({
      tracker: injectionTracker,
      events: deps.events,
      getSessionId: deps.getSessionId,
    }),
  );
  // Session-end commit extraction is process-scoped. The function returned
  // by setupSage is invoked by a surface's onDestroy *before* the shared
  // execution cleanup emits `session.ended`, so disposing this listener from
  // that function would silently disable the final scan.
  if (deps.projectRoot) {
    subscribeSessionEndCommitExtractor(deps.events, {
      memory: memoryStore,
      projectRoot: deps.projectRoot,
    });
  }

  // Optional daily dry-run: hygiene + triage (bounded) + file review proposals.
  // Proposals are always reviewable (never auto-delete). Clears timers on teardown.
  let dailyInterval: ReturnType<typeof setInterval> | undefined;
  let dailyFirst: ReturnType<typeof setTimeout> | undefined;
  if (cfg?.triage?.dailyDryRun === true) {
    const DAY_MS = 24 * 60 * 60_000;
    const runDaily = async () => {
      try {
        await memoryStore.hygiene?.(sageHygieneOptionsFromConfig(cfg?.hygiene));
        const surface = getSageSurface(memoryStore);
        if (!surface) {
          deps.logger.debug('sage daily dry-run: no surface capability');
          return;
        }

        // Bounded triage: prefer LLM when host provided one; otherwise neutral stub.
        let filed = 0;
        let skippedDup = 0;
        try {
          const page = await surface.listSagePage({
            statuses: ['active', 'stale'],
            limit: 200,
          });
          const memories = page.memories ?? [];
          if (memories.length > 0) {
            const llm = deps.getLlmCall?.() ?? (async () => '3');
            const report = await runTriage(memories, llm, {
              dryRun: true,
              maxPhase3Calls: 40,
              maxPhase4Pairs: 15,
              verbose: false,
            });
            // File proposals even on dry-run so Review tab fills without --apply.
            // Auto-apply status mutations are NOT executed (dryRun: true).
            if (report.dispatch.proposals.length > 0) {
              const result = await fileTriageProposals(surface, report.dispatch.proposals);
              filed = result.filed;
              skippedDup = result.skippedAsDuplicate;
            }
          }
        } catch (triageErr) {
          deps.logger.debug(
            `sage daily triage skipped: ${triageErr instanceof Error ? triageErr.message : String(triageErr)}`,
          );
        }

        const pending =
          typeof surface.listCandidates === 'function' ? await surface.listCandidates(false) : [];
        const pendingCount = Array.isArray(pending)
          ? pending.filter((c) => c.status === 'pending').length
          : 0;
        deps.logger.debug(
          `sage daily dry-run: hygiene complete; filed=${filed} skippedDup=${skippedDup}; pending review candidates=${pendingCount}`,
        );
      } catch (err) {
        deps.logger.debug(
          `sage daily dry-run failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
    // First run after 1 hour (avoid boot stampede), then every 24h.
    dailyFirst = setTimeout(() => {
      void runDaily();
      dailyInterval = setInterval(() => void runDaily(), DAY_MS);
    }, 60 * 60_000);
  }

  return async () => {
    if (dailyFirst !== undefined) clearTimeout(dailyFirst);
    if (dailyInterval !== undefined) clearInterval(dailyInterval);
    await retrieval.flushPendingCounters?.();
    if (cfg?.hygiene?.autoAfterSession === false) return;
    const now = Date.now();
    if (now - lastAutoHygieneAt < AUTO_HYGIENE_INTERVAL_MS) {
      deps.logger.debug(
        `sage auto-hygiene skipped: last run ${Math.round((now - lastAutoHygieneAt) / 1000)}s ago (throttle: ${AUTO_HYGIENE_INTERVAL_MS / 1000}s)`,
      );
      return;
    }
    await memoryStore.hygiene?.(sageHygieneOptionsFromConfig(cfg?.hygiene));
    lastAutoHygieneAt = now;
  };
}

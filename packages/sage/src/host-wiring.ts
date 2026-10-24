/**
 * Shared host wiring for SAGE injection middleware + session-end hygiene.
 *
 * Both the CLI (`packages/cli/src/wiring/sage.ts`) and the WebUI server
 * (`packages/webui-server/src/server/backend-services.ts`) install the same
 * middleware stack and run the same throttled hygiene options. Keeping the
 * setup in one module prevents config-forward drift (relationFloor,
 * metadataWeight, full hygiene option set, 1h auto-hygiene throttle).
 */

import type { EventBus } from '@wrongstack/contracts/kernel';
import type { Config, Logger, MemoryPort } from '@wrongstack/contracts/types';
import type { AgentPipelines } from '@wrongstack/core/agent';
import { resolveTypeSafeJudge } from '@wrongstack/core/typesafe';
import { getSageRetrieval, getSageSurface } from './memory-port.js';
import { createSageContextMonitorMiddleware } from './middleware/context-monitor.js';
import { createSageDomainTermExtractorMiddleware } from './middleware/domain-term-extractor-middleware.js';
import { createSageEvidenceRefreshMiddleware } from './middleware/evidence-refresh.js';
import { InjectionTracker } from './middleware/injection-tracker.js';
import { createSageOutcomeCaptureMiddleware } from './middleware/outcome-capture.js';
import { createSagePathRemapMiddleware } from './middleware/path-remap.js';
import { subscribeSessionEndCommitExtractor } from './middleware/session-end-commit-extractor.js';
import { createSageToolCallMiddleware } from './middleware/tool-call-memory.js';
import { createSageTurnMiddleware } from './middleware/turn-memory.js';
import { createSystemOneRecallFilter } from './retrieval/system-one-recall.js';
import { fileTriageProposals } from './shared/file-proposals.js';
import type { LlmCallFn } from './triage/llm-evaluator.js';
import { runTriage } from './triage/orchestrator.js';
import { createSystemOneTriage } from './triage/system-one.js';
import type { InjectorEvidence } from './triage/value-score.js';
import type { Sage, SageHygieneOptions } from './types.js';

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
  const surface = getSageSurface(memoryStore);
  const getMemory = surface ? (id: string) => surface.getSage(id) : undefined;

  if (cfg?.inject?.toolResults !== false) {
    deps.pipelines.toolCall.use(
      createSageToolCallMiddleware({
        memory: retrieval,
        getMemory,
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
    if (getMemory) {
      deps.pipelines.request.use(
        createSageEvidenceRefreshMiddleware({
          getMemory,
          projectRoot: deps.projectRoot,
          getSessionId: deps.getSessionId,
          tracker: injectionTracker,
        }),
      );
    }
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
        events: deps.events,
        projectRoot: deps.projectRoot,
        memory: retrieval,
        maxMemories: cfg?.inject?.maxTurnMemories,
        maxChars: cfg?.inject?.maxCharsPerTurn,
        minScore: cfg?.inject?.minScore,
        metadataWeight: cfg?.retrieval?.metadataWeight,
        tracker: injectionTracker,
        // The context monitor below owns usefulness crediting; two owners
        // would scan the same assistant message twice.
        creditUses: false,
        getSessionId: deps.getSessionId,
        // Read per turn: used only while a TypeSafe account is configured,
        // `typesafe.judgments.memoryRecall` is not false and the host is up.
        recallFilter: createSystemOneRecallFilter({
          getJudge: () =>
            resolveTypeSafeJudge({
              config: deps.config,
              feature: 'memoryRecall',
              logger: deps.logger,
            }),
        }),
      }),
    );
  }
  // The store owner runs hygiene on its own cadence. Teardown hygiene alone
  // was a fire-and-forget call from an exiting process and rarely arrived:
  // expired session memories stayed active for weeks. Registering at boot
  // hands the schedule to the daemon, which outlives this host. An older
  // daemon without the op just leaves teardown as the only path.
  if (cfg?.hygiene?.autoAfterSession !== false && surface?.maintenance) {
    void surface
      .maintenance('schedule', sageHygieneOptionsFromConfig(cfg?.hygiene))
      .catch((error: unknown) =>
        deps.logger.debug(
          `sage maintenance schedule skipped: ${error instanceof Error ? error.message : String(error)}`,
        ),
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
      // Always-on usefulness feedback: `recordUse` is the corpus's only
      // quality signal and must not depend on opt-in turn-context injection.
      memory: retrieval,
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
  let offInjectorRuns: (() => void) | undefined;
  if (cfg?.triage?.dailyDryRun === true) {
    // Injector gate evidence for the daily triage pass: the injector emits
    // `memory.injector_run` (same process, same bus) with per-memory rejection
    // detail, and Phase 2 folds it into the value score — the BELOW_SCORE
    // usage clamp plus the rejection-pressure line in the Phase-3 prompt.
    // Bounded and process-lifetime scoped: counts reset on restart, which the
    // scorer treats as "no evidence".
    type AccumulatedInjectorEvidence = {
      rejectedByGate: Partial<Record<keyof InjectorEvidence['rejectedByGate'], number>>;
      lastActivated: boolean;
      lastInjected: boolean;
    };
    const injectorEvidence = new Map<string, AccumulatedInjectorEvidence>();
    const MAX_INJECTOR_EVIDENCE_ENTRIES = 2_000;
    const touchInjectorEvidence = (id: string): AccumulatedInjectorEvidence => {
      const existing = injectorEvidence.get(id);
      if (existing) return existing;
      const entry: AccumulatedInjectorEvidence = {
        rejectedByGate: {},
        lastActivated: false,
        lastInjected: false,
      };
      injectorEvidence.set(id, entry);
      if (injectorEvidence.size > MAX_INJECTOR_EVIDENCE_ENTRIES) {
        const oldest = injectorEvidence.keys().next().value;
        if (oldest !== undefined) injectorEvidence.delete(oldest);
      }
      return entry;
    };
    const handleInjectorRun = (payload: unknown): void => {
      if (!payload || typeof payload !== 'object') return;
      const run = payload as {
        rejectedDetail?: Array<{ id?: unknown; gate?: unknown }> | undefined;
        activated?: Array<{ id?: unknown }> | undefined;
        injected?: Array<{ id?: unknown }> | undefined;
      };
      for (const detail of run.rejectedDetail ?? []) {
        if (typeof detail?.id !== 'string') continue;
        if (
          detail.gate !== 'duplicate' &&
          detail.gate !== 'belowScore' &&
          detail.gate !== 'alreadyVisible' &&
          detail.gate !== 'cooldown' &&
          detail.gate !== 'budget'
        ) {
          continue;
        }
        const entry = touchInjectorEvidence(detail.id);
        entry.rejectedByGate[detail.gate] = (entry.rejectedByGate[detail.gate] ?? 0) + 1;
      }
      for (const memory of run.activated ?? []) {
        if (typeof memory?.id === 'string') touchInjectorEvidence(memory.id).lastActivated = true;
      }
      for (const memory of run.injected ?? []) {
        if (typeof memory?.id === 'string') touchInjectorEvidence(memory.id).lastInjected = true;
      }
    };
    // Feature-detected like mailbox-attach: a minimal events object without
    // onPattern simply yields no evidence (the scorer's documented fallback).
    offInjectorRuns =
      typeof (deps.events as { onPattern?: unknown }).onPattern === 'function'
        ? (
            deps.events as unknown as {
              onPattern: (
                pattern: string,
                handler: (event: string, payload: unknown) => void,
              ) => () => void;
            }
          ).onPattern('memory.injector_run', (_event, payload) => handleInjectorRun(payload))
        : undefined;
    const readInjectorEvidence = (memoryId: string): InjectorEvidence | undefined => {
      const entry = injectorEvidence.get(memoryId);
      if (!entry) return undefined;
      const counts = Object.values(entry.rejectedByGate);
      const dominant = counts.length > 0 ? Math.max(...counts) : 0;
      return {
        rejectedByGate: entry.rejectedByGate,
        lastActivated: entry.lastActivated,
        lastInjected: entry.lastInjected,
        ...(dominant > 0 ? { rejectionCount: dominant } : {}),
      };
    };
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
          // Cursor-walk the whole active+stale corpus — the same enumeration
          // the manual /memory triage command uses (loadActiveMemories). A
          // single 200-row page would keep re-selecting the same
          // most-recently-updated slice every day: updated_at DESC is stable
          // and a dry run never bumps it, so the older tail would never be
          // triaged by the only automatic triage pass. LLM cost stays bounded
          // by the phase caps below.
          const memories: Sage[] = [];
          let cursor: string | undefined;
          do {
            const page = await surface.listSagePage({
              statuses: ['active', 'stale'],
              limit: 200,
              // Admin surface: triage reviews the whole project corpus, so
              // owned session-scoped memories must not vanish from the
              // listing (buildSessionClause's default hides them). The
              // manual /memory triage command passes the same flag
              // (loadActiveMemories).
              includeAllSessions: true,
              ...(cursor !== undefined ? { cursor } : {}),
            });
            memories.push(...(page.memories ?? []));
            cursor = page.nextCursor ?? undefined;
          } while (cursor !== undefined);
          if (memories.length > 0) {
            const llm = deps.getLlmCall?.() ?? (async () => '3');
            const judge = resolveTypeSafeJudge({
              config: deps.config,
              feature: 'memoryTriage',
              logger: deps.logger,
            });
            const report = await runTriage(memories, llm, {
              dryRun: true,
              maxPhase3Calls: 40,
              maxPhase4Pairs: 15,
              verbose: false,
              systemOne: judge ? createSystemOneTriage({ judge }) : undefined,
              injectorEvidenceProvider: readInjectorEvidence,
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
    offInjectorRuns?.();
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

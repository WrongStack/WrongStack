/**
 * Brain tier assembly — turns `Config.brain` into the concrete LLM tiers
 * (single-LLM pool + optional multi-LLM council) that
 * `createTieredBrainArbiter` composes. Shared by every host that wires a
 * Brain (CLI/TUI in `wiring/brain-and-orchestration.ts`, the standalone
 * WebUI server in `backend-services.ts`) so the config surface behaves
 * identically everywhere.
 *
 * Hosts differ only in HOW a provider id becomes a `Provider` instance, so
 * that is the one injected dependency (`resolveProvider`). Unresolvable
 * pool/council entries are skipped — one bad ref never takes the Brain down.
 *
 * @module brain-chain
 */

import type { BrainArbiter, BrainDecisionRequest } from '../coordination/brain.js';
import { parseModelRef } from '../core/fallback-model.js';
import type { EventBus } from '../kernel/events.js';
import type { BrainConfig, BrainModelEntry } from '../types/config.js';
import type { Provider } from '../types/provider.js';
import { type BrainLlmTarget, createAutonomyBrain } from './autonomy-brain.js';
import type { BrainCircuitBreaker } from './brain-circuit.js';
import { type CouncilVoter, createCouncilBrainArbiter } from './council-brain.js';

/** Default council seats, assigned in order to voters without a persona. */
const DEFAULT_SEATS: ReadonlyArray<Pick<CouncilVoter, 'persona' | 'veto'>> = [
  { persona: 'executor' },
  { persona: 'skeptic', veto: true },
  { persona: 'auditor' },
];

/** Seat rotation for voters without an explicit persona (config may replace it). */
function resolveSeats(
  configured: BrainConfig['council'] extends infer C
    ? C extends { seats?: infer S }
      ? S
      : never
    : never,
): ReadonlyArray<Pick<CouncilVoter, 'persona' | 'veto'>> {
  const seats = configured as Array<{ persona: string; veto?: boolean }> | undefined;
  if (!seats?.length) return DEFAULT_SEATS;
  return seats.map((seat) => ({ persona: seat.persona, veto: seat.veto }));
}

export interface BrainTierAssemblyOptions {
  /** `config.brain` — undefined assembles the legacy session-model single tier. */
  brainConfig: BrainConfig | undefined;
  /** The session's provider id (`config.provider`). */
  defaultProviderId: string;
  /** Live session provider — read per decision so `/setmodel` switches apply. */
  sessionProvider: () => Provider;
  /** Live session model id — read per decision. */
  sessionModel: () => string;
  /**
   * Resolve a NON-default provider id to a Provider instance. May throw or
   * return null; the entry is then skipped.
   */
  resolveProvider: (providerId: string, model: string) => Provider | null;
  /**
   * Decision-history digest (typically `BrainDecisionLedger.digestFor`) —
   * injected into both the single-LLM and council prompts so the Brain
   * learns from the outcomes of its past similar decisions.
   */
  getDecisionDigest?: ((request: BrainDecisionRequest) => string | undefined) | undefined;
  /** Bus for `brain.llm_call` / `brain.council_*` trace events. */
  events?: EventBus | undefined;
  /** Include free text in trace events. Mirrors `brain.trace.content === 'full'`. */
  traceContent?: boolean | undefined;
  /** Failure memory shared by every decision the single-LLM tier makes. */
  circuit?: BrainCircuitBreaker | undefined;
}

export interface BrainTierAssembly {
  /** Single-LLM tier for `TieredBrainArbiterOptions.autonomous`. */
  autonomous: BrainArbiter;
  /** Council tier for `TieredBrainArbiterOptions.council` (undefined = disabled). */
  council: BrainArbiter | undefined;
  /** Live council risk floor for `TieredBrainArbiterOptions.getCouncilMinRisk`. */
  getCouncilMinRisk: () => 'medium' | 'high' | 'critical';
  /** Human-readable pool labels for status surfaces; empty = session model. */
  poolLabels: string[];
  /** Human-readable council seat labels; empty = council disabled. */
  councilLabels: string[];
  /**
   * EFFECTIVE judge label — undefined when no council is wired.
   *
   * Distinct from the CONFIGURED judge (`council.judge`), which is usually
   * absent: the judge is then derived, and whether the derived one is
   * independent of the seated voters is not something any surface could
   * previously observe.
   */
  judgeLabel: string | undefined;
  /**
   * True when the effective judge is ALSO one of the seated voters — i.e. the
   * tie-breaker already cast one of the tied votes.
   *
   * Computed here, from the real voter list, rather than left to each surface
   * to infer by string-matching `judgeLabel` against `councilLabels`: those
   * are display strings (`"<label> (<persona>, veto)"`), and three independent
   * re-parses of a rendering format is exactly how surfaces drift apart.
   */
  judgeIsVoter: boolean;
}

/** Assemble the LLM tiers of the Brain chain from `Config.brain`. */
export function assembleBrainTiers(opts: BrainTierAssemblyOptions): BrainTierAssembly {
  const brainCfg = opts.brainConfig;

  const toEntry = (entry: string | BrainModelEntry): BrainModelEntry =>
    typeof entry === 'string' ? (parseModelRef(entry) as BrainModelEntry) : entry;
  const buildTarget = (entry: BrainModelEntry): BrainLlmTarget | null => {
    if (!entry.model) return null;
    const providerId = entry.provider ?? opts.defaultProviderId;
    try {
      const provider =
        providerId === opts.defaultProviderId
          ? opts.sessionProvider()
          : opts.resolveProvider(providerId, entry.model);
      if (!provider) return null;
      return { provider, model: entry.model, label: `${providerId}/${entry.model}` };
    } catch {
      return null;
    }
  };

  const poolTargets = (brainCfg?.models ?? [])
    .map(toEntry)
    .map(buildTarget)
    .filter((t): t is BrainLlmTarget => t !== null);

  // Single-LLM tier. With a configured pool the arbiter is constructed once
  // (round-robin cursor + fallback order persist across decisions); without
  // one it is built per decision so live provider/model switches apply.
  const autonomous: BrainArbiter =
    poolTargets.length > 0
      ? createAutonomyBrain({
          targets: poolTargets,
          strategy: brainCfg?.strategy ?? 'fallback',
          maxAutoRisk: 'all', // the tiered ceiling gates risk — keep inner permissive
          decisionTimeoutMs: brainCfg?.decisionTimeoutMs,
          heuristics: brainCfg?.heuristics,
          getDecisionDigest: opts.getDecisionDigest,
          events: opts.events,
          traceContent: opts.traceContent,
          maxTokens: brainCfg?.llm?.maxTokens,
          rejectUncertain: brainCfg?.llm?.rejectUncertain,
          minConfidence: brainCfg?.llm?.minConfidence,
          circuit: opts.circuit,
        })
      : {
          decide: (request) =>
            createAutonomyBrain({
              provider: opts.sessionProvider(),
              model: opts.sessionModel(),
              maxAutoRisk: 'all',
              decisionTimeoutMs: brainCfg?.decisionTimeoutMs,
              heuristics: brainCfg?.heuristics,
              getDecisionDigest: opts.getDecisionDigest,
              events: opts.events,
              traceContent: opts.traceContent,
              maxTokens: brainCfg?.llm?.maxTokens,
              rejectUncertain: brainCfg?.llm?.rejectUncertain,
              minConfidence: brainCfg?.llm?.minConfidence,
              circuit: opts.circuit,
            }).decide(request),
        };

  // Council tier — seats come from explicit `brain.council.voters` or are
  // derived from the pool (first 3 models, default personas).
  const councilCfg = brainCfg?.council;
  const SEATS = resolveSeats(councilCfg?.seats);
  const explicitVoters = (councilCfg?.voters ?? []).map((v) =>
    typeof v === 'string'
      ? { entry: toEntry(v), cfg: {} as Partial<CouncilVoter> }
      : { entry: v, cfg: v },
  );
  const voters: CouncilVoter[] = (
    explicitVoters.length > 0
      ? explicitVoters.map(({ entry, cfg }, i) => {
          const target = buildTarget(entry);
          if (!target) return null;
          const seat = SEATS[i % SEATS.length];
          return {
            ...target,
            persona: cfg.persona ?? seat?.persona,
            weight: cfg.weight,
            veto: cfg.veto ?? seat?.veto,
          } satisfies CouncilVoter;
        })
      : poolTargets.slice(0, SEATS.length).map((target, i) => ({
          ...target,
          ...SEATS[i % SEATS.length],
        }))
  ).filter((v): v is CouncilVoter => v !== null);

  const judgeEntry = councilCfg?.judge
    ? typeof councilCfg.judge === 'string'
      ? toEntry(councilCfg.judge)
      : councilCfg.judge
    : undefined;
  // An explicitly configured judge always wins. Otherwise prefer a pool target
  // that is NOT already seated: the judge only runs to break a tie or
  // synthesize a split panel, and a "tie-breaker" that already cast one of the
  // tied votes is not an independent opinion — it re-states its own position
  // with the deciding weight. `poolTargets[0]` was the previous default and is
  // exactly the model that becomes voter #1 whenever seats are derived from
  // the pool, so the old default made the judge a seated voter in every
  // auto-derived council. With no unseated target left (pool size == seat
  // count) it still falls back to the old behaviour, and the distinctness
  // warning now reports the correlation instead of hiding it.
  const seatedLabels = new Set(voters.map((v) => v.label ?? v.model));
  const judge =
    (judgeEntry ? buildTarget(judgeEntry) : null) ??
    poolTargets.find((t) => !seatedLabels.has(t.label ?? t.model)) ??
    poolTargets[0] ??
    voters[0];
  const councilEnabled = councilCfg?.enabled ?? voters.length >= 2;
  const council =
    councilEnabled && voters.length >= 2
      ? createCouncilBrainArbiter({
          voters,
          judge,
          quorumFraction: councilCfg?.quorum,
          approvalFraction: councilCfg?.approval,
          decisionTimeoutMs: councilCfg?.perCallTimeoutMs ?? brainCfg?.decisionTimeoutMs,
          maxConcurrency: councilCfg?.maxConcurrency,
          distinctness: councilCfg?.distinctness,
          voterMaxTokens: councilCfg?.voterMaxTokens,
          deliberationRounds: councilCfg?.deliberationRounds,
          judgeMaxTokens: councilCfg?.judgeMaxTokens,
          getDecisionDigest: opts.getDecisionDigest,
          events: opts.events,
          traceContent: opts.traceContent,
        })
      : undefined;

  return {
    autonomous,
    council,
    getCouncilMinRisk: () => councilCfg?.minRisk ?? 'high',
    poolLabels: poolTargets.map((t) => t.label ?? t.model),
    councilLabels: council
      ? voters.map(
          (v) => `${v.label ?? v.model} (${v.persona ?? 'voter'}${v.veto ? ', veto' : ''})`,
        )
      : [],
    judgeLabel: council ? (judge?.label ?? judge?.model) : undefined,
    judgeIsVoter:
      council !== undefined && judge !== undefined && seatedLabels.has(judge.label ?? judge.model),
  };
}

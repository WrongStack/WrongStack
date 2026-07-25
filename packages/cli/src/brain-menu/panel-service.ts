/**
 * TUI Brain panel host — the CLI side of the BrainPanelHost bridge.
 *
 * Mirrors the auth-panel pattern: the TUI never touches config files or the
 * BrainRuntime directly; every mutation funnels through this service, which
 * calls `runtime.apply()` (live rebuild + persist to the GLOBAL config) and
 * returns an error string (panel hint) or null on success.
 */

import type { BrainConfigPatch, BrainRuntime } from '@wrongstack/core/execution';
import type { BrainCouncilVoterConfig, BrainModelEntry } from '@wrongstack/core/types';
import type { BrainPanelHost, BrainPanelSettings } from '@wrongstack/tui';

export interface BrainPanelServiceDeps {
  brainRuntime: BrainRuntime;
}

const PERSONA_CYCLE = ['executor', 'skeptic', 'auditor'] as const;

function compactEntry(entry: BrainModelEntry): string {
  return entry.provider ? `${entry.provider}/${entry.model}` : entry.model;
}

export function createBrainPanelHost(deps: BrainPanelServiceDeps): BrainPanelHost {
  const { brainRuntime } = deps;

  const apply = async (patch: BrainConfigPatch): Promise<string | null> => {
    try {
      const { persisted } = brainRuntime.apply(patch);
      const result = await persisted;
      return result.ok ? null : `Applied live but NOT saved: ${result.error ?? 'unknown error'}`;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  const currentPool = (): string[] => brainRuntime.getSnapshot().models.map(compactEntry);
  const currentVoters = (): BrainCouncilVoterConfig[] =>
    brainRuntime.getSnapshot().council.voters.map((v) => ({ ...v }));
  const applyVoters = (voters: BrainCouncilVoterConfig[]): Promise<string | null> =>
    apply({ council: { voters: voters.length > 0 ? voters : null } });

  return {
    getSettings(): BrainPanelSettings {
      const snap = brainRuntime.getSnapshot();
      return {
        mode: snap.mode,
        riskLevel: snap.maxAutoRisk,
        strategy: snap.strategy,
        decisionTimeoutMs: snap.decisionTimeoutMs,
        humanTimeoutMs: snap.humanTimeoutMs,
        pool: snap.models.map(compactEntry),
        poolResolved: snap.poolLabels,
        usingSessionModel: snap.usingSessionModel,
        councilEnabled: snap.council.enabled,
        councilMinRisk: snap.council.minRisk,
        voters: snap.council.voters.map((v) => ({
          label: compactEntry(v),
          persona: v.persona,
          veto: v.veto,
          weight: v.weight,
        })),
        councilSeats: snap.councilLabels,
        // The EFFECTIVE judge, not `council.judge`. The configured one is
        // usually absent, so the panel used to read "auto" and say nothing
        // about who actually breaks the panel's ties — including when that is
        // one of the seats that produced the tie.
        judgeLabel: snap.judgeLabel,
        judgeConfigured: snap.council.judge !== undefined,
        judgeIsVoter: snap.judgeIsVoter,
        ledgerEnabled: snap.ledger.enabled,
        autoDenyAfterFailures: snap.ledger.autoDenyAfterFailures,
        terminalPolicy: snap.terminalPolicy,
        heuristics: {
          lowRiskAutoAnswer: snap.heuristics.lowRiskAutoAnswer,
          blockedResolved: snap.heuristics.blockedResolved,
          deadlockSkip: snap.heuristics.deadlockSkip,
          retryExhausted: snap.heuristics.retryExhausted,
          continuePing: snap.heuristics.continuePing,
          blockedResolvedMarkers: snap.heuristics.blockedResolvedMarkers,
        },
        llmMaxTokens: snap.llm.maxTokens,
        llmRejectUncertain: snap.llm.rejectUncertain,
        llmMinConfidence: snap.llm.minConfidence,
        llmDenyIsTerminal: snap.llm.denyIsTerminal,
        cacheEnabled: snap.cache.enabled,
        cacheTtlMs: snap.cache.ttlMs,
        cacheMaxEntries: snap.cache.maxEntries,
        cacheHits: snap.cache.hits,
        cacheMisses: snap.cache.misses,
        cacheSize: snap.cache.size,
        traceEnabled: snap.trace.enabled,
        traceContent: snap.trace.content,
        tracePath: snap.trace.path,
        circuitState: snap.circuit?.state,
        circuitFailures: snap.circuit?.consecutiveFailures,
        ruleCount: snap.rules.length,
        ruleErrors: [...snap.ruleErrors],
      };
    },
    setMode: (mode) => apply({ mode }),
    setRisk: (level) => apply({ maxAutoRisk: level }),
    setStrategy: (strategy) => apply({ strategy }),
    setDecisionTimeout: (ms) => apply({ decisionTimeoutMs: ms ?? null }),
    setHumanTimeout: (ms) => apply({ humanTimeoutMs: ms ?? null }),
    addPoolModel: (providerId, model) =>
      apply({ models: [...currentPool(), `${providerId}/${model}`] }),
    removePoolModel: (index) => {
      const next = currentPool().filter((_, i) => i !== index);
      return apply({ models: next.length > 0 ? next : null });
    },
    clearPool: () => apply({ models: null }),
    setCouncilEnabled: (on) => apply({ council: { enabled: on } }),
    setCouncilMinRisk: (risk) => apply({ council: { minRisk: risk } }),
    addVoter: (providerId, model) => {
      const voters = currentVoters();
      const persona = PERSONA_CYCLE[voters.length % PERSONA_CYCLE.length] as string;
      return applyVoters([...voters, { provider: providerId, model, persona }]);
    },
    removeVoter: (index) => applyVoters(currentVoters().filter((_, i) => i !== index)),
    cycleVoterPersona: (index) => {
      const voters = currentVoters();
      const voter = voters[index];
      if (!voter) return Promise.resolve('No such voter.');
      const at = PERSONA_CYCLE.indexOf(voter.persona as (typeof PERSONA_CYCLE)[number]);
      voter.persona = PERSONA_CYCLE[(at + 1) % PERSONA_CYCLE.length] as string;
      return applyVoters(voters);
    },
    toggleVoterVeto: (index) => {
      const voters = currentVoters();
      const voter = voters[index];
      if (!voter) return Promise.resolve('No such voter.');
      voter.veto = !voter.veto;
      return applyVoters(voters);
    },
    setJudge: (providerId, model) => apply({ council: { judge: `${providerId}/${model}` } }),
    clearJudge: () => apply({ council: { judge: null } }),
    setLedgerEnabled: (on) => apply({ ledger: { enabled: on } }),
    setAutoDeny: (count) => apply({ ledger: { autoDenyAfterFailures: count ?? null } }),
    setTerminalPolicy: (policy) => apply({ terminalPolicy: policy }),
    // Every sub-block below is MERGED field-by-field by `mergePatch`, so a
    // single-key patch leaves the operator's other knobs alone.
    setHeuristic: (key, on) => apply({ heuristics: { [key]: on } }),
    setLlmMaxTokens: (tokens) => apply({ llm: { maxTokens: tokens } }),
    setLlmRejectUncertain: (on) => apply({ llm: { rejectUncertain: on } }),
    setLlmMinConfidence: (value) => apply({ llm: { minConfidence: value } }),
    setLlmDenyIsTerminal: (mode) => apply({ llm: { denyIsTerminal: mode } }),
    setCacheEnabled: (on) => apply({ cache: { enabled: on } }),
    setCacheTtl: (ms) => apply({ cache: { ttlMs: ms } }),
    setCacheMaxEntries: (count) => apply({ cache: { maxEntries: count } }),
    setTraceEnabled: (on) => apply({ trace: { enabled: on } }),
    setTraceContent: (content) => apply({ trace: { content } }),
  };
}

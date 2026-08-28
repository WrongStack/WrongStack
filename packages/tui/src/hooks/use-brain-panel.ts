/**
 * Brain panel controller — opens the panel and translates settings-view
 * key actions into BrainPanelHost mutations (live apply + persist on the
 * CLI side), refreshing the snapshot and surfacing errors as panel hints.
 * Extracted from app.tsx (hotspot guardrail).
 */

import React from 'react';
import type { Action } from '../app-action-type.js';
import type { BrainRiskLevel } from '../brain-contracts.js';
import {
  AUTO_DENY_PRESETS,
  type BrainDenyIsTerminal,
  type BrainPanelHost,
  type BrainPanelRow,
  type BrainTerminalPolicyValue,
  type BrainTraceContent,
  CACHE_MAX_ENTRIES_PRESETS,
  CACHE_TTL_PRESETS,
  COUNCIL_CONCURRENCY_PRESETS,
  COUNCIL_DISTINCTNESS_PRESETS,
  COUNCIL_FRACTION_PRESETS,
  COUNCIL_JUDGE_MAX_TOKENS_PRESETS,
  COUNCIL_TIMEOUT_PRESETS,
  COUNCIL_VOTER_MAX_TOKENS_PRESETS,
  cyclePreset,
  DECISION_TIMEOUT_PRESETS,
  HUMAN_TIMEOUT_PRESETS,
  LLM_MAX_TOKENS_PRESETS,
  LLM_MIN_CONFIDENCE_PRESETS,
} from '../brain-panel-model.js';

/** Step through a fixed enum ladder, wrapping in both directions. */
function cycleEnum<T extends string>(values: readonly T[], current: T, delta: number): T {
  const at = values.indexOf(current);
  return values[
    ((((at >= 0 ? at : 0) + delta) % values.length) + values.length) % values.length
  ] as T;
}

const TERMINAL_POLICIES: readonly BrainTerminalPolicyValue[] = [
  'conservative',
  'deny-all',
  'continue-on-recommended',
];
const DENY_TERMINAL_MODES: readonly BrainDenyIsTerminal[] = ['never', 'when-decided', 'always'];
const TRACE_CONTENT_MODES: readonly BrainTraceContent[] = ['none', 'redacted', 'full'];

/** Selection returned by the shared model-pick overlay (null = cancelled). */
export type ModelPickSelection = { providerId: string; model: string } | null;

interface UseBrainPanelOptions {
  dispatch: React.Dispatch<Action>;
  getBrainData?:
    | (() => {
        riskLevel: BrainRiskLevel;
        log: Array<{ kind: string; question: string; outcome: string; age: string }>;
      })
    | undefined;
  brainPanelHost?: BrainPanelHost | undefined;
  /**
   * The SHARED two-step model picker (same overlay as /model), invoked in
   * 'pick' mode: resolves with the selection instead of switching the
   * session model. Provided by App's requestModelPick.
   */
  requestModelPick?: ((title: string) => Promise<ModelPickSelection>) | undefined;
}

export interface BrainPanelController {
  openBrainPanel: () => void;
  handleBrainAdjust: (row: BrainPanelRow, delta: number) => void;
  handleBrainEnter: (row: BrainPanelRow) => void;
  handleBrainDelete: (row: BrainPanelRow) => void;
  handleBrainVoterMod: (index: number, mod: 'persona' | 'veto') => void;
}

export function useBrainPanel(opts: UseBrainPanelOptions): BrainPanelController {
  const { dispatch, getBrainData, brainPanelHost, requestModelPick } = opts;

  const openBrainPanel = React.useCallback(() => {
    if (!getBrainData) return;
    const data = getBrainData();
    dispatch({
      type: 'brainOpen',
      riskLevel: data.riskLevel,
      log: data.log,
      settings: brainPanelHost?.getSettings(),
    });
  }, [dispatch, getBrainData, brainPanelHost]);

  // Run one BrainPanelHost mutation: busy → apply+persist → refresh + hint.
  // `onSuccess` chains a follow-up UI step (e.g. reopening the voter picker).
  const runBrainMutation = React.useCallback(
    (op: () => Promise<string | null>, successHint?: string, onSuccess?: () => void) => {
      if (!brainPanelHost) return;
      dispatch({ type: 'brainBusy', busy: true });
      void op()
        .then((err) => {
          dispatch({ type: 'brainSettingsLoaded', settings: brainPanelHost.getSettings() });
          dispatch({
            type: 'brainHint',
            text: err ?? successHint ?? 'Saved to the active profile config',
          });
          if (!err) onSuccess?.();
        })
        .catch((e: unknown) => {
          dispatch({ type: 'brainBusy', busy: false });
          dispatch({ type: 'brainHint', text: e instanceof Error ? e.message : String(e) });
        });
    },
    [dispatch, brainPanelHost],
  );

  const reportError = React.useCallback(
    (e: unknown) => {
      dispatch({ type: 'brainBusy', busy: false });
      dispatch({ type: 'brainHint', text: e instanceof Error ? e.message : String(e) });
    },
    [dispatch],
  );

  /** Pick one model via the shared overlay, then run the host mutation. */
  const pickThenApply = React.useCallback(
    (title: string, apply: (providerId: string, model: string) => Promise<string | null>) => {
      if (!requestModelPick) return;
      void requestModelPick(title)
        .then((sel) => {
          if (sel) runBrainMutation(() => apply(sel.providerId, sel.model));
        })
        .catch(reportError);
    },
    [requestModelPick, runBrainMutation, reportError],
  );

  /**
   * Multi-add voter flow: the shared picker reopens after every added voter
   * so a ≥2-seat council is assembled in one pass; Esc/cancel ends the loop.
   */
  const addVotersViaPicker = React.useCallback(() => {
    const host = brainPanelHost;
    if (!host || !requestModelPick) return;
    const loop = async (): Promise<void> => {
      const sel = await requestModelPick('Add council voter (Esc = done)');
      if (!sel) return;
      const err = await host.addVoter(sel.providerId, sel.model);
      dispatch({ type: 'brainSettingsLoaded', settings: host.getSettings() });
      dispatch({
        type: 'brainHint',
        text: err ?? `Voter added: ${sel.providerId}/${sel.model} — pick another or Esc`,
      });
      if (!err) await loop();
    };
    void loop().catch(reportError);
  }, [dispatch, brainPanelHost, requestModelPick, reportError]);

  const handleBrainAdjust = React.useCallback(
    (row: BrainPanelRow, delta: number) => {
      const host = brainPanelHost;
      const settings = host?.getSettings();
      if (!host || !settings) return;
      switch (row.kind) {
        case 'mode':
          runBrainMutation(() =>
            host.setMode(settings.mode === 'headless' ? 'interactive' : 'headless'),
          );
          return;
        case 'risk': {
          const levels: BrainRiskLevel[] = ['off', 'low', 'medium', 'high', 'all'];
          const next = levels[
            (levels.indexOf(settings.riskLevel) + delta + levels.length) % levels.length
          ] as BrainRiskLevel;
          runBrainMutation(() => host.setRisk(next), `Risk ceiling → ${next.toUpperCase()}`);
          return;
        }
        case 'strategy':
          runBrainMutation(() =>
            host.setStrategy(settings.strategy === 'fallback' ? 'round-robin' : 'fallback'),
          );
          return;
        case 'timeout':
          runBrainMutation(() =>
            host.setDecisionTimeout(
              cyclePreset(DECISION_TIMEOUT_PRESETS, settings.decisionTimeoutMs, delta),
            ),
          );
          return;
        case 'humanTimeout':
          runBrainMutation(() =>
            host.setHumanTimeout(
              cyclePreset(HUMAN_TIMEOUT_PRESETS, settings.humanTimeoutMs, delta),
            ),
          );
          return;
        case 'councilToggle':
          runBrainMutation(() => host.setCouncilEnabled(!settings.councilEnabled));
          return;
        case 'councilMinRisk': {
          const risks = ['medium', 'high', 'critical'] as const;
          const next = risks[
            (risks.indexOf(settings.councilMinRisk) + delta + risks.length) % risks.length
          ] as (typeof risks)[number];
          runBrainMutation(() => host.setCouncilMinRisk(next));
          return;
        }
        case 'councilQuorum':
          runBrainMutation(() =>
            host.setCouncilQuorum(
              cyclePreset(COUNCIL_FRACTION_PRESETS, settings.councilQuorum ?? 0.5, delta),
            ),
          );
          return;
        case 'councilApproval':
          runBrainMutation(() =>
            host.setCouncilApproval(
              cyclePreset(COUNCIL_FRACTION_PRESETS, settings.councilApproval ?? 0.5, delta),
            ),
          );
          return;
        case 'councilDistinctness': {
          const next = cycleEnum(COUNCIL_DISTINCTNESS_PRESETS, settings.councilDistinctness, delta);
          runBrainMutation(() => host.setCouncilDistinctness(next));
          return;
        }
        case 'councilTimeout':
          runBrainMutation(() =>
            host.setCouncilPerCallTimeout(
              cyclePreset(COUNCIL_TIMEOUT_PRESETS, settings.councilPerCallTimeoutMs, delta),
            ),
          );
          return;
        case 'councilConcurrency':
          runBrainMutation(() =>
            host.setCouncilMaxConcurrency(
              cyclePreset(COUNCIL_CONCURRENCY_PRESETS, settings.councilMaxConcurrency, delta),
            ),
          );
          return;
        case 'councilVoterMaxTokens':
          runBrainMutation(() =>
            host.setCouncilVoterMaxTokens(
              cyclePreset(COUNCIL_VOTER_MAX_TOKENS_PRESETS, settings.councilVoterMaxTokens, delta),
            ),
          );
          return;
        case 'councilJudgeMaxTokens':
          runBrainMutation(() =>
            host.setCouncilJudgeMaxTokens(
              cyclePreset(COUNCIL_JUDGE_MAX_TOKENS_PRESETS, settings.councilJudgeMaxTokens, delta),
            ),
          );
          return;
        case 'ledgerToggle':
          runBrainMutation(() => host.setLedgerEnabled(!settings.ledgerEnabled));
          return;
        case 'autoDeny':
          runBrainMutation(() =>
            host.setAutoDeny(cyclePreset(AUTO_DENY_PRESETS, settings.autoDenyAfterFailures, delta)),
          );
          return;
        case 'voter':
          runBrainMutation(() => host.cycleVoterPersona(row.index));
          return;
        case 'terminalPolicy': {
          const next = cycleEnum(TERMINAL_POLICIES, settings.terminalPolicy, delta);
          runBrainMutation(() => host.setTerminalPolicy(next), `Terminal policy → ${next}`);
          return;
        }
        case 'heuristic': {
          const key = row.key;
          runBrainMutation(() => host.setHeuristic(key, !settings.heuristics[key]));
          return;
        }
        case 'llmMaxTokens':
          runBrainMutation(() =>
            host.setLlmMaxTokens(cyclePreset(LLM_MAX_TOKENS_PRESETS, settings.llmMaxTokens, delta)),
          );
          return;
        case 'llmRejectUncertain':
          runBrainMutation(() => host.setLlmRejectUncertain(!settings.llmRejectUncertain));
          return;
        case 'llmMinConfidence':
          runBrainMutation(() =>
            host.setLlmMinConfidence(
              cyclePreset(LLM_MIN_CONFIDENCE_PRESETS, settings.llmMinConfidence, delta),
            ),
          );
          return;
        case 'llmDenyIsTerminal': {
          const next = cycleEnum(DENY_TERMINAL_MODES, settings.llmDenyIsTerminal, delta);
          runBrainMutation(() => host.setLlmDenyIsTerminal(next));
          return;
        }
        case 'cacheToggle':
          runBrainMutation(() => host.setCacheEnabled(!settings.cacheEnabled));
          return;
        case 'cacheTtl':
          runBrainMutation(() =>
            host.setCacheTtl(cyclePreset(CACHE_TTL_PRESETS, settings.cacheTtlMs, delta)),
          );
          return;
        case 'cacheMaxEntries':
          runBrainMutation(() =>
            host.setCacheMaxEntries(
              cyclePreset(CACHE_MAX_ENTRIES_PRESETS, settings.cacheMaxEntries, delta),
            ),
          );
          return;
        case 'traceToggle':
          runBrainMutation(() => host.setTraceEnabled(!settings.traceEnabled));
          return;
        case 'traceContent': {
          const next = cycleEnum(TRACE_CONTENT_MODES, settings.traceContent, delta);
          runBrainMutation(() => host.setTraceContent(next));
          return;
        }
        // Read-only rows (cacheStats, tracePath, circuit, rulesSummary,
        // ruleErrors) intentionally fall through — nothing to write back.
        default:
          return;
      }
    },
    [brainPanelHost, runBrainMutation],
  );

  const handleBrainEnter = React.useCallback(
    (row: BrainPanelRow) => {
      switch (row.kind) {
        case 'mode':
        case 'strategy':
        case 'ledgerToggle':
        case 'heuristic':
        case 'llmRejectUncertain':
        case 'cacheToggle':
        case 'traceToggle':
        case 'terminalPolicy':
        case 'llmDenyIsTerminal':
        case 'traceContent':
          handleBrainAdjust(row, 1);
          return;
        case 'councilToggle': {
          // Enter = SET UP the council, not a bare toggle-save: enable it if
          // needed, then flow straight into voter selection. Plain on/off
          // stays on ←/→ (handleBrainAdjust).
          const settings = brainPanelHost?.getSettings();
          if (!brainPanelHost || !settings) return;
          if (settings.councilEnabled) {
            addVotersViaPicker();
            return;
          }
          const host = brainPanelHost;
          runBrainMutation(
            () => host.setCouncilEnabled(true),
            'Council enabled — pick voters (Esc when done)',
            addVotersViaPicker,
          );
          return;
        }
        case 'poolAdd': {
          const host = brainPanelHost;
          if (!host) return;
          pickThenApply('Add Brain pool model', (providerId, model) =>
            host.addPoolModel(providerId, model),
          );
          return;
        }
        case 'voterAdd':
          addVotersViaPicker();
          return;
        case 'judge': {
          const host = brainPanelHost;
          if (!host) return;
          pickThenApply('Pick council judge', (providerId, model) =>
            host.setJudge(providerId, model),
          );
          return;
        }
        default:
          return;
      }
    },
    [brainPanelHost, handleBrainAdjust, addVotersViaPicker, pickThenApply, runBrainMutation],
  );

  const handleBrainDelete = React.useCallback(
    (row: BrainPanelRow) => {
      const host = brainPanelHost;
      if (!host) return;
      if (row.kind === 'poolModel') runBrainMutation(() => host.removePoolModel(row.index));
      else if (row.kind === 'voter') runBrainMutation(() => host.removeVoter(row.index));
      else if (row.kind === 'judge') runBrainMutation(() => host.clearJudge(), 'Judge → auto');
    },
    [brainPanelHost, runBrainMutation],
  );

  const handleBrainVoterMod = React.useCallback(
    (index: number, mod: 'persona' | 'veto') => {
      const host = brainPanelHost;
      if (!host) return;
      runBrainMutation(() =>
        mod === 'persona' ? host.cycleVoterPersona(index) : host.toggleVoterVeto(index),
      );
    },
    [brainPanelHost, runBrainMutation],
  );

  return {
    openBrainPanel,
    handleBrainAdjust,
    handleBrainEnter,
    handleBrainDelete,
    handleBrainVoterMod,
  };
}

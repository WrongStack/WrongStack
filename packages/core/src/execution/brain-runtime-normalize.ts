/**
 * Brain config normalization: model-ref / voter parsing, numeric guards, the
 * lenient boot-time pass, and the compact persisted form (`getConfig`).
 */

import type {
  BrainConfig,
  BrainCouncilVoterConfig,
  BrainModelEntry,
} from '@wrongstack/contracts/types/config';
import { parseModelRef } from '../core/fallback-model.js';

export function normalizeEntry(raw: string | BrainModelEntry): BrainModelEntry {
  const parsed =
    typeof raw === 'string'
      ? (parseModelRef(raw) as { provider?: string | undefined; model?: string | undefined })
      : raw;
  const model = parsed.model?.trim();
  if (!model) {
    throw new Error(
      `Invalid model ref: ${typeof raw === 'string' ? `"${raw}"` : JSON.stringify(raw)} (expected "model" or "provider/model")`,
    );
  }
  const provider = parsed.provider?.trim();
  return provider ? { provider, model } : { model };
}

export function normalizeVoter(raw: string | BrainCouncilVoterConfig): BrainCouncilVoterConfig {
  if (typeof raw === 'string') return normalizeEntry(raw);
  const base = normalizeEntry(raw);
  const voter: BrainCouncilVoterConfig = { ...base };
  if (raw.persona !== undefined) voter.persona = raw.persona;
  if (raw.weight !== undefined) {
    if (!Number.isFinite(raw.weight) || raw.weight <= 0) {
      throw new Error(`Invalid voter weight: ${String(raw.weight)} (must be a positive number)`);
    }
    voter.weight = raw.weight;
  }
  if (raw.veto !== undefined) voter.veto = raw.veto;
  return voter;
}

export function requireFraction(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`Invalid ${label}: ${String(value)} (must be in (0, 1])`);
  }
  return value;
}

export function requirePositiveMs(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Invalid ${label}: ${String(value)} (must be a positive number of milliseconds)`,
    );
  }
  return Math.round(value);
}

/** Compact a normalized entry to the friendliest lossless config form. */
function compactEntry(entry: BrainModelEntry): string {
  return entry.provider ? `${entry.provider}/${entry.model}` : entry.model;
}

function compactVoter(voter: BrainCouncilVoterConfig): string | BrainCouncilVoterConfig {
  if (voter.persona === undefined && voter.weight === undefined && voter.veto === undefined) {
    return compactEntry(voter);
  }
  return { ...voter };
}

/** Lenient boot-time normalization: bad entries are dropped, not fatal. */
export function normalizeInitial(config: BrainConfig | undefined): BrainConfig {
  const cfg: BrainConfig = { ...(config ?? {}) };
  const safe = <T, R>(items: readonly T[] | undefined, map: (item: T) => R): R[] =>
    (items ?? []).flatMap((item) => {
      try {
        return [map(item)];
      } catch {
        return [];
      }
    });
  if (cfg.models) cfg.models = safe(cfg.models, normalizeEntry);
  // Rules are validated at COMPILE time (rebuild), where a bad rule disables
  // only itself and reports through `ruleErrors`. Nothing to drop here — but
  // a non-array from a hand-edited config would break compilation, so guard.
  if (cfg.rules !== undefined && !Array.isArray(cfg.rules)) cfg.rules = undefined;
  if (cfg.council) {
    const council = { ...cfg.council };
    if (council.voters) council.voters = safe(council.voters, normalizeVoter);
    if (council.judge) {
      try {
        council.judge = normalizeEntry(council.judge);
      } catch {
        council.judge = undefined;
      }
    }
    cfg.council = council;
  }
  return cfg;
}

/**
 * The config `apply()` persists: the live config in its friendliest lossless
 * form. Adaptive risk is a derived default, so it is never written back.
 */
export function brainConfigForPersist(cfg: BrainConfig, adaptiveRisk: boolean): BrainConfig {
  const out: BrainConfig = {};
  if (cfg.mode !== undefined) out.mode = cfg.mode;
  if (!adaptiveRisk && cfg.maxAutoRisk !== undefined) out.maxAutoRisk = cfg.maxAutoRisk;
  if (cfg.models?.length) out.models = cfg.models.map((m) => compactEntry(normalizeEntry(m)));
  if (cfg.strategy !== undefined) out.strategy = cfg.strategy;
  if (cfg.decisionTimeoutMs !== undefined) out.decisionTimeoutMs = cfg.decisionTimeoutMs;
  if (cfg.humanTimeoutMs !== undefined) out.humanTimeoutMs = cfg.humanTimeoutMs;
  if (cfg.council !== undefined) {
    const c = cfg.council;
    const outCouncil: NonNullable<BrainConfig['council']> = {};
    if (c.enabled !== undefined) outCouncil.enabled = c.enabled;
    if (c.minRisk !== undefined) outCouncil.minRisk = c.minRisk;
    if (c.voters?.length) outCouncil.voters = c.voters.map((v) => compactVoter(normalizeVoter(v)));
    if (c.quorum !== undefined) outCouncil.quorum = c.quorum;
    if (c.approval !== undefined) outCouncil.approval = c.approval;
    if (c.judge !== undefined) outCouncil.judge = compactEntry(normalizeEntry(c.judge));
    // Same rule as the top level: a field missing here is DELETED from the
    // user's config on the next apply(). Guarded by brain-config-roundtrip.
    if (c.perCallTimeoutMs !== undefined) outCouncil.perCallTimeoutMs = c.perCallTimeoutMs;
    if (c.maxConcurrency !== undefined) outCouncil.maxConcurrency = c.maxConcurrency;
    if (c.distinctness !== undefined) outCouncil.distinctness = c.distinctness;
    if (c.voterMaxTokens !== undefined) outCouncil.voterMaxTokens = c.voterMaxTokens;
    if (c.judgeMaxTokens !== undefined) outCouncil.judgeMaxTokens = c.judgeMaxTokens;
    if (c.deliberationRounds !== undefined) outCouncil.deliberationRounds = c.deliberationRounds;
    if (c.seats?.length) outCouncil.seats = c.seats.map((seat) => ({ ...seat }));
    out.council = outCouncil;
  }
  if (cfg.rules?.length) out.rules = cfg.rules.map((rule) => ({ ...rule }));
  if (cfg.heuristics !== undefined) out.heuristics = { ...cfg.heuristics };
  if (cfg.ledger !== undefined) out.ledger = { ...cfg.ledger };
  if (cfg.monitor !== undefined) out.monitor = { ...cfg.monitor };
  // Blocks that are boot-only (no patch surface yet) must STILL be copied:
  // `apply()` persists this object wholesale, so a field missing here is
  // silently deleted from the user's config the next time any Brain
  // setting changes. `brain-config-roundtrip` guards this.
  if (cfg.trace !== undefined) out.trace = { ...cfg.trace };
  if (cfg.llm !== undefined) out.llm = { ...cfg.llm };
  if (cfg.cache !== undefined) out.cache = { ...cfg.cache };
  if (cfg.terminalPolicy !== undefined) out.terminalPolicy = cfg.terminalPolicy;
  if (cfg.decisionLogMaxEntries !== undefined) {
    out.decisionLogMaxEntries = cfg.decisionLogMaxEntries;
  }
  return out;
}

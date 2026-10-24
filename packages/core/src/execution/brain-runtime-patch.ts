/** Strict merge + validation of a Brain config patch (the `apply()` path). */

import type { BrainConfig } from '@wrongstack/contracts/types/config';
import type { BrainHeuristicsConfig } from '../brain/brain-heuristics.js';
import { compileBrainRules } from '../brain/brain-rules.js';
import {
  AUTO_RISK_LEVELS,
  COUNCIL_DISTINCTNESS,
  COUNCIL_MIN_RISKS,
  DENY_TERMINAL_MODES,
  KNOWN_PATCH_KEYS,
  TERMINAL_POLICIES,
  TRACE_CONTENT_MODES,
} from './brain-runtime-constants.js';
import {
  normalizeEntry,
  normalizeVoter,
  requireFraction,
  requirePositiveMs,
} from './brain-runtime-normalize.js';
import type { BrainConfigPatch } from './brain-runtime-types.js';
import { MAX_COUNCIL_DELIBERATION_ROUNDS } from './council-profiles.js';

/** Merge + validate a patch into a NEW config. Throws before any state changes. */
export function mergeBrainConfigPatch(
  cfg: BrainConfig,
  patch: BrainConfigPatch,
): { next: BrainConfig; rebuildNeeded: boolean } {
  const next: BrainConfig = { ...cfg, council: cfg.council ? { ...cfg.council } : undefined };
  let rebuildNeeded = false;
  const structural = (): void => {
    rebuildNeeded = true;
  };

  if (patch.mode !== undefined) {
    if (patch.mode !== 'headless' && patch.mode !== 'interactive') {
      throw new Error(`Invalid mode: ${String(patch.mode)}`);
    }
    next.mode = patch.mode;
  }
  if (patch.maxAutoRisk !== undefined) {
    if (!AUTO_RISK_LEVELS.has(patch.maxAutoRisk)) {
      throw new Error(`Invalid maxAutoRisk: ${String(patch.maxAutoRisk)}`);
    }
    next.maxAutoRisk = patch.maxAutoRisk;
  }
  if (patch.humanTimeoutMs !== undefined) {
    next.humanTimeoutMs =
      patch.humanTimeoutMs === null
        ? undefined
        : patch.humanTimeoutMs === 0
          ? 0
          : requirePositiveMs(patch.humanTimeoutMs, 'humanTimeoutMs');
  }
  if (patch.models !== undefined) {
    next.models = patch.models === null ? undefined : patch.models.map(normalizeEntry);
    structural();
  }
  if (patch.strategy !== undefined) {
    if (
      patch.strategy !== null &&
      patch.strategy !== 'fallback' &&
      patch.strategy !== 'round-robin'
    ) {
      throw new Error(`Invalid strategy: ${String(patch.strategy)}`);
    }
    next.strategy = patch.strategy ?? undefined;
    structural();
  }
  if (patch.decisionTimeoutMs !== undefined) {
    next.decisionTimeoutMs =
      patch.decisionTimeoutMs === null
        ? undefined
        : requirePositiveMs(patch.decisionTimeoutMs, 'decisionTimeoutMs');
    structural();
  }
  if (patch.heuristics !== undefined) {
    if (patch.heuristics === null) {
      next.heuristics = undefined;
    } else {
      const h: BrainHeuristicsConfig = { ...(next.heuristics ?? {}) };
      for (const key of [
        'lowRiskAutoAnswer',
        'blockedResolved',
        'deadlockSkip',
        'retryExhausted',
        'continuePing',
      ] as const) {
        const value = patch.heuristics[key];
        if (value === undefined) continue;
        if (typeof value !== 'boolean') {
          throw new Error(`Invalid heuristics.${key}: expected a boolean`);
        }
        h[key] = value;
      }
      if (patch.heuristics.blockedResolvedMarkers !== undefined) {
        const markers = patch.heuristics.blockedResolvedMarkers;
        if (markers !== null && !Array.isArray(markers)) {
          throw new Error('Invalid heuristics.blockedResolvedMarkers: expected an array');
        }
        h.blockedResolvedMarkers = markers ?? undefined;
      }
      next.heuristics = h;
    }
    structural();
  }
  if (patch.rules !== undefined) {
    if (patch.rules === null) {
      next.rules = undefined;
    } else {
      if (!Array.isArray(patch.rules)) throw new Error('Invalid rules: expected an array');
      // apply() is STRICT where boot is lenient: an interactive edit that
      // silently dropped half its rules would be worse than a clear error.
      const { errors } = compileBrainRules(patch.rules);
      if (errors.length > 0) {
        throw new Error(`Invalid Brain rule(s): ${errors.join('; ')}`);
      }
      next.rules = [...patch.rules];
    }
    structural();
  }
  if (patch.council !== undefined) {
    if (patch.council === null) {
      next.council = undefined;
    } else {
      const c = { ...(next.council ?? {}) };
      const p = patch.council;
      if (p.enabled !== undefined) c.enabled = p.enabled === null ? undefined : p.enabled;
      if (p.minRisk !== undefined) {
        if (p.minRisk !== null && !COUNCIL_MIN_RISKS.has(p.minRisk)) {
          throw new Error(`Invalid council minRisk: ${String(p.minRisk)}`);
        }
        c.minRisk = p.minRisk ?? undefined;
      }
      if (p.voters !== undefined) {
        c.voters = p.voters === null ? undefined : p.voters.map(normalizeVoter);
      }
      if (p.quorum !== undefined) {
        c.quorum = p.quorum === null ? undefined : requireFraction(p.quorum, 'council quorum');
      }
      if (p.approval !== undefined) {
        c.approval =
          p.approval === null ? undefined : requireFraction(p.approval, 'council approval');
      }
      if (p.judge !== undefined) {
        c.judge = p.judge === null ? undefined : normalizeEntry(p.judge);
      }
      for (const key of [
        'perCallTimeoutMs',
        'maxConcurrency',
        'voterMaxTokens',
        'judgeMaxTokens',
        'deliberationRounds',
      ] as const) {
        const v = p[key];
        if (v === undefined) continue;
        if (v !== null && (!Number.isInteger(v) || v <= 0)) {
          throw new Error(`Invalid council.${key}: ${String(v)} (must be a positive integer)`);
        }
        // Every round costs one provider call PER SEAT and blocks the
        // decision for its whole duration; an unbounded value from config
        // would turn one decision into an open-ended debate.
        if (key === 'deliberationRounds' && v !== null && v > MAX_COUNCIL_DELIBERATION_ROUNDS) {
          throw new Error(
            `Invalid council.deliberationRounds: ${String(v)} (max ${MAX_COUNCIL_DELIBERATION_ROUNDS})`,
          );
        }
        c[key] = v ?? undefined;
      }
      if (p.distinctness !== undefined) {
        if (p.distinctness !== null && !COUNCIL_DISTINCTNESS.has(p.distinctness)) {
          throw new Error(`Invalid council.distinctness: ${String(p.distinctness)}`);
        }
        c.distinctness = p.distinctness ?? undefined;
      }
      if (p.seats !== undefined) {
        if (p.seats === null) {
          c.seats = undefined;
        } else {
          if (!Array.isArray(p.seats)) throw new Error('Invalid council.seats: expected an array');
          for (const seat of p.seats) {
            if (!seat?.persona?.trim()) {
              throw new Error('Invalid council.seats: every seat needs a persona');
            }
          }
          c.seats = p.seats.map((seat) => ({ ...seat }));
        }
      }
      next.council = c;
    }
    structural();
  }
  if (patch.terminalPolicy !== undefined) {
    if (patch.terminalPolicy !== null && !TERMINAL_POLICIES.has(patch.terminalPolicy)) {
      throw new Error(`Invalid terminalPolicy: ${String(patch.terminalPolicy)}`);
    }
    next.terminalPolicy = patch.terminalPolicy ?? undefined;
  }
  if (patch.decisionLogMaxEntries !== undefined) {
    const n = patch.decisionLogMaxEntries;
    if (n !== null && (!Number.isInteger(n) || n <= 0)) {
      throw new Error(`Invalid decisionLogMaxEntries: ${String(n)} (must be a positive integer)`);
    }
    next.decisionLogMaxEntries = n ?? undefined;
  }
  if (patch.cache !== undefined) {
    if (patch.cache === null) {
      next.cache = undefined;
    } else {
      const c = { ...(next.cache ?? {}) };
      if (patch.cache.enabled !== undefined) {
        if (typeof patch.cache.enabled !== 'boolean') {
          throw new Error('Invalid cache.enabled: expected a boolean');
        }
        c.enabled = patch.cache.enabled;
      }
      for (const key of ['ttlMs', 'maxEntries'] as const) {
        const v = patch.cache[key];
        if (v === undefined) continue;
        if (!Number.isInteger(v) || v <= 0) {
          throw new Error(`Invalid cache.${key}: ${String(v)} (must be a positive integer)`);
        }
        c[key] = v;
      }
      next.cache = c;
    }
    structural();
  }
  if (patch.llm !== undefined) {
    if (patch.llm === null) {
      next.llm = undefined;
    } else {
      const l = { ...(next.llm ?? {}) };
      if (patch.llm.maxTokens === null) {
        delete l.maxTokens;
      } else if (patch.llm.maxTokens !== undefined) {
        const n = patch.llm.maxTokens;
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(`Invalid llm.maxTokens: ${String(n)} (must be a positive integer)`);
        }
        l.maxTokens = n;
      }
      if (patch.llm.rejectUncertain !== undefined) {
        if (typeof patch.llm.rejectUncertain !== 'boolean') {
          throw new Error('Invalid llm.rejectUncertain: expected a boolean');
        }
        l.rejectUncertain = patch.llm.rejectUncertain;
      }
      if (patch.llm.denyIsTerminal !== undefined) {
        if (!DENY_TERMINAL_MODES.has(patch.llm.denyIsTerminal)) {
          throw new Error(`Invalid llm.denyIsTerminal: ${String(patch.llm.denyIsTerminal)}`);
        }
        l.denyIsTerminal = patch.llm.denyIsTerminal;
      }
      if (patch.llm.minConfidence !== undefined) {
        const n = patch.llm.minConfidence;
        if (!Number.isFinite(n) || n < 0 || n > 1) {
          throw new Error(`Invalid llm.minConfidence: ${String(n)} (must be in [0, 1])`);
        }
        l.minConfidence = n;
      }
      next.llm = l;
    }
    structural();
  }
  if (patch.trace !== undefined) {
    if (patch.trace === null) {
      next.trace = undefined;
    } else {
      const t = { ...(next.trace ?? {}) };
      if (patch.trace.enabled !== undefined) {
        if (typeof patch.trace.enabled !== 'boolean') {
          throw new Error('Invalid trace.enabled: expected a boolean');
        }
        t.enabled = patch.trace.enabled;
      }
      if (patch.trace.content !== undefined) {
        if (!TRACE_CONTENT_MODES.has(patch.trace.content)) {
          throw new Error(`Invalid trace.content: ${String(patch.trace.content)}`);
        }
        t.content = patch.trace.content;
      }
      if (patch.trace.path !== undefined) t.path = patch.trace.path || undefined;
      if (patch.trace.maxOpenRecords !== undefined) {
        const n = patch.trace.maxOpenRecords;
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(
            `Invalid trace.maxOpenRecords: ${String(n)} (must be a positive integer)`,
          );
        }
        t.maxOpenRecords = n;
      }
      next.trace = t;
    }
    structural();
  }
  if (patch.monitor !== undefined) {
    next.monitor =
      patch.monitor === null ? undefined : { ...(next.monitor ?? {}), ...patch.monitor };
    structural();
  }
  if (patch.ledger !== undefined) {
    if (patch.ledger === null) {
      next.ledger = undefined;
    } else {
      const l = { ...(next.ledger ?? {}) };
      if (patch.ledger.enabled !== undefined) {
        if (typeof patch.ledger.enabled !== 'boolean')
          throw new Error('Invalid ledger.enabled: expected a boolean');
        l.enabled = patch.ledger.enabled;
      }
      if (patch.ledger.autoDenyAfterFailures !== undefined) {
        const n = patch.ledger.autoDenyAfterFailures;
        if (n !== null && (!Number.isInteger(n) || n < 0)) {
          throw new Error(`Invalid autoDenyAfterFailures: ${String(n)} (must be an integer >= 0)`);
        }
        l.autoDenyAfterFailures = n ?? undefined;
      }
      for (const key of ['maxMemoryEntries', 'interventionRetryWindowMs'] as const) {
        const v = patch.ledger[key];
        if (v === undefined) continue;
        if (v !== null && (!Number.isInteger(v) || v <= 0)) {
          throw new Error(`Invalid ledger.${key}: ${String(v)} (must be a positive integer)`);
        }
        l[key] = v ?? undefined;
      }
      next.ledger = l;
    }
    structural();
  }

  // Structural keys already flagged themselves above; anything not covered
  // by either key set is a typo or a field that was added to the patch type
  // without being registered here, and must fail loudly.
  for (const key of Object.keys(patch)) {
    if ((patch as Record<string, unknown>)[key] === undefined) continue;
    if (!KNOWN_PATCH_KEYS.has(key)) {
      throw new Error(`Unknown brain config field: ${key}`);
    }
  }
  return { next, rebuildNeeded };
}

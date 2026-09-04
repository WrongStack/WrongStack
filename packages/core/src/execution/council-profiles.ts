import type {
  CouncilDistinctness,
  CouncilModelTarget,
  CouncilProfileConfig,
  ResolvedCouncilProfile,
  ResolvedCouncilSeat,
} from '../types/council.js';
import {
  type CouncilPersonaRegistry,
  DEFAULT_COUNCIL_PERSONA_REGISTRY,
} from './council-personas.js';

const PROFILE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DISTINCTNESS_VALUES: ReadonlySet<CouncilDistinctness> = new Set([
  'none',
  'model',
  'provider',
]);

export const DEFAULT_COUNCIL_QUORUM_FRACTION = 0.5;
export const DEFAULT_COUNCIL_APPROVAL_FRACTION = 0.5;
export const DEFAULT_COUNCIL_VOTER_MAX_TOKENS = 300;
export const DEFAULT_COUNCIL_JUDGE_MAX_TOKENS = 500;
export const DEFAULT_COUNCIL_PER_CALL_TIMEOUT_MS = 30_000;
export const DEFAULT_COUNCIL_OVERALL_TIMEOUT_MS = 90_000;
/**
 * Voting rounds per decision. 2 = one independent round plus one deliberation
 * round in which each seat sees the others' ballots.
 */
export const DEFAULT_COUNCIL_DELIBERATION_ROUNDS = 2;
/**
 * Hard ceiling on rounds. Every round costs one provider call PER SEAT and
 * the panel blocks a decision the whole time; a runaway `deliberationRounds`
 * from config would otherwise turn one decision into an unbounded debate.
 */
export const MAX_COUNCIL_DELIBERATION_ROUNDS = 5;

/** Model-agnostic profiles. Roles are routing hints, never provider/model pins. */
export const BUILTIN_COUNCIL_PROFILES: readonly CouncilProfileConfig[] = Object.freeze([
  Object.freeze({
    id: 'balanced',
    name: 'Balanced',
    description: 'Three complementary lenses plus an independent judge for general decisions.',
    seats: Object.freeze([
      Object.freeze({ persona: 'executor', target: Object.freeze({ role: 'planner' }) }),
      Object.freeze({ persona: 'skeptic', target: Object.freeze({ role: 'critic' }) }),
      Object.freeze({ persona: 'auditor', target: Object.freeze({ role: 'analyst' }) }),
    ]),
    judge: Object.freeze({ role: 'reviewer' }),
    quorumFraction: 0.5,
    approvalFraction: 0.5,
    distinctness: 'model',
  }),
  Object.freeze({
    id: 'fast',
    name: 'Fast',
    description: 'Two-seat panel without a judge for quick, low-cost decisions.',
    seats: Object.freeze([
      Object.freeze({ persona: 'executor', target: Object.freeze({ role: 'planner' }) }),
      Object.freeze({ persona: 'skeptic', target: Object.freeze({ role: 'critic' }) }),
    ]),
    judge: false,
    quorumFraction: 0.5,
    approvalFraction: 0.5,
    distinctness: 'none',
    voterMaxTokens: 200,
    perCallTimeoutMs: 20_000,
    overallTimeoutMs: 30_000,
  }),
  Object.freeze({
    id: 'risk-review',
    name: 'Risk Review',
    description: 'Security, assumptions, maintenance, and cost review for high-impact choices.',
    seats: Object.freeze([
      Object.freeze({ persona: 'skeptic', target: Object.freeze({ role: 'critic' }) }),
      Object.freeze({ persona: 'security', target: Object.freeze({ role: 'security-reviewer' }) }),
      Object.freeze({ persona: 'maintainer', target: Object.freeze({ role: 'reviewer' }) }),
      Object.freeze({ persona: 'auditor', target: Object.freeze({ role: 'analyst' }) }),
    ]),
    judge: Object.freeze({ role: 'architect' }),
    quorumFraction: 0.75,
    approvalFraction: 0.5,
    distinctness: 'provider',
    judgeMaxTokens: 700,
    overallTimeoutMs: 120_000,
  }),
]);

/** Immutable registry of normalized Council profiles. */
export class CouncilProfileRegistry {
  private readonly byId: ReadonlyMap<string, ResolvedCouncilProfile>;
  private readonly personas: CouncilPersonaRegistry;

  constructor(
    profiles: readonly CouncilProfileConfig[] = [],
    personas: CouncilPersonaRegistry = DEFAULT_COUNCIL_PERSONA_REGISTRY,
  ) {
    this.personas = personas;
    const entries = new Map<string, ResolvedCouncilProfile>();
    for (const profile of profiles) {
      const normalized = normalizeCouncilProfile(profile, personas);
      if (entries.has(normalized.id)) {
        throw new Error(`CouncilProfileRegistry: duplicate profile id "${normalized.id}".`);
      }
      entries.set(normalized.id, normalized);
    }
    this.byId = entries;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): ResolvedCouncilProfile | undefined {
    return this.byId.get(id);
  }

  require(id: string): ResolvedCouncilProfile {
    const profile = this.get(id);
    if (!profile) throw new Error(`CouncilProfileRegistry: unknown profile "${id}".`);
    return profile;
  }

  list(): readonly ResolvedCouncilProfile[] {
    return Object.freeze([...this.byId.values()]);
  }

  /** Return a new registry; the current registry is never mutated. */
  with(
    profile: CouncilProfileConfig,
    opts: {
      replace?: boolean | undefined;
      personas?: CouncilPersonaRegistry | undefined;
    } = {},
  ): CouncilProfileRegistry {
    const personas = opts.personas ?? this.personas;
    const normalized = normalizeCouncilProfile(profile, personas);
    if (this.has(normalized.id) && opts.replace !== true) {
      throw new Error(`CouncilProfileRegistry: profile "${normalized.id}" already exists.`);
    }
    return new CouncilProfileRegistry(
      [...this.list().filter((entry) => entry.id !== normalized.id), profile],
      personas,
    );
  }
}

export const DEFAULT_COUNCIL_PROFILE_REGISTRY = new CouncilProfileRegistry(
  BUILTIN_COUNCIL_PROFILES,
);

export function createCouncilProfileRegistry(
  additional: readonly CouncilProfileConfig[] = [],
  personas: CouncilPersonaRegistry = DEFAULT_COUNCIL_PERSONA_REGISTRY,
): CouncilProfileRegistry {
  return new CouncilProfileRegistry([...BUILTIN_COUNCIL_PROFILES, ...additional], personas);
}

export function resolveCouncilProfile(
  profile: string | CouncilProfileConfig | undefined,
  opts: {
    registry?: CouncilProfileRegistry | undefined;
    personas?: CouncilPersonaRegistry | undefined;
    defaultProfile?: string | undefined;
  } = {},
): ResolvedCouncilProfile {
  const personas = opts.personas ?? DEFAULT_COUNCIL_PERSONA_REGISTRY;
  if (profile && typeof profile !== 'string') return normalizeCouncilProfile(profile, personas);
  const id = profile ?? opts.defaultProfile ?? 'balanced';
  return (opts.registry ?? DEFAULT_COUNCIL_PROFILE_REGISTRY).require(id);
}

export function normalizeCouncilProfile(
  profile: CouncilProfileConfig,
  personas: CouncilPersonaRegistry = DEFAULT_COUNCIL_PERSONA_REGISTRY,
): ResolvedCouncilProfile {
  const id = profile.id.trim();
  if (!PROFILE_ID_RE.test(id)) {
    throw new Error(`CouncilProfileRegistry: invalid profile id "${profile.id}".`);
  }
  if (profile.seats.length === 0) {
    throw new Error(`CouncilProfileRegistry: profile "${id}" requires at least one seat.`);
  }

  const usedIds = new Set<string>();
  const seats = profile.seats.map((seat) => {
    const persona = personas.require(seat.persona.trim());
    const explicitSeatId = seat.id?.trim();
    if (explicitSeatId && usedIds.has(explicitSeatId)) {
      throw new Error(`CouncilProfileRegistry: duplicate seat id "${explicitSeatId}".`);
    }
    const seatId = uniqueSeatId(explicitSeatId || persona.id, usedIds);
    const label = seat.label?.trim() || persona.name;
    const weight = seat.weight ?? persona.defaultWeight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error(`CouncilProfileRegistry: seat "${seatId}" has an invalid weight.`);
    }
    return Object.freeze({
      id: seatId,
      label,
      persona: persona.id,
      ...(seat.target ? { target: freezeTarget(seat.target, `seat "${seatId}"`) } : {}),
      weight,
      veto: seat.veto ?? persona.defaultVeto ?? false,
    }) satisfies ResolvedCouncilSeat;
  });

  const quorumFraction = fraction(
    profile.quorumFraction ?? DEFAULT_COUNCIL_QUORUM_FRACTION,
    'quorumFraction',
    id,
  );
  const approvalFraction = fraction(
    profile.approvalFraction ?? DEFAULT_COUNCIL_APPROVAL_FRACTION,
    'approvalFraction',
    id,
  );
  const distinctness = profile.distinctness ?? 'model';
  if (!DISTINCTNESS_VALUES.has(distinctness)) {
    throw new Error(`CouncilProfileRegistry: profile "${id}" has invalid distinctness.`);
  }
  const voterMaxTokens = positiveInteger(
    profile.voterMaxTokens ?? DEFAULT_COUNCIL_VOTER_MAX_TOKENS,
    'voterMaxTokens',
    id,
  );
  const judgeMaxTokens = positiveInteger(
    profile.judgeMaxTokens ?? DEFAULT_COUNCIL_JUDGE_MAX_TOKENS,
    'judgeMaxTokens',
    id,
  );
  const perCallTimeoutMs = positiveInteger(
    profile.perCallTimeoutMs ?? DEFAULT_COUNCIL_PER_CALL_TIMEOUT_MS,
    'perCallTimeoutMs',
    id,
  );
  const deliberationRounds = positiveInteger(
    profile.deliberationRounds ?? DEFAULT_COUNCIL_DELIBERATION_ROUNDS,
    'deliberationRounds',
    id,
  );
  if (deliberationRounds > MAX_COUNCIL_DELIBERATION_ROUNDS) {
    throw new Error(
      `CouncilProfileRegistry: profile "${id}" deliberationRounds must not exceed ` +
        `${MAX_COUNCIL_DELIBERATION_ROUNDS}.`,
    );
  }
  // The overall budget covers EVERY round, so an explicit budget written for
  // a single-round panel would now abort the panel mid-deliberation. Scale
  // the default by the round count and let an explicit value stand.
  const overallTimeoutMs = positiveInteger(
    profile.overallTimeoutMs ?? DEFAULT_COUNCIL_OVERALL_TIMEOUT_MS * deliberationRounds,
    'overallTimeoutMs',
    id,
  );
  if (overallTimeoutMs < perCallTimeoutMs) {
    throw new Error(
      `CouncilProfileRegistry: profile "${id}" overallTimeoutMs must be at least perCallTimeoutMs.`,
    );
  }

  return Object.freeze({
    id,
    name: profile.name?.trim() || id,
    description: profile.description?.trim() || '',
    seats: Object.freeze(seats),
    judge: profile.judge ? freezeTarget(profile.judge, 'judge') : false,
    quorumFraction,
    approvalFraction,
    distinctness,
    voterMaxTokens,
    judgeMaxTokens,
    perCallTimeoutMs,
    overallTimeoutMs,
    deliberationRounds,
  });
}

function uniqueSeatId(base: string, used: Set<string>): string {
  if (!PROFILE_ID_RE.test(base)) {
    throw new Error(`CouncilProfileRegistry: invalid seat id "${base}".`);
  }
  let id = base;
  let suffix = 2;
  while (used.has(id)) id = `${base}-${suffix++}`;
  used.add(id);
  return id;
}

function freezeTarget(target: CouncilModelTarget, label: string): CouncilModelTarget {
  const providerId = optionalText(target.providerId);
  const model = optionalText(target.model);
  const role = optionalText(target.role);
  const fallbackProfile = optionalText(target.fallbackProfile);
  const fallbackModels = Object.freeze([
    ...new Set((target.fallbackModels ?? []).map((ref) => ref.trim()).filter(Boolean)),
  ]);
  if (!providerId && !model && !role && !fallbackProfile && fallbackModels.length === 0) {
    throw new Error(`CouncilProfileRegistry: ${label} target is empty.`);
  }
  return Object.freeze({
    ...(providerId ? { providerId } : {}),
    ...(model ? { model } : {}),
    ...(role ? { role } : {}),
    ...(fallbackProfile ? { fallbackProfile } : {}),
    ...(fallbackModels.length > 0 ? { fallbackModels } : {}),
  });
}

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function fraction(value: number, field: string, profileId: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`CouncilProfileRegistry: profile "${profileId}" ${field} must be in (0, 1].`);
  }
  return value;
}

function positiveInteger(value: number, field: string, profileId: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `CouncilProfileRegistry: profile "${profileId}" ${field} must be a positive integer.`,
    );
  }
  return value;
}

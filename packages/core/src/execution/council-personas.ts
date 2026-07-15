import type { CouncilPersona } from '../types/council.js';

const PERSONA_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Provider-neutral personas shipped with every Council installation. */
export const BUILTIN_COUNCIL_PERSONAS: readonly CouncilPersona[] = Object.freeze([
  freezePersona({
    id: 'executor',
    name: 'Executor',
    description: 'Tests whether a proposal is practical and keeps useful work moving.',
    instruction:
      'Evaluate operational feasibility, concrete progress, and the cost of delay. Favor decisive action when evidence supports it, but reject action whose prerequisites are missing.',
    tags: ['delivery', 'feasibility', 'progress'],
  }),
  freezePersona({
    id: 'skeptic',
    name: 'Skeptic',
    description: 'Challenges assumptions and looks for concrete failure modes.',
    instruction:
      'Identify unsupported assumptions, unsafe premises, irreversible consequences, and credible failure modes. Oppose or refuse only when you can name a concrete reason.',
    defaultVeto: true,
    tags: ['risk', 'assumptions', 'failure-modes'],
  }),
  freezePersona({
    id: 'auditor',
    name: 'Auditor',
    description: 'Evaluates cost, waste, evidence quality, and expected value.',
    instruction:
      'Compare resource cost, opportunity cost, evidence quality, reversibility, and expected value. Prefer the option that achieves the objective with the least avoidable waste.',
    tags: ['cost', 'evidence', 'efficiency'],
  }),
  freezePersona({
    id: 'security',
    name: 'Security Reviewer',
    description: 'Examines trust boundaries, abuse cases, and security impact.',
    instruction:
      'Evaluate trust boundaries, attacker-controlled inputs, privilege changes, data exposure, abuse cases, and recovery options. Treat unmitigated high-impact security risk as grounds to refuse.',
    defaultVeto: true,
    tags: ['security', 'trust', 'abuse-cases'],
  }),
  freezePersona({
    id: 'maintainer',
    name: 'Maintainer',
    description: 'Evaluates complexity, compatibility, and long-term ownership.',
    instruction:
      'Evaluate behavioral compatibility, conceptual complexity, testability, migration cost, and future maintenance. Prefer the smallest design that remains clear and extensible.',
    tags: ['maintenance', 'compatibility', 'simplicity'],
  }),
  freezePersona({
    id: 'user-advocate',
    name: 'User Advocate',
    description: 'Evaluates the decision from the affected user’s perspective.',
    instruction:
      'Evaluate usability, surprise, accessibility, failure recovery, and whether the outcome solves the user’s stated need. Prefer understandable behavior with safe recovery paths.',
    tags: ['users', 'usability', 'accessibility'],
  }),
]);

/** Immutable registry of trusted Council persona definitions. */
export class CouncilPersonaRegistry {
  private readonly byId: ReadonlyMap<string, CouncilPersona>;

  constructor(personas: readonly CouncilPersona[] = []) {
    const entries = new Map<string, CouncilPersona>();
    for (const persona of personas) {
      const normalized = freezePersona(persona);
      if (entries.has(normalized.id)) {
        throw new Error(`CouncilPersonaRegistry: duplicate persona id "${normalized.id}".`);
      }
      entries.set(normalized.id, normalized);
    }
    this.byId = entries;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): CouncilPersona | undefined {
    return this.byId.get(id);
  }

  require(id: string): CouncilPersona {
    const persona = this.get(id);
    if (!persona) throw new Error(`CouncilPersonaRegistry: unknown persona "${id}".`);
    return persona;
  }

  list(): readonly CouncilPersona[] {
    return Object.freeze([...this.byId.values()]);
  }

  /** Return a new registry; the current registry is never mutated. */
  with(persona: CouncilPersona, opts: { replace?: boolean | undefined } = {}): CouncilPersonaRegistry {
    const normalized = freezePersona(persona);
    if (this.has(normalized.id) && opts.replace !== true) {
      throw new Error(`CouncilPersonaRegistry: persona "${normalized.id}" already exists.`);
    }
    return new CouncilPersonaRegistry([
      ...this.list().filter((entry) => entry.id !== normalized.id),
      normalized,
    ]);
  }
}

export const DEFAULT_COUNCIL_PERSONA_REGISTRY = new CouncilPersonaRegistry(
  BUILTIN_COUNCIL_PERSONAS,
);

export function createCouncilPersonaRegistry(
  additional: readonly CouncilPersona[] = [],
): CouncilPersonaRegistry {
  let registry = DEFAULT_COUNCIL_PERSONA_REGISTRY;
  for (const persona of additional) registry = registry.with(persona);
  return registry;
}

function freezePersona(persona: CouncilPersona): CouncilPersona {
  const id = persona.id.trim();
  const name = persona.name.trim();
  const description = persona.description.trim();
  const instruction = persona.instruction.trim();
  if (!PERSONA_ID_RE.test(id)) {
    throw new Error(`CouncilPersonaRegistry: invalid persona id "${persona.id}".`);
  }
  if (!name) throw new Error(`CouncilPersonaRegistry: persona "${id}" requires a name.`);
  if (!description) {
    throw new Error(`CouncilPersonaRegistry: persona "${id}" requires a description.`);
  }
  if (!instruction) {
    throw new Error(`CouncilPersonaRegistry: persona "${id}" requires an instruction.`);
  }
  if (
    persona.defaultWeight !== undefined &&
    (!Number.isFinite(persona.defaultWeight) || persona.defaultWeight <= 0)
  ) {
    throw new Error(`CouncilPersonaRegistry: persona "${id}" has an invalid default weight.`);
  }
  const tags = Object.freeze(
    [...new Set((persona.tags ?? []).map((tag) => tag.trim()).filter(Boolean))],
  );
  return Object.freeze({
    id,
    name,
    description,
    instruction,
    ...(persona.defaultWeight !== undefined ? { defaultWeight: persona.defaultWeight } : {}),
    ...(persona.defaultVeto !== undefined ? { defaultVeto: persona.defaultVeto } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  });
}

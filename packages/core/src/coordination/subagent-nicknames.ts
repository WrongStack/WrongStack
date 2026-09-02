/**
 * Subagent nickname pool — famous scientists, mathematicians, and computing pioneers.
 * Names are grouped by domain affinity so the nickname hints at the agent's role.
 */

const NICKNAME_POOL = {
  // Physics & fundamental sciences
  einstein: { name: 'Einstein', domain: 'physics' },
  newton: { name: 'Newton', domain: 'physics' },
  feynman: { name: 'Feynman', domain: 'physics' },
  dirac: { name: 'Dirac', domain: 'physics' },
  bohr: { name: 'Bohr', domain: 'physics' },
  planck: { name: 'Planck', domain: 'physics' },
  curie: { name: 'Curie', domain: 'physics' },
  fermi: { name: 'Fermi', domain: 'physics' },
  heisenberg: { name: 'Heisenberg', domain: 'physics' },
  schrodinger: { name: 'Schrödinger', domain: 'physics' },

  // Mathematics
  euclid: { name: 'Euclid', domain: 'math' },
  gauss: { name: 'Gauss', domain: 'math' },
  turing: { name: 'Turing', domain: 'math' },
  poincare: { name: 'Poincaré', domain: 'math' },
  riemann: { name: 'Riemann', domain: 'math' },
  hilbert: { name: 'Hilbert', domain: 'math' },
  pythagoras: { name: 'Pythagoras', domain: 'math' },

  // Computing & information theory
  'von-neumann': { name: 'Von Neumann', domain: 'computing' },
  shannon: { name: 'Shannon', domain: 'computing' },
  hopper: { name: 'Hopper', domain: 'computing' },
  backus: { name: 'Backus', domain: 'computing' },
  knuth: { name: 'Knuth', domain: 'computing' },
  torvalds: { name: 'Torvalds', domain: 'computing' },
  stallman: { name: 'Stallman', domain: 'computing' },
  'berners-lee': { name: 'Berners-Lee', domain: 'computing' },
  babbage: { name: 'Babbage', domain: 'computing' },
  lovelace: { name: 'Lovelace', domain: 'computing' },
  klein: { name: 'Klein', domain: 'computing' },

  // Electronics & electrical engineering
  edison: { name: 'Edison', domain: 'ee' },
  tesla: { name: 'Tesla', domain: 'ee' },
  faraday: { name: 'Faraday', domain: 'ee' },
  maxwell: { name: 'Maxwell', domain: 'ee' },
  ohm: { name: 'Ohm', domain: 'ee' },
  bell: { name: 'Bell', domain: 'ee' },
  marconi: { name: 'Marconi', domain: 'ee' },
  lamarr: { name: 'Lamarr', domain: 'ee' },

  // General science / multi-disciplinary
  darwin: { name: 'Darwin', domain: 'biology' },
  mendel: { name: 'Mendel', domain: 'biology' },
  pasteur: { name: 'Pasteur', domain: 'biology' },
  hawking: { name: 'Hawking', domain: 'cosmology' },
  sagan: { name: 'Sagan', domain: 'cosmology' },

  // Exploration & navigation
  columbus: { name: 'Columbus', domain: 'exploration' },
  polo: { name: 'Polo', domain: 'exploration' },
  magellan: { name: 'Magellan', domain: 'exploration' },

  // Chemistry / materials
  lavoisier: { name: 'Lavoisier', domain: 'chemistry' },
  mendeleev: { name: 'Mendeleev', domain: 'chemistry' },
} as const;

/** Flat ordered list of all available nicknames — used for round-robin. */
const ALL_NICKNAMES = Object.entries(NICKNAME_POOL) as [
  NicknameKey,
  { name: string; domain: string },
][];

/** Reverse index: display name (e.g. "Von Neumann") → canonical pool key. */
const NAME_TO_KEY: Record<string, string> = Object.fromEntries(
  ALL_NICKNAMES.map(([key, entry]) => [entry.name, key]),
);

/** Domain → preferred nickname keys (fallback chain). */
const DOMAIN_PREFERENCES: Record<string, string[]> = {
  security: ['shannon', 'turing', 'lamarr', 'stallman'],
  'bug-hunter': ['darwin', 'curie', 'feynman', 'fermi'],
  refactor: ['gauss', 'hilbert', 'euclid', 'planck'],
  'audit-log': ['sagan', 'hawking', 'poincare', 'newton'],
  planner: ['hilbert', 'gauss', 'turing', 'euclid'],
  researcher: ['sagan', 'hawking', 'darwin', 'pasteur'],
  explorer: ['marconi', 'bell', 'columbus', 'polo'],
  testing: ['pasteur', 'curie', 'fermi', 'bohr'],
  frontend: ['lovelace', 'hopper', 'babbage', 'backus'],
  backend: ['torvalds', 'stallman', 'von-neumann', 'backus'],
  database: ['turing', 'shannon', 'backus', 'knuth'],
  devops: ['tesla', 'edison', 'faraday', 'bell'],
  'security-scanner': ['shannon', 'turing', 'lamarr', 'stallman'],
  'refactor-planner': ['gauss', 'hilbert', 'planck', 'newton'],
  architect: ['von-neumann', 'turing', 'gauss', 'hilbert'],
  critic: ['einstein', 'feynman', 'dirac', 'bohr'],
  e2e: ['hopper', 'bell', 'marconi', 'tesla'],
  performance: ['knuth', 'gauss', 'planck', 'feynman'],
  chaos: ['tesla', 'edison', 'curie', 'fermi'],
  cost: ['ohm', 'bell', 'marconi', 'tesla'],
  // default fallback
  default: [
    'einstein',
    'newton',
    'curie',
    'tesla',
    'edison',
    'turing',
    'shannon',
    'hopper',
    'knuth',
    'stallman',
  ],
};

type NicknameKey = keyof typeof NICKNAME_POOL;

/** Result of a nickname assignment. */
export interface NicknameAssignment {
  /**
   * Canonical pool key (e.g. `von-neumann`). This — NOT the display string — is
   * what callers must add to their `used` set and later remove on release.
   * Deriving the key by parsing the display string is unsafe: multi-word names
   * like "Von Neumann" would be truncated to "von" and never dedupe correctly.
   */
  key: string;
  /** Human display string, e.g. `Von Neumann (Backend)`. */
  display: string;
}

/**
 * Assign a unique nickname to a subagent based on its role.
 *
 * Returns both the canonical pool `key` (for the `used` set) and the formatted
 * `display` string (`Name (Role)`, e.g. `Einstein (Bug Hunter)`).
 *
 * @param role - The subagent's role id (e.g. 'bug-hunter', 'security-scanner')
 * @param used - Set of nickname KEYS already assigned in this fleet
 *               (so no two subagents share the same base name)
 */
export function assignNickname(role: string, used: ReadonlySet<string>): NicknameAssignment {
  // 1. Build preference list: role-specific → default fallback
  const preferences = [
    ...(DOMAIN_PREFERENCES[role] ?? []),
    ...(DOMAIN_PREFERENCES['default'] ?? []),
  ];

  // 2. Find the first unassigned nickname from preferences. Skip keys that are
  //    not in the pool — preference lists can drift out of sync with the pool
  //    (typos, removed names), and an unknown key must not crash assignment.
  for (const key of preferences) {
    const entry = NICKNAME_POOL[key as NicknameKey];
    if (entry && !used.has(key)) {
      return { key, display: `${entry.name} (${formatRole(role)})` };
    }
  }

  // 3. Exhausted preferences — pick the first unused name round-robin style.
  for (const [key, entry] of ALL_NICKNAMES) {
    if (!used.has(key)) {
      return { key, display: `${entry.name} (${formatRole(role)})` };
    }
  }

  // 4. Pool exhausted — synthesize a stable, unique key/display pair.
  const counter = used.size + 1;
  return { key: `scientist-${counter}`, display: `Scientist #${counter} (${formatRole(role)})` };
}

/**
 * Resolve a previously-assigned display string back to its canonical pool key,
 * for release paths that only retained the formatted name (e.g. a manifest
 * entry). Strips the trailing ` (Role)` suffix, then matches the base name
 * against the pool. Returns `undefined` when the name is not a known nickname.
 *
 * Use this instead of `name.split(' ')[0]` — the latter mangles multi-word
 * names like "Von Neumann" and "Berners-Lee".
 */
export function nicknameKeyFromDisplay(display: string): string | undefined {
  const base = display.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const key = NAME_TO_KEY[base];
  if (key) return key;
  const synthesized = base.match(/^Scientist #(\d+)$/);
  return synthesized ? `scientist-${synthesized[1]}` : undefined;
}

/** Format role id into human-readable title-case. */
function formatRole(role: string): string {
  return role
    .trim()
    .split(/[-_\s]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Returns all available nickname keys. Useful for testing or reset logic.
 */
export function getAllNicknameKeys(): string[] {
  return Object.keys(NICKNAME_POOL);
}

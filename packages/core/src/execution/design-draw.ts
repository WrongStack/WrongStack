/**
 * Job-first & material-first page anatomy draw (`design {action:"draw"}`).
 *
 * A kit pins ink, paper, type, and material rules, NOT page structure. Left to
 * default instincts, models stamp the same 5-band SaaS template (centered badge,
 * H1 with one accented word, twin pill CTAs, 3-icon feature grid, 3-tier pricing)
 * onto bakeries, CLI tools, journals, and consoles alike.
 *
 * `drawDesignAnatomy` deals a concrete, deterministic page skeleton keyed by:
 *   1. `job`      — the single verb a visitor came to complete
 *   2. `material` — what real visual matter exists (`photo` | `product` | `words`)
 *   3. `seed`     — reproducible PRNG seed, avoiding recent draws and the active
 *                   kit's own specimen (`kitPictured`) so kits don't clone layouts.
 *
 * Every dealt region also names the canonical `design-patterns` IDs so the output
 * composes directly with WrongStack's pattern catalog.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { resolveWstackPaths } from '../utils/wstack-paths.js';

export const DESIGN_JOBS = [
  'subscribe',
  'book',
  'visit',
  'attend',
  'buy',
  'try',
  'sign-up',
  'hire',
  'join',
  'listen',
  'dashboard',
] as const;

export type DesignJob = (typeof DESIGN_JOBS)[number];

export const DESIGN_MATERIALS = ['photo', 'product', 'words'] as const;

export type DesignMaterial = (typeof DESIGN_MATERIALS)[number];

export interface DesignMacrostructure {
  id: string;
  label: string;
  shellPattern: string;
  summary: string;
}

export interface DesignDrawSection {
  title: string;
  patternId: string;
  directive: string;
}

export interface DesignDrawResult {
  seed: string;
  job: DesignJob;
  material: DesignMaterial;
  macrostructure: DesignMacrostructure;
  hero: {
    id: string;
    patternId: string;
    slot: string;
    directive: string;
  };
  nav: {
    id: string;
    patternId: string;
    directive: string;
  };
  sections: DesignDrawSection[];
  footer: {
    id: string;
    patternId: string;
    directive: string;
  };
  skip: string[];
  excludedMacros: string[];
}

export interface DesignDrawHistoryEntry {
  seed: string;
  job: DesignJob;
  material: DesignMaterial;
  macroId: string;
  heroId: string;
  project: string;
  at: string;
}

const DRAW_KEY = 'designDraw';
const DRAW_HISTORY_LIMIT = 40;
const RECENT_MACRO_EXCLUDE = 3;

const JOB_ALIASES: Readonly<Record<string, DesignJob>> = {
  subscribe: 'subscribe',
  newsletter: 'subscribe',
  journal: 'subscribe',
  read: 'subscribe',
  publication: 'subscribe',
  book: 'book',
  reserve: 'book',
  schedule: 'book',
  appointment: 'book',
  visit: 'visit',
  venue: 'visit',
  restaurant: 'visit',
  bakery: 'visit',
  hotel: 'visit',
  attend: 'attend',
  event: 'attend',
  conference: 'attend',
  ticket: 'attend',
  festival: 'attend',
  buy: 'buy',
  shop: 'buy',
  purchase: 'buy',
  store: 'buy',
  commerce: 'buy',
  try: 'try',
  install: 'try',
  download: 'try',
  cli: 'try',
  oss: 'try',
  'sign-up': 'sign-up',
  signup: 'sign-up',
  register: 'sign-up',
  saas: 'sign-up',
  start: 'sign-up',
  hire: 'hire',
  studio: 'hire',
  agency: 'hire',
  portfolio: 'hire',
  inquire: 'hire',
  join: 'join',
  waitlist: 'join',
  community: 'join',
  apply: 'join',
  membership: 'join',
  listen: 'listen',
  audio: 'listen',
  podcast: 'listen',
  music: 'listen',
  release: 'listen',
  dashboard: 'dashboard',
  console: 'dashboard',
  workspace: 'dashboard',
  admin: 'dashboard',
  app: 'dashboard',
};

export function normalizeDesignJob(raw: string | undefined): DesignJob | undefined {
  if (!raw) return undefined;
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
  return JOB_ALIASES[key];
}

export function normalizeDesignMaterial(raw: string | undefined): DesignMaterial | undefined {
  if (!raw) return undefined;
  const key = raw.trim().toLowerCase();
  if (key === 'photo' || key === 'photography' || key === 'image' || key === 'editorial') {
    return 'photo';
  }
  if (key === 'product' || key === 'ui' || key === 'demo' || key === 'code' || key === 'tool') {
    return 'product';
  }
  if (key === 'words' || key === 'type' || key === 'prose' || key === 'text' || key === 'copy') {
    return 'words';
  }
  return undefined;
}

/** Deterministic FNV-1a → mulberry32 PRNG. */
function rng(seed: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickOne<T>(items: readonly T[], next: () => number): T {
  const idx = Math.floor(next() * items.length);
  return items[Math.min(idx, items.length - 1)] as T;
}

function shuffleWith<T>(items: readonly T[], next: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

const MACROSTRUCTURES: Readonly<Record<string, DesignMacrostructure>> = {
  frontispiece: {
    id: 'frontispiece',
    label: 'Editorial Frontispiece',
    shellPattern: 'editorial-column',
    summary:
      'Asymmetric masthead + primary plate above the fold, followed by a measured reading column and factual index rows.',
  },
  split: {
    id: 'split',
    label: '55/45 Asymmetric Split',
    shellPattern: 'split-pane',
    summary:
      'Left claim + action column paired against a full-height right material plate or interactive specimen; zero centered hero stacks.',
  },
  broadsheet: {
    id: 'broadsheet',
    label: 'Ruled Broadsheet Grid',
    shellPattern: 'holy-grail',
    summary:
      '1px hairline-ruled multi-column grid with visible issue/date metadata, tabular figures, and dense scannable index rows.',
  },
  catalogue: {
    id: 'catalogue',
    label: 'Numbered Plate Catalogue',
    shellPattern: 'catalogue-grid',
    summary:
      'Direct opening statement over a structured 2- or 4-column specimen/item catalogue with specs, prices, or availability inline.',
  },
  dossier: {
    id: 'dossier',
    label: 'Sticky Dossier & Proof Ledger',
    shellPattern: 'editorial-column',
    summary:
      'Sticky rail holding the primary action/summary beside a scrolling specification ledger, case notes, and concrete deliverables.',
  },
  programme: {
    id: 'programme',
    label: 'Chronological Programme Sheet',
    shellPattern: 'editorial-column',
    summary:
      'Poster-scale title + date/place block leading straight into a time-ordered schedule, lineup, or syllabus table.',
  },
  workbench: {
    id: 'workbench',
    label: 'Live Artifact Workbench',
    shellPattern: 'app-shell',
    summary:
      'Immediate working command/input surface above the fold with real copyable output, followed by technical specs and benchmarks.',
  },
  console: {
    id: 'console',
    label: 'Dense Operational Console',
    shellPattern: 'sidebar-console',
    summary:
      '220–260px rail + compact toolbar + KPI strip + primary filterable table/detail pane; zero marketing hero banners.',
  },
};

const JOB_MACROS: Readonly<Record<DesignJob, readonly string[]>> = {
  subscribe: ['frontispiece', 'broadsheet', 'dossier'],
  book: ['split', 'dossier', 'frontispiece'],
  visit: ['frontispiece', 'split', 'broadsheet'],
  attend: ['programme', 'broadsheet', 'split'],
  buy: ['catalogue', 'split', 'frontispiece'],
  try: ['workbench', 'split', 'dossier'],
  'sign-up': ['split', 'workbench', 'broadsheet'],
  hire: ['dossier', 'frontispiece', 'catalogue'],
  join: ['broadsheet', 'frontispiece', 'dossier'],
  listen: ['frontispiece', 'programme', 'split'],
  dashboard: ['console', 'workbench'],
};

interface HeroCandidate {
  id: string;
  patternId: string;
  slot: string;
  directive: string;
}

const MATERIAL_HEROES: Readonly<Record<DesignMaterial, readonly HeroCandidate[]>> = {
  photo: [
    {
      id: 'plate-beside-claim',
      patternId: 'hero-split',
      slot: 'data-slot="hero"',
      directive:
        '58/42 asymmetric grid (`max-h-[740px]`): left holds the display headline + 1-sentence premise + primary CTA visible within `800px` height; right holds one real cropped photograph on `[data-slot="hero"]` with a factual caption.',
    },
    {
      id: 'editorial-front-plate',
      patternId: 'hero-editorial',
      slot: 'data-slot="hero"',
      directive:
        'Masthead rule + left-aligned display headline over a wide 16:9 photograph (`[data-slot="hero"]`, capped at `420px` tall so headline + primary action + photo top all clear the `800px` desktop fold).',
    },
    {
      id: 'diptych-ledger-open',
      patternId: 'hero-split',
      slot: 'data-slot="hero"',
      directive:
        'Primary vertical photograph (`[data-slot="hero"]`) anchored flush-left with headline, factual specs (hours/date/price), and single high-contrast CTA stacked on the right.',
    },
  ],
  product: [
    {
      id: 'live-artifact-first',
      patternId: 'hero-demo-first',
      slot: 'data-slot="artifact"',
      directive:
        'Headline (`<= 10` words) + single primary action + a real interactive control or copyable command/output surface in `[data-slot="artifact"]` within the first `800px` — NO fake 3-dot browser/OS window bar.',
    },
    {
      id: 'claim-beside-inspector',
      patternId: 'hero-claim-product-shot',
      slot: 'data-slot="artifact"',
      directive:
        'Left 5 columns: crisp operational headline, concrete metric/constraint line, and primary CTA; right 7 columns: live tabbed/stateful product surface in `[data-slot="artifact"]` using real domain records.',
    },
    {
      id: 'console-direct-entry',
      patternId: 'hero-demo-first',
      slot: 'data-slot="artifact"',
      directive:
        'Skip decorative hero chrome: open directly on a working toolbar + primary state summary + interactive preview table/canvas in `[data-slot="artifact"]` above the fold.',
    },
  ],
  words: [
    {
      id: 'typographic-manifesto',
      patternId: 'hero-editorial',
      slot: 'data-slot="specimen"',
      directive:
        'Display-scale left-aligned thesis (`clamp(2.5rem, 5vw, 4.75rem)`) + 2-column lead paragraph + inline primary action within `720px` height; zero stock illustrations or decorative blobs.',
    },
    {
      id: 'index-masthead-open',
      patternId: 'hero-editorial',
      slot: 'data-slot="specimen"',
      directive:
        'Ruled masthead with issue/edition facts, bold display statement, and an immediate 3-row factual ledger (`tabular-nums`) beside the primary CTA.',
    },
    {
      id: 'split-thesis-and-proof',
      patternId: 'hero-split',
      slot: 'data-slot="specimen"',
      directive:
        'Left column carries the headline and primary form/CTA; right column (`[data-slot="specimen"]`) prints a real excerpt, specification table, or sample issue toc on `bg-surface`.',
    },
  ],
};

const NAV_CANDIDATES: ReadonlyArray<{
  id: string;
  patternId: string;
  jobs?: readonly DesignJob[];
  directive: string;
}> = [
  {
    id: 'ruled-utility-bar',
    patternId: 'top-bar-nav',
    directive:
      'Single `56px` hairline-bottom bar: wordmark left, 3–4 plain text anchors center/right, and one action button matching the page job (no glass blur pill bar).',
  },
  {
    id: 'masthead-dateline',
    patternId: 'top-bar-nav',
    jobs: ['subscribe', 'attend', 'visit', 'listen', 'join'],
    directive:
      'Two-tier editorial masthead: compact dateline/location strip above a crisp wordmark + direct action link.',
  },
  {
    id: 'quiet-rail-header',
    patternId: 'top-bar-nav',
    jobs: ['hire', 'buy', 'book', 'try', 'sign-up'],
    directive:
      'Unboxed top row aligned to the page container grid: wordmark, 3 section jumps, and one high-contrast job CTA.',
  },
  {
    id: 'compact-app-rail',
    patternId: 'sidebar-nav',
    jobs: ['dashboard'],
    directive:
      '`240px` collapsible left rail (`sidebar-nav`) with grouped domain destinations, active state pill, and `⌘K` command trigger; collapses to a drawer below `1024px`.',
  },
];

const JOB_SECTIONS: Readonly<Record<DesignJob, readonly DesignDrawSection[]>> = {
  subscribe: [
    {
      title: 'Recent issues index',
      patternId: 'row-list',
      directive:
        'Numbered archive list (issue #, date in `tabular-nums`, title, reading time) with real hover state — not 3 equal cards.',
    },
    {
      title: 'Full sample excerpt',
      patternId: 'editorial-column',
      directive:
        '60–70ch reading column showing an actual excerpt from a representative dispatch so readers judge the prose before subscribing.',
    },
    {
      title: 'Inline subscription form',
      patternId: 'single-column-form',
      directive:
        'Real `<label>` + email input + cadence note + working submit state (`aria-live="polite"`), zero fake subscriber-count badges.',
    },
  ],
  book: [
    {
      title: 'Service & duration menu',
      patternId: 'row-list',
      directive:
        'Ruled list of bookable offerings with exact duration, price (`tabular-nums`), and preparation notes.',
    },
    {
      title: 'Availability & booking form',
      patternId: 'single-column-form',
      directive:
        'Concrete date/slot selector + party/project fields + explicit confirmation expectation.',
    },
    {
      title: 'Location, policy & FAQ',
      patternId: 'faq-accordion',
      directive:
        '2-column factual block: cancellation/arrival terms on the left, expandable operational questions on the right.',
    },
  ],
  visit: [
    {
      title: 'Hours, address & transit ledger',
      patternId: 'kpi-tiles',
      directive:
        'Immediate factual strip: today’s hours, street address + map link, kitchen/door cutoff, and phone.',
    },
    {
      title: 'Menu / seasonal bill of fare',
      patternId: 'row-list',
      directive:
        'Two-column typographic menu with prices aligned in `tabular-nums` — no bordered SaaS cards.',
    },
    {
      title: 'Room & material gallery',
      patternId: 'catalogue-grid',
      directive:
        'Asymmetric 2-plate photo pair (`[data-slot="card"]`) with short factual captions.',
    },
  ],
  attend: [
    {
      title: 'Timed programme / lineup',
      patternId: 'activity-timeline',
      directive:
        'Chronological schedule keyed by `tabular-nums` timestamps, speaker/artist names, and stage/room tags.',
    },
    {
      title: 'Pass tiers & inclusions',
      patternId: 'pricing-table',
      directive:
        '1–2 honest ticket classes with exact dates, venue capacity note, and direct registration CTA.',
    },
    {
      title: 'Venue & travel logistics',
      patternId: 'editorial-column',
      directive:
        'Concrete venue address, doors-open time, accessibility notes, and code-of-conduct link.',
    },
  ],
  buy: [
    {
      title: 'Product plate & variant selector',
      patternId: 'catalogue-grid',
      directive:
        '2- or 4-column product grid (never 3 identical feature cards) with real specs, finish/size options, and `tabular-nums` price.',
    },
    {
      title: 'Materials, dimensions & care table',
      patternId: 'data-table',
      directive:
        'Ruled specification table covering dimensions, materials, origin, and shipping lead time.',
    },
    {
      title: 'Checkout / bag summary bar',
      patternId: 'checkout-flow',
      directive: 'Clear shipping/returns terms beside a working quantity + add-to-bag control.',
    },
  ],
  try: [
    {
      title: 'Copyable install + real output diff',
      patternId: 'feature-tabbed',
      directive:
        'Package-manager / CLI command switcher with real copy button and concrete before/after terminal or file output.',
    },
    {
      title: 'Architecture & constraints matrix',
      patternId: 'data-table',
      directive:
        'Measured runtime footprints, supported targets, or API guarantees in a compact ruled table.',
    },
    {
      title: 'Step-by-step quickstart',
      patternId: 'editorial-column',
      directive:
        '3 numbered implementation steps with real code blocks — zero vague "blazing fast / seamless" adjectives.',
    },
  ],
  'sign-up': [
    {
      title: 'Workflow walkthrough by real task',
      patternId: 'feature-sticky-narrative',
      directive:
        '2 asymmetric task stages showing real domain inputs and resulting states, replacing generic 3-icon feature grids.',
    },
    {
      title: 'Transparent plan comparison',
      patternId: 'pricing-table',
      directive:
        '2 clear plans (or 1 base + usage table) with honest limits in `tabular-nums` and no artificial "Most Popular" ribbon.',
    },
    {
      title: 'Direct account / workspace start',
      patternId: 'auth-screen',
      directive:
        'Focused sign-up block with labeled email field, workspace slug preview, and explicit terms notice.',
    },
  ],
  hire: [
    {
      title: 'Selected work ledger',
      patternId: 'list-detail',
      directive:
        '3–5 numbered client/project engagements with year, scope, concrete outcome, and plate preview.',
    },
    {
      title: 'Engagement model & deliverables',
      patternId: 'data-table',
      directive:
        'Clear table of engagement shapes (sprint, retainer, audit), timeline, and exact artifacts delivered.',
    },
    {
      title: 'Project brief intake',
      patternId: 'single-column-form',
      directive:
        'Labeled inquiry form (scope, target window, budget band) or direct calendar/email dispatch.',
    },
  ],
  join: [
    {
      title: 'Charter & membership commitments',
      patternId: 'editorial-column',
      directive:
        'Numbered principles stating who the group is for, cadence, and what members contribute.',
    },
    {
      title: 'Upcoming calendar / cohort rhythm',
      patternId: 'activity-timeline',
      directive:
        'Concrete dates, sessions, or milestones in `tabular-nums` so prospective members see real activity.',
    },
    {
      title: 'Application / waitlist form',
      patternId: 'single-column-form',
      directive: '2–3 purposeful fields with real validation and honest response-time copy.',
    },
  ],
  listen: [
    {
      title: 'Playable tracklist / episode index',
      patternId: 'row-list',
      directive:
        'Numbered rows with play trigger, title, guest/notes, and `tabular-nums` duration (`mm:ss`).',
    },
    {
      title: 'Liner notes & transcript excerpt',
      patternId: 'editorial-column',
      directive:
        'Credits, recording metadata, and timestamped show notes in a readable 65ch column.',
    },
    {
      title: 'Feed & platform links',
      patternId: 'cta-band',
      directive:
        'Direct RSS URL copy control + plain text platform links without bloated badge walls.',
    },
  ],
  dashboard: [
    {
      title: 'Operational KPI strip',
      patternId: 'kpi-tiles',
      directive:
        '3–4 compact metric cells (`tabular-nums`) with period delta and semantic status text — never decorative sparklines without axes.',
    },
    {
      title: 'Primary filterable record table',
      patternId: 'data-table',
      directive:
        'Toolbar with search + status filter + dense `data-table` with empty/loading/error states handled.',
    },
    {
      title: 'Inspector / activity drawer',
      patternId: 'activity-timeline',
      directive:
        'Right-hand detail summary or chronological audit log scoped to the selected record.',
    },
  ],
};

const FOOTER_CANDIDATES: ReadonlyArray<{
  id: string;
  patternId: string;
  directive: string;
}> = [
  {
    id: 'colophon-line',
    patternId: 'site-footer',
    directive:
      'Single ruled colophon row: edition/year, contact link, and 3 essential legal/archive links (skip bloated 4-column link farms).',
  },
  {
    id: 'two-column-index-footer',
    patternId: 'site-footer',
    directive:
      'Asymmetric 2-column footer: brief factual colophon + address/status on the left, compact 2-group directory on the right.',
  },
];

const OVERUSED_COMPOSITIONS = [
  'Centered pill eyebrow badge → H1 with one accented/italic word → twin pill buttons → 3 equal icon-in-circle feature cards.',
  'Fake macOS/browser traffic-light window chrome (`#ff5f56 / #ffbd2e / #27c93f`) wrapping a static screenshot or mock code block.',
  '4-column footer link farm of `href="#"` placeholders below a generic "Ready to get started?" gradient banner.',
  'Fabricated "+10,000 happy teams", "99.99% uptime", or invented 3-person avatar testimonial strip.',
  '3-tier pricing grid with a glowing "Most Popular" middle card when the product only has one action.',
] as const;

function drawHistoryFile(projectRoot: string): string {
  return path.join(resolveWstackPaths({ projectRoot }).configDir, 'design-draws.json');
}

export async function readDesignDrawHistory(
  projectRoot: string,
): Promise<DesignDrawHistoryEntry[]> {
  try {
    const raw = JSON.parse(
      (await fs.readFile(drawHistoryFile(projectRoot), 'utf8')).replace(/^\uFEFF/, ''),
    ) as unknown;
    return Array.isArray(raw)
      ? raw.filter(
          (e): e is DesignDrawHistoryEntry =>
            !!e && typeof (e as DesignDrawHistoryEntry).macroId === 'string',
        )
      : [];
  } catch {
    return [];
  }
}

export async function recordDesignDraw(
  projectRoot: string,
  entry: Omit<DesignDrawHistoryEntry, 'project' | 'at'>,
): Promise<void> {
  try {
    const history = await readDesignDrawHistory(projectRoot);
    history.push({
      ...entry,
      project: path.basename(path.resolve(projectRoot)),
      at: new Date().toISOString(),
    });
    const file = drawHistoryFile(projectRoot);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(history.slice(-DRAW_HISTORY_LIMIT), null, 2)}\n`);
  } catch {
    // Advisory history — never fail a draw on read-only filesystems.
  }
}

/**
 * Pure, deterministic page-anatomy dealer. Same `{ seed, job, material }`
 * produces the exact same draw.
 */
export function drawDesignAnatomy(opts: {
  seed: string;
  job: DesignJob;
  material: DesignMaterial;
  recentMacros?: readonly string[];
  kitPictured?: string | undefined;
}): DesignDrawResult {
  const next = rng(`${opts.seed}:${opts.job}:${opts.material}`);
  const recentSet = new Set((opts.recentMacros ?? []).slice(0, RECENT_MACRO_EXCLUDE));

  // If the active kit's specimen pictures a known macro keyword, bias away from it
  // so kits provide material rather than cloning their specimen layout.
  const picturedLower = opts.kitPictured?.toLowerCase();
  const candidateIds = JOB_MACROS[opts.job];
  const unexcluded = candidateIds.filter((id) => {
    if (recentSet.has(id)) return false;
    if (picturedLower?.includes(id)) return false;
    return true;
  });
  const macroPool = unexcluded.length > 0 ? unexcluded : candidateIds;
  const macroId = pickOne(macroPool, next);
  const macrostructure =
    MACROSTRUCTURES[macroId] ?? (MACROSTRUCTURES['frontispiece'] as DesignMacrostructure);

  // Dashboard overrides hero to console-direct-entry when material is product.
  const heroPool =
    opts.job === 'dashboard' && opts.material === 'product'
      ? [MATERIAL_HEROES.product[2]!, MATERIAL_HEROES.product[1]!]
      : MATERIAL_HEROES[opts.material];
  const hero = pickOne(heroPool, next);

  const jobNavs = NAV_CANDIDATES.filter((n) => n.jobs?.includes(opts.job));
  const navPool =
    opts.job === 'dashboard' ? jobNavs : [...jobNavs, ...NAV_CANDIDATES.filter((n) => !n.jobs)];
  const chosenNav = pickOne(navPool.length > 0 ? navPool : NAV_CANDIDATES, next);

  const sections = [...JOB_SECTIONS[opts.job]];
  const footer = pickOne(FOOTER_CANDIDATES, next);

  const shuffledSkips = shuffleWith(OVERUSED_COMPOSITIONS, next).slice(0, 2);
  const skip = opts.kitPictured
    ? [
        `Do not copy the active kit specimen’s own subject/layout (${opts.kitPictured}); keep its paper, ink, and type rules only.`,
        ...shuffledSkips,
      ]
    : shuffledSkips;

  return {
    seed: opts.seed,
    job: opts.job,
    material: opts.material,
    macrostructure,
    hero,
    nav: {
      id: chosenNav.id,
      patternId: chosenNav.patternId,
      directive: chosenNav.directive,
    },
    sections,
    footer,
    skip,
    excludedMacros: [...recentSet].filter((id) => id !== macroId),
  };
}

type DrawCtx = { meta: Record<string, unknown>; projectRoot: string };

export function getDesignDraw(ctx: Pick<DrawCtx, 'meta'>): DesignDrawResult | undefined {
  return ctx.meta[DRAW_KEY] as DesignDrawResult | undefined;
}

export async function ensureDesignDraw(
  ctx: DrawCtx,
  opts: {
    job: DesignJob;
    material: DesignMaterial;
    seed?: string | undefined;
    redeal?: boolean | undefined;
    kitPictured?: string | undefined;
  },
): Promise<DesignDrawResult> {
  const existing = getDesignDraw(ctx);
  if (
    existing &&
    !opts.redeal &&
    !opts.seed &&
    existing.job === opts.job &&
    existing.material === opts.material
  ) {
    return existing;
  }
  const count = (Number(ctx.meta[`${DRAW_KEY}Count`]) || 0) + 1;
  ctx.meta[`${DRAW_KEY}Count`] = count;
  const seed =
    opts.seed ??
    `${path.basename(path.resolve(ctx.projectRoot))}-draw-${Date.now().toString(36)}-${count}`;
  const history = await readDesignDrawHistory(ctx.projectRoot);
  const recentMacros: string[] = [];
  for (let i = history.length - 1; i >= 0 && recentMacros.length < RECENT_MACRO_EXCLUDE; i--) {
    const macroId = history[i]?.macroId;
    if (macroId && !recentMacros.includes(macroId)) recentMacros.push(macroId);
  }
  const result = drawDesignAnatomy({
    seed,
    job: opts.job,
    material: opts.material,
    recentMacros,
    kitPictured: opts.kitPictured,
  });
  ctx.meta[DRAW_KEY] = result;
  await recordDesignDraw(ctx.projectRoot, {
    seed: result.seed,
    job: result.job,
    material: result.material,
    macroId: result.macrostructure.id,
    heroId: result.hero.id,
  });
  return result;
}

export function renderDesignDraw(draw: DesignDrawResult): string {
  const excl = draw.excludedMacros.length
    ? `; skipped recent macrostructures: ${draw.excludedMacros.join(', ')}`
    : '';
  return [
    `# Page anatomy draw (seed "${draw.seed}" — job: ${draw.job}, material: ${draw.material}${excl})`,
    '',
    `- **Macrostructure**: \`${draw.macrostructure.id}\` (${draw.macrostructure.label} · pattern \`${draw.macrostructure.shellPattern}\`) — ${draw.macrostructure.summary}`,
    `- **Navigation**: \`${draw.nav.id}\` (pattern \`${draw.nav.patternId}\`) — ${draw.nav.directive}`,
    `- **Opening / Hero**: \`${draw.hero.id}\` (pattern \`${draw.hero.patternId}\`, slot \`[${draw.hero.slot}]\`) — ${draw.hero.directive}`,
    '',
    '## Body sections (job-native — build only sections backed by real facts)',
    ...draw.sections.map(
      (s, idx) => `${idx + 1}. **${s.title}** (pattern \`${s.patternId}\`) — ${s.directive}`,
    ),
    '',
    `- **Footer**: \`${draw.footer.id}\` (pattern \`${draw.footer.patternId}\`) — ${draw.footer.directive}`,
    '',
    '## Skip on this build',
    ...draw.skip.map((line) => `- ${line}`),
    '',
    'Gate: verify the hero at `1280×800` (`design_reference {action:"inspect", stage:"hero", ...}`) before writing the rest of the page so the headline + primary CTA clear the desktop fold.',
  ].join('\n');
}

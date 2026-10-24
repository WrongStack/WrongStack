/**
 * Design Studio — curated frontend/mobile UI design kits.
 *
 * A "design kit" is a self-contained, selectable design direction (an aesthetic
 * + concrete design tokens + per-stack implementation guidance) that the model
 * commits to BEFORE writing UI code. Kits are surfaced progressively: a compact
 * menu is injected when frontend work is detected, and the heavy kit body is
 * only loaded once the model (or user) picks one — keeping per-turn tokens low.
 *
 * This mirrors the skills subsystem (`types/skill.ts` + `execution/skill-loader.ts`)
 * but adds the per-stack body selection and a token snapshot for visual pickers.
 */

/** Target implementation stacks a kit can speak to. */
export const DESIGN_STACKS = ['web', 'react-native', 'flutter', 'swiftui', 'compose'] as const;

export type DesignStack = (typeof DESIGN_STACKS)[number];

export function isDesignStack(v: string): v is DesignStack {
  return (DESIGN_STACKS as readonly string[]).includes(v);
}

export interface DesignKitManifest {
  id: string;
  name: string;
  /** One-line vibe shown in the menu, e.g. "Restrained, Linear-style minimalism". */
  aesthetic: string;
  /** Free-form tags for filtering. */
  tags: string[];
  /** Stacks this kit provides guidance for. */
  stacks: DesignStack[];
  /** Whether the kit ships light + dark themes (almost always true). */
  themes: string[];
  /** "Best for…" one-liner used in menu + pickers. */
  bestFor: string;
  version?: string | undefined;
  path: string;
  source: 'project' | 'user' | 'bundled';
}

/** A single theme's concrete token values (OKLCH strings, font names, etc.). */
export interface DesignTokenSet {
  [token: string]: string;
}

/**
 * The kind of value a token holds, inferred from its string form. Materialize
 * and verify branch on this so non-color axes (radius, spacing, type, motion)
 * are handled correctly — not just colors. See `classifyTokenValue`.
 */
export type TokenValueKind =
  | 'color' // oklch(...) / #hex
  | 'length' // 12px, 0.75rem, 100%, 2em
  | 'duration' // 150ms, 0.2s
  | 'number' // bare numeric (unitless scale/weight/line-height)
  | 'font' // font-family stack
  | 'shadow' // box-shadow definition (offset/blur/color …)
  | 'gradient' // linear-/radial-gradient(...)
  | 'raw'; // anything else (kept verbatim)

/**
 * Recognized token groups by kebab-scale prefix. A kit's `tokens.json` stays a
 * FLAT string map (backward compatible); richness comes from populating these
 * scale keys. `_foundations/tokens.json` supplies defaults that kits override
 * per-axis. CSS materialization maps each group to a Tailwind v4 `@theme`
 * namespace so utilities (`rounded-lg`, `p-4`, `text-base`, `shadow-2`) resolve
 * to the kit.
 *
 * Dot (`.`) is reserved for theme-scoping (`light.`/`dark.`) in overrides, so
 * scale token names use kebab (`radius-lg`, not `radius.lg`).
 */
export const KNOWN_TOKEN_GROUPS = {
  /** Corner radii. */
  radius: ['radius-none', 'radius-sm', 'radius-md', 'radius-lg', 'radius-xl', 'radius-full'],
  /** Spacing scale (4/8px rhythm). */
  space: ['space-1', 'space-2', 'space-3', 'space-4', 'space-6', 'space-8', 'space-12'],
  /** Type sizes. */
  text: ['text-xs', 'text-sm', 'text-base', 'text-lg', 'text-xl', 'text-2xl', 'text-3xl'],
  /** Line-heights (unitless). */
  leading: ['leading-tight', 'leading-normal', 'leading-relaxed'],
  /** Font weights (unitless). */
  weight: ['weight-normal', 'weight-medium', 'weight-semibold', 'weight-bold'],
  /** Letter-spacing. */
  tracking: ['tracking-tight', 'tracking-normal', 'tracking-wide'],
  /** Elevation / shadow ramp. */
  shadow: ['shadow-1', 'shadow-2', 'shadow-3', 'shadow-4'],
  /** Border widths. */
  border: ['border-hairline', 'border-thin', 'border-thick'],
  /** Motion durations. */
  duration: ['duration-fast', 'duration-base', 'duration-slow'],
  /** Motion easings. */
  ease: ['ease-standard', 'ease-emphasized'],
  /** Font families. */
  font: ['font-sans', 'font-mono', 'font-display'],
} as const;

/** Flat list of every known scale token name across all groups. */
export const KNOWN_TOKEN_NAMES: readonly string[] = Object.values(KNOWN_TOKEN_GROUPS).flat();

/** Parsed `tokens.json` — light + dark token snapshots used by visual pickers. */
export interface DesignKitTokens {
  light?: DesignTokenSet | undefined;
  dark?: DesignTokenSet | undefined;
}

/** A kit directory that failed to load — surfaced as authoring feedback. */
export interface SkippedKitInfo {
  /** Directory name under its discovery layer. */
  dir: string;
  source: DesignKitManifest['source'];
  /** Why it was skipped (shown in `design list` and the /design picker). */
  reason: string;
}

/** Compact menu entry rendered into the request when frontend work is detected. */
export interface DesignKitEntry {
  id: string;
  name: string;
  aesthetic: string;
  bestFor: string;
  stacks: DesignStack[];
  source: DesignKitManifest['source'];
}

/**
 * Live Design Studio state stashed on `ctx.meta.designStudio`. Set by the
 * detection middleware (user intent + frontend file writes); read by the
 * request middleware that injects the menu / active-kit reminder.
 */
export interface DesignStudioState {
  /** True once frontend/UI work has been detected this session. */
  active: boolean;
  /** Detected target stack, if any. */
  stack?: DesignStack | undefined;
  /** What triggered activation (for transparency / debugging). */
  signals: string[];
  /** Kit id the model/user committed to, if any. */
  activeKit?: string | undefined;
  /**
   * User color/token overrides applied over the active kit's tokens. Keys are
   * token names (`primary`) applied to both themes, or theme-scoped
   * (`light.bg`/`dark.bg`). See `applyTokenOverrides`.
   */
  overrides?: Record<string, string> | undefined;
}

export interface DesignKitLoader {
  list(): Promise<DesignKitManifest[]>;
  /** Structured entries for the compact menu. */
  listEntries(): Promise<DesignKitEntry[]>;
  /** Kit directories that failed to load (authoring feedback), if any. */
  listSkipped(): Promise<SkippedKitInfo[]>;
  find(id: string): Promise<DesignKitManifest | undefined>;
  /** Compact, model-facing menu of every available kit. */
  menuText(): Promise<string>;
  /**
   * Full kit body for a given stack. Strips frontmatter and, when `stack` is
   * provided, narrows stack-specific sections to that stack.
   */
  readBody(id: string, stack?: DesignStack | undefined): Promise<string>;
  /** Parsed `tokens.json` for a kit (light/dark snapshots), if present. */
  readTokens(id: string): Promise<DesignKitTokens | undefined>;
  /** The mandatory cross-cutting baseline (responsive / a11y / theming / motion). */
  foundationsText(stack?: DesignStack | undefined): Promise<string>;
  invalidateCache(): void;
}

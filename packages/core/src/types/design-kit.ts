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

/** Parsed `tokens.json` — light + dark token snapshots used by visual pickers. */
export interface DesignKitTokens {
  light?: DesignTokenSet | undefined;
  dark?: DesignTokenSet | undefined;
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

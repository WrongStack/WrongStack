/**
 * Prompt library types — the canonical home for the prompt data model and the
 * loader/registry contracts. Has no internal dependencies so both `storage/`
 * (the writable store) and `execution/` (the layered loader) can import it
 * without creating a cycle.
 */

/** Provenance of a prompt — which layer it came from. */
export type PromptSource = 'builtin' | 'user' | 'project' | 'synced';

/**
 * The fourteen first-party categories shipped with the builtin dataset, plus
 * the `uncategorized` sentinel used when migrating legacy v1 entries. Builtin
 * prompts MUST use one of these (enforced by the dataset schema test); user and
 * project prompts may use any free-form string.
 */
export const BUILTIN_PROMPT_CATEGORIES = [
  'coding',
  'debugging',
  'refactoring',
  'testing',
  'code-review',
  'architecture',
  'performance',
  'devops',
  'documentation',
  'data-analysis',
  'writing',
  'research',
  'product',
  'agentic-workflows',
  'meta-prompting',
  'uncategorized',
] as const;

export type BuiltinPromptCategory = (typeof BUILTIN_PROMPT_CATEGORIES)[number];

/**
 * Human-readable labels for the builtin categories (for UI chips / pickers).
 */
export const PROMPT_CATEGORY_LABELS: Record<BuiltinPromptCategory, string> = {
  coding: 'Coding',
  debugging: 'Debugging',
  refactoring: 'Refactoring',
  testing: 'Testing',
  'code-review': 'Code Review',
  architecture: 'Architecture',
  performance: 'Performance',
  devops: 'DevOps',
  documentation: 'Documentation',
  'data-analysis': 'Data Analysis',
  writing: 'Writing',
  research: 'Research',
  product: 'Product',
  'agentic-workflows': 'Agentic Workflows',
  'meta-prompting': 'Meta-Prompting',
  uncategorized: 'Uncategorized',
};

/**
 * A prompt's category. Typed as a free-form string because user/project prompts
 * may invent their own; the builtin dataset is constrained to
 * {@link BUILTIN_PROMPT_CATEGORIES} by its schema.
 */
export type PromptCategory = BuiltinPromptCategory | (string & {});

export function isBuiltinCategory(value: string): value is BuiltinPromptCategory {
  return (BUILTIN_PROMPT_CATEGORIES as readonly string[]).includes(value);
}

/** A `{{name}}` placeholder declared by a prompt. */
export interface PromptVariable {
  /** Placeholder name as it appears between `{{ }}` (case-sensitive). */
  name: string;
  description?: string | undefined;
  default?: string | undefined;
  required?: boolean | undefined;
  /**
   * Closed set of allowed values. When present, surfaces render a dropdown
   * instead of a free text field and a supplied value outside the set is
   * reported as invalid by {@link renderPrompt}.
   */
  enum?: string[] | undefined;
  /**
   * UI hint: the value is expected to span multiple lines (pasted code, a
   * diff, a long passage). Surfaces render a textarea instead of a one-line
   * input. Has no effect on rendering — purely presentational.
   */
  multiline?: boolean | undefined;
}

/**
 * A reusable prompt. v2 schema. Legacy v1 entries (only `id/title/content/tags/
 * createdAt/updatedAt`) are upgraded lazily on read by `migratePromptEntry`.
 */
export interface PromptEntry {
  /** Stable unique handle (ULID for new entries; legacy short hex tolerated). */
  id: string;
  /** kebab-case stable key — the dedup key across layers and registry key. */
  slug: string;
  title: string;
  /** One-line summary shown in lists/pickers. */
  description: string;
  content: string;
  category: PromptCategory;
  /** Secondary facets (free-form). */
  tags: string[];
  source: PromptSource;
  favorite: boolean;
  /** `{{placeholder}}` variables this prompt expects, if any. */
  variables?: PromptVariable[] | undefined;
  author?: string | undefined;
  version?: string | undefined;
  license?: string | undefined;
  /** sha256 of `content` — set for builtin/synced entries for integrity. */
  checksum?: string | undefined;
  /** When a builtin was copy-on-written into the user layer, its origin slug. */
  forkedFrom?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

/** One category with its prompt count, for picker chips. */
export interface PromptCategoryCount {
  id: PromptCategory;
  label: string;
  count: number;
}

export interface PromptSearchOptions {
  category?: PromptCategory | undefined;
  /** Max results (default: unbounded). */
  limit?: number | undefined;
}

/**
 * Read-side contract over the three prompt layers (project > user > builtin),
 * merged and de-duplicated by slug. Mirrors `SkillLoader` in shape.
 */
export interface PromptLoader {
  /** All prompts across layers, project/user shadowing builtin by slug. */
  list(): Promise<PromptEntry[]>;
  /** Resolve by slug first, then by id. */
  find(slugOrId: string): Promise<PromptEntry | undefined>;
  /** Ranked search over title/description/content/tags, optional category filter. */
  search(query: string, opts?: PromptSearchOptions): Promise<PromptEntry[]>;
  /** Category counts across all layers, for UI chips. */
  categories(): Promise<PromptCategoryCount[]>;
  /**
   * Persist into the writable (user, or project when `scope:'project'`) layer.
   * Throws if the resolved target is the read-only builtin layer.
   */
  save(entry: PromptEntry, opts?: { scope?: 'user' | 'project' }): Promise<void>;
  /** Delete from a writable layer. Returns false if not found / builtin. */
  delete(slugOrId: string): Promise<boolean>;
  /**
   * Mark/unmark a prompt as favorite. Favoriting a builtin copies it down into
   * the user layer (copy-on-write, `source:'user'`, `forkedFrom:<slug>`).
   */
  setFavorite(slugOrId: string, favorite: boolean): Promise<PromptEntry | undefined>;
  /** Clear the internal cache so the next read re-scans disk. */
  invalidateCache(): void;
}

/**
 * The packed builtin index (also the shape a remote registry manifest mirrors
 * — see `types/prompt-registry.ts`).
 */
export interface PromptManifest {
  datasetVersion: number;
  generatedAt: string;
  count: number;
  categories: PromptCategoryCount[];
  prompts: PromptManifestRef[];
}

export interface PromptManifestRef {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: PromptCategory;
  tags: string[];
  checksum: string;
  /** Relative path of the per-prompt file within the dataset. */
  file: string;
}

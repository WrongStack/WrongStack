export interface SkillManifest {
  name: string;
  description: string;
  /**
   * Optional explicit "Use when…" trigger from frontmatter. When present it is
   * used verbatim as the SkillEntry trigger; otherwise the trigger falls back
   * to the first sentence of `description` (see parseDescriptionFromText).
   */
  trigger?: string | undefined;
  version?: string | undefined;
  /** agentskills.io optional frontmatter fields. */
  license?: string | undefined;
  compatibility?: string | undefined;
  metadata?: Record<string, string> | undefined;
  /**
   * agentskills.io `allowed-tools`. INFORMATIONAL ONLY — parsed from frontmatter
   * and surfaced for display, but never enforced: the `skill` tool has fixed
   * permissions/capabilities and does not consult this field, so it neither
   * grants nor restricts any tool.
   */
  allowedTools?: string[] | undefined;
  path: string;
  /**
   * Discovery layer the skill came from. `claude-*`, `foreign`, and `extra` are
   * read-only foreign sources (other coding agents' dirs, or
   * `config.skills.extraDirs`); they are never written to by the skill installer.
   */
  source: 'project' | 'user' | 'bundled' | 'claude-project' | 'claude-user' | 'extra' | 'foreign';
  /** For `foreign` sources: the originating tool id (codex, cursor, agents, …). */
  originTool?: string | undefined;
}

/** Parsed skill entry for structured rendering in system prompt. */
export interface SkillEntry {
  name: string;
  /** "Use when..." trigger condition — one-liner */
  trigger: string;
  /** Comma-separated scope items */
  scope: string[];
  source: SkillManifest['source'];
  /** For `foreign` sources: the originating tool id. */
  originTool?: string | undefined;
  path: string;
}

/**
 * A skill directory that was discovered but rejected during `list()`. Surfaced
 * via {@link SkillLoader.diagnostics} so a skill that silently fails to load
 * (missing name/description, malformed name) is diagnosable instead of simply
 * vanishing from the available-skills list.
 */
export interface SkippedSkill {
  /** Absolute directory that contained the rejected `SKILL.md`. */
  dir: string;
  /** Directory entry name (the folder name under a skills root). */
  entry: string;
  /** Why the skill was rejected. */
  reason: 'missing-name' | 'missing-description' | 'invalid-name-format';
  /** The parsed `name` when one was present (absent for `missing-name`). */
  name?: string | undefined;
}

/**
 * A skill that was excluded because a higher-priority discovery layer already
 * claimed the same name. The canonical case is a project-local skill shadowing
 * a maintained bundled skill. Surfaced via {@link SkillLoader.diagnostics}.
 */
export interface ShadowedSkill {
  name: string;
  /** Discovery layer of the shadowed (hidden) skill. */
  source: SkillManifest['source'];
  /** Path to the shadowed skill's `SKILL.md`. */
  path: string;
  /** Discovery layer that claimed the name first (won the shadow). */
  shadowedBy: SkillManifest['source'] | 'unknown';
  /** Path to the winning skill's `SKILL.md`, when known. */
  shadowedByPath?: string | undefined;
}

/** Load-time diagnostics collected during {@link SkillLoader.list}. */
export interface SkillLoaderDiagnostics {
  skipped: SkippedSkill[];
  shadowed: ShadowedSkill[];
}

export interface SkillLoader {
  list(): Promise<SkillManifest[]>;
  /** Structured entries with trigger/scope for system prompt rendering. */
  listEntries(): Promise<SkillEntry[]>;
  find(name: string): Promise<SkillManifest | undefined>;
  manifestText(): Promise<string>;
  readBody(name: string): Promise<string>;
  /**
   * Read the token-saving compact variant of a skill body.
   * Tries `SKILL.save.md` first (hand-crafted compact version), falls back
   * to auto-compacting the full `SKILL.md` body.
   */
  readSaveBody(name: string): Promise<string>;
  /** Clear the internal cache so the next list/find re-reads from disk. */
  invalidateCache(): void;
  /**
   * Load-time diagnostics from the most recent full `list()` scan: skills that
   * were skipped as malformed and skills shadowed by a higher-priority layer.
   * Optional so lightweight/mock loaders need not implement it; callers must
   * feature-detect (`loader.diagnostics?.()`).
   */
  diagnostics?(): SkillLoaderDiagnostics;
}

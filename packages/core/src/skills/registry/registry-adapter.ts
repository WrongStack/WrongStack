/**
 * Skill registry adapter contract.
 *
 * A registry is a searchable catalog of skills that resolves to a concrete
 * install target (a GitHub `user/repo[@ref]`). Two adapters ship out of the
 * box:
 *
 *   - `githubDirectAdapter`  — no search; `user/repo` is typed directly. This
 *                              is the original pre-registry install path.
 *   - `skillsShAdapter`     — searches the skills.sh marketplace
 *                              (https://skills.sh/api/skills), which indexes
 *                              34k+ skills from 2.8k+ repos and computes a
 *                              per-skill security score (0–100).
 *
 * The adapter layer keeps the installer registry-agnostic: it asks each
 * adapter to resolve a `<adapterId>:<registryId>` ref to a `user/repo@ref`
 * and reuses the existing GitHub tarball path. New registries (an internal
 * company hub, ags, …) are added by implementing this interface and passing
 * them to the `SkillInstaller`.
 */

/**
 * One hit from a registry search. Fields are optional where the underlying
 * registry doesn't guarantee them — every adapter normalizes to this shape.
 */
export interface RegistrySkillSummary {
  /** Registry-native id (used as `<adapterId>:<id>` in `/skill-install`). */
  id: string;
  /** Skill name (kebab-case, as it will appear once installed). */
  name: string;
  /** Short description / trigger line. */
  description: string;
  /** Author / owner (often the GitHub owner). */
  author?: string | undefined;
  /** Install count, if the registry reports it. */
  installs?: number | undefined;
  /** Star count, if the registry reports it. */
  stars?: number | undefined;
  /**
   * Security score 0–100 (skills.sh computes this; ags uses the same scale).
   * Lower = riskier. Below 30 the install command prompts for confirmation.
   */
  securityScore?: number | undefined;
  /** ISO timestamp of the skill's last update, if known. */
  updatedAt?: string | undefined;
  /**
   * The `user/repo[@ref]` the installer passes to `downloadGitHubTarball`.
   * Always present for real registry hits — it's the whole point of resolving.
   */
  installRef: string;
}

export interface RegistrySearchOptions {
  /** 1-indexed page (default 1). */
  page?: number | undefined;
  /** Page size (default 20; registries may cap this). */
  pageSize?: number | undefined;
}

export interface RegistrySearchResult {
  /** Which adapter produced these results. */
  adapterId: string;
  results: RegistrySkillSummary[];
  /** True when the registry indicates more pages exist. */
  hasMore?: boolean | undefined;
}

/**
 * A searchable skill catalog that resolves to a GitHub install target.
 *
 * `search` is optional in spirit (the github-direct adapter doesn't search),
 * but the interface requires it so callers can fan out uniformly — adapters
 * that can't search simply return `[]`.
 */
export interface SkillRegistryAdapter {
  /** Stable id used in `<adapterId>:<registryId>` refs (e.g. `'skills.sh'`). */
  readonly id: string;
  /** Human label for UI (e.g. `'skills.sh'`). */
  readonly displayName: string;
  /** Search the catalog. Return `[]` if the adapter doesn't support search. */
  search(query: string, opts?: RegistrySearchOptions): Promise<RegistrySearchResult>;
  /**
   * Resolve a registry-native id to a `user/repo[@ref]` install ref. Should
   * validate the id shape and throw on an id this adapter can't resolve.
   */
  resolveInstallRef(registryId: string): string;
}

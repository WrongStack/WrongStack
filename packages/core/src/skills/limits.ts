/**
 * Centralized skill system limits.
 *
 * Before this file existed, the magic numbers below were scattered across five
 * modules (`skill-installer`, `github-fetcher`, `skill` tool, system-prompt
 * builder, skill-loader), sometimes duplicated (e.g. per-skill body cap was
 * defined independently in the builder and the tool). Centralizing them here
 * keeps the budget model coherent — change one, change everywhere — and makes
 * the trade-offs visible in one place.
 *
 * Values are frozen at their pre-centralization defaults so this is a pure
 * refactor (no behavior change).
 */
export const SKILL_LIMITS = {
  /**
   * Per-skill body cap when injecting a full skill body into the system prompt
   * (eager mode), and when returning a skill body from the `skill` tool.
   * ~4k tokens. Oversized bodies are truncated at a paragraph boundary.
   *
   * Consumers: `system-prompt-builder.capSkillBody`, `skill` tool body return.
   */
  MAX_SKILL_BODY_CHARS: 16_000,

  /**
   * Per-resource cap when the `skill` tool loads a bundled file
   * (`scripts/`, `references/`, `assets/`). ~8k tokens.
   *
   * Consumer: `skill` tool `loadResource`.
   */
  MAX_RESOURCE_CHARS: 32_000,

  /**
   * Maximum number of bundled resource paths the `skill` tool lists in one
   * response. Caps a pathological skill (huge `assets/` tree) from blowing up
   * the tool result.
   *
   * Consumer: `skill` tool resource listing.
   */
  MAX_LISTED_RESOURCES: 100,

  /**
   * Max size of a single installed skill file (SKILL.md or a bundled resource).
   * Guards against a malicious registry skill shipping a multi-MB blob that
   * then flows into the prompt. 100KB.
   *
   * Consumer: `SkillInstaller.install` / `importFromDir`.
   */
  MAX_SKILL_FILE_SIZE: 100 * 1024,

  /**
   * Max size of a GitHub tarball downloaded by the skill installer. Guards
   * against a repo accidentally (or maliciously) shipping a giant tarball that
   * would be extracted into a temp dir. 50MB.
   *
   * Consumer: `downloadGitHubTarball`.
   */
  MAX_TARBALL_SIZE: 50 * 1024 * 1024,

  /**
   * Default total char budget for skill bodies injected in eager mode when
   * `config.skills.eagerMaxChars` is unset. ~6k tokens. Skills are injected
   * highest-priority first; once the budget is exhausted the remaining skills
   * are listed as a manifest the agent loads via the `skill` tool. Set very
   * high to effectively disable budgeting.
   *
   * Consumer: `DefaultSystemPromptBuilder.buildMemoryAndSkills` (default for
   * `skillEagerMaxChars`).
   */
  EAGER_DEFAULT_MAX_CHARS: 24_000,

  /**
   * Auto-compact body limits (the token-saving fallback used when a skill has
   * no hand-crafted `SKILL.save.md`). The Overview and Rules sections are
   * extracted and trimmed to these char budgets, then the total is capped.
   *
   * Consumer: `DefaultSkillLoader.compactSkillBody`.
   */
  COMPACT_OVERVIEW_MAX: 200,
  COMPACT_RULES_MAX: 350,
  COMPACT_TOTAL_MAX: 450,

  /**
   * Max length of a skill name (agentskills.io spec). Enforced by the
   * frontmatter validator's format regex plus this length bound.
   *
   * Consumer: `isValidSkillNameFormat`.
   */
  SKILL_NAME_MAX_LEN: 64,

  /**
   * Soft line limit for a SKILL.md body, per the bundled `skill-creator` rule.
   * Not enforced in code (a skill can exceed it) — surfaced by `/skill-gen
   * validate` and the `skill-creator` skill as guidance to move deep material
   * into `references/`.
   *
   * Consumer: `skill-creator` skill, `/skill-gen validate` advisory.
   */
  SKILL_BODY_LINE_LIMIT: 500,
} as const;

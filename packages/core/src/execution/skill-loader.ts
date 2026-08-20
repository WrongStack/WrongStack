import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { FOREIGN_SKILL_TOOLS, resolveForeignToolIds } from '../skills/foreign-sources.js';
import {
  isValidSkillNameFormat,
  parseSkillFrontmatter,
  stripFrontmatter,
} from '../skills/frontmatter.js';
import { SKILL_LIMITS } from '../skills/limits.js';
import type {
  ShadowedSkill,
  SkillEntry,
  SkillLoader,
  SkillLoaderDiagnostics,
  SkillManifest,
  SkippedSkill,
} from '../types/skill.js';
import type { WstackPaths } from '../utils/wstack-paths.js';

/**
 * Compact a full skill body for token-saving fallback.
 * Extracts the Overview and Rules sections, trims to the compact budget.
 */
function compactSkillBody(body: string): string {
  const sections: string[] = [];
  const overviewMatch = body.match(/##\s*Overview\s*\n([\s\S]*?)(?=\n##|\n$|$)/i);
  const overview = overviewMatch?.[1];
  if (overview?.trim()) {
    sections.push(overview.trim().slice(0, SKILL_LIMITS.COMPACT_OVERVIEW_MAX));
  }
  const rulesMatch = body.match(/##\s*Rules\s*\n([\s\S]*?)(?=\n##|\n$|$)/i);
  const rules = rulesMatch?.[1];
  if (rules?.trim()) {
    const trimmed = rules.trim().slice(0, SKILL_LIMITS.COMPACT_RULES_MAX);
    const ruleLines = trimmed
      .split('\n')
      .filter((l) => /^\s*[-*]\s/.test(l) || /^\s*\d+[.)]\s/.test(l))
      .slice(0, 6)
      .join('\n');
    if (ruleLines) sections.push(ruleLines);
  }
  if (sections.length === 0) {
    const first = body.trim().slice(0, SKILL_LIMITS.COMPACT_OVERVIEW_MAX);
    if (first) sections.push(first);
  }
  const result = sections.join('\n\n');
  const total = SKILL_LIMITS.COMPACT_TOTAL_MAX;
  return result.length > total ? result.slice(0, total - 3) + '…' : result;
}

/**
 * True if `entry` is a directory, following symlinks. `Dirent.isDirectory()`
 * is lstat-based and returns false for a symlink — but Claude Code and other
 * agents commonly symlink skill dirs (e.g. `~/.claude/skills/foo` →
 * `~/.agents/skills/foo`), so we stat the target for symlink entries.
 */
async function entryIsDirectory(dir: string, entry: import('node:fs').Dirent): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (entry.isSymbolicLink()) {
    try {
      return (await fs.stat(path.join(dir, entry.name))).isDirectory();
    } catch {
      return false; // broken symlink
    }
  }
  return false;
}

export interface SkillLoaderOptions {
  paths: WstackPaths;
  bundledDir?: string | undefined;
  /** Read foreign `.claude/skills` dirs (project + user). Default `true`. */
  readClaudeSkills?: boolean | undefined;
  /** Scan other agents' skill dirs (codex/cursor/agents/qwen/trae/…). Default `true` (all); `string[]` restricts, `false` disables. */
  foreignSources?: boolean | string[] | undefined;
  /** Extra skill directories to scan (lowest priority, before bundled). */
  extraDirs?: string[] | undefined;
}

/**
 * Discovery order (we walk highest priority first and skip names already
 * seen, so earlier layers shadow later ones):
 *   1. Project-committed:   <project>/.wrongstack/skills/
 *   2. Project foreign:     <project>/.claude/skills/      (opt-out)
 *   3. Project foreign:     <project>/.{codex,cursor,agents,…}/skills/
 *   4. User profile:        ~/.wrongstack/profiles/<name>/skills/
 *   5. User foreign:        ~/.claude/skills/              (opt-out)
 *   6. User foreign:        ~/.{codex,cursor,agents,…}/skills/
 *   7. Extra dirs:          config.skills.extraDirs         (user config only)
 *   8. Bundled with build:  packages/core/skills/
 *
 * The `.claude/*` layers let skills authored for other coding agents (Claude
 * Code, Codex, Gemini, `asm`, `gh skill`) be used without copying. They are
 * read-only — the installer never writes there.
 */
export class DefaultSkillLoader implements SkillLoader {
  private readonly dirs: { dir: string; source: SkillManifest['source']; originTool?: string }[];
  private cache?: SkillManifest[] | undefined;
  private entriesCache?: SkillEntry[] | undefined;
  private readonly bodyCache = new Map<string, string>();
  /** Load-time diagnostics from the most recent full `list()` scan. */
  private skipped: SkippedSkill[] = [];
  private shadowed: ShadowedSkill[] = [];

  constructor(opts: SkillLoaderOptions) {
    const readClaude = opts.readClaudeSkills !== false;
    const foreignIds = resolveForeignToolIds(opts.foreignSources);
    const dirs: { dir: string; source: SkillManifest['source']; originTool?: string }[] = [];
    // Push each enabled foreign tool's dir under `root`, in registry order.
    const pushForeign = (root: string | undefined) => {
      if (!root) return;
      for (const tool of FOREIGN_SKILL_TOOLS) {
        if (!foreignIds.includes(tool.id)) continue;
        dirs.push({
          dir: path.join(root, '.' + tool.id, tool.subdir),
          source: 'foreign',
          originTool: tool.id,
        });
      }
    };
    dirs.push({ dir: opts.paths.inProjectSkills, source: 'project' });
    if (readClaude) dirs.push({ dir: opts.paths.inProjectClaudeSkills, source: 'claude-project' });
    pushForeign(opts.paths.projectRoot);
    dirs.push({ dir: opts.paths.globalSkills, source: 'user' });
    if (readClaude) dirs.push({ dir: opts.paths.globalClaudeSkills, source: 'claude-user' });
    pushForeign(opts.paths.homeDir);
    for (const d of opts.extraDirs ?? []) dirs.push({ dir: d, source: 'extra' });
    if (opts.bundledDir) dirs.push({ dir: opts.bundledDir, source: 'bundled' });
    this.dirs = dirs;
  }

  async list(): Promise<SkillManifest[]> {
    if (this.cache) return this.cache;
    const found: SkillManifest[] = [];
    const seen = new Set<string>();
    // First-claimant map so a shadowed skill can report which layer won.
    const claimedBy = new Map<string, { source: SkillManifest['source']; path: string }>();
    // Reset diagnostics for this fresh scan. A cache hit returns early above,
    // so these always reflect the most recent full scan.
    this.skipped = [];
    this.shadowed = [];
    for (const { dir, source, originTool } of this.dirs) {
      try {
        // Node does not guarantee filesystem enumeration order. Sort each
        // discovery layer so eager-budget selection and prompt output are
        // deterministic across ext4/APFS/NTFS and packaged installations.
        const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        );
        for (const e of entries) {
          if (!(await entryIsDirectory(dir, e))) continue;
          // The DIRECTORY name — not just the frontmatter name — becomes part of
          // manifest.path, which downstream consumers hand to editors and other
          // child processes. `<projectRoot>/.wrongstack/skills` is repo-committed,
          // so an untrusted repo controls this string. NTFS permits `&` in a
          // filename, which is a cmd.exe command separator. Hold the directory
          // name to the same agentskills.io charset as the frontmatter name, so
          // no shell metacharacter can ever reach a spawn argument this way.
          if (!isValidSkillNameFormat(e.name)) {
            this.skipped.push({ dir, entry: e.name, reason: 'invalid-name-format' });
            continue;
          }
          const skillFile = path.join(dir, e.name, 'SKILL.md');
          let raw: string;
          try {
            raw = await fs.readFile(skillFile, 'utf8');
          } catch {
            // No SKILL.md → not a skill directory. Normal; not reported.
            continue;
          }
          const fm = parseSkillFrontmatter(raw);
          if (!fm.name) {
            this.skipped.push({ dir, entry: e.name, reason: 'missing-name' });
            continue;
          }
          if (!fm.description) {
            this.skipped.push({
              dir,
              entry: e.name,
              reason: 'missing-description',
              name: fm.name,
            });
            continue;
          }
          // agentskills.io name format — skip genuinely malformed names.
          if (!isValidSkillNameFormat(fm.name)) {
            this.skipped.push({
              dir,
              entry: e.name,
              reason: 'invalid-name-format',
              name: fm.name,
            });
            continue;
          }
          if (seen.has(fm.name)) {
            // A higher-priority layer already claimed this name — record the
            // shadow so it is diagnosable rather than silently dropped.
            const claimant = claimedBy.get(fm.name);
            this.shadowed.push({
              name: fm.name,
              source,
              path: skillFile,
              shadowedBy: claimant?.source ?? 'unknown',
              shadowedByPath: claimant?.path,
            });
            continue;
          }
          seen.add(fm.name);
          claimedBy.set(fm.name, { source, path: skillFile });
          found.push({
            name: fm.name,
            description: fm.description,
            trigger: fm.trigger,
            version: fm.version,
            license: fm.license,
            compatibility: fm.compatibility,
            metadata: fm.metadata,
            allowedTools: fm.allowedTools,
            requiredCapabilities: fm.requiredCapabilities,
            requiredTools: fm.requiredTools,
            optionalCapabilities: fm.optionalCapabilities,
            path: skillFile,
            source,
            originTool,
          });
        }
      } catch {
        // directory may not exist
      }
    }
    this.cache = found;
    return found;
  }

  async find(name: string): Promise<SkillManifest | undefined> {
    const all = await this.list();
    const lower = name.toLowerCase();
    return all.find((s) => s.name.toLowerCase() === lower);
  }

  async manifestText(): Promise<string> {
    const entries = await this.listEntries();
    if (entries.length === 0) return '';
    const lines = ['## Available skills'];
    for (const e of entries) {
      const scopeTag = e.scope.length > 0 ? ` — ${e.scope.slice(0, 3).join(', ')}` : '';
      lines.push(`- **${e.name}**${scopeTag}`);
      lines.push(`  Use when: ${e.trigger}`);
    }
    return lines.join('\n');
  }

  async listEntries(): Promise<SkillEntry[]> {
    if (this.entriesCache) return this.entriesCache;
    const skills = await this.list();
    const entries: SkillEntry[] = [];
    for (const s of skills) {
      // Scope always comes from the description heuristic; the trigger prefers
      // an explicit frontmatter `trigger:` field and falls back to the first
      // sentence of the description when none is declared.
      const parsed = parseDescriptionFromText(s.description ?? '');
      const trigger = s.trigger?.trim() || parsed.trigger;
      entries.push({
        name: s.name,
        trigger,
        scope: parsed.scope,
        source: s.source,
        originTool: s.originTool,
        path: s.path,
      });
    }
    this.entriesCache = entries;
    return entries;
  }

  invalidateCache(): void {
    this.cache = undefined;
    this.entriesCache = undefined;
    this.bodyCache.clear();
    this.skipped = [];
    this.shadowed = [];
  }

  /**
   * Load-time diagnostics from the most recent full `list()` scan: skills
   * skipped as malformed and skills shadowed by a higher-priority layer.
   * Returns copies so callers cannot mutate internal state.
   */
  diagnostics(): SkillLoaderDiagnostics {
    return { skipped: [...this.skipped], shadowed: [...this.shadowed] };
  }

  async readBody(name: string): Promise<string> {
    const key = name.toLowerCase();
    const cached = this.bodyCache.get(key);
    if (cached !== undefined) return cached;
    const m = await this.find(name);
    if (!m) throw new Error(`Skill "${name}" not found`);
    const body = await fs.readFile(m.path, 'utf8');
    this.bodyCache.set(key, body);
    return body;
  }

  async readSaveBody(name: string): Promise<string> {
    const key = `save:${name.toLowerCase()}`;
    const cached = this.bodyCache.get(key);
    if (cached !== undefined) return cached;
    const m = await this.find(name);
    if (!m) throw new Error(`Skill "${name}" not found`);
    // Try SKILL.save.md in the same directory as SKILL.md
    const savePath = path.join(path.dirname(m.path), 'SKILL.save.md');
    let result: string;
    try {
      result = await fs.readFile(savePath, 'utf8');
    } catch {
      // No hand-crafted save variant — auto-compact the full body
      const full = await fs.readFile(m.path, 'utf8');
      const body = stripFrontmatter(full);
      const compact = compactSkillBody(body);
      if (compact) {
        result = `## Overview\n\n${compact}`;
      } else {
        // Fallback: return first 300 chars of full body
        result = body.trim().slice(0, 300);
      }
    }
    this.bodyCache.set(key, result);
    return result;
  }
}

/**
 * Parse skill description into:
 * - trigger: extracted "Use when..." sentence (first sentence of description)
 * - scope: comma-separated items from first line's parenthetical or file-ext list
 */
/**
 * Extract trigger and scope from a skill's description text.
 * Used by listEntries() when the description has already been parsed from frontmatter.
 */
function parseDescriptionFromText(desc: string): { trigger: string; scope: string[] } {
  // Extract first sentence as trigger
  const firstSentenceEnd = desc.indexOf('. ');
  const trigger =
    firstSentenceEnd !== -1
      ? desc.slice(0, firstSentenceEnd + 1).trim()
      : (desc.trim().split('\n')[0] ?? '');

  // Extract scope from parenthetical: "Covers X, Y, and Z" or "for A, B, C"
  const scope: string[] = [];
  const coversMatch = /(?:covers|for|including)\s+([^.]+)/i.exec(desc);
  if (coversMatch) {
    // NB: parenthesize the `?? ''` — without it, `??` binds looser than the
    // method chain, so `items` would be the raw match string and `...items`
    // would spread it into individual characters.
    const items = (coversMatch[1] ?? '')
      .replace(/[·•]/g, ',')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    scope.push(...items);
  }

  return { trigger, scope };
}

import { SKILL_LIMITS } from '../skills/limits.js';
import type { SkillLoader, SkillManifest } from '../types/skill.js';
import { capSkillBody, stripFrontmatter } from './system-prompt-skill-text.js';

/**
 * Discovery layers that originate outside the user's own WrongStack skill
 * directories — another coding agent's skills dir, or a configured `extraDirs`
 * entry. These are read-only third-party instructions injected into the prompt
 * with the same trust as bundled/project skills, so we tag their origin
 * (provenance) so the model can weigh them accordingly. Mirrors the type-level
 * definition of "foreign sources" in types/skill.ts.
 */
const FOREIGN_SOURCES: ReadonlySet<SkillManifest['source']> = new Set([
  // WS-016: `project` skills come from `<repo>/.wrongstack/skills` — they
  // arrive with a cloned repository and load at the HIGHEST priority, shadowing
  // the user's own. They were the only discovery layer injected into the prompt
  // with no provenance tag at all, i.e. indistinguishable from bundled or
  // user-authored instructions. `claude-project` was already tagged for exactly
  // this reason; the native project layer carries the same trust properties.
  'project',
  'claude-project',
  'claude-user',
  'foreign',
  'extra',
]);

/**
 * Provenance marker for a foreign skill, e.g. ` [foreign skill: codex]`. For
 * `foreign` sources the originating tool id is used when known; otherwise the
 * discovery layer name (e.g. `claude-user`, `extra`). Returns '' for native
 * skills (project/user/bundled) so their rendering is unchanged.
 */
function foreignProvenanceTag(source: SkillManifest['source'], originTool?: string): string {
  if (!FOREIGN_SOURCES.has(source)) return '';
  // A repo-committed skill is not "foreign" in the another-agent's-directory
  // sense, so name it for what it is rather than mislabelling it (WS-016).
  if (source === 'project') return ' [repository-supplied skill]';
  const origin = source === 'foreign' && originTool ? originTool : source;
  return ` [foreign skill: ${origin}]`;
}

export async function buildProgressiveSkillManifestText(loader: SkillLoader): Promise<string> {
  try {
    const entries = await loader.listEntries();
    if (entries.length === 0) return '';
    const lines = [
      'Call the `skill` tool to load a skill before relying on it.',
      '',
      '| Skill | Use when |',
      '|---|---|',
    ];
    for (const e of entries) {
      const trigger = (e.trigger ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
      lines.push(`| \`${e.name}\`${foreignProvenanceTag(e.source, e.originTool)} | ${trigger} |`);
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

export async function buildFullSkillBodiesText(
  loader: SkillLoader,
  budget: number = SKILL_LIMITS.EAGER_DEFAULT_MAX_CHARS,
): Promise<string> {
  try {
    const skills = await loader.list();
    if (skills.length === 0) return '';
    const bodies: string[] = [];
    const overflow: string[] = [];
    let used = 0;
    for (const s of skills) {
      try {
        const raw = await loader.readBody(s.name);
        const trimmed = stripFrontmatter(raw).trim();
        if (!trimmed) continue;
        const entry = `## Skill: ${s.name}${foreignProvenanceTag(s.source, s.originTool)}\n\n${capSkillBody(trimmed)}`;
        if (used + entry.length <= budget) {
          bodies.push(entry);
          used += entry.length;
        } else {
          overflow.push(`- ${s.name}`);
        }
      } catch {
        // skip unreadable skill
      }
    }
    let out = bodies.join('\n\n---\n\n');
    if (overflow.length > 0) {
      const note =
        overflow.length === skills.length
          ? '## Available skills (load with the `skill` tool)'
          : '## Other available skills (not injected — load with the `skill` tool)';
      out += `${out ? '\n\n---\n\n' : ''}${note}\n${overflow.join('\n')}`;
    }
    return out;
  } catch {
    return '';
  }
}

export async function buildCompactSkillBodiesText(
  loader: SkillLoader,
  budget: number = SKILL_LIMITS.COMPACT_DEFAULT_MAX_CHARS,
): Promise<string> {
  try {
    const skills = await loader.list();
    if (skills.length === 0) return '';
    const bodies: string[] = [];
    const overflow: string[] = [];
    let used = 0;
    for (const s of skills) {
      try {
        const saveBody = await loader.readSaveBody(s.name);
        const clean = stripFrontmatter(saveBody).trim();
        if (!clean) continue;
        const entry = `## Skill: ${s.name}${foreignProvenanceTag(s.source, s.originTool)}\n\n${clean}`;
        if (used + entry.length <= budget) {
          bodies.push(entry);
          used += entry.length;
        } else {
          overflow.push(`- ${s.name}`);
        }
      } catch {
        // skip unreadable skill
      }
    }
    let out = bodies.join('\n\n---\n\n');
    if (overflow.length > 0) {
      const note =
        overflow.length === skills.length
          ? '## Available skills (load with the `skill` tool)'
          : '## Other available skills (not injected — load with the `skill` tool)';
      out += `${out ? '\n\n---\n\n' : ''}${note}\n${overflow.join('\n')}`;
    }
    return out;
  } catch {
    return '';
  }
}

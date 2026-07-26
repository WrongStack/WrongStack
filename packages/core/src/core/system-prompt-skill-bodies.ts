import { SKILL_LIMITS } from '../skills/limits.js';
import type { SkillLoader } from '../types/skill.js';
import { capSkillBody, stripFrontmatter } from './system-prompt-skill-text.js';

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
      lines.push(`| \`${e.name}\` | ${trigger} |`);
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
        const entry = `## Skill: ${s.name}\n\n${capSkillBody(trimmed)}`;
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

export async function buildCompactSkillBodiesText(loader: SkillLoader): Promise<string> {
  try {
    const skills = await loader.list();
    if (skills.length === 0) return '';
    const bodies: string[] = [];
    for (const s of skills) {
      try {
        const saveBody = await loader.readSaveBody(s.name);
        const clean = stripFrontmatter(saveBody);
        if (clean.trim()) {
          bodies.push(`## Skill: ${s.name}\n\n${clean.trim()}`);
        }
      } catch {
        // skip unreadable skill
      }
    }
    return bodies.length > 0 ? bodies.join('\n\n---\n\n') : '';
  } catch {
    return '';
  }
}

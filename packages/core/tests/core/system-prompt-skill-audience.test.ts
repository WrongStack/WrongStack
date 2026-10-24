import type { SkillEntry, SkillLoader, SkillManifest } from '@wrongstack/contracts/types/skill';
import { describe, expect, it } from 'vitest';
import {
  buildCompactSkillBodiesText,
  buildFullSkillBodiesText,
  buildProgressiveSkillManifestText,
  isSkillHiddenFromPrompt,
} from '../../src/core/system-prompt-skill-bodies.js';
import { parseSkillFrontmatter } from '../../src/skills/frontmatter.js';

/** One skill per audience: unset, `roster`, and `external`. */
function audienceLoader(): SkillLoader {
  const skills: SkillManifest[] = [
    { name: 'visible', description: 'd', path: '/visible/SKILL.md', source: 'bundled' },
    {
      name: 'crew',
      description: 'd',
      audience: 'roster',
      path: '/crew/SKILL.md',
      source: 'bundled',
    },
    {
      name: 'outside',
      description: 'd',
      audience: 'external',
      path: '/outside/SKILL.md',
      source: 'bundled',
    },
  ];
  const entries: SkillEntry[] = skills.map((skill) => ({
    name: skill.name,
    trigger: `Use when ${skill.name}.`,
    scope: [],
    audience: skill.audience,
    source: skill.source,
    path: skill.path,
  }));
  return {
    list: async () => skills,
    listEntries: async () => entries,
    find: async (name: string) => skills.find((skill) => skill.name === name),
    manifestText: async () => '',
    readBody: async (name: string) => `BODY ${name}`,
    readSaveBody: async (name: string) => `BODY ${name}`,
    invalidateCache: () => undefined,
  } as unknown as SkillLoader;
}

describe('skill audience → prompt visibility', () => {
  it('parses `audience` from frontmatter', () => {
    const parsed = parseSkillFrontmatter('---\nname: x\ndescription: d\naudience: roster\n---\n');
    expect(parsed.audience).toBe('roster');
  });

  it('hides only the roster and external audiences', () => {
    expect(isSkillHiddenFromPrompt(undefined)).toBe(false);
    expect(isSkillHiddenFromPrompt('all')).toBe(false);
    expect(isSkillHiddenFromPrompt('roster')).toBe(true);
    expect(isSkillHiddenFromPrompt(' External ')).toBe(true);
  });

  it('keeps hidden skills out of the progressive manifest', async () => {
    const out = await buildProgressiveSkillManifestText(audienceLoader());
    expect(out).toContain('| `visible` |');
    expect(out).not.toContain('`crew`');
    expect(out).not.toContain('`outside`');
  });

  it('keeps hidden skills out of eager and compact bodies, including overflow', async () => {
    for (const build of [buildFullSkillBodiesText, buildCompactSkillBodiesText]) {
      const injected = await build(audienceLoader(), 100_000);
      expect(injected).toContain('## Skill: visible');
      expect(injected).not.toContain('crew');
      expect(injected).not.toContain('outside');

      const overflow = await build(audienceLoader(), 1);
      expect(overflow).toContain('- visible');
      expect(overflow).not.toContain('- crew');
      expect(overflow).not.toContain('- outside');
    }
  });
});

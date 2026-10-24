import type { SkillLoader, SkillManifest } from '@wrongstack/contracts/types/skill';
import { describe, expect, it } from 'vitest';
import {
  buildCompactSkillBodiesText,
  buildFullSkillBodiesText,
  buildProgressiveSkillManifestText,
} from '../../src/core/system-prompt-skill-bodies.js';
import {
  skillPromptExclusionReasons,
  skillUseWhenText,
} from '../../src/skills/prompt-discovery.js';

describe('skill prompt discovery', () => {
  it('shows routing guidance only when the maintained bundled router is usable', async () => {
    const router: SkillManifest = {
      name: 'skill-router',
      description: 'Select a workflow.',
      source: 'bundled',
      path: '/router/SKILL.md',
      requiredTools: ['skill'],
    };
    const specialist: SkillManifest = {
      name: 'nextjs-modern',
      description: 'Next.js routes.',
      source: 'bundled',
      path: '/next/SKILL.md',
    };
    const loader = {
      list: async () => [router, specialist],
      listEntries: async () =>
        [router, specialist].map((skill) => ({ ...skill, trigger: skill.description, scope: [] })),
      readBody: async () => 'Instructions.',
      readSaveBody: async () => 'Compact instructions.',
    } as unknown as SkillLoader;
    const available = await buildProgressiveSkillManifestText(loader, ['skill']);
    expect(available).toContain('load its specialist directly');
    expect(available).toContain('load `skill-router` first');
    expect(available).toContain('acceptance checks');
    for (const build of [buildFullSkillBodiesText, buildCompactSkillBodiesText]) {
      const overflow = await build(loader, 1, ['skill']);
      expect(overflow).toContain('load `skill-router` first');
      expect(overflow).toContain('- skill-router');
      expect(await build(loader, 1, [])).not.toContain('skill-router');
    }
    const unavailable = await buildProgressiveSkillManifestText(loader, []);
    expect(unavailable).not.toContain('skill-router');
    expect(unavailable).toContain('`nextjs-modern`');
    router.source = 'project';
    const overridden = await buildProgressiveSkillManifestText(loader, ['skill']);
    expect(overridden).toContain('[repository-supplied skill]');
    expect(overridden).not.toContain('load `skill-router` first');
  });

  it('preserves full scope and exclusions while removing duplicated trigger text', async () => {
    const skill: SkillManifest = {
      name: 'ui',
      source: 'project',
      path: '/ui/SKILL.md',
      description: 'Create layouts. Do not use for mobile apps.',
      trigger: ' Create layouts.\n Do not use for mobile apps. ',
    };
    const loader = {
      list: async () => [skill],
      listEntries: async () => [{ ...skill, scope: [] }],
    } as unknown as SkillLoader;
    const text = await buildProgressiveSkillManifestText(loader);
    expect(text.match(/Do not use for mobile apps\./g)).toHaveLength(1);
    expect(text).toContain('[repository-supplied skill]');
    expect(skillUseWhenText('Create layouts. Keep accessible.', 'Create layouts.')).toBe(
      'Create layouts. Keep accessible.',
    );
    expect(skillUseWhenText('Create layouts.', 'Use for desktop | tablets.')).toContain(
      'desktop | tablets',
    );
    expect(skillUseWhenText(undefined, undefined, 'Fallback\ntext')).toBe('Fallback text');
  });

  it('separates hidden audiences, missing capabilities and missing tools from optional capabilities', () => {
    const skill: SkillManifest = {
      name: 'hidden',
      source: 'bundled',
      path: '/hidden/SKILL.md',
      description: 'Hidden',
      audience: ' External ',
      requiredCapabilities: ['filesystem.read'],
      requiredTools: ['bash'],
      optionalCapabilities: ['browser.automation'],
    };
    expect(skillPromptExclusionReasons(skill)).toEqual(['audience: External']);
    expect(skillPromptExclusionReasons(skill, [])).toEqual([
      'audience: External',
      'missing capability: filesystem.read',
      'missing tool: bash',
    ]);
    expect(
      skillPromptExclusionReasons({ ...skill, audience: undefined }, [
        'read',
        'grep',
        'glob',
        'tree',
        'bash',
      ]),
    ).toEqual([]);
  });
});

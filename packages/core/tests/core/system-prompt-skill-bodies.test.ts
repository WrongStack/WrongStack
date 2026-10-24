import type { SkillLoader, SkillManifest } from '@wrongstack/contracts/types/skill';
import { describe, expect, it } from 'vitest';
import {
  buildCompactSkillBodiesText,
  buildFullSkillBodiesText,
  buildFullSkillBodiesTextCached,
  buildProgressiveSkillManifestText,
  newSkillFragmentCache,
} from '../../src/core/system-prompt-skill-bodies.js';
import { SKILL_LIMITS } from '../../src/skills/limits.js';

/** In-memory loader whose compact body is a fixed string per skill. */
function fakeLoader(names: string[], body: string): SkillLoader {
  const manifest = (name: string): SkillManifest => ({
    name,
    description: 'd',
    path: `/${name}/SKILL.md`,
    source: 'bundled',
  });
  return {
    list: async () => names.map(manifest),
    listEntries: async () => [],
    find: async (name: string) => (names.includes(name) ? manifest(name) : undefined),
    manifestText: async () => '',
    readBody: async () => body,
    readSaveBody: async () => body,
    invalidateCache: () => undefined,
  } as unknown as SkillLoader;
}

const NAMES = ['aaa', 'bbb', 'ccc'];
// One injected entry is `## Skill: aaa\n\nBODY`.
const ONE_ENTRY = '## Skill: aaa\n\nBODY'.length;

describe('buildCompactSkillBodiesText aggregate budget (T5)', () => {
  it('injects every skill when the budget is generous', async () => {
    const out = await buildCompactSkillBodiesText(fakeLoader(NAMES, 'BODY'), 100_000);
    for (const n of NAMES) expect(out).toContain(`## Skill: ${n}`);
    expect(out).not.toContain('load with the `skill` tool');
  });

  it('overflows every skill to the manifest when the budget is exhausted', async () => {
    const out = await buildCompactSkillBodiesText(fakeLoader(NAMES, 'BODY'), 1);
    expect(out).not.toContain('## Skill:');
    expect(out).toContain('## Available skills (load with the `skill` tool)');
    for (const n of NAMES) expect(out).toContain(`- ${n}`);
  });

  it('injects what fits and lists the rest on a partial budget', async () => {
    const out = await buildCompactSkillBodiesText(fakeLoader(NAMES, 'BODY'), ONE_ENTRY);
    expect(out).toContain('## Skill: aaa');
    expect(out).not.toContain('## Skill: bbb');
    expect(out).toContain('## Other available skills (not injected — load with the `skill` tool)');
    expect(out).toContain('- bbb');
    expect(out).toContain('- ccc');
  });

  it('defaults to the centralized compact budget constant', () => {
    expect(SKILL_LIMITS.COMPACT_DEFAULT_MAX_CHARS).toBeGreaterThan(0);
  });

  it('does not inject a body that calls an unregistered tool', async () => {
    const loader = fakeLoader(['unsafe'], 'Call `ghost_tool` before continuing.');
    expect(await buildCompactSkillBodiesText(loader, 100_000)).toBe('');
    expect(await buildFullSkillBodiesText(loader, 100_000)).toBe('');
  });
});

/** A loader with two foreign (other-agent) skills and one native bundled skill. */
function foreignLoader(): SkillLoader {
  const foreign: SkillManifest = {
    name: 'codex-skill',
    description: 'd',
    path: '/home/u/.codex/skills/codex-skill/SKILL.md',
    source: 'foreign',
    originTool: 'codex',
  };
  const claudeUser: SkillManifest = {
    name: 'claude-skill',
    description: 'd',
    path: '/home/u/.claude/skills/claude-skill/SKILL.md',
    source: 'claude-user',
  };
  const bundled: SkillManifest = {
    name: 'native-skill',
    description: 'd',
    path: '/proj/packages/core/skills/native-skill/SKILL.md',
    source: 'bundled',
  };
  const all = [foreign, claudeUser, bundled];
  return {
    list: async () => all,
    listEntries: async () =>
      all.map((m) => ({
        name: m.name,
        trigger: 'when needed',
        scope: [],
        source: m.source,
        originTool: m.originTool,
        path: m.path,
      })),
    find: async (name: string) => all.find((m) => m.name === name),
    manifestText: async () => '',
    readBody: async () => 'BODY',
    readSaveBody: async () => 'BODY',
    invalidateCache: () => undefined,
  } as unknown as SkillLoader;
}

describe('foreign-skill provenance labeling (Phase 4)', () => {
  it('tags foreign skills in the eager body block, not native ones', async () => {
    const out = await buildFullSkillBodiesText(foreignLoader(), 100_000);
    expect(out).toContain('## Skill: codex-skill [foreign skill: codex]');
    expect(out).toContain('## Skill: claude-skill [foreign skill: claude-user]');
    expect(out).toContain('## Skill: native-skill\n');
    expect(out).not.toContain('native-skill [foreign');
  });

  it('tags foreign skills in the compact body block', async () => {
    const out = await buildCompactSkillBodiesText(foreignLoader(), 100_000);
    expect(out).toContain('## Skill: codex-skill [foreign skill: codex]');
    expect(out).toContain('## Skill: claude-skill [foreign skill: claude-user]');
    expect(out).not.toContain('native-skill [foreign');
  });

  it('tags foreign skills in the progressive manifest table', async () => {
    const out = await buildProgressiveSkillManifestText(foreignLoader());
    expect(out).toContain('`codex-skill` [foreign skill: codex]');
    expect(out).toContain('`claude-skill` [foreign skill: claude-user]');
    expect(out).toContain('`native-skill` |');
    expect(out).not.toContain('`native-skill` [foreign');
  });
});

/** Loader whose bodies can be swapped between builds, mimicking an edit. */
function mutableLoader(names: string[]): {
  loader: SkillLoader;
  setBody: (body: string) => void;
} {
  let body = 'BODY';
  const manifest = (name: string): SkillManifest => ({
    name,
    description: 'd',
    path: `/${name}/SKILL.md`,
    source: 'bundled',
  });
  const loader: SkillLoader = {
    list: async () => names.map(manifest),
    listEntries: async () => [],
    find: async (name: string) => (names.includes(name) ? manifest(name) : undefined),
    manifestText: async () => '',
    // Returns the live string instance, like the real loader's stamped body
    // cache: same instance while unchanged, a NEW string after a re-read.
    readBody: async () => body,
    readSaveBody: async () => body,
    invalidateCache: () => undefined,
  } as unknown as SkillLoader;
  return {
    loader,
    setBody: (next: string) => {
      body = next;
    },
  };
}

describe('buildFullSkillBodiesTextCached fragment cache', () => {
  it('matches the uncached builder on cold and warm calls', async () => {
    const loader = fakeLoader(['aaa', 'bbb'], 'BODY');
    const uncached = await buildFullSkillBodiesText(loader, 100_000);
    const first = await buildFullSkillBodiesTextCached(loader, 100_000);
    const second = await buildFullSkillBodiesTextCached(loader, 100_000, [], first.cache);
    expect(first.text).toBe(uncached);
    expect(second.text).toBe(uncached);
  });

  it('re-renders a skill after its body changes (freshness contract)', async () => {
    const { loader, setBody } = mutableLoader(['aaa']);
    const cache = newSkillFragmentCache();
    const v1 = await buildFullSkillBodiesTextCached(loader, 100_000, [], cache);
    expect(v1.text).toContain('BODY');
    setBody('BODY-V2 edited further');
    const v2 = await buildFullSkillBodiesTextCached(loader, 100_000, [], cache);
    expect(v2.text).toContain('BODY-V2');
    expect(v2.text).not.toContain('\n\nBODY\n');
  });

  it('gates a cached fragment against tool references each turn', async () => {
    const { loader, setBody } = mutableLoader(['aaa']);
    const cache = newSkillFragmentCache();
    const ok = await buildFullSkillBodiesTextCached(loader, 100_000, [], cache);
    expect(ok.text).toContain('## Skill: aaa');
    setBody('Call `ghost_tool` before continuing.');
    const gated = await buildFullSkillBodiesTextCached(loader, 100_000, [], cache);
    expect(gated.text).toBe('');
  });

  it('follows tool-catalog admission changes without re-reading bodies', async () => {
    const { loader, setBody } = mutableLoader(['aaa']);
    setBody('Use `mailbox` to reach fleet peers.');
    const cache = newSkillFragmentCache();
    const admitted = await buildFullSkillBodiesTextCached(loader, 100_000, ['mailbox'], cache);
    expect(admitted.text).toContain('## Skill: aaa');
    const rejected = await buildFullSkillBodiesTextCached(loader, 100_000, [], cache);
    expect(rejected.text).toBe('');
    const restored = await buildFullSkillBodiesTextCached(loader, 100_000, ['mailbox'], cache);
    expect(restored.text).toBe(admitted.text);
  });

  it('skips a skill whose readBody rejects and renders the rest', async () => {
    const names = ['aaa', 'bbb'];
    const manifest = (name: string): SkillManifest => ({
      name,
      description: 'd',
      path: `/${name}/SKILL.md`,
      source: 'bundled',
    });
    const loader: SkillLoader = {
      list: async () => names.map(manifest),
      listEntries: async () => [],
      find: async (name: string) => (names.includes(name) ? manifest(name) : undefined),
      manifestText: async () => '',
      readBody: async (name: string) => {
        if (name === 'bbb') throw new Error('vanished mid-turn');
        return 'BODY';
      },
      readSaveBody: async () => 'BODY',
      invalidateCache: () => undefined,
    } as unknown as SkillLoader;
    const out = await buildFullSkillBodiesText(loader, 100_000);
    expect(out).toContain('## Skill: aaa');
    expect(out).not.toContain('## Skill: bbb');
  });
});

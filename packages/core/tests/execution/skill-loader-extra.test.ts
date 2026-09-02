import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultSkillLoader, resolveWstackPaths } from '../../src/index.js';

const profileSkills = (globalRoot: string) =>
  path.join(globalRoot, 'profiles', 'default', 'skills');

// ---------------------------------------------------------------------------
// parseDescriptionFromText — no direct export, tested via listEntries
// ---------------------------------------------------------------------------
describe('skill description parsing', () => {
  let tmp: string;
  let projectRoot: string;
  let globalRoot: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-skills-desc-'));
    projectRoot = path.join(tmp, 'proj');
    globalRoot = path.join(tmp, 'global');
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('extracts trigger from first sentence and scope from parenthetical', async () => {
    const desc = 'Covers profanity, spam, hate speech. Use this skill for moderation.';
    const dir = path.join(profileSkills(globalRoot), 'moderate');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'SKILL.md'),
      `---\nname: moderate\ndescription: "${desc}"\n---\n# moderate body`,
    );
    const paths = resolveWstackPaths({ projectRoot, globalRoot, userHome: tmp });
    const loader = new DefaultSkillLoader({ paths });
    const entries = await loader.listEntries();
    const moderate = entries.find((e) => e.name === 'moderate')!;
    expect(moderate.trigger).toBe('Covers profanity, spam, hate speech.');
    expect(moderate.scope).toContain('profanity');
    expect(moderate.scope).toContain('spam');
    expect(moderate.scope).toContain('hate speech');
  });

  it('uses full description as trigger when no period separator exists', async () => {
    const desc = 'the alpha skill spans multiple lines';
    const dir = path.join(profileSkills(globalRoot), 'alpha');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'SKILL.md'),
      `---\nname: alpha\ndescription: |\n  ${desc}\n---\n# body`,
    );
    const paths = resolveWstackPaths({ projectRoot, globalRoot, userHome: tmp });
    const loader = new DefaultSkillLoader({ paths });
    const entries = await loader.listEntries();
    const alpha = entries.find((e) => e.name === 'alpha')!;
    expect(alpha.trigger).toContain('alpha skill');
  });

  it('extracts scope with · and • bullet separators as commas', async () => {
    const desc = 'Formatting tool. Covers indent • spacing • line-breaks';
    const dir = path.join(profileSkills(globalRoot), 'fmt');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'SKILL.md'),
      `---\nname: fmt\ndescription: "${desc}"\n---\n# body`,
    );
    const paths = resolveWstackPaths({ projectRoot, globalRoot, userHome: tmp });
    const loader = new DefaultSkillLoader({ paths });
    const entries = await loader.listEntries();
    const fmt = entries.find((e) => e.name === 'fmt')!;
    expect(fmt.scope.length).toBeGreaterThanOrEqual(3);
  });

  it('uses first line as trigger when description has no period', async () => {
    const desc = 'Quick math helper\nfor basic arithmetic';
    const dir = path.join(profileSkills(globalRoot), 'math');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'SKILL.md'),
      `---\nname: math\ndescription: |\n  ${desc}\n---\n# body`,
    );
    const paths = resolveWstackPaths({ projectRoot, globalRoot, userHome: tmp });
    const loader = new DefaultSkillLoader({ paths });
    const entries = await loader.listEntries();
    const math = entries.find((e) => e.name === 'math')!;
    expect(math.trigger).toContain('Quick math helper');
  });
});

// ---------------------------------------------------------------------------
// DefaultSkillLoader — additional coverage
// ---------------------------------------------------------------------------
describe('DefaultSkillLoader — extra', () => {
  let tmp: string;
  let projectRoot: string;
  let globalRoot: string;
  let _bundled: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-skills-extra-'));
    projectRoot = path.join(tmp, 'proj');
    globalRoot = path.join(tmp, 'global');
    _bundled = path.join(tmp, 'bundled');
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  describe('readBody caching', () => {
    it('returns cached body on repeated call', async () => {
      const skillDir = path.join(profileSkills(globalRoot), 'cacheme');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---\nname: cacheme\ndescription: cached\n---\n# original body`,
      );
      const paths = resolveWstackPaths({ projectRoot, globalRoot, userHome: tmp });
      const loader = new DefaultSkillLoader({ paths });
      const body1 = await loader.readBody('cacheme');
      expect(body1).toContain('original body');

      // Modify the file on disk
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), 'changed content');
      // Should still return cached body
      const body2 = await loader.readBody('cacheme');
      expect(body2).toContain('original body');
    });
  });

  describe('invalidateCache', () => {
    it('clears all caches so next list re-reads disk', async () => {
      const alphaDir = path.join(profileSkills(globalRoot), 'alpha');
      await fs.mkdir(alphaDir, { recursive: true });
      await fs.writeFile(
        path.join(alphaDir, 'SKILL.md'),
        `---\nname: alpha\ndescription: first\n---\n# body`,
      );
      const paths = resolveWstackPaths({ projectRoot, globalRoot, userHome: tmp });
      const loader = new DefaultSkillLoader({ paths });

      const list1 = await loader.list();
      expect(list1).toHaveLength(1);

      // Add a new skill on disk
      const betaDir = path.join(profileSkills(globalRoot), 'beta');
      await fs.mkdir(betaDir, { recursive: true });
      await fs.writeFile(
        path.join(betaDir, 'SKILL.md'),
        `---\nname: beta\ndescription: second\n---\n# body`,
      );

      // Without invalidation, cache returns old list
      const list2 = await loader.list();
      expect(list2).toHaveLength(1);

      // After invalidation, re-reads from disk
      loader.invalidateCache();
      const list3 = await loader.list();
      expect(list3).toHaveLength(2);
    });

    it('clears bodyCache on invalidation', async () => {
      const alphaDir = path.join(profileSkills(globalRoot), 'alpha');
      await fs.mkdir(alphaDir, { recursive: true });
      await fs.writeFile(
        path.join(alphaDir, 'SKILL.md'),
        `---\nname: alpha\ndescription: test\n---\n# original`,
      );
      const paths = resolveWstackPaths({ projectRoot, globalRoot, userHome: tmp });
      const loader = new DefaultSkillLoader({ paths });

      await loader.readBody('alpha');
      await fs.writeFile(
        path.join(alphaDir, 'SKILL.md'),
        `---\nname: alpha\ndescription: test\n---\n# modified`,
      );

      loader.invalidateCache();
      const body = await loader.readBody('alpha');
      expect(body).toContain('modified');
    });
  });

  describe('readSaveBody', () => {
    it('returns hand-crafted SKILL.save.md when it exists', async () => {
      const alphaDir = path.join(profileSkills(globalRoot), 'alpha');
      await fs.mkdir(alphaDir, { recursive: true });
      await fs.writeFile(
        path.join(alphaDir, 'SKILL.md'),
        `---\nname: alpha\ndescription: test\n---\n# full body\n## Overview\nfull overview\n## Rules\n- rule 1\n- rule 2\n`,
      );
      await fs.writeFile(path.join(alphaDir, 'SKILL.save.md'), '## Overview\n\nsaved overview');
      const paths = resolveWstackPaths({ projectRoot, globalRoot, userHome: tmp });
      const loader = new DefaultSkillLoader({ paths });
      const saveBody = await loader.readSaveBody('alpha');
      expect(saveBody).toContain('saved overview');
    });

    it('auto-compacts from full body when no SKILL.save.md exists', async () => {
      const alphaDir = path.join(profileSkills(globalRoot), 'alpha');
      await fs.mkdir(alphaDir, { recursive: true });
      await fs.writeFile(
        path.join(alphaDir, 'SKILL.md'),
        `---\nname: alpha\ndescription: test skill\n---\n# body\n## Overview\nUse for testing\n## Rules\n- rule one\n- rule two\n- rule three\n`,
      );
      const paths = resolveWstackPaths({ projectRoot, globalRoot, userHome: tmp });
      const loader = new DefaultSkillLoader({ paths });
      const saveBody = await loader.readSaveBody('alpha');
      expect(saveBody).toContain('## Overview');
      expect(saveBody).toContain('Use for testing');
      expect(saveBody).toContain('rule one');
    });

    it('returns first 300 chars when no Overview or Rules sections exist', async () => {
      const alphaDir = path.join(profileSkills(globalRoot), 'alpha');
      await fs.mkdir(alphaDir, { recursive: true });
      await fs.writeFile(
        path.join(alphaDir, 'SKILL.md'),
        `---\nname: alpha\ndescription: test\n---\n\nSome plain text body without sections. Just text. More text here. Even more to fill up space for testing. And still more content that should be included in the fallback.`,
      );
      const paths = resolveWstackPaths({ projectRoot, globalRoot, userHome: tmp });
      const loader = new DefaultSkillLoader({ paths });
      const saveBody = await loader.readSaveBody('alpha');
      // Should contain the text and be prefixed with ## Overview
      expect(saveBody).toContain('Some plain text body');
    });

    it('caches save body and returns cached version', async () => {
      const alphaDir = path.join(profileSkills(globalRoot), 'alpha');
      await fs.mkdir(alphaDir, { recursive: true });
      await fs.writeFile(
        path.join(alphaDir, 'SKILL.md'),
        `---\nname: alpha\ndescription: test\n---\n# body\n## Overview\nUse for testing`,
      );
      const paths = resolveWstackPaths({ projectRoot, globalRoot, userHome: tmp });
      const loader = new DefaultSkillLoader({ paths });
      const body1 = await loader.readSaveBody('alpha');
      // Modify the file
      await fs.writeFile(
        path.join(alphaDir, 'SKILL.md'),
        `---\nname: alpha\ndescription: test\n---\n# modified`,
      );
      const body2 = await loader.readSaveBody('alpha');
      expect(body2).toBe(body1); // cached
    });
  });

  describe('case-insensitive find', () => {
    it('finds skill by case-insensitive name', async () => {
      const alphaDir = path.join(profileSkills(globalRoot), 'alphaskill');
      await fs.mkdir(alphaDir, { recursive: true });
      await fs.writeFile(
        path.join(alphaDir, 'SKILL.md'),
        `---\nname: alphaskill\ndescription: case test\n---\n# body`,
      );
      const paths = resolveWstackPaths({ projectRoot, globalRoot, userHome: tmp });
      const loader = new DefaultSkillLoader({ paths });
      const found = await loader.find('ALPHASKILL');
      expect(found).toBeDefined();
      expect(found!.name).toBe('alphaskill');
    });
  });

  describe('listEntries caching', () => {
    it('caches entries after first call', async () => {
      const alphaDir = path.join(profileSkills(globalRoot), 'alpha');
      await fs.mkdir(alphaDir, { recursive: true });
      await fs.writeFile(
        path.join(alphaDir, 'SKILL.md'),
        `---\nname: alpha\ndescription: test\n---\n# body`,
      );
      const paths = resolveWstackPaths({ projectRoot, globalRoot, userHome: tmp });
      const loader = new DefaultSkillLoader({ paths });
      const entries1 = await loader.listEntries();
      expect(entries1).toHaveLength(1);

      // Add another skill
      const betaDir = path.join(profileSkills(globalRoot), 'beta');
      await fs.mkdir(betaDir, { recursive: true });
      await fs.writeFile(
        path.join(betaDir, 'SKILL.md'),
        `---\nname: beta\ndescription: second\n---\n# body`,
      );

      const entries2 = await loader.listEntries();
      expect(entries2).toHaveLength(1); // still cached
    });
  });

  describe('foreign sources', () => {
    it('skips foreign source directories when readClaudeSkills is false', async () => {
      const paths = resolveWstackPaths({ projectRoot, globalRoot, userHome: tmp });
      const loader = new DefaultSkillLoader({ paths, readClaudeSkills: false });
      const list = await loader.list();
      // No skills added - should be empty
      expect(list).toHaveLength(0);
    });

    it('includes extraDirs as lowest priority source', async () => {
      const extraDir = path.join(tmp, 'extra-skills');
      await fs.mkdir(path.join(extraDir, 'extra-skill'), { recursive: true });
      await fs.writeFile(
        path.join(extraDir, 'extra-skill', 'SKILL.md'),
        `---\nname: extra-skill\ndescription: extra\n---\n# body`,
      );
      const paths = resolveWstackPaths({ projectRoot, globalRoot, userHome: tmp });
      const loader = new DefaultSkillLoader({ paths, extraDirs: [extraDir] });
      const list = await loader.list();
      const extra = list.find((s) => s.name === 'extra-skill');
      expect(extra).toBeDefined();
      expect(extra!.source).toBe('extra');
    });
  });

  describe('malformed skill entries', () => {
    it('skips directories without SKILL.md', async () => {
      const noSkillDir = path.join(profileSkills(globalRoot), 'noskill');
      await fs.mkdir(noSkillDir, { recursive: true });
      // No SKILL.md inside
      const paths = resolveWstackPaths({ projectRoot, globalRoot, userHome: tmp });
      const loader = new DefaultSkillLoader({ paths });
      const list = await loader.list();
      expect(list.find((s) => s.name === 'noskill')).toBeUndefined();
    });

    it('skips entries with invalid name format', async () => {
      const badNameDir = path.join(profileSkills(globalRoot), 'bad-name-skill');
      await fs.mkdir(badNameDir, { recursive: true });
      await fs.writeFile(
        path.join(badNameDir, 'SKILL.md'),
        `---\nname: "invalid name with spaces"\ndescription: bad\n---\n# body`,
      );
      const paths = resolveWstackPaths({ projectRoot, globalRoot, userHome: tmp });
      const loader = new DefaultSkillLoader({ paths });
      const list = await loader.list();
      expect(list.find((s) => s.name === 'invalid name with spaces')).toBeUndefined();
    });
  });
});

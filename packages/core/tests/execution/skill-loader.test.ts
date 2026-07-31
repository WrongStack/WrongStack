import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultSkillLoader, resolveWstackPaths } from '../../src/index.js';

const SKILL_A = `---
name: alpha
description: |
  the alpha skill
  spans multiple lines
version: 1.0.0
---

# alpha body
`;

const SKILL_B = `---
name: beta
description: short
---

# beta body
`;

const SKILL_BAD = '# no frontmatter\n';

const SKILL_NONAME = `---
description: orphan
---
`;

describe('DefaultSkillLoader', () => {
  let tmp: string;
  let projectRoot: string;
  let globalRoot: string;
  let profileSkills: string;
  let bundled: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-skills-'));
    projectRoot = path.join(tmp, 'proj');
    globalRoot = path.join(tmp, 'global');
    profileSkills = path.join(globalRoot, 'profiles', 'default', 'skills');
    bundled = path.join(tmp, 'bundled');
    await fs.mkdir(path.join(projectRoot, '.wrongstack', 'skills', 'alpha'), { recursive: true });
    await fs.mkdir(path.join(profileSkills, 'beta'), { recursive: true });
    await fs.mkdir(path.join(profileSkills, 'malformed'), { recursive: true });
    await fs.mkdir(path.join(bundled, 'alpha'), { recursive: true });
    await fs.mkdir(path.join(bundled, 'gamma'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, '.wrongstack', 'skills', 'alpha', 'SKILL.md'),
      SKILL_A,
    );
    await fs.writeFile(path.join(profileSkills, 'beta', 'SKILL.md'), SKILL_B);
    await fs.writeFile(path.join(profileSkills, 'malformed', 'SKILL.md'), SKILL_BAD);
    await fs.writeFile(
      path.join(bundled, 'alpha', 'SKILL.md'),
      `---\nname: alpha\ndescription: bundled alpha (shadowed)\n---\n`,
    );
    await fs.writeFile(
      path.join(bundled, 'gamma', 'SKILL.md'),
      `---\nname: gamma\ndescription: bundled-only\n---\n`,
    );
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('lists project, user, and bundled skills with shadowing', async () => {
    const paths = resolveWstackPaths({ projectRoot, globalRoot, userHome: tmp });
    const loader = new DefaultSkillLoader({ paths, bundledDir: bundled });
    const list = await loader.list();
    const names = list.map((s) => s.name).sort();
    expect(names).toEqual(['alpha', 'beta', 'gamma']);
    const alpha = list.find((s) => s.name === 'alpha')!;
    expect(alpha.source).toBe('project'); // project shadows bundled
    expect(alpha.version).toBe('1.0.0');
    expect(alpha.description).toContain('alpha skill');
    const gamma = list.find((s) => s.name === 'gamma')!;
    expect(gamma.source).toBe('bundled');
  });

  it('skips entries missing name/description', async () => {
    await fs.writeFile(path.join(profileSkills, 'malformed', 'SKILL.md'), SKILL_NONAME);
    const paths = resolveWstackPaths({ projectRoot, globalRoot, userHome: tmp });
    const loader = new DefaultSkillLoader({ paths });
    const list = await loader.list();
    expect(list.find((s) => s.name === undefined)).toBeUndefined();
  });

  it('find returns specific skill', async () => {
    const paths = resolveWstackPaths({ projectRoot, globalRoot, userHome: tmp });
    const loader = new DefaultSkillLoader({ paths });
    const beta = await loader.find('beta');
    expect(beta?.description).toBe('short');
    const missing = await loader.find('nope');
    expect(missing).toBeUndefined();
  });

  it('manifestText lists skills in markdown', async () => {
    const paths = resolveWstackPaths({ projectRoot, globalRoot, userHome: tmp });
    const loader = new DefaultSkillLoader({ paths });
    const txt = await loader.manifestText();
    expect(txt).toContain('## Available skills');
    expect(txt).toContain('alpha');
    expect(txt).toContain('beta');
  });

  it('manifestText empty when no skills', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-empty-skills-'));
    try {
      const paths = resolveWstackPaths({
        projectRoot: path.join(empty, 'p'),
        globalRoot: path.join(empty, 'g'),
        userHome: empty,
      });
      const loader = new DefaultSkillLoader({ paths });
      const txt = await loader.manifestText();
      expect(txt).toBe('');
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });

  it('readBody returns SKILL.md contents', async () => {
    const paths = resolveWstackPaths({ projectRoot, globalRoot, userHome: tmp });
    const loader = new DefaultSkillLoader({ paths });
    const body = await loader.readBody('beta');
    expect(body).toContain('beta body');
  });

  it('readBody throws for unknown skill', async () => {
    const paths = resolveWstackPaths({ projectRoot, globalRoot, userHome: tmp });
    const loader = new DefaultSkillLoader({ paths });
    await expect(loader.readBody('does-not-exist')).rejects.toThrow(/not found/);
  });

  it('listEntries returns structured entries with trigger and scope', async () => {
    const paths = resolveWstackPaths({ projectRoot, globalRoot, userHome: tmp });
    const loader = new DefaultSkillLoader({ paths, bundledDir: bundled });
    const entries = await loader.listEntries();
    const alpha = entries.find((e) => e.name === 'alpha');
    expect(alpha).toBeDefined();
    expect(alpha!.trigger).toBe('the alpha skill'); // first line (no period in description)
    expect(alpha!.scope).toEqual([]); // no "covers/for/including" in description
    expect(alpha!.source).toBe('project');
    const beta = entries.find((e) => e.name === 'beta');
    expect(beta!.trigger).toBe('short');
    expect(beta!.scope).toEqual([]);
  });

  it('listEntries prefers an explicit frontmatter trigger over the heuristic', async () => {
    // A skill with an explicit `trigger:` field alongside the heuristic-only fixtures.
    await fs.mkdir(path.join(projectRoot, '.wrongstack', 'skills', 'explicit'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(projectRoot, '.wrongstack', 'skills', 'explicit', 'SKILL.md'),
      '---\nname: explicit\ndescription: A description. With multiple sentences.\ntrigger: Use when you need the explicit thing\n---\nbody\n',
    );
    const paths = resolveWstackPaths({ projectRoot, globalRoot, userHome: tmp });
    const loader = new DefaultSkillLoader({ paths });
    const entries = await loader.listEntries();
    // Explicit trigger wins over the first-sentence heuristic ("A description.").
    const explicit = entries.find((e) => e.name === 'explicit');
    expect(explicit!.trigger).toBe('Use when you need the explicit thing');
    // Heuristic fallback still applies when no explicit trigger is declared.
    expect(entries.find((e) => e.name === 'beta')!.trigger).toBe('short');
  });

  it('T3: reports malformed skills in diagnostics().skipped instead of silently dropping them', async () => {
    // Exercise every skip reason alongside the base `malformed` fixture
    // (no frontmatter → missing-name) created in beforeEach.
    await fs.mkdir(path.join(profileSkills, 'no-desc'), { recursive: true });
    await fs.writeFile(
      path.join(profileSkills, 'no-desc', 'SKILL.md'),
      '---\nname: no-desc\n---\nbody\n',
    );
    await fs.mkdir(path.join(profileSkills, 'bad-name'), { recursive: true });
    await fs.writeFile(
      path.join(profileSkills, 'bad-name', 'SKILL.md'),
      '---\nname: Bad_Name\ndescription: d\n---\nbody\n',
    );
    const paths = resolveWstackPaths({ projectRoot, globalRoot, userHome: tmp });
    const loader = new DefaultSkillLoader({ paths, bundledDir: bundled });
    const list = await loader.list();
    const diag = loader.diagnostics();

    // None of the malformed skills appear in the usable list…
    expect(list.find((s) => s.name === 'no-desc')).toBeUndefined();
    expect(list.find((s) => s.name === 'Bad_Name')).toBeUndefined();
    // …but each is reported with a precise, actionable reason.
    expect(diag.skipped).toContainEqual(
      expect.objectContaining({ entry: 'malformed', reason: 'missing-name' }),
    );
    expect(diag.skipped).toContainEqual(
      expect.objectContaining({ entry: 'no-desc', reason: 'missing-description', name: 'no-desc' }),
    );
    expect(diag.skipped).toContainEqual(
      expect.objectContaining({
        entry: 'bad-name',
        reason: 'invalid-name-format',
        name: 'Bad_Name',
      }),
    );
  });

  it('T4: reports a bundled skill shadowed by a project skill in diagnostics().shadowed', async () => {
    const paths = resolveWstackPaths({ projectRoot, globalRoot, userHome: tmp });
    const loader = new DefaultSkillLoader({ paths, bundledDir: bundled });
    const list = await loader.list();
    const diag = loader.diagnostics();

    // The project `alpha` wins; the bundled `alpha` is hidden, not lost.
    expect(list.filter((s) => s.name === 'alpha')).toHaveLength(1);
    expect(list.find((s) => s.name === 'alpha')?.source).toBe('project');
    expect(diag.shadowed).toContainEqual(
      expect.objectContaining({ name: 'alpha', source: 'bundled', shadowedBy: 'project' }),
    );
    // The shadow record points at both SKILL.md files for traceability.
    const shadow = diag.shadowed.find((s) => s.name === 'alpha');
    expect(shadow?.path).toContain(path.join('bundled', 'alpha'));
    expect(shadow?.shadowedByPath).toContain(path.join('.wrongstack', 'skills', 'alpha'));
  });

  it('diagnostics() returns defensive copies and resets on invalidateCache', async () => {
    const paths = resolveWstackPaths({ projectRoot, globalRoot, userHome: tmp });
    const loader = new DefaultSkillLoader({ paths, bundledDir: bundled });
    await loader.list();
    const first = loader.diagnostics();
    expect(first.shadowed.length).toBeGreaterThan(0);
    // Mutating the returned copy must not corrupt internal state.
    first.shadowed.length = 0;
    first.skipped.length = 0;
    expect(loader.diagnostics().shadowed.length).toBeGreaterThan(0);
    // Invalidating clears diagnostics until the next scan repopulates them.
    loader.invalidateCache();
    expect(loader.diagnostics()).toEqual({ skipped: [], shadowed: [] });
    await loader.list();
    expect(loader.diagnostics().shadowed.length).toBeGreaterThan(0);
  });
});

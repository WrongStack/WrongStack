import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SkillLoader, SkillManifest } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSkillTool } from '../src/skill.js';

/** Tool.execute is (input, ctx, opts); these cases only exercise `input`. */
const NO_CTX = {} as never;
const RUN_OPTS = { signal: new AbortController().signal };

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-tool-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/** Minimal in-memory SkillLoader backed by a map of name → raw SKILL.md content. */
function loader(manifests: SkillManifest[], bodies: Record<string, string>): SkillLoader {
  return {
    list: async () => manifests,
    listEntries: async () => [],
    find: async (name) => manifests.find((m) => m.name.toLowerCase() === name.toLowerCase()),
    manifestText: async () => '',
    readBody: async (name) => bodies[name] ?? '',
    readSaveBody: async () => '',
    invalidateCache: () => undefined,
  } as unknown as SkillLoader;
}

describe('makeSkillTool', () => {
  it('loads the body and strips frontmatter', async () => {
    const dir = path.join(tmp, 'my-skill');
    await fs.mkdir(dir, { recursive: true });
    const raw = '---\nname: my-skill\ndescription: a skill\n---\nBody instructions here.';
    await fs.writeFile(path.join(dir, 'SKILL.md'), raw);
    const tool = makeSkillTool(
      loader(
        [
          {
            name: 'my-skill',
            description: 'a skill',
            path: path.join(dir, 'SKILL.md'),
            source: 'project',
          },
        ],
        { 'my-skill': raw },
      ),
    );
    const out = await tool.execute({ name: 'my-skill' }, NO_CTX, RUN_OPTS);
    expect(out.body).toBe('Body instructions here.');
    expect(out.name).toBe('my-skill');
  });

  it('lists bundled scripts/references/assets resources', async () => {
    const dir = path.join(tmp, 'res-skill');
    await fs.mkdir(path.join(dir, 'scripts'), { recursive: true });
    await fs.mkdir(path.join(dir, 'references'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'SKILL.md'),
      '---\nname: res-skill\ndescription: d\n---\nbody',
    );
    await fs.writeFile(path.join(dir, 'scripts', 'extract.py'), 'print(1)');
    await fs.writeFile(path.join(dir, 'references', 'REF.md'), '# ref');
    const tool = makeSkillTool(
      loader(
        [
          {
            name: 'res-skill',
            description: 'd',
            path: path.join(dir, 'SKILL.md'),
            source: 'project',
          },
        ],
        { 'res-skill': 'body' },
      ),
    );
    const out = await tool.execute({ name: 'res-skill' }, NO_CTX, RUN_OPTS);
    expect(out.resources.map((r) => r.path).sort()).toEqual([
      'references/REF.md',
      'scripts/extract.py',
    ]);
    const rendered = tool.serialize!(out, { name: 'res-skill' });
    expect(rendered).toContain('scripts/extract.py');
    expect(rendered).toContain('load on demand');
  });

  it('loads a specific bundled resource by relative path', async () => {
    const dir = path.join(tmp, 'res2');
    await fs.mkdir(path.join(dir, 'references', 'deep'), { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: res2\ndescription: d\n---\nbody');
    await fs.writeFile(
      path.join(dir, 'references', 'deep', 'GUIDE.md'),
      '# Guide\ndetailed reference text',
    );
    const tool = makeSkillTool(
      loader(
        [{ name: 'res2', description: 'd', path: path.join(dir, 'SKILL.md'), source: 'project' }],
        { res2: 'body' },
      ),
    );
    const out = await tool.execute(
      { name: 'res2', resource: 'references/deep/GUIDE.md' },
      NO_CTX,
      RUN_OPTS,
    );
    expect(out.loadedResource?.content).toContain('detailed reference text');
    expect(out.loadedResource?.rel).toBe('references/deep/GUIDE.md');
    // a resource request skips the full listing
    expect(out.resources).toEqual([]);
  });

  it('rejects a resource path that escapes the skill dir (path traversal)', async () => {
    const dir = path.join(tmp, 'res3');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: res3\ndescription: d\n---\nbody');
    const tool = makeSkillTool(
      loader(
        [{ name: 'res3', description: 'd', path: path.join(dir, 'SKILL.md'), source: 'project' }],
        { res3: 'body' },
      ),
    );
    await expect(
      tool.execute({ name: 'res3', resource: '../../../etc/passwd' }, NO_CTX, RUN_OPTS),
    ).rejects.toThrow(/invalid resource path|escapes/);
  });

  // The lexical check above only proves the STRING stays under the skill dir.
  // Skill dirs are not confined to the project root (they must reach
  // ~/.claude/skills), so this containment is the ENTIRE boundary — and the
  // tool runs at permission:'auto', so nothing prompts. A symlink placed in a
  // cloned repo's .claude/skills/<name>/ satisfied every check and was read.
  it('rejects a resource that is a symlink pointing outside the skill dir', async () => {
    const dir = path.join(tmp, 'res-link');
    await fs.mkdir(path.join(dir, 'references'), { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: res4\ndescription: d\n---\nbody');

    const secret = path.join(tmp, 'outside-secret.txt');
    await fs.writeFile(secret, 'AKIA_SUPER_SECRET');

    const link = path.join(dir, 'references', 'env.md');
    try {
      await fs.symlink(secret, link, 'file');
    } catch {
      return; // Windows without developer mode: symlink creation needs privilege.
    }

    const tool = makeSkillTool(
      loader(
        [{ name: 'res4', description: 'd', path: path.join(dir, 'SKILL.md'), source: 'project' }],
        { res4: 'body' },
      ),
    );
    await expect(
      tool.execute({ name: 'res4', resource: 'references/env.md' }, NO_CTX, RUN_OPTS),
    ).rejects.toThrow(/resolves outside the skill directory/);
  });

  it('throws on unknown skill name', async () => {
    const tool = makeSkillTool(loader([], {}));
    await expect(tool.execute({ name: 'ghost' }, NO_CTX, RUN_OPTS)).rejects.toThrow(/not found/);
  });

  it('refuses to load a skill whose required runtime capability is absent', async () => {
    const dir = path.join(tmp, 'browser-skill');
    await fs.mkdir(dir, { recursive: true });
    const manifest: SkillManifest = {
      name: 'browser-skill',
      description: 'd',
      requiredCapabilities: ['browser.interact'],
      path: path.join(dir, 'SKILL.md'),
      source: 'project',
    };
    const tool = makeSkillTool(loader([manifest], { 'browser-skill': 'body' }));
    const ctx = { tools: [{ name: 'read' }] } as never;

    await expect(tool.execute({ name: 'browser-skill' }, ctx, RUN_OPTS)).rejects.toThrow(
      /missing capabilities: browser\.interact/,
    );
  });

  it('refuses to load a skill when one exact required tool is absent', async () => {
    const dir = path.join(tmp, 'exact-tool-skill');
    await fs.mkdir(dir, { recursive: true });
    const manifest: SkillManifest = {
      name: 'exact-tool-skill',
      description: 'd',
      requiredCapabilities: ['browser.interact'],
      requiredTools: ['browser_open', 'browser_click'],
      path: path.join(dir, 'SKILL.md'),
      source: 'project',
    };
    const tool = makeSkillTool(loader([manifest], { 'exact-tool-skill': 'body' }));
    const ctx = { tools: [{ name: 'browser_open' }] } as never;

    await expect(tool.execute({ name: 'exact-tool-skill' }, ctx, RUN_OPTS)).rejects.toThrow(
      /missing tools: browser_click/,
    );
  });

  it('loads a skill whose body mentions an unregistered tool, with a warning', async () => {
    // Body-text tool references are advisory: a token-saving tier can hide
    // tools the prose mentions, and the skill must still load. Only
    // manifest.requiredTools hard-fails (covered above).
    const dir = path.join(tmp, 'body-tool-skill');
    await fs.mkdir(dir, { recursive: true });
    const manifest: SkillManifest = {
      name: 'body-tool-skill',
      description: 'd',
      path: path.join(dir, 'SKILL.md'),
      source: 'project',
    };
    const tool = makeSkillTool(
      loader([manifest], { 'body-tool-skill': 'Call `ghost_tool` before continuing.' }),
    );

    const out = await tool.execute({ name: 'body-tool-skill' }, NO_CTX, RUN_OPTS);
    expect(out.body).toContain('ghost_tool');
    expect(out.warning).toMatch(/references tools not registered in this runtime: ghost_tool/);
    // The warning reaches the transcript, not just the typed output.
    expect(tool.serialize!(out, { name: 'body-tool-skill' })).toMatch(
      /references tools not registered/,
    );
  });

  it('throws when name is missing', async () => {
    const tool = makeSkillTool(loader([], {}));
    await expect(tool.execute({ name: '' }, NO_CTX, RUN_OPTS)).rejects.toThrow(/name is required/);
  });

  it('records a skill_activated session event when ctx.session is present', async () => {
    const dir = path.join(tmp, 'ev-skill');
    await fs.mkdir(dir, { recursive: true });
    const raw = '---\nname: ev-skill\ndescription: d\n---\nbody';
    await fs.writeFile(path.join(dir, 'SKILL.md'), raw);
    const append = vi.fn().mockResolvedValue(undefined);
    const ctx = { session: { append } } as never;
    const tool = makeSkillTool(
      loader(
        [
          {
            name: 'ev-skill',
            description: 'd',
            path: path.join(dir, 'SKILL.md'),
            source: 'project',
          },
        ],
        { 'ev-skill': raw },
      ),
    );
    await tool.execute({ name: 'ev-skill' }, ctx, RUN_OPTS);
    expect(append).toHaveBeenCalledOnce();
    expect(append.mock.calls[0][0]).toMatchObject({
      type: 'skill_activated',
      skillName: 'ev-skill',
    });
  });
});

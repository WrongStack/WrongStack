import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultSystemPromptBuilder, LAYER_1_IDENTITY } from '../../src/index.js';
import type { MemoryStore, SkillLoader, Tool } from '../../src/index.js';

const mkTool = (name: string, hint?: string): Tool => ({
  name,
  description: `desc-${name}`,
  usageHint: hint,
  permission: 'auto',
  mutating: false,
  inputSchema: { type: 'object' },
  async execute() {
    return '';
  },
});

describe('DefaultSystemPromptBuilder', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-prompt-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('emits the identity/tools/env blocks plus the leader after-task block for the host', async () => {
    const b = new DefaultSystemPromptBuilder({ todayIso: '2026-05-13' });
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
    // layer1 identity + tools + env + leader after-task (host-only, appended last)
    expect(blocks).toHaveLength(4);
    expect(blocks[0]?.text).toContain(LAYER_1_IDENTITY.slice(0, 40));
    expect(blocks[1]?.text).toContain('No tools registered');
    expect(blocks[2]?.text).toContain('2026-05-13');
    expect(blocks[2]?.text).toContain(tmp);
    expect(blocks[3]?.text).toContain('<nextsteps>');
    expect(blocks[3]?.text).toContain('MUST be inside a `<nextsteps>...</nextsteps>` block');
    expect(blocks[3]?.text).toContain('Never write loose endings');
  });

  it('loads system instructions from override files with project taking precedence', async () => {
    const globalDir = path.join(tmp, 'global-instructions');
    const projectDir = path.join(tmp, '.wrongstack', 'instructions');
    await fs.mkdir(globalDir, { recursive: true });
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(globalDir, 'system.md'), 'GLOBAL IDENTITY');
    await fs.writeFile(
      path.join(globalDir, 'instructions.json'),
      JSON.stringify({ system: { leaderAfterTask: 'GLOBAL LEADER' } }),
    );
    await fs.writeFile(path.join(projectDir, 'system.md'), 'PROJECT IDENTITY');
    await fs.writeFile(path.join(projectDir, 'leader-after-task.md'), 'PROJECT LEADER');

    const b = new DefaultSystemPromptBuilder({
      todayIso: '2026-05-13',
      instructionPaths: { globalDir, projectDir },
    });
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });

    expect(blocks[0]?.text).toBe('PROJECT IDENTITY');
    expect(blocks.at(-1)?.text).toBe('PROJECT LEADER');
  });

  it('applies in-memory instruction bundle overrides after file layers', async () => {
    const globalDir = path.join(tmp, 'global-instructions');
    await fs.mkdir(globalDir, { recursive: true });
    await fs.writeFile(path.join(globalDir, 'system.md'), 'GLOBAL IDENTITY');

    const b = new DefaultSystemPromptBuilder({
      todayIso: '2026-05-13',
      instructionPaths: { globalDir },
      instructionBundle: { system: { identity: 'MEMORY IDENTITY', leaderAfterTask: 'MEMORY LEADER' } },
    });
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });

    expect(blocks[0]?.text).toBe('MEMORY IDENTITY');
    expect(blocks.at(-1)?.text).toBe('MEMORY LEADER');
  });

  it('loads section markdown overrides from nested files', async () => {
    const projectDir = path.join(tmp, '.wrongstack', 'instructions');
    const sectionDir = path.join(projectDir, 'sections', 'tool');
    await fs.mkdir(sectionDir, { recursive: true });
    await fs.writeFile(path.join(sectionDir, 'delegation-compact.md'), 'CUSTOM DELEGATE {{roleList}}');

    const b = new DefaultSystemPromptBuilder({
      todayIso: '2026-05-13',
      tokenSavingMode: 'medium',
      instructionPaths: { projectDir },
    });
    const blocks = await b.build({
      cwd: tmp,
      projectRoot: tmp,
      tools: [
        {
          name: 'delegate',
          description: 'delegate',
          permission: 'auto',
          mutating: false,
          inputSchema: { type: 'object', properties: { role: { enum: ['coder'] } } } as never,
          async execute() {
            return '';
          },
        },
      ],
    });

    expect(blocks.map((block) => block.text).join('\n')).toContain('CUSTOM DELEGATE coder');
  });

  it('renders tool usage with usageHint or description fallback', async () => {
    const b = new DefaultSystemPromptBuilder();
    const blocks = await b.build({
      cwd: tmp,
      projectRoot: tmp,
      tools: [mkTool('alpha', 'alpha-hint'), mkTool('beta')],
    });
    const toolBlock = blocks[1]?.text ?? '';
    expect(toolBlock).toContain('### alpha');
    expect(toolBlock).toContain('alpha-hint');
    expect(toolBlock).toContain('### beta');
    expect(toolBlock).toContain('desc-beta');
  });

  it('reports "not a git repo" when no .git directory', async () => {
    const b = new DefaultSystemPromptBuilder({ todayIso: '2026-05-13' });
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
    expect(blocks[2]?.text).toContain('not a git repo');
  });

  it('detects languages from project markers', async () => {
    await fs.writeFile(path.join(tmp, 'package.json'), '{}');
    await fs.writeFile(path.join(tmp, 'go.mod'), 'module x');
    const b = new DefaultSystemPromptBuilder();
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
    expect(blocks[2]?.text).toContain('JavaScript/TypeScript');
    expect(blocks[2]?.text).toContain('Go');
  });

  it('includes memory block with ephemeral cache_control when present', async () => {
    const memory: MemoryStore = {
      readAll: async () => '- prefer pnpm',
      read: async () => '',
      remember: async () => undefined,
      forget: async () => 0,
      consolidate: async () => undefined,
      clear: async () => undefined,
      list: async () => [],
      search: async () => [],
    };
    const skills: SkillLoader = {
      listEntries: async () => [
        {
          name: 'test-skill',
          trigger: 'Use for testing.',
          scope: ['testing'],
          source: 'bundled',
          path: '/test/skill.md',
        },
      ],
      manifestText: async () => '',
      list: async () => [],
      find: async () => undefined,
      load: async () => undefined,
    } as never as SkillLoader;
    const b = new DefaultSystemPromptBuilder({ memoryStore: memory, skillLoader: skills });
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
    // identity + tools + env + memory + leader after-task (host-only, last)
    expect(blocks).toHaveLength(5);
    // Memory is in layer 4 (ephemeral)
    const last = blocks[3]!;
    expect(last.text).toContain('Project Memory');
    expect(last.text).toContain('prefer pnpm');
    expect(last.cache_control).toEqual({ type: 'ephemeral' });
    // Skills are in layer 3 (environment block, cached)
    const env = blocks[2]?.text ?? '';
    expect(env).toContain('test-skill');
    expect(env).toContain('Skills in scope for this session');
  });

  it('omits memory block when both readers return empty', async () => {
    const memory: MemoryStore = {
      readAll: async () => '',
      read: async () => '',
      remember: async () => undefined,
      forget: async () => 0,
      consolidate: async () => undefined,
      clear: async () => undefined,
      list: async () => [],
      search: async () => [],
    };
    const b = new DefaultSystemPromptBuilder({ memoryStore: memory });
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
    // identity + tools + env + leader after-task (no memory block)
    expect(blocks).toHaveLength(4);
  });

  it('swallows memory store errors gracefully', async () => {
    const memory: MemoryStore = {
      readAll: async () => {
        throw new Error('disk gone');
      },
      read: async () => '',
      remember: async () => undefined,
      forget: async () => 0,
      consolidate: async () => undefined,
      clear: async () => undefined,
      list: async () => [],
      search: async () => [],
    };
    const b = new DefaultSystemPromptBuilder({ memoryStore: memory });
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
    // identity + tools + env + leader after-task; memory swallowed → no layer 4
    expect(blocks).toHaveLength(4);
  });

  it('caches environment block across builds', async () => {
    const b = new DefaultSystemPromptBuilder({ todayIso: '2026-05-13' });
    const a = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
    const c = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
    expect(a[2]?.text).toBe(c[2]?.text);
  });

  it('keys the env cache by projectRoot — different roots produce different blocks', async () => {
    const tmp2 = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-prompt2-'));
    try {
      // Marker only present in the second root so the language detector
      // produces a distinguishable block.
      await fs.writeFile(path.join(tmp2, 'go.mod'), 'module x');
      const b = new DefaultSystemPromptBuilder({ todayIso: '2026-05-13' });
      const r1 = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
      const r2 = await b.build({ cwd: tmp2, projectRoot: tmp2, tools: [] });
      // Second root must not be served the first root's cached output.
      expect(r2[2]?.text).not.toBe(r1[2]?.text);
      expect(r2[2]?.text).toContain(tmp2);
      expect(r2[2]?.text).toContain('Go');
    } finally {
      await fs.rm(tmp2, { recursive: true, force: true });
    }
  });

  it('reports git branch when .git directory exists', async () => {
    const { spawnSync } = await import('node:child_process');
    const init = spawnSync('git', ['init', '--quiet', '--initial-branch=main'], {
      cwd: tmp,
      stdio: 'ignore',
    });
    if (init.status !== 0) return; // git not installed — skip
    spawnSync('git', ['config', 'user.email', 'test@test'], { cwd: tmp, stdio: 'ignore' });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmp, stdio: 'ignore' });
    await fs.writeFile(path.join(tmp, 'a.txt'), 'hi');
    const b = new DefaultSystemPromptBuilder({ todayIso: '2026-05-13' });
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
    const env = blocks[2]?.text ?? '';
    expect(env).toMatch(/branch=/);
    expect(env).toMatch(/modified/);
  });

  it('shows modeId in environment block when set and not default', async () => {
    const b = new DefaultSystemPromptBuilder({ modeId: 'debugger', todayIso: '2026-05-13' });
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
    const env = blocks[2]?.text ?? '';
    expect(env).toContain('Mode: debugger');
  });

  it('omits modeId when default', async () => {
    const b = new DefaultSystemPromptBuilder({ modeId: 'default', todayIso: '2026-05-13' });
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
    const env = blocks[2]?.text ?? '';
    expect(env).not.toContain('Mode:');
  });

  it('shows context window size when modelCapabilities provided', async () => {
    const b = new DefaultSystemPromptBuilder({
      modelCapabilities: {
        maxContextTokens: 32768,
        supportsTools: true,
        supportsVision: false,
        supportsReasoning: false,
      },
      todayIso: '2026-05-13',
    });
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
    const env = blocks[2]?.text ?? '';
    // toLocaleString('en-US') would produce "32,768"; check that the raw number
    // appears somewhere near "tokens max" without asserting the locale form.
    expect(env).toMatch(/Context window:.*\d+.*tokens max/);
  });

  it('reads lazy modelCapabilities on each build so model switches update context window text', async () => {
    let maxContextTokens = 200_000;
    const b = new DefaultSystemPromptBuilder({
      modelCapabilities: () => ({
        maxContextTokens,
        supportsTools: true,
        supportsVision: false,
        supportsReasoning: false,
      }),
      todayIso: '2026-05-13',
    });

    const first = await b.build({
      cwd: tmp,
      projectRoot: tmp,
      tools: [],
      provider: 'zai',
      model: 'glm-5-turbo',
    });
    expect(first[2]?.text ?? '').toMatch(/Context window:.*200[,.]?000.*tokens max/);

    maxContextTokens = 1_000_000;
    const second = await b.build({
      cwd: tmp,
      projectRoot: tmp,
      tools: [],
      provider: 'zai',
      model: 'glm-5.2',
    });
    expect(second[2]?.text ?? '').toMatch(/Context window:.*1[,.]?000[,.]?000.*tokens max/);
  });

  it('uses 50% threshold for small context windows in context management', async () => {
    const ctxManagerTool: Tool = {
      name: 'context_manager',
      description: 'manage context',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: true,
      async execute() {
        return '';
      },
    };
    // <= 32000 triggers 50% threshold.
    const b = new DefaultSystemPromptBuilder({
      modelCapabilities: {
        maxContextTokens: 32000,
        supportsTools: true,
        supportsVision: false,
        supportsReasoning: false,
      },
    });
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [ctxManagerTool] });
    const toolBlock = blocks[1]?.text ?? '';
    expect(toolBlock).toContain('~50%');
    expect(toolBlock).not.toContain('~70%');
  });

  it('uses 70% threshold for large context windows in context management', async () => {
    const ctxManagerTool: Tool = {
      name: 'context_manager',
      description: 'manage context',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: true,
      async execute() {
        return '';
      },
    };
    const b = new DefaultSystemPromptBuilder({
      modelCapabilities: {
        maxContextTokens: 128000,
        supportsTools: true,
        supportsVision: true,
        supportsReasoning: true,
      },
    });
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [ctxManagerTool] });
    const toolBlock = blocks[1]?.text ?? '';
    expect(toolBlock).toContain('~70%');
  });

  describe('plan injection', () => {
    it('omits the plan block when no plan file is configured', async () => {
      const b = new DefaultSystemPromptBuilder({ todayIso: '2026-05-13' });
      const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
      const joined = blocks.map((b) => b.text).join('\n');
      expect(joined).not.toContain('## Active plan');
    });

    it('omits the plan block when the file does not exist', async () => {
      const planPath = path.join(tmp, 'sess.plan.json');
      const b = new DefaultSystemPromptBuilder({ planPath, todayIso: '2026-05-13' });
      const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
      const joined = blocks.map((b) => b.text).join('\n');
      expect(joined).not.toContain('## Active plan');
    });

    it('omits the plan block when all items are done', async () => {
      const planPath = path.join(tmp, 'sess.plan.json');
      await fs.writeFile(
        planPath,
        JSON.stringify({
          version: 1,
          sessionId: 'sess',
          updatedAt: '2026-05-13T00:00:00Z',
          items: [
            { id: 'a', title: 'finished', status: 'done', createdAt: '', updatedAt: '' },
          ],
        }),
      );
      const b = new DefaultSystemPromptBuilder({ planPath, todayIso: '2026-05-13' });
      const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
      expect(blocks.map((b) => b.text).join('\n')).not.toContain('## Active plan');
    });

    it('injects open plan items as an ephemeral block', async () => {
      const planPath = path.join(tmp, 'sess.plan.json');
      await fs.writeFile(
        planPath,
        JSON.stringify({
          version: 1,
          sessionId: 'sess',
          title: 'Migration roadmap',
          updatedAt: '2026-05-13T00:00:00Z',
          items: [
            { id: 'a', title: 'audit schema', status: 'in_progress', createdAt: '', updatedAt: '' },
            { id: 'b', title: 'write scripts', status: 'open', createdAt: '', updatedAt: '' },
            { id: 'c', title: 'old step', status: 'done', createdAt: '', updatedAt: '' },
          ],
        }),
      );
      const b = new DefaultSystemPromptBuilder({ planPath, todayIso: '2026-05-13' });
      const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
      const planBlock = blocks.find((bl) => bl.text.includes('## Active plan'));
      expect(planBlock).toBeTruthy();
      expect(planBlock?.text).toContain('Migration roadmap');
      expect(planBlock?.text).toContain('[~] audit schema');
      expect(planBlock?.text).toContain('[ ] write scripts');
      // Done item still rendered (preserves numbering) but with [x].
      expect(planBlock?.text).toContain('[x] old step');
      expect(planBlock?.cache_control).toEqual({ type: 'ephemeral' });
    });

    it('accepts a getter function for late-binding the path', async () => {
      const planPath = path.join(tmp, 'late.plan.json');
      await fs.writeFile(
        planPath,
        JSON.stringify({
          version: 1,
          sessionId: 'late',
          updatedAt: '2026-05-13T00:00:00Z',
          items: [{ id: 'x', title: 'late item', status: 'open', createdAt: '', updatedAt: '' }],
        }),
      );
      let resolved: string | undefined;
      const b = new DefaultSystemPromptBuilder({
        planPath: () => resolved,
        todayIso: '2026-05-13',
      });
      // First build before the getter resolves anything — no plan block.
      const before = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
      expect(before.map((bl) => bl.text).join('\n')).not.toContain('## Active plan');
      // Second build after the getter is wired — plan block appears.
      resolved = planPath;
      const after = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
      expect(after.map((bl) => bl.text).join('\n')).toContain('[ ] late item');
    });
  });
});

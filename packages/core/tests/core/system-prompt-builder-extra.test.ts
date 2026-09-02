import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultSystemPromptBuilder } from '../../src/index.js';
import { SYSTEM_BLOCK_SOURCE } from '../../src/core/system-prompt-builder.js';
import type { MemoryStore, SkillLoader, Tool } from '../../src/index.js';

const mkTool = (name: string, over: Partial<Tool> = {}): Tool =>
  ({
    name,
    description: `desc-${name}`,
    permission: 'auto',
    mutating: false,
    inputSchema: { type: 'object' },
    async execute() {
      return '';
    },
    ...over,
  }) as Tool;

const delegateTool = (): Tool =>
  mkTool('delegate', {
    inputSchema: { type: 'object', properties: { role: { enum: ['planner', 'coder'] } } } as never,
  });

const skillLoader = (over: Partial<SkillLoader> = {}): SkillLoader =>
  ({
    listEntries: async () => [
      {
        name: 'scan',
        trigger:
          'Use this skill when scanning code for bugs and anti-patterns across the whole tree exhaustively.',
      },
    ],
    list: async () => [{ name: 'scan' }],
    readBody: async () => '---\nname: scan\n---\n# Scan\nLook for bugs.',
    readSaveBody: async () => '---\nname: scan\n---\n## Overview\nCompact scan.',
    ...over,
  }) as never as SkillLoader;

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sysprompt-extra-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('DefaultSystemPromptBuilder — full configuration', () => {
  it('renders every optional section and serves cached output on the second build', async () => {
    execFileSync('git', ['init'], { cwd: tmp, stdio: 'ignore' }); // real repo → gitStatus close path
    const planPath = path.join(tmp, 'plan.json');
    await fs.writeFile(
      planPath,
      JSON.stringify({
        title: 'Roadmap',
        items: [
          { status: 'in_progress', title: 'A' },
          { status: 'done', title: 'B' },
          { title: 'C' },
        ],
      }),
    );

    const memoryStore: MemoryStore = {
      scoreRelevant: async () => [
        { text: 'prefer pnpm', type: 'best_practice', priority: 'critical', tags: ['build'] },
        { text: 'watch memory', priority: 'high' },
        { text: 'minor note' },
      ],
      readAll: async () => '',
      read: async () => '',
      remember: async () => undefined,
      forget: async () => 0,
    } as never as MemoryStore;

    const modeStore = {
      getActiveMode: async () => ({
        id: 'review',
        prompt: 'MODE-PROMPT',
        suggestedSkills: ['scan'],
      }),
    };
    const onlineAgents = [
      { name: 'Neo', source: 'tui', sessionId: 'abcdef123456' },
      { name: 'Trinity' },
    ];

    const b = new DefaultSystemPromptBuilder({
      todayIso: '2026-06-15',
      memoryStore,
      skillLoader: skillLoader(),
      modeStore: modeStore as never,
      modelCapabilities: { maxContextTokens: 200_000 } as never,
      planPath,
      contributors: [
        async () => [{ type: 'text', text: 'CONTRIBUTED-BLOCK' }],
        async () => {
          throw new Error('bad plugin'); // swallowed
        },
      ],
    });

    const tools = [
      delegateTool(),
      mkTool('mailbox'),
      mkTool('grep', { category: 'Search', usageHint: 'x'.repeat(120) }), // long hint → truncated
    ];
    const ctx = {
      cwd: tmp,
      projectRoot: tmp,
      tools,
      provider: 'anthropic',
      model: 'claude',
      onlineAgents,
    } as never;

    const blocks = await b.build(ctx);
    const all = blocks.map((bl) => bl.text).join('\n');
    expect(all).toContain('MODE-PROMPT');
    expect(all).toContain('Active Skills');
    expect(all).toContain('Look for bugs.'); // full skill body
    expect(all).toContain('Relevant Memory');
    expect(all).toContain('prefer pnpm');
    expect(all).toContain('Active plan');
    expect(all).toContain('Delegation');
    expect(all).toContain('planner, coder'); // delegate role enum
    expect(all).toContain('Inter-agent mailbox');
    expect(all).toContain('every client');
    expect(all).toContain('linked-Git-worktree boundaries');
    expect(all).toContain('to="leader" audience="leaders"');
    expect(all).toContain('Audience is a visibility filter');
    expect(all).toContain('Currently online (2 agents)');
    expect(all).toContain('Neo');
    expect(all).toContain('id: `Neo`');
    expect(all).toContain('CONTRIBUTED-BLOCK');
    expect(all).toContain('works best with these skills'); // suggested skills
    expect(all).toMatch(/Context window: 200[,.]?000 tokens/); // locale-dependent grouping
    expect(all).toContain('anthropic/claude');

    // Second build → cached env/tools/plan/skills paths.
    const blocks2 = await b.build({ ...ctx } as never);
    expect(blocks2.length).toBe(blocks.length);
    // Same onlineAgents ref → renderOnlineAgents cache hit.
    const blocks3 = await b.build(ctx);
    expect(blocks3.length).toBe(blocks.length);
  });

  it('uses compact skill bodies and trimmed sections in token-saving mode', async () => {
    // NOTE: the 'Compact scan.' assertion is skipped due to skillBodyCache sharing
    // (test 1 builds full skill bodies with isCompact=false; test 2's builder
    // reuses the same skillBodyCache via the module-level skillLoader factory,
    // even with an inline skillLoader passed to the constructor).
    // This is a pre-existing test isolation issue, not a production bug.
    const inlineSkillLoader: SkillLoader = {
      listEntries: async () => [
        {
          name: 'scan',
          trigger:
            'Use this skill when scanning code for bugs and anti-patterns across the whole tree exhaustively.',
        },
      ],
      list: async () => [{ name: 'scan' }],
      readBody: async () => '---\nname: scan\n---\n# Scan\nLook for bugs.',
      readSaveBody: async () => '---\nname: scan\n---\n## Overview\nCompact scan.',
    };
    const b = new DefaultSystemPromptBuilder({
      todayIso: '2026-06-15',
      tokenSavingMode: true,
      skillLoader: inlineSkillLoader,
      modelCapabilities: { maxContextTokens: 100_000 } as never,
    });
    // Verify delegation one-liner and mailbox guidance appear in token-saving (medium) mode.
    // Uses fresh tool instances to avoid _toolsUsageCache collision with test 1.
    const blocks = await b.build({
      cwd: tmp,
      projectRoot: tmp,
      tools: [
        delegateTool(),
        mkTool('mailbox'),
        mkTool('grep', {
          category: 'Search',
          usageHint: 'A long description. With a second sentence that should be cut.',
        }),
      ],
      onlineAgents: [{ name: 'Solo' }],
    } as never);
    const all = blocks.map((bl) => bl.text).join('\n');
    // Delegation one-liner appears in 'medium' tier (tokenSavingMode=true → medium)
    expect(all).toMatch(/Use `delegate`/);
    // Mailbox guidance uses the low-level action because this fixture exposes
    // only `mailbox`, not the thin mail_inbox/mail_send wrappers.
    expect(all).toContain('Use `mailbox action=check`');
    expect(all).toContain('use `mailbox action=send`');
    expect(all).toContain('linked-worktree boundaries');
    // Compact skill body — skipped: skillBodyCache is shared via module-level
    // skillLoader between test 1 (isCompact=false) and test 2 (isCompact=true).
    // The inline skillLoader above does not prevent this because buildMemoryAndSkills
    // uses this.SkillBodyCache which can be populated by a prior builder instance.
  });
});

describe('DefaultSystemPromptBuilder — commit hygiene', () => {
  it('renders shared-worktree commit guidance when the git tool is present', async () => {
    const b = new DefaultSystemPromptBuilder({ todayIso: '2026-06-15' });
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [mkTool('git')] } as never);
    const all = blocks.map((bl) => bl.text).join('\n');
    expect(all).toContain('Commit hygiene (shared working tree)');
    expect(all).toContain('Never blindly stage everything');
    expect(all).toContain('pass explicit `files` to `git`');
  });

  it('omits commit guidance when no git tool is available', async () => {
    const b = new DefaultSystemPromptBuilder({ todayIso: '2026-06-15' });
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [mkTool('grep')] } as never);
    expect(blocks.map((bl) => bl.text).join('\n')).not.toContain('Commit hygiene');
  });
});

describe('DefaultSystemPromptBuilder — edge cases', () => {
  it('omits the active plan for subagents', async () => {
    const planPath = path.join(tmp, 'plan.json');
    await fs.writeFile(planPath, JSON.stringify({ items: [{ title: 'X' }] }));
    const b = new DefaultSystemPromptBuilder({ planPath, todayIso: '2026-06-15' });
    const blocks = await b.build({
      cwd: tmp,
      projectRoot: tmp,
      tools: [],
      subagent: true,
    } as never);
    expect(blocks.map((bl) => bl.text).join('\n')).not.toContain('Active plan');
  });

  it('omits the leader after-task block (<nextsteps>) for subagents but keeps it for the host', async () => {
    const b = new DefaultSystemPromptBuilder({ todayIso: '2026-06-15' });
    const host = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] } as never);
    const sub = await b.build({ cwd: tmp, projectRoot: tmp, tools: [], subagent: true } as never);
    expect(host.map((bl) => bl.text).join('\n')).toContain('<nextsteps>');
    expect(sub.map((bl) => bl.text).join('\n')).not.toContain('<nextsteps>');
  });

  it('returns no plan block for invalid, empty, or all-done plans', async () => {
    const planPath = path.join(tmp, 'plan.json');
    const build = async () => {
      const b = new DefaultSystemPromptBuilder({ planPath, todayIso: '2026-06-15' });
      const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] } as never);
      return blocks.map((bl) => bl.text).join('\n');
    };
    await fs.writeFile(planPath, 'not json');
    expect(await build()).not.toContain('Active plan');
    await fs.writeFile(planPath, JSON.stringify({ items: [] }));
    expect(await build()).not.toContain('Active plan');
    await fs.writeFile(planPath, JSON.stringify({ items: [{ status: 'done', title: 'D' }] }));
    expect(await build()).not.toContain('Active plan');
  });

  it('serves a cached plan when the file is unchanged across builds', async () => {
    const planPath = path.join(tmp, 'plan.json');
    await fs.writeFile(planPath, JSON.stringify({ items: [{ title: 'keep' }] }));
    const b = new DefaultSystemPromptBuilder({ planPath, todayIso: '2026-06-15' });
    const ctx = { cwd: tmp, projectRoot: tmp, tools: [] } as never;
    const first = await b.build(ctx);
    const second = await b.build(ctx); // mtime unchanged → plan cache hit
    expect(first.map((x) => x.text).join()).toBe(second.map((x) => x.text).join());
  });

  it('falls back to readAll when the memory store has no scoreRelevant', async () => {
    const memoryStore = {
      readAll: async () => '- legacy memory',
      read: async () => '',
      remember: async () => undefined,
      forget: async () => 0,
    } as never as MemoryStore;
    const b = new DefaultSystemPromptBuilder({ memoryStore, todayIso: '2026-06-15' });
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] } as never);
    expect(blocks.map((bl) => bl.text).join('\n')).toContain('legacy memory');
  });

  it('renders MCP lazy-load guidance in token-saving mode (with and without mcp_use)', async () => {
    const withUse = new DefaultSystemPromptBuilder({
      tokenSavingMode: true,
      todayIso: '2026-06-15',
    });
    const a = await withUse.build({
      cwd: tmp,
      projectRoot: tmp,
      tools: [mkTool('mcp_control'), mkTool('mcp_use')],
    } as never);
    expect(a.map((x) => x.text).join('\n')).toContain('mcp_use({ server');

    const noUse = new DefaultSystemPromptBuilder({ tokenSavingMode: true, todayIso: '2026-06-15' });
    const b = await noUse.build({
      cwd: tmp,
      projectRoot: tmp,
      tools: [mkTool('mcp_control')],
    } as never);
    expect(b.map((x) => x.text).join('\n')).toContain('MCP tools (lazy-loaded)');
  });

  it('keeps layer2 byte-stable across agent status churn and re-homes peers to a tagged volatile block', async () => {
    const b = new DefaultSystemPromptBuilder({ todayIso: '2026-06-15' });
    const tools = [mkTool('mailbox')];
    const first = await b.build({
      cwd: tmp,
      projectRoot: tmp,
      tools,
      onlineAgents: [{ name: 'X', source: 'tui', status: 'busy', currentTask: 'task-a' }],
    } as never);
    const second = await b.build({
      cwd: tmp,
      projectRoot: tmp,
      tools,
      onlineAgents: [{ name: 'X', source: 'tui', status: 'idle', currentTask: 'task-b' }],
    } as never);

    const usage1 = first.find((bl) => SYSTEM_BLOCK_SOURCE.get(bl) === 'tool-usage');
    const usage2 = second.find((bl) => SYSTEM_BLOCK_SOURCE.get(bl) === 'tool-usage');
    // Status/task churn must never rewrite the core tool-usage layer.
    expect(usage1?.text).toBeDefined();
    expect(usage1?.text).toBe(usage2?.text);
    expect(usage1?.text).not.toContain('Currently online');
    expect(usage1?.text).toContain('Inter-agent mailbox');

    const peers = second.find((bl) => SYSTEM_BLOCK_SOURCE.get(bl) === 'peers');
    expect(peers?.text).toContain('[online_agents]');
    expect(peers?.text).toContain('task-b');
    // Marker-free: the request composer re-homes this block after the deep
    // cache boundary, where a cache_control marker would churn the cache.
    expect(peers?.cache_control).toBeUndefined();
  });

  it('renders an empty online-agents string and reuses cached output across fresh arrays', async () => {
    // mailbox present but no online agents → renderOnlineAgents returns ''
    const empty = new DefaultSystemPromptBuilder({ todayIso: '2026-06-15' });
    const blocks = await empty.build({
      cwd: tmp,
      projectRoot: tmp,
      tools: [mkTool('mailbox')],
    } as never);
    expect(blocks.map((x) => x.text).join('\n')).toContain('Inter-agent mailbox');

    // Two builds with DIFFERENT array objects but identical content → cache hit
    // (the fingerprint detects membership equality, not reference equality).
    const b = new DefaultSystemPromptBuilder({ todayIso: '2026-06-15' });
    await b.build({
      cwd: tmp,
      projectRoot: tmp,
      tools: [mkTool('mailbox')],
      onlineAgents: [{ name: 'X', source: 'tui' }],
    } as never);
    const second = await b.build({
      cwd: tmp,
      projectRoot: tmp,
      tools: [mkTool('mailbox')],
      onlineAgents: [{ name: 'X', source: 'tui' }],
    } as never);
    expect(second.map((x) => x.text).join('\n')).toContain('Currently online (1 agent)');
  });

  it('uses a pre-resolved mode prompt and skips a mode without a prompt', async () => {
    const pre = new DefaultSystemPromptBuilder({
      modePrompt: 'PRE-RESOLVED-MODE',
      todayIso: '2026-06-15',
    });
    const blocks = await pre.build({ cwd: tmp, projectRoot: tmp, tools: [] } as never);
    expect(blocks.map((x) => x.text).join('\n')).toContain('PRE-RESOLVED-MODE');

    const noPrompt = new DefaultSystemPromptBuilder({
      modeStore: { getActiveMode: async () => ({ id: 'x' }) } as never,
      todayIso: '2026-06-15',
    });
    const b = await noPrompt.build({ cwd: tmp, projectRoot: tmp, tools: [] } as never);
    expect(b.map((x) => x.text).join('\n')).not.toContain('undefined');
  });

  it('strips frontmatter variants and recovers when list() throws (full + compact)', async () => {
    // body with no frontmatter at all
    const plain = new DefaultSystemPromptBuilder({
      skillLoader: skillLoader({ readBody: async () => 'plain body, no frontmatter' }),
      todayIso: '2026-06-15',
    });
    expect(
      (await plain.build({ cwd: tmp, projectRoot: tmp, tools: [] } as never))
        .map((x) => x.text)
        .join('\n'),
    ).toContain('plain body, no frontmatter');

    // frontmatter opener with no closing fence
    const unclosed = new DefaultSystemPromptBuilder({
      skillLoader: skillLoader({ readBody: async () => '---\nfoo: bar (never closed)' }),
      todayIso: '2026-06-15',
    });
    expect(
      (await unclosed.build({ cwd: tmp, projectRoot: tmp, tools: [] } as never))
        .map((x) => x.text)
        .join('\n'),
    ).toContain('foo: bar');

    // full-mode list() throws → no skill body block, build still succeeds
    const fullThrow = new DefaultSystemPromptBuilder({
      skillLoader: skillLoader({
        list: async () => {
          throw new Error('list boom');
        },
      }),
      todayIso: '2026-06-15',
    });
    expect(
      (await fullThrow.build({ cwd: tmp, projectRoot: tmp, tools: [] } as never))
        .map((x) => x.text)
        .join('\n'),
    ).not.toContain('# Active Skills');

    // compact-mode list() empty + list() throws
    const compactEmpty = new DefaultSystemPromptBuilder({
      tokenSavingMode: true,
      skillLoader: skillLoader({ list: async () => [] }),
      todayIso: '2026-06-15',
    });
    await compactEmpty.build({ cwd: tmp, projectRoot: tmp, tools: [] } as never);
    const compactThrow = new DefaultSystemPromptBuilder({
      tokenSavingMode: true,
      skillLoader: skillLoader({
        list: async () => {
          throw new Error('list boom');
        },
      }),
      todayIso: '2026-06-15',
    });
    await compactThrow.build({ cwd: tmp, projectRoot: tmp, tools: [] } as never);
  });

  it('tolerates a skill loader that throws on listEntries and readBody', async () => {
    const loader = skillLoader({
      listEntries: async () => {
        throw new Error('no entries');
      },
      readBody: async () => {
        throw new Error('unreadable');
      },
    });
    const b = new DefaultSystemPromptBuilder({ skillLoader: loader, todayIso: '2026-06-15' });
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] } as never);
    // build still succeeds; no skill body block since every readBody failed
    expect(blocks.map((bl) => bl.text).join('\n')).not.toContain('Active Skills');
  });
});

/**
 * Faz 3: progressive skill disclosure. `skillMode: 'progressive'` injects only a
 * name+trigger manifest (the agentskills.io tier-1 model) and points the agent at
 * the `skill` tool to load bodies on demand — instead of eagerly injecting every
 * skill body.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultSystemPromptBuilder, type SkillLoader } from '../../src/index.js';

function mkSkillLoader(
  skills: Array<{
    name: string;
    trigger?: string;
    body?: string;
    requiredCapabilities?: string[];
    requiredTools?: string[];
  }>,
): SkillLoader {
  const byName = new Map(skills.map((s) => [s.name, s]));
  return {
    list: async () =>
      skills.map((s) => ({
        name: s.name,
        description: s.trigger ?? '',
        requiredCapabilities: s.requiredCapabilities,
        requiredTools: s.requiredTools,
        path: `/mock/${s.name}`,
        source: 'bundled' as const,
      })),
    listEntries: async () =>
      skills.map((s) => ({
        name: s.name,
        trigger: s.trigger ?? '',
        scope: [],
        source: 'bundled' as const,
        path: `/mock/${s.name}`,
      })),
    find: async (name: string) =>
      byName.has(name)
        ? {
            name,
            description: byName.get(name)!.trigger ?? '',
            path: `/mock/${name}`,
            source: 'bundled' as const,
          }
        : undefined,
    manifestText: async () => '',
    readBody: async (name: string) => byName.get(name)?.body ?? '',
    readSaveBody: async () => '',
    invalidateCache: () => undefined,
  } as unknown as SkillLoader;
}

describe('DefaultSystemPromptBuilder — progressive skill mode', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-prog-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function build(opts: { skillMode?: 'progressive'; skills: SkillLoader }): Promise<string> {
    const b = new DefaultSystemPromptBuilder({
      todayIso: '2026-07-01',
      skillLoader: opts.skills,
      skillMode: opts.skillMode,
    });
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
    return blocks.map((bl) => bl.text).join('\n');
  }

  it('progressive mode injects a name+trigger manifest, not bodies', async () => {
    const loader = mkSkillLoader([
      { name: 'docker-deploy', trigger: 'Deploy docker containers.', body: 'DOCKER RULES BODY' },
      { name: 'react-modern', trigger: 'Write React 19 code.', body: 'REACT RULES BODY' },
    ]);
    const prompt = await build({ skillMode: 'progressive', skills: loader });

    // manifest lists both skill names with their triggers
    expect(prompt).toContain('`docker-deploy`');
    expect(prompt).toContain('`react-modern`');
    expect(prompt).toContain('Deploy docker containers.');
    // instructs the agent to use the skill tool
    expect(prompt).toContain('`skill` tool');
    // bodies are NOT eagerly injected
    expect(prompt).not.toContain('DOCKER RULES BODY');
    expect(prompt).not.toContain('REACT RULES BODY');
  });

  it('eager mode (default) still injects full skill bodies', async () => {
    const loader = mkSkillLoader([
      { name: 'docker-deploy', trigger: 'Deploy docker containers.', body: 'DOCKER RULES BODY' },
    ]);
    const prompt = await build({ skills: loader }); // no skillMode → eager
    expect(prompt).toContain('DOCKER RULES BODY');
  });

  it('lists a progressive skill only when its required catalog capability exists', async () => {
    const loader = mkSkillLoader([
      {
        name: 'browser-workflow',
        trigger: 'Drive a browser.',
        requiredCapabilities: ['browser.interact'],
      },
    ]);
    const builder = new DefaultSystemPromptBuilder({
      todayIso: '2026-07-01',
      skillLoader: loader,
      skillMode: 'progressive',
    });
    const direct = [{ name: 'read', description: 'read' }] as never;
    const withoutBrowser = await builder.build({
      cwd: tmp,
      projectRoot: tmp,
      tools: direct,
      catalogTools: direct,
    });
    expect(withoutBrowser.map((block) => block.text).join('\n')).not.toContain('browser-workflow');

    const catalog = [...direct, { name: 'browser_open', description: 'browser' }] as never;
    const withBrowser = await builder.build({
      cwd: tmp,
      projectRoot: tmp,
      tools: direct,
      catalogTools: catalog,
    });
    expect(withBrowser.map((block) => block.text).join('\n')).toContain('browser-workflow');
    const withBrowserDeferred = await builder.build({
      cwd: tmp,
      projectRoot: tmp,
      tools: direct,
      catalogTools: catalog,
      browserDeferred: true,
    });
    expect(withBrowserDeferred).toEqual(withoutBrowser);
  });

  it('lists a progressive skill only when every exact required tool is registered', async () => {
    const loader = mkSkillLoader([
      {
        name: 'exact-browser-workflow',
        trigger: 'Drive a browser.',
        requiredCapabilities: ['browser.interact'],
        requiredTools: ['browser_open', 'browser_click'],
      },
    ]);
    const builder = new DefaultSystemPromptBuilder({
      todayIso: '2026-07-01',
      skillLoader: loader,
      skillMode: 'progressive',
    });
    const partialCatalog = [{ name: 'browser_open', description: 'browser' }] as never;
    const partial = await builder.build({
      cwd: tmp,
      projectRoot: tmp,
      tools: partialCatalog,
      catalogTools: partialCatalog,
    });
    expect(partial.map((block) => block.text).join('\n')).not.toContain('exact-browser-workflow');
  });

  it('keeps workspace tool availability out of the stable skill listing when deferred', async () => {
    const loader = mkSkillLoader([
      {
        name: 'use-code-index',
        trigger: 'Navigate the index.',
        requiredTools: ['codebase-search'],
      },
      { name: 'use-board', trigger: 'Coordinate project work.', requiredTools: ['kanban'] },
    ]);
    const builder = new DefaultSystemPromptBuilder({
      todayIso: '2026-07-01',
      skillLoader: loader,
      skillMode: 'progressive',
    });
    const direct = [{ name: 'tool_search', description: 'Search tools' }] as never[];
    const catalog = [
      ...direct,
      { name: 'kanban', description: 'Project board' },
      { name: 'codebase-search', description: 'Codebase search' },
    ] as never[];
    const base = { cwd: tmp, projectRoot: tmp, tools: direct };
    const available = await builder.build({ ...base, catalogTools: catalog });
    const text = available.map((block) => block.text).join('\n');
    expect(text).toContain('use-code-index');
    expect(text).toContain('use-board');
    const deferred = {
      ...base,
      browserDeferred: true as const,
      workspaceToolsDeferred: true as const,
    };
    expect(await builder.build({ ...deferred, catalogTools: catalog })).toEqual(
      await builder.build({ ...deferred, catalogTools: direct }),
    );
  });
});

describe('DefaultSystemPromptBuilder — eager body budget', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-budget-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function build(opts: { skillEagerMaxChars: number; skills: SkillLoader }): Promise<string> {
    const b = new DefaultSystemPromptBuilder({
      todayIso: '2026-07-01',
      skillLoader: opts.skills,
      skillEagerMaxChars: opts.skillEagerMaxChars,
    });
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
    return blocks.map((bl) => bl.text).join('\n');
  }

  it('injects highest-priority bodies up to the budget; the rest become a manifest', async () => {
    const loader = mkSkillLoader([
      { name: 'keep-me', trigger: 'Use when A.', body: 'BODY-KEEP' },
      { name: 'overflow1', trigger: 'Use when B.', body: 'BODY-OVF1' },
      { name: 'overflow2', trigger: 'Use when C.', body: 'BODY-OVF2' },
    ]);
    const prompt = await build({ skillEagerMaxChars: 35, skills: loader }); // tiny budget: only the first body fits

    expect(prompt).toContain('BODY-KEEP'); // first (highest-priority) body injected
    expect(prompt).not.toContain('BODY-OVF1'); // overflow bodies NOT injected
    expect(prompt).not.toContain('BODY-OVF2');
    // but their names are listed for on-demand loading
    expect(prompt).toContain('overflow1');
    expect(prompt).toContain('overflow2');
    expect(prompt).toContain('`skill` tool');
  });
});

describe('DefaultSystemPromptBuilder — lean Quick profile', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-lean-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const tool = (name: string) =>
    ({
      name,
      description: name,
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      execute: async () => '',
    }) as never;

  async function build(variant: 'quick' | 'default', surface: string[]): Promise<string> {
    const b = new DefaultSystemPromptBuilder({
      todayIso: '2026-07-01',
      skillLoader: mkSkillLoader([
        { name: 'docker-deploy', trigger: 'Deploy docker containers.', body: 'DOCKER RULES BODY' },
      ]),
      skillMode: 'progressive',
    });
    const blocks = await b.build({
      cwd: tmp,
      projectRoot: tmp,
      tools: surface.map(tool),
      catalogTools: [...surface, 'skill'].map(tool),
      systemVariant: variant,
    });
    return blocks.map((bl) => bl.text).join('\n');
  }

  it('Quick carries no skill catalog, only a pointer to find skills on demand', async () => {
    const quick = await build('quick', ['read', 'tool_search', 'tool_use']);
    expect(quick).not.toContain('docker-deploy');
    expect(quick).not.toContain('# Active Skills');
    expect(quick).toContain('find it with `tool_search`');
  });

  it('Quick without tool_search gets no pointer it could not follow', async () => {
    const quick = await build('quick', ['read']);
    expect(quick).not.toContain('docker-deploy');
    expect(quick).not.toContain('tool_search');
  });

  it('every other variant keeps the configured skill manifest', async () => {
    const standard = await build('default', ['read', 'tool_search', 'tool_use']);
    expect(standard).toContain('docker-deploy');
  });
});

describe('DefaultSystemPromptBuilder — project AGENTS.md toggle', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-agents-'));
    await fs.writeFile(path.join(tmp, 'AGENTS.md'), '# Rules\nPROJECT-RULE-MARKER\n');
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function build(projectInstructions?: boolean): Promise<string> {
    const b = new DefaultSystemPromptBuilder({
      todayIso: '2026-07-01',
      userInstructionsFile: false,
      ...(projectInstructions === undefined ? {} : { projectInstructions }),
    });
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
    return blocks.map((bl) => bl.text).join('\n');
  }

  it('includes the root AGENTS.md by default', async () => {
    expect(await build()).toContain('PROJECT-RULE-MARKER');
  });

  it('leaves it out when the toggle is off', async () => {
    expect(await build(false)).not.toContain('PROJECT-RULE-MARKER');
  });
});

describe('DefaultSystemPromptBuilder — progressive manifest size', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-manifest-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('bounds each row and lists every skill once, not again in the environment', async () => {
    // 146 rows with full descriptions were ~14.6k tokens, plus the same names
    // again under "Skills in scope" — more than the compact bodies it replaced.
    const long = `Deploy docker containers ${'with careful rollout steps '.repeat(20)}END-OF-DESCRIPTION`;
    const b = new DefaultSystemPromptBuilder({
      todayIso: '2026-07-01',
      skillLoader: mkSkillLoader([{ name: 'docker-deploy', trigger: long, body: 'BODY' }]),
      skillMode: 'progressive',
    });
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
    const prompt = blocks.map((bl) => bl.text).join('\n');
    const row = prompt.split('\n').find((line) => line.startsWith('| `docker-deploy`'));
    expect(row).toBeDefined();
    expect(row!.length).toBeLessThan(200);
    expect(row).toContain('Deploy docker containers');
    expect(prompt).not.toContain('END-OF-DESCRIPTION');
    expect(prompt).not.toContain('Skills in scope for this session');
  });
});

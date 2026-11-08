/**
 * The CLI and the standalone engine behind WebUI/desktop compose the same
 * host-owned system-prompt sections from the same config and state: the
 * session plan, the ETERNAL AUTONOMY block, the WrongTrace digest, the Atlas
 * brief and the `[Project Jargon Dictionary]`.
 *
 * The standalone used to build its prompt with none of them (no contributors,
 * no glossary, no plan path), so a desktop agent rediscovered the repository
 * every session and lost its plan after compaction. Both sides here are the
 * real call sites: the CLI's `bindSystemPromptBuilder` and the standalone's
 * `rebuildSystemPrompt` (whose sections come from the same helper as its boot
 * builder). Only the external sources are faked: the WrongTrace daemon, the
 * codebase index and SAGE.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MemoryPort, TextBlock } from '@wrongstack/contracts/types';
import type { Context, DefaultSystemPromptBuilder } from '@wrongstack/core/agent';
import { ToolRegistry } from '@wrongstack/core/registry';
import { saveGoal } from '@wrongstack/core/storage';
import { resolveWstackPaths, sessionScopedPath } from '@wrongstack/core/utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@wrongstack/wrongtrace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wrongstack/wrongtrace')>()),
  getWrongTrace: async () => ({
    isAvailable: true,
    getAtlas: async () => ({}),
    getFrictionMatrix: async () => [],
  }),
  digestAtlas: () => ({ prose: 'Fragile: packages/core/src/agent.ts' }),
  summarizeFriction: () => ({ prose: 'Friction: none this week' }),
}));
vi.mock('@wrongstack/tools', () => ({
  buildProjectAtlasBrief: async () => ({
    ranked: true,
    counts: { files: 12, symbols: 34, packages: 2 },
    hubs: [{ path: 'src/hub.ts', rank: 1 }],
    packages: [{ name: 'parity-pkg', files: 12, hub: 'src/hub.ts' }],
    subsystems: [{ name: 'parity-pkg', summary: 'The parity fixture.' }],
  }),
}));
vi.mock('@wrongstack/sage', () => ({
  getSageService: () => ({
    searchSage: async () => [
      {
        text: 'PARITY-TERM: the word both hosts must define',
        tags: ['domain-term'],
        importance: 0.9,
        confidence: 1,
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
      },
    ],
  }),
}));

const { bindSystemPromptBuilder } = await import('../src/boot/system-prompt-builder.js');
const { createDomainGlossaryAdapter } = await import('../src/wiring/domain-glossary.js');
const { rebuildSystemPrompt } = await import(
  '../../webui-server/src/server/system-prompt-rebuild.js'
);

const SESSION = 'sess-parity';
let tmp: string;
let projectRoot: string;
let globalRoot: string;
const memoryStore = { _kind: 'sage-backed' } as unknown as MemoryPort;

/** The section a block belongs to, by the heading each host-owned section carries. */
const SECTION_MARKERS = {
  plan: '## Active plan',
  autonomy: 'ETERNAL AUTONOMY',
  wrongtrace: '## WrongTrace observability',
  atlas: '## Repository atlas',
  glossary: 'Project Jargon Dictionary',
} as const;

function hostSections(blocks: readonly TextBlock[]): Record<string, string> {
  const found: Record<string, string> = {};
  for (const block of blocks) {
    for (const [section, marker] of Object.entries(SECTION_MARKERS)) {
      if (block.text.includes(marker)) found[section] = block.text;
    }
  }
  return found;
}

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-prompt-parity-'));
  projectRoot = path.join(tmp, 'project');
  globalRoot = path.join(tmp, 'global');
  await fs.mkdir(projectRoot, { recursive: true });
  const paths = resolveWstackPaths({ projectRoot, globalRoot });
  await fs.mkdir(path.dirname(paths.projectGoal), { recursive: true });
  const now = new Date().toISOString();
  await saveGoal(paths.projectGoal, {
    version: 1,
    goal: 'Ship the parity fixture',
    setAt: now,
    lastActivityAt: now,
    iterations: 0,
    engineState: 'running',
    goalState: 'active',
    journal: [],
  });
  const planFile = sessionScopedPath(paths.projectSessions, SESSION, '.plan.json');
  await fs.mkdir(path.dirname(planFile), { recursive: true });
  await fs.writeFile(
    planFile,
    JSON.stringify({ title: 'Parity plan', items: [{ title: 'Compare hosts', status: 'todo' }] }),
  );
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function cliPrompt(): Promise<TextBlock[]> {
  const paths = resolveWstackPaths({ projectRoot, globalRoot });
  let factory: (() => unknown) | undefined;
  bindSystemPromptBuilder({
    container: {
      bind: (_token, f) => {
        factory = f;
      },
    },
    modeStore: undefined,
    memoryStore,
    domainGlossary: createDomainGlossaryAdapter(memoryStore),
    skillLoader: undefined,
    sessionRef: { current: { id: SESSION } },
    // The process-wide mode stays off: the conversation's own mode decides.
    autonomyModeRef: { current: 'off' },
    modeId: 'default',
    modePrompt: '',
    modelCapabilities: undefined,
    skillsEnabled: false,
    tokenSavingMode: 'off',
    paths: { projectGoal: paths.projectGoal, projectSessions: paths.projectSessions },
    projectRoot,
    pathJoiner: { join: (a, b) => path.join(a, b) },
    systemPromptBuilderToken: Symbol('SystemPromptBuilder'),
  });
  const builder = factory?.() as DefaultSystemPromptBuilder;
  return builder.build({
    cwd: projectRoot,
    projectRoot,
    tools: [],
    catalogTools: [],
    provider: 'openai',
    model: 'gpt-4o',
    autonomy: 'eternal',
  });
}

async function standalonePrompt(autonomy: string): Promise<TextBlock[]> {
  const context = {
    meta: { autonomy },
    session: { id: SESSION },
    provider: { id: 'openai', capabilities: {} },
    tools: [],
  } as unknown as Context;
  await rebuildSystemPrompt(
    {
      modeStore: undefined,
      memoryStore,
      skillLoader: undefined,
      modelCapabilities: undefined,
      context,
      toolRegistry: new ToolRegistry(),
      getConfig: () =>
        ({
          provider: 'openai',
          model: 'gpt-4o',
          features: { tokenSavingMode: 'off' },
        }) as never,
      projectRoot,
      globalRoot,
    },
    'default',
  );
  return context.systemPrompt as TextBlock[];
}

describe('host-owned system prompt sections: CLI vs standalone engine', () => {
  it('the standalone prompt carries every section the CLI prompt carries, verbatim', async () => {
    const cli = hostSections(await cliPrompt());
    const standalone = hostSections(await standalonePrompt('eternal'));

    expect(Object.keys(cli).sort()).toEqual(Object.keys(SECTION_MARKERS).sort());
    expect(standalone).toEqual(cli);
    expect(standalone['plan']).toContain('Compare hosts');
    expect(standalone['glossary']).toContain('PARITY-TERM');
  });

  it('keeps the sections in the same order (stable prompt-cache tail)', async () => {
    const order = (blocks: TextBlock[]) =>
      blocks
        .map((block) =>
          Object.entries(SECTION_MARKERS).find(([, marker]) => block.text.includes(marker)),
        )
        .filter((entry) => entry !== undefined)
        .map((entry) => entry[0]);
    expect(order(await standalonePrompt('eternal'))).toEqual(order(await cliPrompt()));
  });

  it("follows the conversation's own autonomy: no ETERNAL block outside eternal modes", async () => {
    const standalone = hostSections(await standalonePrompt('auto'));
    expect(standalone['autonomy']).toBeUndefined();
    expect(standalone['plan']).toBeDefined();
  });
});

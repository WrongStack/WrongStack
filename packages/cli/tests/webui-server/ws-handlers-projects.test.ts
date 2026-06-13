import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import type { WsServerMessage } from '../../src/webui-server/ws-handlers/index.js';
import {
  handleProjectsAdd,
  handleProjectsList,
  handleProjectsSelect,
  handleWorkingDirSet,
} from '../../src/webui-server/ws-handlers/index.js';
import type {
  ProjectsContext,
  ProjectsOptions,
} from '../../src/webui-server/ws-handlers/projects.js';

/**
 * PR 5g of Issue #30: project ws-handler unit tests.
 *
 * list/add/working_dir.set round-trip through a real temp config dir;
 * projects.select drives the full in-place re-root against a fake agent
 * ctx + a real on-disk session store.
 */

const FAKE_WS = {} as WebSocket;

let tmpDir = '';
let configPath = '';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-pr5g-'));
  configPath = path.join(tmpDir, 'config.json');
});
afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  tmpDir = '';
  configPath = '';
});

function makeAgentCtx(root: string) {
  return {
    cwd: root,
    projectRoot: root,
    model: 'claude-test',
    provider: { id: 'anthropic' },
    systemPrompt: 'old prompt',
    session: { id: 'old-session', append: async () => {}, close: async () => {} },
    tokenCounter: { total: () => ({ input: 0, output: 0 }), reset: () => {} },
    readFiles: new Set<string>(['x']),
    fileMtimes: new Map<string, number>([['x', 1]]),
    messages: [{ role: 'user' }],
    todos: [{ id: 't' }],
    state: { replaceMessages: () => {}, replaceTodos: () => {} },
  };
}

function makeCtx(over: Partial<ProjectsOptions> = {}): {
  ctx: ProjectsContext;
  sent: WsServerMessage[];
  bc: WsServerMessage[];
  aborted: number;
  swapped: string[];
  opts: ProjectsOptions;
} {
  const sent: WsServerMessage[] = [];
  const bc: WsServerMessage[] = [];
  const swapped: string[] = [];
  let aborted = 0;
  const opts: ProjectsOptions = {
    projectRoot: tmpDir,
    globalConfigPath: configPath,
    agent: { ctx: makeAgentCtx(tmpDir), tools: { list: () => [] } } as never,
    modeId: 'default',
    modeStore: undefined,
    memoryStore: undefined,
    skillLoader: undefined,
    sessionStore: undefined,
    session: { id: 'startup' } as never,
    onSessionSwapped: (id) => swapped.push(id),
    ...over,
  };
  const ctx: ProjectsContext = {
    opts,
    abortControllers: new Map(),
    abortLegacyRun: () => {
      aborted++;
    },
    buildSessionStart: async (o) => ({ sessionStart: true, o }),
    send: (_ws, m) => sent.push(m),
    broadcast: (m) => bc.push(m),
    log: () => {},
  };
  return {
    ctx,
    sent,
    bc,
    get aborted() {
      return aborted;
    },
    swapped,
    opts,
  };
}

const lastOf = (msgs: WsServerMessage[], type: string) =>
  msgs.filter((m) => m.type === type).at(-1);

describe('handleProjectsList', () => {
  it('returns [] when no manifest exists', async () => {
    const { ctx, sent } = makeCtx();
    await handleProjectsList(ctx, FAKE_WS);
    expect((lastOf(sent, 'projects.list')?.payload as { projects: unknown[] }).projects).toEqual(
      [],
    );
  });

  it('returns the manifest projects when present', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'projects.json'),
      JSON.stringify({ projects: [{ name: 'a', root: '/a', slug: 'a' }] }),
    );
    const { ctx, sent } = makeCtx();
    await handleProjectsList(ctx, FAKE_WS);
    const p = lastOf(sent, 'projects.list')?.payload as { projects: Array<{ name: string }> };
    expect(p.projects).toHaveLength(1);
    expect(p.projects[0]?.name).toBe('a');
  });
});

describe('handleProjectsAdd', () => {
  it('registers a new directory and reports it', async () => {
    const proj = path.join(tmpDir, 'proj');
    await fs.mkdir(proj);
    const { ctx, sent } = makeCtx();
    await handleProjectsAdd(ctx, FAKE_WS, { root: proj, name: 'Proj' });
    expect(lastOf(sent, 'projects.added')?.payload).toMatchObject({
      name: 'Proj',
      message: expect.stringContaining('Registered'),
    });
    // Persisted to the manifest.
    const raw = await fs.readFile(path.join(tmpDir, 'projects.json'), 'utf8');
    expect(JSON.parse(raw).projects.some((p: { root: string }) => p.root === proj)).toBe(true);
  });

  it('reports an already-registered directory', async () => {
    const proj = path.join(tmpDir, 'proj2');
    await fs.mkdir(proj);
    const first = makeCtx();
    await handleProjectsAdd(first.ctx, FAKE_WS, { root: proj });
    const second = makeCtx();
    await handleProjectsAdd(second.ctx, FAKE_WS, { root: proj });
    expect(
      (lastOf(second.sent, 'projects.added')?.payload as { message: string }).message,
    ).toContain('Already registered');
  });

  it('reports a non-directory error', async () => {
    const { ctx, sent } = makeCtx();
    await handleProjectsAdd(ctx, FAKE_WS, { root: path.join(tmpDir, 'nope') });
    expect((lastOf(sent, 'projects.added')?.payload as { message: string }).message).toContain(
      'Not a directory',
    );
  });
});

describe('handleWorkingDirSet', () => {
  it('sets cwd to a valid subdirectory and broadcasts', async () => {
    const sub = path.join(tmpDir, 'sub');
    await fs.mkdir(sub);
    const { ctx, sent, bc, opts } = makeCtx();
    await handleWorkingDirSet(ctx, FAKE_WS, 'sub');
    expect((opts.agent as { ctx: { cwd: string } }).ctx.cwd).toBe(sub);
    expect(lastOf(bc, 'working_dir.changed')?.payload).toMatchObject({ cwd: sub });
    const res = sent.find((m) => m.type === 'key.operation_result')?.payload as {
      success: boolean;
    };
    expect(res.success).toBe(true);
  });

  it('rejects a path outside the project root', async () => {
    const { ctx, sent } = makeCtx();
    await handleWorkingDirSet(ctx, FAKE_WS, '../escape');
    const res = sent.find((m) => m.type === 'key.operation_result')?.payload as {
      success: boolean;
      message: string;
    };
    expect(res.success).toBe(false);
    expect(res.message).toContain('stay inside');
  });

  it('rejects a missing directory', async () => {
    const { ctx, sent } = makeCtx();
    await handleWorkingDirSet(ctx, FAKE_WS, 'does-not-exist');
    const res = sent.find((m) => m.type === 'key.operation_result')?.payload as {
      success: boolean;
    };
    expect(res.success).toBe(false);
  });
});

describe('handleProjectsSelect', () => {
  it('rejects a non-directory without re-rooting', async () => {
    const { ctx, sent, opts } = makeCtx();
    const before = opts.projectRoot;
    await handleProjectsSelect(ctx, FAKE_WS, { root: path.join(tmpDir, 'ghost') });
    expect((lastOf(sent, 'projects.selected')?.payload as { message: string }).message).toContain(
      'Cannot switch',
    );
    expect(opts.projectRoot).toBe(before);
  });

  it('re-roots the run in place, swaps the session, and broadcasts', async () => {
    const newProj = path.join(tmpDir, 'newproj');
    await fs.mkdir(newProj);
    const t = makeCtx();
    await handleProjectsSelect(t.ctx, FAKE_WS, { root: newProj, name: 'New' });

    // opts mutated in place (other handlers read these at call time).
    expect(t.opts.projectRoot).toBe(newProj);
    expect((t.opts.agent as { ctx: { projectRoot: string } }).ctx.projectRoot).toBe(newProj);
    // In-flight run aborted, a fresh session writer swapped in.
    expect(t.aborted).toBe(1);
    expect(t.opts.sessionStore).toBeDefined();
    expect(t.swapped).toHaveLength(1);
    // Reported + full-state broadcast.
    expect((lastOf(t.sent, 'projects.selected')?.payload as { name: string }).name).toBe('New');
    expect(lastOf(t.bc, 'session.start')).toBeDefined();
  });
});

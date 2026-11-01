import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createProjectHandlers } from '../src/server/project-handlers.js';
import { handleProjectRoute } from '../src/server/project-routes.js';
import { profileUsageSummary } from '../src/server/usage-summary.js';
import { send } from '../src/server/ws-utils.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function home() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-profile-usage-'));
  dirs.push(dir);
  return dir;
}

async function withHistory(globalRoot: string, root: string) {
  await fs.mkdir(resolveWstackPaths({ projectRoot: root, globalRoot }).projectSessions, {
    recursive: true,
  });
}

describe('profile usage summary', () => {
  it('adds every project, keeps each project total and merges models across projects', async () => {
    const globalRoot = await home();
    const a = path.join(globalRoot, 'a'),
      b = path.join(globalRoot, 'b');
    await withHistory(globalRoot, a);
    await withHistory(globalRoot, b);
    const recorded: Record<string, Array<Record<string, unknown>>> = {
      [a]: [
        { provider: 'p', model: 'm', tokenTotal: 100 },
        { provider: 'q', model: 'n', tokenTotal: 5 },
      ],
      [b]: [
        { provider: 'p', model: 'm', tokenTotal: 40 },
        { provider: 'p', model: 'm' },
      ],
    };
    const summary = await profileUsageSummary(
      [
        { name: 'A', root: a },
        { name: 'B', root: b },
        { name: 'New', root: path.join(globalRoot, 'c') },
      ],
      globalRoot,
      async (_dir, root) => recorded[root] as never,
    );
    expect(summary).toMatchObject({
      sessions: 4,
      sessionsWithTokens: 3,
      tokenTotal: 145,
      capped: false,
    });
    expect(summary.byModel).toEqual([
      { provider: 'p', model: 'm', sessions: 3, tokenTotal: 140 },
      { provider: 'q', model: 'n', sessions: 1, tokenTotal: 5 },
    ]);
    // A project with no history yet is listed with zero, and its directory is not created.
    expect(
      summary.projects.map((row) => [row.name, 'tokenTotal' in row ? row.tokenTotal : null]),
    ).toEqual([
      ['A', 105],
      ['B', 40],
      ['New', 0],
    ]);
    await expect(
      fs.stat(
        resolveWstackPaths({ projectRoot: path.join(globalRoot, 'c'), globalRoot }).projectSessions,
      ),
    ).rejects.toThrow();
  });

  it('lists a project whose history cannot be read with its error and adds nothing for it', async () => {
    const globalRoot = await home();
    const a = path.join(globalRoot, 'a');
    await withHistory(globalRoot, a);
    const summary = await profileUsageSummary(
      [{ name: 'A', root: a }, { root: 7 } as never],
      globalRoot,
      async () => {
        throw Error('unreadable');
      },
    );
    expect(summary.tokenTotal).toBe(0);
    expect(summary.projects).toEqual([{ name: 'A', root: a, error: 'unreadable' }]);
  });

  it('reads recorded conversations through projects.list on request only', async () => {
    const globalRoot = await home();
    const root = path.join(globalRoot, 'repo');
    await fs.writeFile(
      path.join(globalRoot, 'projects.json'),
      JSON.stringify({ projects: [{ name: 'Repo', root, slug: 'repo' }] }),
    );
    await withHistory(globalRoot, root);
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const handlers = createProjectHandlers({
      globalConfigPath: path.join(globalRoot, 'config.json'),
      wpaths: { globalRoot },
      sendMessage: (_ws, message) => sent.push(message as never),
    } as never);
    await handlers.listProjects({} as never, { type: 'projects.list', payload: {} } as never);
    await handlers.listProjects(
      {} as never,
      { type: 'projects.list', payload: { usageSummary: true } } as never,
    );
    expect(sent[0]?.payload['usageSummary']).toBeUndefined();
    expect(sent[1]?.payload).toMatchObject({
      projects: [{ name: 'Repo' }],
      usageSummary: {
        sessions: 0,
        tokenTotal: 0,
        projects: [{ name: 'Repo', root, tokenTotal: 0 }],
      },
    });
  });

  it('answers the asking request, so a client can wait for its own reply', async () => {
    const frames: Array<{ payload: Record<string, unknown> }> = [];
    const ws = { readyState: 1, send: (raw: string) => frames.push(JSON.parse(raw)) };
    await handleProjectRoute(
      ws as never,
      { type: 'projects.list', payload: { usageSummary: true, requestId: 'r1' } } as never,
      {
        listProjects: async (socket) => send(socket, { type: 'projects.list', payload: {} }),
      } as never,
    );
    expect(frames[0]?.payload['requestId']).toBe('r1');
  });
});

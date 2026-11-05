/**
 * WrongMemoryPort in a linked Git worktree, against the real `wrongmemoryd`.
 * The worktree shares its main checkout's project but not its files: the
 * port binds its connection to the worktree, so the host's absolute paths
 * find the shared anchors and verification reports the worktree's own files
 * without changing the shared records. Point WRONGMEMORYD_PATH at a built
 * daemon (0.1.4 or later), or build the WrongMemory checkout next to this
 * repo. Skipped when no daemon binary is available, or when the daemon
 * predates `project.bindCheckout`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { METHODS, WrongMemoryClient } from '@wrongstack/wrongmemory-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSageRetrieval, getSageService } from '../src/memory-port.js';
import { WrongMemoryPort } from '../src/wrongmemory-port.js';

const exe = process.platform === 'win32' ? 'wrongmemoryd.exe' : 'wrongmemoryd';
const DAEMON =
  process.env.WRONGMEMORYD_PATH ??
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../WrongMemory/target/debug',
    exe,
  );

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
}

describe.skipIf(!existsSync(DAEMON))('WrongMemoryPort in a linked worktree (real daemon)', () => {
  let tmp: string;
  let home: string;
  let main: string;
  let worktree: string;
  let mainPort: WrongMemoryPort;
  let worktreePort: WrongMemoryPort;

  const port = (projectRoot: string) =>
    new WrongMemoryPort({
      projectRoot,
      dataRoot: home,
      daemonPath: DAEMON,
      startPolicy: 'on-demand',
      timeoutMs: 15_000,
    });

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'wm-worktree-'));
    home = path.join(tmp, 'home');
    main = path.join(tmp, 'main');
    worktree = path.join(tmp, 'linked');
    mkdirSync(main);
    git(main, 'init', '-q');
    git(
      main,
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    );
    git(main, 'worktree', 'add', '-q', worktree);
    // The anchored file exists in the main checkout; the worktree renamed it.
    mkdirSync(path.join(main, 'src'));
    writeFileSync(path.join(main, 'src', 'config.ts'), 'export const port = 8080;\n');
    mkdirSync(path.join(worktree, 'src'));
    writeFileSync(path.join(worktree, 'src', 'settings.ts'), 'export const port = 8080;\n');
    mainPort = port(main);
    await mainPort.initialize();
    worktreePort = port(worktree);
    await worktreePort.initialize();
  }, 60_000);

  afterAll(async () => {
    await worktreePort?.dispose();
    await mainPort?.dispose();
    try {
      const c = await WrongMemoryClient.connect({ dataRoot: home, clientName: 'stop' });
      await c.call('daemon.shutdown', {}).catch(() => undefined);
      c.close();
    } catch {
      // daemon already gone
    }
    await new Promise((r) => setTimeout(r, 500));
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }, 30_000);

  it('shares the project, resolves its own paths and keeps worktree evidence local', async (ctx) => {
    const projectId = mainPort.getProject()?.projectId ?? '';
    expect(projectId).not.toBe('');
    expect(worktreePort.getProject()?.projectId).toBe(projectId);
    const c = await WrongMemoryClient.connect({ dataRoot: home, clientName: 'probe' });
    const supported = await c
      .call(METHODS.PROJECT_BIND_CHECKOUT, { root: worktree }, { projectId })
      .then(
        () => true,
        (error: { code?: string }) => error?.code !== 'METHOD_NOT_FOUND',
      );
    c.close();
    if (!supported) ctx.skip();

    const created = await getSageService(mainPort)!.rememberSage({
      text: 'The default port is 8080 in src/config.ts.',
      kind: 'fact',
      anchors: [{ type: 'file', path: 'src/config.ts' }],
    });

    // The worktree host's absolute path finds the shared anchor.
    const absolute = path.join(worktree, 'src', 'config.ts');
    const found = await getSageRetrieval(worktreePort)!.retrieveForPath({ path: absolute });
    expect(found.map((m) => m.id)).toEqual([created.id]);

    // Verified against the worktree (the file is gone there), labeled, not persisted.
    const [local] = (await worktreePort.verify(created.id)) as unknown as Array<
      Record<string, unknown>
    >;
    expect(local).toMatchObject({ memoryId: created.id, status: 'stale' });
    expect(local!['checkout']).toMatchObject({ kind: 'linkedWorktree' });
    const shared = await getSageService(mainPort)!.getSage(created.id);
    expect(shared).toMatchObject({ status: 'active', revision: 1 });
    expect(shared?.lastVerifiedAt).toBeUndefined();

    // The main checkout's verification is the shared one.
    const [fromMain] = (await mainPort.verify(created.id)) as unknown as Array<
      Record<string, unknown>
    >;
    expect(fromMain).toMatchObject({ memoryId: created.id, status: 'verified' });
    expect(fromMain!['checkout']).toBeUndefined();
  });
});

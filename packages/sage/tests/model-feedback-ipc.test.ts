import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Tool } from '@wrongstack/contracts/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sageProjectServerMetadataPath } from '../src/project-server-endpoint.js';
import type { ProjectSageMemoryPort } from '../src/remote-memory-port.js';
import type { SageServiceLike } from '../src/service-contract.js';
import { createSageTools } from '../src/tools/memory-tools.js';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
let root: string;
let child: ChildProcess | undefined;
let ports: ProjectSageMemoryPort[] = [];
const context = { session: { id: 'feedback-session' } } as unknown as Parameters<
  Tool['execute']
>[1];
const options = { signal: new AbortController().signal };

async function startDaemon() {
  child = spawn(process.execPath, [join(dist, 'project-server.js'), '--project-root', root], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const metadata = JSON.parse(await readFile(sageProjectServerMetadataPath(root), 'utf8'));
      if (metadata.pid === child.pid) return;
    } catch {
      /* startup not finished */
    }
    if (child.exitCode !== null) throw new Error(`SAGE test daemon exited ${child.exitCode}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('SAGE test daemon startup timed out');
}

async function stopDaemon() {
  await Promise.all(ports.map((port) => port.dispose()));
  ports = [];
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    child.kill();
    await exited;
  }
  child = undefined;
}

async function service(): Promise<SageServiceLike> {
  // Use the built client just as production does; the daemon also runs dist.
  const url = pathToFileURL(join(dist, 'index.js')).href;
  const api = (await import(/* @vite-ignore */ url)) as typeof import('../src/index.js');
  const port = new api.ProjectSageMemoryPort({
    projectRoot: root,
    getSessionId: () => 'feedback-session',
  });
  ports.push(port);
  await port.initialize();
  return port.getCapability<SageServiceLike>(api.SAGE_SERVICE_CAPABILITY)!;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sage-feedback-ipc-'));
  await startDaemon();
}, 20_000);
afterEach(async () => {
  await stopDaemon();
  await rm(root, { recursive: true, force: true });
});

describe('model feedback through the production IPC boundary', () => {
  it('persists feedback and review proposals across daemon restart, then corrects with evidence', async () => {
    const remote = await service();
    const original = await remote.rememberSage({
      text: 'Transport retries share a single quota.',
      anchors: [{ type: 'file', path: 'transport.ts' }],
      persistence: 'permanent',
      validity: {
        statement: 'Only for the default transport policy.',
        checks: [{ type: 'source_contains', path: 'transport.ts', text: 'retryQuota = 3' }],
      },
    });
    expect(original.validity?.statement).toBe('Only for the default transport policy.');
    const update = createSageTools(remote).find((tool) => tool.name === 'memory_update')!;
    await update.execute(
      {
        id: original.id,
        feedback: {
          verdict: 'outdated',
          observedRevision: original.revision,
          evidence: 'transport.test.ts checks independent retry quotas.',
        },
      },
      context,
      options,
    );
    await stopDaemon();
    await startDaemon();
    const reopened = await service();
    const reviewed = (await reopened.getSage(original.id))!;
    expect(reviewed).toMatchObject({
      revision: original.revision,
      text: original.text,
      anchors: original.anchors,
      validity: original.validity,
      status: original.status,
      confidence: original.confidence,
      freshness: original.freshness,
      updatedAt: original.updatedAt,
    });
    expect(reviewed.feedback).toHaveLength(1);
    expect(reviewed.feedback?.[0]).toMatchObject({
      verdict: 'outdated',
      sessionId: 'feedback-session',
    });
    expect(await reopened.listCandidates()).toHaveLength(1);
    const corrected = await reopened.updateSage(original.id, {
      expectedRevision: original.revision,
      text: 'Transport retries now have independent quotas.',
      sources: [{ type: 'test', path: 'transport.test.ts' }],
    });
    expect(corrected.revision).toBe(original.revision + 1);
    expect(corrected.feedback?.[0]?.observedRevision).toBe(original.revision);
    expect(corrected.sources).toEqual([{ type: 'test', path: 'transport.test.ts' }]);
    const pending = (await reopened.listCandidates())[0]!;
    expect(pending.targetRevision).toBe(original.revision);
    expect(await reopened.resolveCandidate(pending.id, 'archive')).toMatchObject({
      applied: false,
      error: expect.stringContaining('revision changed'),
    });
    expect((await reopened.getSage(original.id))?.status).toBe('active');
    await expect(
      reopened.updateSage(original.id, {
        feedback: {
          verdict: 'useful',
          observedRevision: original.revision,
          evidence: 'Stale observation.',
        },
      }),
    ).rejects.toThrow('revision changed');
  }, 30_000);

  it('allows only one concurrent correction based on the same observed revision', async () => {
    const first = await service();
    const second = await service();
    const original = await first.rememberSage({ text: 'Admission retries use a bounded quota.' });
    const results = await Promise.allSettled([
      first.updateSage(original.id, {
        expectedRevision: original.revision,
        text: 'Admission quotas are per request.',
      }),
      second.updateSage(original.id, {
        expectedRevision: original.revision,
        text: 'Admission quotas are per session.',
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await first.getSage(original.id))?.revision).toBe(original.revision + 1);
  }, 30_000);
});

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sageProjectServerMetadataPath } from '../src/project-server-endpoint.js';
import type { ProjectSageMemoryPort } from '../src/remote-memory-port.js';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
let root: string;
let child: ChildProcess | undefined;
let ports: ProjectSageMemoryPort[] = [];

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

async function connect() {
  // Use the built client just as production does; the daemon also runs dist.
  const url = pathToFileURL(join(dist, 'index.js')).href;
  const api = (await import(/* @vite-ignore */ url)) as typeof import('../src/index.js');
  const port = new api.ProjectSageMemoryPort({ projectRoot: root });
  ports.push(port);
  await port.initialize();
  return {
    retrieval: api.getSageRetrieval(port)!,
    surface: api.getSageSurface(port)!,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sage-verify-paths-ipc-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'tax.ts'), 'export function calculateTax() {}\n');
  await startDaemon();
}, 20_000);
afterEach(async () => {
  await stopDaemon();
  await rm(root, { recursive: true, force: true });
});

describe('verifyForPaths through the production IPC boundary', () => {
  it('is exposed by the remote retrieval capability and reconciles anchored memories', async () => {
    const { retrieval, surface } = await connect();
    expect(typeof retrieval.verifyForPaths).toBe('function');
    const note = await surface.rememberSage({
      kind: 'decision',
      text: 'calculateTax rounds up because of regulation X.',
      importance: 0.8,
      anchors: [{ type: 'symbol', path: 'src/tax.ts', symbol: 'calculateTax' }],
    });

    await writeFile(join(root, 'src', 'tax.ts'), 'export function computeTax() {}\n');
    const results = (await retrieval.verifyForPaths!([join(root, 'src', 'tax.ts')])) as Array<{
      memoryId: string;
      status: string;
    }>;

    expect(results).toEqual([expect.objectContaining({ memoryId: note.id, status: 'stale' })]);
    expect((await surface.getSage(note.id))?.status).toBe('stale');
  });
});

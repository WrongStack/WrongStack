#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (typeof globalThis.Bun === 'undefined') {
  throw new Error('The Bun runtime smoke test must be executed with Bun.');
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryProject = mkdtempSync(join(tmpdir(), 'wrongstack-bun-runtime-'));
let store;

try {
  const [{ SqliteSageStore }, { startHeapWatchdog }] = await Promise.all([
    import('../packages/sage/dist/index.js'),
    import('../packages/core/dist/utils/index.js'),
    // Importing this package catches unsupported node:module named exports at link time.
    import('../packages/webui-server/dist/index.js'),
  ]);

  store = new SqliteSageStore({ projectRoot: temporaryProject });
  await store.initialize();
  const saved = await store.rememberSage({
    text: 'Bun runtime SQLite smoke test',
    kind: 'fact',
  });
  const matches = await store.searchSage('Bun runtime SQLite');
  if (matches[0]?.id !== saved.id) throw new Error('Bun SAGE write/search round-trip failed.');

  const stopWatchdog = startHeapWatchdog({
    sampleEveryMs: 60_000,
    logEveryMs: 60_000,
    writeDiagnosticLine: async () => undefined,
  });
  await stopWatchdog();

  const cli = join(root, 'packages', 'cli', 'dist', 'index.js');
  const version = spawnSync(process.execPath, [cli, 'version'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (version.error || version.status !== 0 || !version.stdout.includes('WrongStack')) {
    throw new Error(`Bun CLI version smoke failed: ${version.stderr || version.error}`);
  }

  console.log(`Bun ${globalThis.Bun.version} runtime smoke passed.`);
} finally {
  store?.close();
  store = undefined;
  globalThis.Bun.gc(true);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  rmSync(temporaryProject, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

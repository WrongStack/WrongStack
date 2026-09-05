/**
 * End-to-end smoke for the standalone WebUI → vector-memory wiring.
 *
 * Booting `startWebUI` end-to-end from a test is fragile: the function
 * never resolves and registers SIGTERM handlers in the same process,
 * so any test-side teardown either kills the vitest worker before the
 * result commits or hangs the worker because the HTTP server keeps
 * the event loop alive. We split the proof into two layers:
 *
 *   1. **Integration** — boots `createHttpServer` directly (the same
 *      construction `start-webui.ts` performs at runtime), threads a
 *      real `VectorMemoryStore` through the existing `getVectorMemoryStore`
 *      getter, and asserts `GET /api/vector-memory/status` returns
 *      `enabled: true` with `entries` as a number. This proves the
 *      wiring chain `createHttpServer → api-router →
 *      handleVectorMemoryStatus` flips the bit — not just the unit
 *      handler.
 *
 *   2. **Static check** — pins `start-webui.ts` so it MUST thread
 *      `getVectorMemoryStore: () => vectorMemoryStore` into
 *      `startHttpServer`. Catches a future refactor that would
 *      silently re-disable the surface.
 *
 * Both pieces together prove the user-visible wiring chain
 *   startWebUI → startHttpServer → api-router → handleVectorMemoryStatus
 * without paying the lifecycle cost of a full startWebUI boot.
 */
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { HashingEmbeddingProvider } from '@wrongstack/sage';
import { VectorMemoryStore } from '@wrongstack/vector-memory';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/server/http-server.js';
import { createWsServers, type ResolvedPorts } from '../src/server/server-runtime.js';

interface VectorMemoryStatus {
  enabled: boolean;
  entries?: number;
  vectors?: number;
  storePath?: string;
  modelCacheDir?: string;
}

async function pickFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('no ephemeral port');
  return address.port;
}

async function makeTempProjectRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webui-vm-e2e-'));
  await fs.mkdir(path.join(dir, '.wrongstack'), { recursive: true });
  return dir;
}

async function makeTempDist(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webui-vm-e2e-dist-'));
  await fs.writeFile(
    path.join(dir, 'index.html'),
    '<!doctype html><title>vector-memory e2e</title>',
  );
  return dir;
}

function closeHttpServer(server: import('node:http').Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function closeWebSocketServer(server: import('ws').WebSocketServer): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function listen(server: net.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

describe('WebUI server → vector-memory wiring', () => {
  const cleanups: Array<() => Promise<void>> = [];
  let store: VectorMemoryStore | undefined;

  afterEach(async () => {
    // Close the vector-memory store BEFORE removing its data
    // directory. SQLite holds open the .db + .db-shm + .db-wal files
    // and Windows refuses to unlink them while the handle is alive
    // (EBUSY). Cleanup order matters: store.close() then fs.rm.
    if (store) {
      store.close();
      store = undefined;
    }
    for (const dispose of cleanups.splice(0).reverse()) {
      await dispose();
    }
  });

  it('exposes enabled:true + entries field through /api/vector-memory/status', async () => {
    const projectRoot = await makeTempProjectRoot();
    const distDir = await makeTempDist();
    cleanups.push(() => fs.rm(distDir, { recursive: true, force: true }));
    cleanups.push(() => fs.rm(projectRoot, { recursive: true, force: true }));

    // Real VectorMemoryStore + a deterministic embedding provider so
    // the constructor does not try to download an ONNX model. The
    // status endpoint only reads stats() — no embedding happens here.
    store = new VectorMemoryStore({
      provider: new HashingEmbeddingProvider({ dimensions: 32 }),
      projectRoot,
    });

    const ports: ResolvedPorts = {
      wsHost: '127.0.0.1',
      httpPort: await pickFreePort(),
      requireToken: false,
      publicUrl: undefined,
      publicWsUrl: undefined,
    };

    const httpServer = createHttpServer({
      host: ports.wsHost,
      port: ports.httpPort,
      apiToken: 'integration-token',
      publicWsUrl: undefined,
      requireToken: false,
      globalRoot: projectRoot,
      projectRoot,
      watcherMetrics: {
        fileChangesDetected: 0,
        filesProcessed: 0,
        broadcastsSent: 0,
        debounceResets: 0,
        totalDebounceDelayMs: 0,
        activeProjects: 0,
        averageDebounceDelayMs: 0,
        watcherActive: false,
      },
      onFleetPing: () => undefined,
      onTechStackEvent: () => undefined,
      getLlm: () => undefined,
      executePackageOperation: async () => undefined,
      distDir,
      // The wiring under test — start-webui.ts threads these exact
      // two options into createHttpServer via startHttpServer.
      getVectorMemoryStore: () => store,
      vectorMemoryModelCacheDir: path.join(
        projectRoot,
        '.wrongstack',
        'cache',
        'transformers-models',
      ),
    });
    const { wssPrimary } = createWsServers(httpServer, ports, 'integration-token');
    cleanups.push(() => closeWebSocketServer(wssPrimary));
    cleanups.push(() => closeHttpServer(httpServer));
    await listen(httpServer, ports.httpPort);

    // Hit the status endpoint that the WebUI's sage memory tab polls.
    const response = await fetch(`http://127.0.0.1:${ports.httpPort}/api/vector-memory/status`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as VectorMemoryStatus;

    // The contract the WebUI tab reads:
    expect(body.enabled).toBe(true);
    expect(typeof body.entries).toBe('number');
    expect(body.entries).toBeGreaterThanOrEqual(0);
    expect(typeof body.storePath).toBe('string');
    expect(typeof body.modelCacheDir).toBe('string');
  });

  it('returns enabled:false when getVectorMemoryStore resolves to undefined', async () => {
    const projectRoot = await makeTempProjectRoot();
    const distDir = await makeTempDist();
    cleanups.push(() => fs.rm(distDir, { recursive: true, force: true }));
    cleanups.push(() => fs.rm(projectRoot, { recursive: true, force: true }));

    const ports: ResolvedPorts = {
      wsHost: '127.0.0.1',
      httpPort: await pickFreePort(),
      requireToken: false,
      publicUrl: undefined,
      publicWsUrl: undefined,
    };
    const httpServer = createHttpServer({
      host: ports.wsHost,
      port: ports.httpPort,
      apiToken: 'integration-token',
      publicWsUrl: undefined,
      requireToken: false,
      globalRoot: projectRoot,
      projectRoot,
      watcherMetrics: {
        fileChangesDetected: 0,
        filesProcessed: 0,
        broadcastsSent: 0,
        debounceResets: 0,
        totalDebounceDelayMs: 0,
        activeProjects: 0,
        averageDebounceDelayMs: 0,
        watcherActive: false,
      },
      onFleetPing: () => undefined,
      onTechStackEvent: () => undefined,
      getLlm: () => undefined,
      executePackageOperation: async () => undefined,
      distDir,
      // Simulates the read-only-FS fallback path in start-webui.ts.
      getVectorMemoryStore: () => undefined,
    });
    const { wssPrimary } = createWsServers(httpServer, ports, 'integration-token');
    cleanups.push(() => closeWebSocketServer(wssPrimary));
    cleanups.push(() => closeHttpServer(httpServer));
    await listen(httpServer, ports.httpPort);

    const response = await fetch(`http://127.0.0.1:${ports.httpPort}/api/vector-memory/status`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as VectorMemoryStatus;
    expect(body.enabled).toBe(false);
  });

  // Regression test: the standalone WebUI boot must mirror the CLI host
  // by writing the sage-sync marker file under
  // `<projectRoot>/.wrongstack/vector-memory/` after the first-boot sync
  // completes. This catches a future refactor that drops the
  // `startFirstBootSageSync` call (or moves it to a path that never
  // fires) — without the marker, every subsequent boot would re-run the
  // ONNX probe instead of skipping to `already-complete`.
  it('writes the complete marker under <projectRoot>/.wrongstack/vector-memory/', async () => {
    const { SAGE_SYNC_MARKER_FILENAME, startFirstBootSageSync } = await import(
      '@wrongstack/vector-memory'
    );
    const { HashingEmbeddingProvider, SAGE_SURFACE_CAPABILITY } = await import('@wrongstack/sage');

    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'webui-vm-sync-marker-'));
    cleanups.push(() => fs.rm(projectRoot, { recursive: true, force: true }));

    const realStore = new VectorMemoryStore({
      provider: new HashingEmbeddingProvider({ dimensions: 32 }),
      projectRoot,
    });
    store = realStore;

    // A minimal in-memory MemoryPort that exposes a SAGE surface with
    // zero memories. `startFirstBootSageSync` should:
    //   1. See no marker → decide to run.
    //   2. Probe the embedding provider (deterministic hashing → ok).
    //   3. Get the empty SAGE surface → sync zero entries.
    //   4. Mark the sync `complete` (failed === 0, vectors === entries).
    const memoryStore = makeEmptySageMemoryStore(SAGE_SURFACE_CAPABILITY);

    const result = await startFirstBootSageSync({
      store: realStore,
      memoryStore,
      logger: {
        warn: (msg, ctx) => console.error('[sync warn]', msg, ctx),
        debug: (msg, ctx) => console.error('[sync debug]', msg, ctx),
        info: (msg, ctx) => console.error('[sync info]', msg, ctx),
      },
    });
    // Surface the actual reason if the sync returned early — the
    // matcher above matches the capability object reference, but the
    // sync may still skip for other reasons (no-marker → run, but
    // provider probe or SAGE surface might fail). Print first so a
    // future failure is debuggable without re-running.
    expect(result.synced, `sync returned: ${JSON.stringify(result)}`).toBe(true);
    expect(result.reason).toBe('synced');

    const markerFile = path.join(
      projectRoot,
      '.wrongstack',
      'vector-memory',
      SAGE_SYNC_MARKER_FILENAME,
    );
    const markerRaw = await fs.readFile(markerFile, 'utf8');
    const marker = JSON.parse(markerRaw) as {
      phase: string;
      completedAt?: string;
      providerId?: string;
      scanned?: number;
      indexed?: number;
      skipped?: number;
      failed?: number;
    };
    expect(marker.phase).toBe('complete');
    expect(marker.completedAt).toBeTruthy();
    expect(marker.failed ?? 0).toBe(0);
    // Second call must short-circuit on the marker.
    const second = await startFirstBootSageSync({
      store: realStore,
      memoryStore,
    });
    expect(second.synced).toBe(false);
    expect(second.reason).toBe('already-complete');
  });
});

// Static assertion: catches a future refactor that silently drops the
// `getVectorMemoryStore` or `vectorMemoryModelCacheDir` wiring on
// `startHttpServer` in `start-webui.ts`. Without one of these two
// options the API router answers `enabled: false` and the WebUI tab
// regresses to "Vector Memory Disabled".
describe('start-webui.ts source-text wiring', () => {
  it('threads getVectorMemoryStore and vectorMemoryModelCacheDir into startHttpServer', async () => {
    const startWebuiPath = path.resolve(
      import.meta.dirname,
      '..',
      'src',
      'server',
      'start-webui.ts',
    );
    const source = await fs.readFile(startWebuiPath, 'utf8');

    // Both option keys must appear inside the file …
    expect(source).toContain('getVectorMemoryStore: () => vectorMemoryStore');
    expect(source).toContain('vectorMemoryModelCacheDir,');

    // … AND inside the same `startHttpServer({ ... })` call site. The
    // cheapest robust check: find the index of `startHttpServer({`,
    // then assert both keys are within the next ~30 lines. This
    // tolerates whitespace/comment churn but rejects the regression
    // where one of them is moved to a different call.
    const startHttpServerIdx = source.indexOf('startHttpServer({');
    expect(startHttpServerIdx).toBeGreaterThan(-1);
    const callWindow = source.slice(startHttpServerIdx, startHttpServerIdx + 2_000);
    expect(callWindow).toContain('getVectorMemoryStore');
    expect(callWindow).toContain('vectorMemoryModelCacheDir');
    // The call must end with `});` (or the closing brace of the call)
    // before the file exits — sanity check we didn't accidentally
    // anchor into a different `startHttpServer` invocation.
    expect(callWindow).toContain('});');
  });
});

// Regression test: the standalone WebUI boot must mirror the CLI host
// by writing the sage-sync marker file under
// `<projectRoot>/.wrongstack/vector-memory/` after the first-boot sync
// completes. This catches a future refactor that drops the
// `startFirstBootSageSync` call (or moves it to a path that never
// fires) — without the marker, every subsequent boot would re-run the
// ONNX probe instead of skipping to `already-complete`.
describe('start-webui.ts source-text sync wiring', () => {
  it('invokes startFirstBootSageSync when a vector memory store is constructed', async () => {
    const startWebuiPath = path.resolve(
      import.meta.dirname,
      '..',
      'src',
      'server',
      'start-webui-vector.ts',
    );
    const source = await fs.readFile(startWebuiPath, 'utf8');
    expect(source).toContain('startFirstBootSageSync,');
    expect(source).toContain("from '@wrongstack/vector-memory'");
    expect(source).toContain('startFirstBootSageSync({');
    expect(source).toContain('store: vectorMemoryStore');
    expect(source).toContain('memoryStore: baseMemoryStore,');
    expect(source).toContain('logger,');
  });
});

/**
 * Minimal `MemoryPort` that exposes a SAGE surface (matched by the
 * same capability object `getSageSurface` uses) with zero memories —
 * just enough to let `startFirstBootSageSync` walk its completion
 * invariant without dragging in the full core/container machinery.
 */
function makeEmptySageMemoryStore(surfaceCapability: {
  id: string;
}): import('@wrongstack/core/types').MemoryPort {
  // `createSageSurfaceSyncSource` calls `listSagePage` (see
  // packages/vector-memory/src/sage-sync-source.ts:52), not
  // `listActiveMemories`. The shape mirrors what `SqliteMemoryPort`
  // exposes on the SAGE surface capability.
  const surface = {
    async listSagePage(_opts: { statuses?: string[]; limit?: number; cursor?: string }) {
      return { memories: [], nextCursor: undefined };
    },
  };
  return {
    initialize: async () => undefined,
    health: async () => ({ ok: true }),
    getCapability: (cap: { id: string }) =>
      cap === surfaceCapability || cap.id === surfaceCapability.id ? surface : undefined,
    withTraceId: () => makeEmptySageMemoryStore(surfaceCapability),
    dispose: async () => undefined,
  } as unknown as import('@wrongstack/core/types').MemoryPort;
}

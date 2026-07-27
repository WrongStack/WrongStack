import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MemoryPort, MemoryStore } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getSageRetrieval,
  getSageService,
  getSageSurface,
  LegacyMemoryPortAdapter,
  SqliteMemoryPort,
} from '../src/memory-port.js';
import { isSqliteAvailable } from '../src/sqlite-store.js';

function legacyStore(): MemoryStore {
  let entries: Array<{ scope: 'project-memory'; text: string; ts: string }> = [];
  const store: MemoryStore = {
    async readAll() {
      return entries.map((entry) => entry.text).join('\n');
    },
    async read(scope) {
      return entries
        .filter((entry) => entry.scope === scope)
        .map((entry) => entry.text)
        .join('\n');
    },
    async remember(text) {
      entries.push({ scope: 'project-memory', text, ts: new Date().toISOString() });
    },
    async forget(query) {
      const before = entries.length;
      entries = entries.filter((entry) => !entry.text.includes(query));
      return before - entries.length;
    },
    async consolidate() {},
    async clear() {
      entries = [];
    },
    async list() {
      return [...entries];
    },
    async search(query) {
      return entries.filter((entry) => entry.text.includes(query));
    },
    withTraceId() {
      return store;
    },
  };
  return store;
}

describe('MemoryPort conformance', () => {
  let tempDir: string;
  let ports: MemoryPort[];

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-memory-port-'));
    ports = [new LegacyMemoryPortAdapter(legacyStore())];
    if (isSqliteAvailable()) {
      ports.push(new SqliteMemoryPort({ projectRoot: path.join(tempDir, 'sqlite') }));
    }
  });

  afterEach(async () => {
    await Promise.all(ports.map((port) => port.dispose()));
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('runs the same basic lifecycle and query behavior against every adapter', async () => {
    for (const port of ports) {
      await port.initialize();
      expect((await port.health()).status).toBe('ready');
      await port.remember('MemoryPort conformance marker', 'project-memory');
      expect(
        (await port.search('conformance', 'project-memory')).map((entry) => entry.text),
      ).toContain('MemoryPort conformance marker');
      expect(await port.forget('conformance', 'project-memory')).toBe(1);
      expect(await port.search('conformance', 'project-memory')).toEqual([]);
    }
  });

  it('exposes optional behavior only through a typed capability', () => {
    // The legacy adapter wraps a plain MemoryStore and exposes no SAGE
    // capability.
    const legacy = ports.find((port) => port instanceof LegacyMemoryPortAdapter)!;
    expect(getSageService(legacy)).toBeUndefined();
    expect(getSageSurface(legacy)).toBeUndefined();
    expect(getSageRetrieval(legacy)).toBeUndefined();

    // The SQLite owner implements the complete service contract. Production
    // hosts normally reach this same contract through ProjectSageMemoryPort,
    // while tests/offline maintenance can still use the inline owner directly.
    const sqlite = ports.find((port) => port instanceof SqliteMemoryPort);
    if (sqlite) {
      expect(getSageService(sqlite)).toBeDefined();
      expect(getSageSurface(sqlite)).toBeDefined();
      expect(getSageRetrieval(sqlite)).toBeDefined();
    }
  });

  it('normalizes canonical path retrieval for every SAGE backend', async () => {
    for (const port of ports.filter((candidate) => getSageSurface(candidate))) {
      const surface = getSageSurface(port)!;
      const retrieval = getSageRetrieval(port)!;
      const created = await surface.rememberSage({
        text: 'Path retrieval contract marker',
        anchors: [{ type: 'file', path: 'src/memory-port.ts' }],
      });

      const matches = await retrieval.retrieveForPath({
        path: 'src/memory-port.ts',
        includeAncestors: true,
      });
      expect(matches.map((memory) => memory.id)).toContain(created.id);
    }
  });
});

describe('SqliteMemoryPort flushPendingCounters is wired', () => {
  // M1: flushPendingCounters was declared on the capability surface but
  // never bound on the SqliteMemoryPort — the optional chain in CLI
  // hygiene teardown (packages/cli/src/wiring/sage.ts:99) was silently
  // no-oping. Pin the binding so a future refactor can't accidentally
  // remove the wiring again.

  it('returns a callable no-op that resolves without error', async () => {
    if (!isSqliteAvailable()) return;
    const port = new SqliteMemoryPort({
      projectRoot: path.join(os.tmpdir(), 'wstack-flush-' + Date.now()),
    });
    await port.initialize();
    try {
      const retrieval = getSageRetrieval(port);
      expect(retrieval).toBeDefined();
      expect(typeof retrieval!.flushPendingCounters).toBe('function');
      // The no-op contract: resolves to undefined, doesn't throw.
      await expect(retrieval!.flushPendingCounters!()).resolves.toBeUndefined();
    } finally {
      await port.dispose();
    }
  });

  it('flushPendingCounters can be called repeatedly without leaking resources', async () => {
    if (!isSqliteAvailable()) return;
    const port = new SqliteMemoryPort({
      projectRoot: path.join(os.tmpdir(), 'wstack-flush-iter-' + Date.now()),
    });
    await port.initialize();
    try {
      const retrieval = getSageRetrieval(port)!;
      // Multiple back-to-back calls must remain stable — the no-op
      // implementation must not acquire a lock, mutate state, or
      // depend on any per-call setup.
      for (let i = 0; i < 50; i++) {
        await retrieval.flushPendingCounters!();
      }
    } finally {
      await port.dispose();
    }
  });
});

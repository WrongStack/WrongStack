import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  codebaseAtlasTool,
  codebaseReadSymbolTool,
  detectMovedOrRenamedSymbols,
  findAnchoredSageMemories,
  findFileHealthAlerts,
  remapAnchoredSageMemories,
  runIndexer,
  setEcosystemBridgeProvider,
  setWrongTraceHealthProvider,
} from '../src/codebase-index/index.js';
import { loadDatabaseSync } from '../src/codebase-index/sqlite-runtime.js';
import { indexStorePool } from '../src/codebase-index/writer.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-phase4-'));
  setEcosystemBridgeProvider(null);
});

afterEach(async () => {
  setEcosystemBridgeProvider(null);
  setWrongTraceHealthProvider(null);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('Phase 4.1: Cross-System Ecosystem Bridge (SAGE + Codebase Index)', () => {
  it('reads anchored SAGE memories from .wrongstack/memories/sage.db without side effects', async () => {
    // When no .wrongstack/memories directory exists, returns [] and creates nothing
    const empty = findAnchoredSageMemories({
      projectRoot: tmpDir,
      files: ['src/billing.ts'],
      symbols: ['chargeCard'],
    });
    expect(empty).toEqual([]);
    await expect(fs.access(path.join(tmpDir, '.wrongstack'))).rejects.toThrow();

    // Seed a real .wrongstack/memories/sage.db
    const memoriesDir = path.join(tmpDir, '.wrongstack', 'memories');
    await fs.mkdir(memoriesDir, { recursive: true });
    const Database = loadDatabaseSync();
    const db = new Database(path.join(memoriesDir, 'sage.db'));
    db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        status TEXT NOT NULL,
        kind TEXT NOT NULL,
        importance REAL NOT NULL
      );
    `);
    db.prepare(
      'INSERT INTO memories(id, data, status, kind, importance) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'mem-1',
      JSON.stringify({
        id: 'mem-1',
        kind: 'gotcha',
        status: 'active',
        importance: 0.92,
        text: 'chargeCard must always pass an idempotencyKey to Stripe to avoid double-charging on retry.',
        anchors: [{ path: 'src/billing.ts', symbol: 'chargeCard' }],
      }),
      'active',
      'gotcha',
      0.92,
    );
    db.close();

    const hits = findAnchoredSageMemories({
      projectRoot: tmpDir,
      files: ['src/billing.ts'],
      symbols: ['chargeCard'],
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      id: 'mem-1',
      kind: 'gotcha',
      anchorPath: 'src/billing.ts',
      anchorSymbol: 'chargeCard',
    });
    expect(hits[0]?.text).toContain('idempotencyKey');
  });

  it('merges custom host provider insights with persisted JSONL memories', async () => {
    const memoriesDir = path.join(tmpDir, '.wrongstack', 'memories');
    await fs.mkdir(memoriesDir, { recursive: true });
    await fs.writeFile(
      path.join(memoriesDir, 'memories.jsonl'),
      `${JSON.stringify({
        id: 'jsonl-1',
        kind: 'convention',
        status: 'active',
        importance: 0.8,
        text: 'All auth tokens in src/auth.ts use Ed25519 signatures.',
        anchors: [{ path: 'src/auth.ts' }],
      })}\n`,
      'utf8',
    );

    setEcosystemBridgeProvider(() => [
      {
        id: 'live-wt-1',
        kind: 'warning',
        text: 'Active WrongTrace lock held by agent-2 on src/auth.ts',
        importance: 0.99,
        anchorPath: 'src/auth.ts',
      },
    ]);

    const hits = findAnchoredSageMemories({
      projectRoot: tmpDir,
      files: ['src/auth.ts'],
      limit: 5,
    });

    expect(hits.map((h) => h.id)).toEqual(['live-wt-1', 'jsonl-1']);
  });

  it('detects file-move and symbol-rename candidates via normalized signature fingerprinting', () => {
    const moved = detectMovedOrRenamedSymbols(
      [
        {
          file: 'src/old-billing.ts',
          name: 'chargeCard',
          kind: 'function',
          signature:
            'export function chargeCard(amount: number, currency: string): Promise<Receipt>',
        },
        {
          file: 'src/auth.ts',
          name: 'verifyLegacyToken',
          kind: 'function',
          signature: 'export function verifyLegacyToken(token: string, secret: string): boolean',
        },
      ],
      [
        {
          file: 'src/new-billing.ts',
          name: 'chargeCard',
          kind: 'function',
          signature:
            'export function chargeCard(amount: number, currency: string): Promise<Receipt>',
        },
        {
          file: 'src/auth.ts',
          name: 'verifySessionToken',
          kind: 'function',
          signature: 'export function verifySessionToken(token: string, secret: string): boolean',
        },
      ],
    );

    expect(moved).toEqual([
      {
        oldFile: 'src/old-billing.ts',
        oldSymbol: 'chargeCard',
        newFile: 'src/new-billing.ts',
        newSymbol: 'chargeCard',
        kind: 'function',
        moveKind: 'file-move',
        confidence: 0.98,
      },
      {
        oldFile: 'src/auth.ts',
        oldSymbol: 'verifyLegacyToken',
        newFile: 'src/auth.ts',
        newSymbol: 'verifySessionToken',
        kind: 'function',
        moveKind: 'symbol-rename',
        confidence: 0.9,
      },
    ]);
  });

  it('attaches anchored SAGE memories to codebase-read-symbol responses', async () => {
    const indexDir = path.join(tmpDir, '.idx');
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'src', 'payment.ts'),
      `export function settleInvoice(invoiceId: string): boolean {\n  return invoiceId.length > 0;\n}\n`,
      'utf8',
    );
    await runIndexer(undefined as never, { projectRoot: tmpDir, indexDir });

    setEcosystemBridgeProvider(() => [
      {
        id: 'mem-settle-1',
        kind: 'gotcha',
        text: 'settleInvoice must only be called inside a serializable transaction.',
        importance: 0.95,
        anchorPath: 'src/payment.ts',
        anchorSymbol: 'settleInvoice',
      },
    ]);

    try {
      const res = await codebaseReadSymbolTool.execute(
        { file: 'src/payment.ts', symbol: 'settleInvoice' },
        {
          cwd: tmpDir,
          projectRoot: tmpDir,
          meta: { codebaseIndexDir: indexDir },
        } as never,
        { signal: new AbortController().signal },
      );

      expect(res.symbol).toBe('settleInvoice');
      expect(res.relatedMemories).toHaveLength(1);
      expect(res.relatedMemories?.[0]?.id).toBe('mem-settle-1');

      const store = indexStorePool.acquire(tmpDir, { indexDir });
      const symGraph = store.getSymbolGraph(path.join(tmpDir, 'src', 'payment.ts'));
      const settleNode = symGraph.nodes.find((n) => n.label === 'settleInvoice');
      expect(settleNode?.memoryCount).toBe(1);
      expect(settleNode?.memories?.[0]?.id).toBe('mem-settle-1');
    } finally {
      indexStorePool.evict(tmpDir, indexDir);
    }
  });

  it('heals SAGE memory anchors in sage.db and memories.jsonl when symbols move or rename', async () => {
    const memoriesDir = path.join(tmpDir, '.wrongstack', 'memories');
    await fs.mkdir(memoriesDir, { recursive: true });

    const Database = loadDatabaseSync();
    const db = new Database(path.join(memoriesDir, 'sage.db'));
    db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        status TEXT NOT NULL,
        kind TEXT NOT NULL,
        importance REAL NOT NULL
      );
    `);
    db.prepare(
      'INSERT INTO memories(id, data, status, kind, importance) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'mem-move-1',
      JSON.stringify({
        id: 'mem-move-1',
        kind: 'gotcha',
        status: 'active',
        importance: 0.9,
        text: 'chargeCard requires idempotency key.',
        anchors: [{ path: 'src/old-billing.ts', symbol: 'chargeCard' }],
      }),
      'active',
      'gotcha',
      0.9,
    );
    db.close();

    await fs.writeFile(
      path.join(memoriesDir, 'memories.jsonl'),
      `${JSON.stringify({
        id: 'mem-rename-1',
        kind: 'convention',
        status: 'active',
        importance: 0.85,
        text: 'Token verification must check expiry.',
        anchors: [{ path: 'src/auth.ts', symbol: 'verifyLegacyToken' }],
      })}\n`,
      'utf8',
    );

    const moves = detectMovedOrRenamedSymbols(
      [
        {
          file: 'src/old-billing.ts',
          name: 'chargeCard',
          kind: 'function',
          signature: 'export function chargeCard(amount: number): Promise<void>',
        },
        {
          file: 'src/auth.ts',
          name: 'verifyLegacyToken',
          kind: 'function',
          signature: 'export function verifyLegacyToken(token: string, secret: string): boolean',
        },
      ],
      [
        {
          file: 'src/new-billing.ts',
          name: 'chargeCard',
          kind: 'function',
          signature: 'export function chargeCard(amount: number): Promise<void>',
        },
        {
          file: 'src/auth.ts',
          name: 'verifySessionToken',
          kind: 'function',
          signature: 'export function verifySessionToken(token: string, secret: string): boolean',
        },
      ],
    );

    const remapRes = remapAnchoredSageMemories(tmpDir, moves);
    expect(remapRes.updatedSqliteCount).toBe(1);
    expect(remapRes.updatedJsonlCount).toBe(1);
    expect(remapRes.remappedMemoryIds).toEqual(['mem-move-1', 'mem-rename-1']);

    // Querying at the new locations now returns both healed memories
    const movedHit = findAnchoredSageMemories({
      projectRoot: tmpDir,
      files: ['src/new-billing.ts'],
      symbols: ['chargeCard'],
    });
    expect(movedHit.map((m) => m.id)).toEqual(['mem-move-1']);

    const renamedHit = findAnchoredSageMemories({
      projectRoot: tmpDir,
      files: ['src/auth.ts'],
      symbols: ['verifySessionToken'],
    });
    expect(renamedHit.map((m) => m.id)).toEqual(['mem-rename-1']);
  });

  it('automatically heals SAGE memory anchors during incremental runIndexer when a file moves or a symbol is renamed', async () => {
    const indexDir = path.join(tmpDir, '.idx-auto');
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'src', 'old-billing.ts'),
      'export function chargeCard(amount: number, currency: string): boolean {\n  return amount > 0 && currency.length > 0;\n}\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(tmpDir, 'src', 'auth.ts'),
      'export function verifyLegacyToken(token: string, secret: string): boolean {\n  return token === secret;\n}\n',
      'utf8',
    );
    await runIndexer(undefined as never, { projectRoot: tmpDir, indexDir });

    const memoriesDir = path.join(tmpDir, '.wrongstack', 'memories');
    await fs.mkdir(memoriesDir, { recursive: true });
    await fs.writeFile(
      path.join(memoriesDir, 'memories.jsonl'),
      [
        JSON.stringify({
          id: 'auto-move-1',
          kind: 'gotcha',
          status: 'active',
          importance: 0.9,
          text: 'chargeCard must validate currency.',
          anchors: [{ path: 'src/old-billing.ts', symbol: 'chargeCard' }],
        }),
        JSON.stringify({
          id: 'auto-rename-1',
          kind: 'convention',
          status: 'active',
          importance: 0.85,
          text: 'Token verifier must compare constant-time.',
          anchors: [{ path: 'src/auth.ts', symbol: 'verifyLegacyToken' }],
        }),
      ].join('\n'),
      'utf8',
    );

    // Move src/old-billing.ts -> src/new-billing.ts and rename verifyLegacyToken -> verifySessionToken
    await fs.rm(path.join(tmpDir, 'src', 'old-billing.ts'));
    await fs.writeFile(
      path.join(tmpDir, 'src', 'new-billing.ts'),
      'export function chargeCard(amount: number, currency: string): boolean {\n  return amount > 0 && currency.length > 0;\n}\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(tmpDir, 'src', 'auth.ts'),
      'export function verifySessionToken(token: string, secret: string): boolean {\n  return token === secret;\n}\n',
      'utf8',
    );

    try {
      await runIndexer(undefined as never, { projectRoot: tmpDir, indexDir });

      const movedHit = findAnchoredSageMemories({
        projectRoot: tmpDir,
        files: ['src/new-billing.ts'],
        symbols: ['chargeCard'],
      });
      expect(movedHit.map((m) => m.id)).toEqual(['auto-move-1']);

      const renamedHit = findAnchoredSageMemories({
        projectRoot: tmpDir,
        files: ['src/auth.ts'],
        symbols: ['verifySessionToken'],
      });
      expect(renamedHit.map((m) => m.id)).toEqual(['auto-rename-1']);
    } finally {
      indexStorePool.evict(tmpDir, indexDir);
    }
  });

  it('decorates GraphNodes with WrongTrace fragility and lock telemetry and queries codebase-atlas', async () => {
    const indexDir = path.join(tmpDir, '.idx-wt');
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'src', 'fragile.ts'),
      [
        'export function riskyOperation(input: string): string {',
        '  return input.trim();',
        '}',
        '',
        'function internalHelper(x: number): number {',
        '  return x + 1;',
        '}',
      ].join('\n'),
      'utf8',
    );
    await runIndexer(undefined as never, { projectRoot: tmpDir, indexDir });

    setWrongTraceHealthProvider(() => [
      {
        file: 'src/fragile.ts',
        healthScore: 32,
        isFragile: true,
        recentThrashingCount: 4,
        isLocked: true,
        lockOwner: 'agent-alpha',
      },
    ]);

    try {
      const alerts = findFileHealthAlerts(tmpDir, ['src/fragile.ts']);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.isFragile).toBe(true);
      expect(alerts[0]?.lockOwner).toBe('agent-alpha');

      const store = indexStorePool.acquire(tmpDir, { indexDir });
      const fileGraph = store.getFileGraph('src');
      const fragileNode = fileGraph.nodes.find((n) => n.label.includes('fragile.ts'));
      expect(fragileNode?.isFragile).toBe(true);
      expect(fragileNode?.thrashingCount).toBe(4);
      expect(fragileNode?.healthScore).toBe(32);
      expect(fragileNode?.lockOwner).toBe('agent-alpha');

      // Verify symbols table populated end_line, is_exported, signature_hash
      const Database = loadDatabaseSync();
      const rawDb = new Database(path.join(indexDir, 'index.db'), { readOnly: true });
      try {
        const symRows = rawDb
          .prepare(
            'SELECT name, line, end_line, is_exported, signature_hash FROM symbols ORDER BY line ASC',
          )
          .all() as Array<{
          name: string;
          line: number;
          end_line: number;
          is_exported: number;
          signature_hash: string;
        }>;
        const riskyRow = symRows.find((r) => r.name === 'riskyOperation');
        const helperRow = symRows.find((r) => r.name === 'internalHelper');
        expect(riskyRow?.is_exported).toBe(1);
        expect(riskyRow?.end_line).toBeGreaterThanOrEqual(riskyRow?.line ?? 1);
        expect(riskyRow?.signature_hash.length).toBeGreaterThan(0);
        expect(helperRow?.is_exported).toBe(0);
      } finally {
        rawDb.close();
      }

      // Verify codebase-atlas tool modes (brief, write, freshness)
      const ctx = {
        cwd: tmpDir,
        projectRoot: tmpDir,
        meta: { codebaseIndexDir: indexDir },
      } as never;
      const briefRes = await codebaseAtlasTool.execute({ mode: 'brief' }, ctx, {
        signal: new AbortController().signal,
      });
      expect(briefRes.indexed).toBe(true);
      expect(briefRes.brief).toBeDefined();

      const writeRes = await codebaseAtlasTool.execute({ mode: 'write' }, ctx, {
        signal: new AbortController().signal,
      });
      expect(writeRes.written?.files).toContain('atlas.json');
      expect(writeRes.freshness?.fresh).toBe(true);
    } finally {
      indexStorePool.evict(tmpDir, indexDir);
    }
  });

  it('does not take an unrelated namesake in another file for a move (F905)', () => {
    const removed = {
      file: 'src/ast/parse.ts',
      name: 'parse',
      kind: 'function',
      line: 1,
      signature: 'export function parse(input: string): Ast',
    };
    const unrelated = {
      file: 'src/cli/parse.ts',
      name: 'parse',
      kind: 'function',
      line: 3,
      signature: 'export function parse(argv: string[]): CliOptions',
    };
    expect(detectMovedOrRenamedSymbols([removed], [unrelated] as never)).toEqual([]);
    // Without signatures only a one-to-one pairing is trusted.
    const doc = (file: string) => ({ file, name: 'Intro', kind: 'heading', line: 1 });
    expect(detectMovedOrRenamedSymbols([doc('a.md')], [doc('b.md'), doc('c.md')] as never)).toEqual(
      [],
    );
  });

  it('findFileHealthAlerts strips UTF-8 BOM and skips null entries in wrongtrace-health.json', async () => {
    const fsPromises = await import('node:fs/promises');
    const { findFileHealthAlerts } = await import('../src/codebase-index/ecosystem-bridge.js');
    const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'eco-health-bom-'));
    try {
      await fsPromises.mkdir(path.join(dir, '.wrongstack'), { recursive: true });
      await fsPromises.writeFile(
        path.join(dir, '.wrongstack', 'wrongtrace-health.json'),
        `\uFEFF${JSON.stringify([null, { file_path: 'src/app.ts', health_score: 30, is_fragile: true }])}`,
        'utf8',
      );
      expect(findFileHealthAlerts(dir, ['src/app.ts'])).toHaveLength(1);
    } finally {
      await fsPromises.rm(dir, { recursive: true, force: true });
    }
  });
});

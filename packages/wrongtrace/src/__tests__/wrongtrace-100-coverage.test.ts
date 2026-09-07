import { EventEmitter } from 'node:events';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _connectSocket, createIpcTransport, TimeoutError } from '../adapters/ipc.js';
import { createMcpTransport, mcp } from '../adapters/mcp.js';
import {
  digestAtlas,
  getCrossAgentRisk,
  getRecentActivity,
  summarizeFriction,
} from '../agent-helpers.js';
import type { WrongTraceClient, WrongTraceClientInternal } from '../client.js';
import { _httpJson, createWrongTraceClient } from '../client.js';
import { defaultSocketPath, discover } from '../discovery.js';
import { getWrongTrace, preflightFileEdit, resetWrongTraceGate, withFileLock } from '../gate.js';
import {
  _fsOps,
  countersFilePath,
  createWrongTraceGateCounter,
  formatGateCounterReport,
  loadWrongTraceGateCounters,
  persistWrongTraceGateCounters,
  recordGateDecision,
  resetGateDecisions,
  snapshotGateDecisions,
} from '../gate-counters.js';
import {
  createWrongTraceHookPair,
  createWrongTracePostToolUseHook,
  createWrongTracePreToolUseHook,
} from '../hooks.js';

describe('wrongtrace 100% coverage suite', () => {
  let tmpDir: string;
  let originalFetch: typeof fetch | undefined;
  let originalWrongTraceUrl: string | undefined;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wt-100-'));
    resetWrongTraceGate();
    resetGateDecisions();
    originalFetch = globalThis.fetch;
    originalWrongTraceUrl = process.env.WRONGTRACE_URL;
  });

  afterEach(async () => {
    resetWrongTraceGate();
    resetGateDecisions();
    globalThis.fetch = originalFetch as typeof fetch;
    if (originalWrongTraceUrl === undefined) {
      delete process.env.WRONGTRACE_URL;
    } else {
      process.env.WRONGTRACE_URL = originalWrongTraceUrl;
    }
    vi.restoreAllMocks();
    try {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('gate-counters.ts', () => {
    it('tallies decisions, snapshots, resets, and formats report', () => {
      const counter = createWrongTraceGateCounter();
      counter.record({ kind: 'deny', path: 'a.ts', reason: 'locked' });
      counter.record({ kind: 'allow-fragile', path: 'b.ts', reasons: ['fragile'] });
      counter.record({ kind: 'lock-acquired', path: 'c.ts', owner: 'agent' });
      counter.record({ kind: 'lock-conflict-race', path: 'd.ts' });
      counter.record({ kind: 'lock-released', path: 'c.ts' });

      const snap = counter.snapshot();
      expect(snap.deny).toBe(1);
      expect(snap.allowFragile).toBe(1);
      expect(snap.lockAcquired).toBe(1);
      expect(snap.lockConflictRace).toBe(1);
      expect(snap.lockReleased).toBe(1);
      expect(snap.total).toBe(5);

      const report = formatGateCounterReport(snap);
      expect(report).toContain('deny=1');
      expect(report).toContain('total=5');

      counter.reset();
      expect(counter.snapshot().total).toBe(0);
    });

    it('uses process-shared module functions and file persistence', async () => {
      recordGateDecision({ kind: 'deny', path: 'x.ts', reason: 'test' });
      const snap = snapshotGateDecisions();
      expect(snap.deny).toBe(1);

      const filePath = countersFilePath(tmpDir);
      expect(filePath).toContain('wrongtrace-gate-counters.json');

      const nonExistent = await loadWrongTraceGateCounters(tmpDir);
      expect(nonExistent).toBeNull();

      await persistWrongTraceGateCounters(tmpDir, snap);
      const loaded = await loadWrongTraceGateCounters(tmpDir);
      expect(loaded).toEqual(snap);

      await fsp.writeFile(filePath, 'invalid json');
      expect(await loadWrongTraceGateCounters(tmpDir)).toBeNull();

      await fsp.writeFile(filePath, JSON.stringify({ deny: 'not-a-number' }));
      expect(await loadWrongTraceGateCounters(tmpDir)).toBeNull();

      let _renameAttempts = 0;
      const origRename = _fsOps.rename;
      _fsOps.rename = async () => {
        _renameAttempts++;
        throw new Error('EPERM');
      };
      // test fallback copyFile and unlink failure catch callback
      let unlinkErrorAttempts = 0;
      const origUnlink = _fsOps.unlink;
      _fsOps.unlink = async (_p) => {
        unlinkErrorAttempts++;
        throw new Error('UNLINK_FAIL');
      };
      await persistWrongTraceGateCounters(tmpDir, snap);
      expect(unlinkErrorAttempts).toBeGreaterThan(0);
      _fsOps.unlink = origUnlink;
      _fsOps.rename = origRename;

      // test mkdir error catch block
      const origMkdir = _fsOps.mkdir;
      _fsOps.mkdir = async () => {
        throw new Error('DISK_FULL');
      };
      await persistWrongTraceGateCounters(tmpDir, snap);
      _fsOps.mkdir = origMkdir;
    });
  });

  describe('discovery.ts', () => {
    it('handles defaultSocketPath fallbacks and missing fetch', async () => {
      expect(defaultSocketPath('/custom/home', 'linux')).toBe(
        path.join('/custom/home', '.wrongtrace', 'ipc.sock'),
      );
      expect(defaultSocketPath('', 'linux')).toBe('/tmp/wrongtrace.sock');
      expect(defaultSocketPath('', 'win32')).toBe('\\\\.\\pipe\\wrongtrace');

      // defaultSocketPath() with default args
      expect(defaultSocketPath()).toBeDefined();

      const origHome = process.env['HOME'];
      const origUserprofile = process.env['USERPROFILE'];
      delete process.env['HOME'];
      process.env['USERPROFILE'] = 'C:\\Users\\Mock';
      expect(defaultSocketPath(undefined, 'win32')).toBe('\\\\.\\pipe\\wrongtrace');

      process.env['HOME'] = '/home/mock';
      delete process.env['USERPROFILE'];
      expect(defaultSocketPath(undefined, 'linux')).toBe(
        path.join('/home/mock', '.wrongtrace', 'ipc.sock'),
      );

      delete process.env['HOME'];
      delete process.env['USERPROFILE'];
      expect(defaultSocketPath(undefined, 'linux')).toBe('/tmp/wrongtrace.sock');

      if (origHome !== undefined) process.env['HOME'] = origHome;
      if (origUserprofile !== undefined) process.env['USERPROFILE'] = origUserprofile;

      const res = await discover({ fetchImpl: 'not-a-func' as never });
      expect(res.available).toBe(false);

      // JSON parse failure in discover
      const resBadJson = await discover({
        fetchImpl: async () => new Response('not-json', { status: 200 }) as never,
      });
      expect(resBadJson.available).toBe(false);

      // Status not ok ({ ok: false }) in discover
      const resNotOk = await discover({
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false }), { status: 200 }) as never,
      });
      expect(resNotOk.available).toBe(false);
    });
  });

  describe('gate.ts', () => {
    it('handles getWrongTrace discovery failure and offline degradation', async () => {
      process.env.WRONGTRACE_URL = 'http://127.0.0.1:1';
      resetWrongTraceGate();
      const client = await getWrongTrace();
      expect(client.isAvailable).toBe(false);

      const verdict = await preflightFileEdit('foo.ts');
      expect(verdict).toEqual({ kind: 'allow', risk: null });

      const executed = await withFileLock('foo.ts', 'edit', async () => 'result');
      expect(executed).toBe('result');

      resetWrongTraceGate();
      vi.spyOn(await import('../client.js'), 'createWrongTraceClient').mockRejectedValueOnce(
        new Error('crash'),
      );
      const fallbackClient = await getWrongTrace();
      expect(fallbackClient.isAvailable).toBe(false);
    });

    it('preflightFileEdit blocks when client reports locked risk', async () => {
      resetWrongTraceGate();
      const mockClient: WrongTraceClientInternal = {
        isAvailable: true,
        getFileHealth: async () => ({
          path: 'locked.ts',
          health_score: 10,
          is_fragile: false,
          is_locked: true,
          lock_owner: 'other-agent',
          lock_reason: 'editing',
          lock_expires_at: new Date(Date.now() + 60000).toISOString(),
          recent_thrashing_count: 0,
          collaborator_count: 1,
        }),
        getFrictionMatrix: async () => [],
        lockFile: async () => ({ ok: true }),
        unlockFile: async () => ({ ok: true }),
      } as never;

      vi.spyOn(await import('../client.js'), 'createWrongTraceClient').mockResolvedValue(
        mockClient,
      );

      const verdict = await preflightFileEdit('locked.ts', 'my-agent');
      expect(verdict.kind).toBe('blocked');

      let fnCalled = false;
      const res = await withFileLock(
        'locked.ts',
        'edit',
        async () => {
          fnCalled = true;
          return 'locked-work';
        },
        { owner: 'me', ownerRunId: 'run-1', ttlSeconds: 30 },
      );
      expect(fnCalled).toBe(true);
      expect(res).toBe('locked-work');

      mockClient.lockFile = async () => ({ ok: false, owner: 'other' }) as never;
      const resConflict = await withFileLock('locked.ts', 'edit', async () => 'conflict-work');
      expect(resConflict).toBe('conflict-work');
    });
  });

  describe('agent-helpers.ts', () => {
    it('handles null getFileHealth, health_score < 70, friction filtering, and atlas prose sorting', async () => {
      const mockClient: WrongTraceClient = {
        isAvailable: true,
        getFileHealth: async () => null,
        getFrictionMatrix: async () => [],
      } as never;

      const riskNull = await getCrossAgentRisk(mockClient, 'missing.ts');
      expect(riskNull.band).toBe('unknown');
      expect(riskNull.reasons).toContain('file health endpoint unreachable');

      mockClient.getFileHealth = async () => ({
        path: 'mid.ts',
        health_score: 55,
        is_fragile: false,
        is_locked: false,
        recent_thrashing_count: 0,
        collaborator_count: 1,
      });
      mockClient.getFrictionMatrix = async () => [
        { file_path: 'mid.ts', conflict_count: 4 } as never,
        { files: ['mid.ts'], conflict_count: 2 } as never,
      ];
      const riskMid = await getCrossAgentRisk(mockClient, 'mid.ts');
      expect(riskMid.reasons.some((r) => r.includes('health_score below 70'))).toBe(true);
      expect(riskMid.reasons.some((r) => r.includes('cross-agent conflicts'))).toBe(true);

      const atlas = {
        workspaces: ['ws1', 'ws2'],
        packages: [
          {
            name: 'pkg-a',
            files: [
              { health_score: 20, is_fragile: true, recent_thrashing_count: 10 },
              { health_score: 20, is_fragile: true, recent_thrashing_count: 10 },
            ],
          },
          {
            name: 'pkg-b',
            files: [{ health_score: 30, is_fragile: false, recent_thrashing_count: 12 }],
          },
        ],
      };
      const formatted = digestAtlas(atlas as never);
      expect(formatted?.selfThrashWorkspaces[0]).toBe('pkg-a');
      expect(formatted?.selfThrashWorkspaces[1]).toBe('pkg-b');

      expect(summarizeFriction(null)).toEqual({
        topPair: null,
        crossAgentRatioPct: 0,
        selfThrashRatioPct: 0,
        totalCollisions: 0,
        prose: '',
      });
      expect(summarizeFriction({ total_collisions: 0 })).toEqual({
        topPair: null,
        crossAgentRatioPct: 0,
        selfThrashRatioPct: 0,
        totalCollisions: 0,
        prose: '',
      });
      const fSummary = summarizeFriction({
        total_collisions: 10,
        edges: [
          {
            author_model: 'gpt',
            overwriter_model: 'claude',
            conflict_count: 3,
            is_self_thrash: false,
          },
          {
            author_model: 'claude',
            overwriter_model: 'gpt',
            conflict_count: 2,
            is_self_thrash: false,
          },
          {
            author_model: 'claude',
            overwriter_model: 'claude',
            conflict_count: 5,
            is_self_thrash: true,
          },
        ],
      });
      expect(fSummary.topPair).toMatch(/claude ↔ gpt|gpt ↔ claude/);
      expect(fSummary.topPair).toContain('(5 conflicts)');
      expect(fSummary.selfThrashRatioPct).toBe(50);

      const actClient: WrongTraceClient = {
        isAvailable: true,
        getFrictionMatrix: async () => ({
          events: [
            {
              file_path: 'f1.ts',
              author_time: '2026-08-01T10:00:00Z',
              author_model: 'agent-a',
              author_run_id: 'r1',
            },
            {
              file_path: 'f1.ts',
              overwriter_time: '2026-08-01T11:00:00Z',
              overwriter_model: 'agent-b',
            },
            { file_path: 'f1.ts' },
            { file_path: 'other.ts', author_time: '2026-08-01T10:00:00Z' },
          ],
        }),
      } as never;
      const recent = await getRecentActivity(actClient, 'f1.ts');
      expect(recent).toHaveLength(2);
    });
  });

  describe('client.ts', () => {
    it('covers getters, getHealth, getSymbolLineage, getFrictionMatrix edges, getAtlas query, mcp unlock/telemetry, listLocks, and recentEvents', async () => {
      const mockFetch = vi.fn(async (url: string) => {
        if (url.includes('/api/health')) {
          return new Response(JSON.stringify({ ok: true, status: 'ok' }), { status: 200 });
        }
        if (url.includes('/api/symbol/history')) {
          return new Response(JSON.stringify([{ symbol: 'sym1' }]), { status: 200 });
        }
        if (url.includes('/api/metrics/friction')) {
          return new Response(
            JSON.stringify({
              edges: [{ edge: 'e1' }],
              recent_collisions: [{ col: 1 }],
            }),
            { status: 200 },
          );
        }
        if (url.includes('/api/events/recent')) {
          return new Response(JSON.stringify([{ event: 'ev1' }]), { status: 200 });
        }
        if (url.includes('/api/guardrail/locks')) {
          return new Response(JSON.stringify([{ path: 'locked.ts' }]), { status: 200 });
        }
        if (url.includes('/api/guardrail/unlock')) {
          return new Response(JSON.stringify({ ok: true, status: 'unlocked' }), { status: 200 });
        }
        if (url.includes('/api/telemetry')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response('{}', { status: 200 });
      });

      globalThis.fetch = mockFetch as never;

      const mcpTools = {
        unlock_file: vi.fn(async () => ({ ok: true })),
        report_telemetry: vi.fn(async () => ({ ok: true })),
      };

      const client = await createWrongTraceClient({
        baseUrl: 'http://test:3444',
        socketPath: '',
        mcpTools: mcpTools as never,
      });

      expect(client.baseUrl).toBe('http://test:3444');
      expect(client.socketPath).toBeDefined();

      const health = await client.getHealth();
      expect(health?.ok).toBe(true);

      const lineage = await client.getSymbolLineage('file.ts', 'func:foo');
      expect(lineage).toHaveLength(1);

      const friction = await client.getFrictionMatrix(10);
      expect(friction).toHaveLength(1);
      expect((friction as any).recent_collisions).toBeDefined();

      const atlas = await client.getAtlas({
        workspace: 'ws1',
        summary: true,
        includeSymbols: false,
        limit: 10,
        offset: 0,
      });
      expect(atlas).toBeDefined();

      const events = await client.getRecentEvents({
        limit: 5,
        since: '1h',
        repo: 'r1',
        filePath: 'f.ts',
      });
      expect(events).toHaveLength(1);

      const locks = await client.listLocks();
      expect(locks).toHaveLength(1);

      // unlock via HTTP when no IPC and no MCP
      const clientHttpOnly = await createWrongTraceClient({
        baseUrl: 'http://test:3444',
        socketPath: '',
      });
      const unlockRes = await clientHttpOnly.unlockFile('f.ts');
      expect(unlockRes?.ok).toBe(true);

      // unlock via MCP when mcpTools wired
      const clientWithMcp = await createWrongTraceClient({
        baseUrl: 'http://test:3444',
        socketPath: '',
        mcpTools: {
          unlock_file: async () => ({ ok: true }),
          report_telemetry: async () => ({ ok: true }),
        } as never,
      });
      const unlockMcp = await clientWithMcp.unlockFile('f.ts');
      expect(unlockMcp?.ok).toBe(true);

      // reportTelemetry via HTTP
      const telRes = await clientHttpOnly.reportTelemetry({} as never);
      expect(telRes?.ok).toBe(true);

      // reportTelemetry via MCP
      const telMcp = await clientWithMcp.reportTelemetry({} as never);
      expect(telMcp?.ok).toBe(true);

      // lockFile options: owner, ownerRunId, ttlSeconds, force
      await clientHttpOnly.lockFile('f.ts', 'reason', {
        owner: 'own1',
        ownerRunId: 'run1',
        ttlSeconds: 60,
        force: true,
      });

      // getFrictionMatrix returning bare array
      mockFetch.mockImplementationOnce(
        async () => new Response(JSON.stringify([{ edge: 'bare' }]), { status: 200 }),
      );
      const bareFriction = await clientHttpOnly.getFrictionMatrix();
      expect(bareFriction).toHaveLength(1);

      // unavailable client (baseUrl is null)
      mockFetch.mockImplementationOnce(async () => new Response('down', { status: 503 }));
      const unavailClient = await createWrongTraceClient({ baseUrl: 'http://127.0.0.1:1' });
      expect(await unavailClient.getRecentEvents()).toEqual([]);
      expect(await unavailClient.listLocks()).toEqual([]);

      // httpJson timeout abort trigger
      const slowFetch = vi.fn((_url: string, init?: any) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      });
      globalThis.fetch = slowFetch as never;
      const resTimeout = await _httpJson('http://test:3444', '/api/slow', { timeoutMs: 10 });
      expect(resTimeout).toBeNull();

      // httpJson with missing fetch
      const origF = globalThis.fetch;
      delete (globalThis as any).fetch;
      expect(await clientHttpOnly.getHealth()).toBeNull();
      globalThis.fetch = origF;
    });
  });

  describe('hooks.ts', () => {
    it('handles target file extraction, deny on blocked verdict, fragile context, and legacy hook factories', async () => {
      const preHook = createWrongTracePreToolUseHook(() => 'sess-1');
      const postHook = createWrongTracePostToolUseHook();
      expect(typeof preHook).toBe('function');
      expect(typeof postHook).toBe('function');

      const { preToolUse, postToolUse } = createWrongTraceHookPair(() => 's1');
      await preToolUse({ toolName: 'edit', toolInput: { files: 'single.ts' } });
      await preToolUse({ toolName: 'edit', toolInput: { files: ['first.ts', 'second.ts'] } });
      await preToolUse({ toolName: 'edit', toolInput: { files: [''] } });
      await preToolUse({ toolName: 'edit', toolInput: { files: [] } });
      await preToolUse({ toolName: 'edit', toolInput: { directory: 'some/dir' } });
      await preToolUse({ toolName: 'edit', toolInput: { directory: '' } });
      await preToolUse({ toolName: 'edit', toolInput: { directory: 123 } });
      await postToolUse({ toolName: 'edit', toolInput: { files: 'single.ts' } });

      resetWrongTraceGate();
      const mockClient: WrongTraceClientInternal = {
        isAvailable: true,
        getFileHealth: async () => ({
          path: 'blocked.ts',
          health_score: 10,
          is_fragile: false,
          is_locked: true,
          lock_owner: 'other',
          lock_reason: 'reason',
          lock_expires_at: new Date(Date.now() + 60000).toISOString(),
          recent_thrashing_count: 0,
          collaborator_count: 1,
        }),
        getFrictionMatrix: async () => [],
        lockFile: async () => ({ ok: false }),
        unlockFile: async () => ({ ok: true }),
      } as never;

      vi.spyOn(await import('../client.js'), 'createWrongTraceClient').mockResolvedValue(
        mockClient,
      );

      const emitted: any[] = [];
      const pair = createWrongTraceHookPair(() => 'my-sess', {
        emit: (e) => emitted.push(e),
      });

      const resBlocked = await pair.preToolUse({
        toolName: 'edit',
        toolInput: { path: 'blocked.ts' },
      });
      expect(resBlocked?.action).toBe('deny');
      expect(emitted.some((e) => e.kind === 'deny')).toBe(true);

      // Fragile verdict
      resetWrongTraceGate();
      mockClient.getFileHealth = async () => ({
        path: 'fragile.ts',
        health_score: 20,
        is_fragile: true,
        is_locked: false,
        recent_thrashing_count: 0,
        collaborator_count: 1,
      });
      mockClient.lockFile = async () => ({ ok: true });

      const resFragile = await pair.preToolUse({
        toolName: 'edit',
        toolInput: { path: 'fragile.ts' },
      });
      expect(resFragile?.action).toBe('allow');
      expect(resFragile?.additionalContext).toContain('fragile');
      expect(emitted.some((e) => e.kind === 'allow-fragile')).toBe(true);

      expect(await pair.preToolUse({ toolName: 'read_file', toolInput: {} })).toBeUndefined();
      await pair.postToolUse({ toolName: 'read_file', toolInput: {} });
      expect(await pair.preToolUse({ toolName: 'edit', toolInput: null as never })).toBeUndefined();

      // postToolUse when path is not in counters
      await pair.postToolUse({ toolName: 'edit', toolInput: { path: 'not-tracked.ts' } });

      // Lock conflict race branch in preToolUse and postToolUse
      resetWrongTraceGate();
      mockClient.getFileHealth = async () => ({
        path: 'race.ts',
        health_score: 80,
        is_fragile: false,
        is_locked: false,
        recent_thrashing_count: 0,
        collaborator_count: 1,
      });
      mockClient.lockFile = async () => ({ ok: false }); // race lost
      await pair.preToolUse({ toolName: 'edit', toolInput: { path: 'race.ts' } });
      expect(emitted.some((e) => e.kind === 'lock-conflict-race')).toBe(true);

      // postToolUse where lock_owner !== expectedOwner
      mockClient.getFileHealth = async () => ({
        path: 'race.ts',
        health_score: 80,
        is_fragile: false,
        is_locked: true,
        lock_owner: 'someone-else',
        recent_thrashing_count: 0,
        collaborator_count: 1,
      });
      await pair.postToolUse({ toolName: 'edit', toolInput: { path: 'race.ts' } });

      // postToolUse where lock_owner === expectedOwner
      await pair.preToolUse({ toolName: 'edit', toolInput: { path: 'race.ts' } });
      mockClient.getFileHealth = async () => ({
        path: 'race.ts',
        health_score: 80,
        is_fragile: false,
        is_locked: true,
        lock_owner: 'wrongstack:my-sess',
        recent_thrashing_count: 0,
        collaborator_count: 1,
      });
      await pair.postToolUse({ toolName: 'edit', toolInput: { path: 'race.ts' } });

      // toolName undefined / empty
      expect(
        await pair.preToolUse({ toolName: undefined, toolInput: { path: 'no-tool.ts' } }),
      ).toBeUndefined();
      await pair.postToolUse({ toolName: undefined, toolInput: { path: 'no-tool.ts' } });

      // sibling lock decrement: releaseLock where next > 0 (lines 195, 196)
      // Call preToolUse twice with ok:true so counter reaches 2
      mockClient.getFileHealth = async () => ({
        path: 'multi-hold.ts',
        health_score: 80,
        is_fragile: false,
        is_locked: false,
        recent_thrashing_count: 0,
        collaborator_count: 1,
      });
      mockClient.lockFile = async () => ({ ok: true });
      await pair.preToolUse({ toolName: 'edit', toolInput: { path: 'multi-hold.ts' } });
      await pair.preToolUse({ toolName: 'edit', toolInput: { path: 'multi-hold.ts' } });
      // First release decrements counter from 2 to 1 (shouldUnlock stays false)
      await pair.postToolUse({ toolName: 'edit', toolInput: { path: 'multi-hold.ts' } });
      // Second release decrements from 1 to 0 (shouldUnlock becomes true)
      await pair.postToolUse({ toolName: 'edit', toolInput: { path: 'multi-hold.ts' } });

      // wt.isAvailable === false during preToolUse and postToolUse (lines 239, 295)
      resetWrongTraceGate();
      const mockClientOffline: WrongTraceClientInternal = {
        isAvailable: false,
      } as never;
      vi.spyOn(await import('../client.js'), 'createWrongTraceClient').mockResolvedValue(
        mockClientOffline,
      );

      const pairOffline = createWrongTraceHookPair(() => 'sess-offline');
      const offlinePre = await pairOffline.preToolUse({
        toolName: 'edit',
        toolInput: { path: 'offline.ts' },
      });
      expect(offlinePre).toEqual({ action: 'allow' });
      await pairOffline.postToolUse({ toolName: 'edit', toolInput: { path: 'offline.ts' } });

      // legacy factories postHook execution
      await postHook({ toolName: 'edit', toolInput: { path: 'legacy.ts' } });

      resetWrongTraceGate();
      vi.spyOn(await import('../gate.js'), 'preflightFileEdit').mockRejectedValueOnce(
        new Error('boom'),
      );
      const resThrow = await pair.preToolUse({ toolName: 'edit', toolInput: { path: 'boom.ts' } });
      expect(resThrow).toBeUndefined();
    });
  });

  describe('adapters', () => {
    it('covers mcp helper mappings and ipc timeout', async () => {
      expect(mcp.health(null)).toBeNull();
      expect(mcp.lockResult({ ok: true })).toEqual({ ok: true });

      const err = new TimeoutError(100);
      expect(err.name).toBe('TimeoutError');
      expect(err.message).toContain('100ms');

      // 1. connect error handling
      const origConnect = _connectSocket.connect;
      const sock1 = new EventEmitter() as any;
      sock1.destroy = vi.fn();
      _connectSocket.connect = () => sock1;
      const ipc1 = createIpcTransport('/test.sock', { connectTimeoutMs: 50 });
      const p1 = ipc1.call('m1', {});
      sock1.emit('error', new Error('connection refused'));
      const r1 = await p1;
      expect(r1.result).toBeNull();

      // 2. read timeout & empty line & socket close using mock socket
      const sockEmptyLine = new EventEmitter() as any;
      sockEmptyLine.destroy = vi.fn();
      sockEmptyLine.write = vi.fn((data: string) => {
        const parsed = JSON.parse(data.trim());
        setTimeout(() => {
          sockEmptyLine.emit(
            'data',
            Buffer.from(
              '\n\n' +
                JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { ok: true } }) +
                '\n',
            ),
          );
        }, 5);
      });
      sockEmptyLine[Symbol.asyncIterator] = async function* () {
        while (true) {
          const chunk = await new Promise((res) => sockEmptyLine.once('data', res));
          yield chunk;
        }
      };
      _connectSocket.connect = () => {
        setTimeout(() => sockEmptyLine.emit('connect'), 2);
        return sockEmptyLine;
      };

      const ipcEmptyLine = createIpcTransport('/mock.sock', {
        connectTimeoutMs: 200,
        readTimeoutMs: 500,
      });
      const rEmptyLine = await ipcEmptyLine.call('m_empty_line', {});
      expect(rEmptyLine.result).toEqual({ ok: true });
      _connectSocket.connect = origConnect;

      // 2b. read timeout fires line 121: timer = setTimeout(() => sock.destroy(new TimeoutError(readTimeoutMs)), readTimeoutMs)
      const sockReadTimeout = new EventEmitter() as any;
      let destroyError: any;
      sockReadTimeout.destroy = vi.fn((err: any) => {
        if (err) {
          destroyError = err;
          sockReadTimeout.emit('error', err);
        }
      });
      sockReadTimeout.write = vi.fn();
      sockReadTimeout[Symbol.asyncIterator] = async function* () {
        // never emits data, waits until destroyed
        await new Promise((_, reject) => sockReadTimeout.once('error', reject));
      };
      _connectSocket.connect = () => {
        setTimeout(() => sockReadTimeout.emit('connect'), 2);
        return sockReadTimeout;
      };
      const ipcReadTimeout = createIpcTransport('/mock-read-timeout.sock', {
        connectTimeoutMs: 200,
        readTimeoutMs: 20,
      });
      const rReadTimeout = await ipcReadTimeout.call('m_read_timeout', {});
      expect(rReadTimeout.result).toBeNull();
      expect(destroyError?.name).toBe('TimeoutError');
      _connectSocket.connect = origConnect;

      // 3. connect timeout handler branch (line 112)
      const sockNeverConnect = new EventEmitter() as any;
      sockNeverConnect.destroy = vi.fn();
      sockNeverConnect[Symbol.asyncIterator] = async function* () {};
      _connectSocket.connect = () => sockNeverConnect;
      const ipcConnectTimeout = createIpcTransport('/test.sock', { connectTimeoutMs: 50 });
      const rConnectTimeout = await ipcConnectTimeout.call('m_conn_timeout', {});
      expect(rConnectTimeout.result).toBeNull();
      _connectSocket.connect = origConnect;

      // 4. MCP invoke timeout branch (line 83)
      const mcpWithSlowTool = createMcpTransport(
        {
          slow_tool: () => new Promise(() => {}),
        },
        50,
      );
      const mcpSlowRes = await mcpWithSlowTool.invoke('slow_tool' as never, {});
      expect(mcpSlowRes).toBeNull();

      // 5. IPC socket closed without frame -> line 155
      const sockCloseEarly = new EventEmitter() as any;
      sockCloseEarly.destroy = vi.fn();
      sockCloseEarly.write = vi.fn();
      sockCloseEarly[Symbol.asyncIterator] = async function* () {
        // yields nothing, ends immediately
      };
      _connectSocket.connect = () => {
        setTimeout(() => sockCloseEarly.emit('connect'), 2);
        return sockCloseEarly;
      };
      const ipcCloseEarly = createIpcTransport('/mock-close.sock', {
        connectTimeoutMs: 200,
        readTimeoutMs: 200,
      });
      const rClose = await ipcCloseEarly.call('m_close', {});
      expect(rClose.result).toBeNull();
      _connectSocket.connect = origConnect;
    });
  });

  describe('additional edge case branch coverage', () => {
    it('covers agent-helpers branches: stale lock with empty owner, friction calculations, activity sorting, and atlas defaults', async () => {
      // 1. health.lock_owner is undefined -> ownerNote = '' (line 96)
      const mockClientNoOwner: WrongTraceClient = {
        isAvailable: true,
        getFileHealth: async () => ({
          path: 'no-owner.ts',
          health_score: 10,
          is_fragile: false,
          is_locked: true,
          lock_owner: undefined,
          lock_reason: 'reason',
          recent_thrashing_count: 0,
          collaborator_count: 1,
        }),
        getFrictionMatrix: async () => [],
      } as never;
      const riskNoOwner = await getCrossAgentRisk(mockClientNoOwner, 'no-owner.ts');
      expect(riskNoOwner.reasons[0]).toContain('file is locked: reason');

      // 2. totalConflicts < 3 branch (line 153) and raw conflict_count not a number (line 151)
      const mockClientLowConflicts: WrongTraceClient = {
        isAvailable: true,
        getFileHealth: async () => ({
          path: 'low.ts',
          health_score: 80,
          is_fragile: false,
          is_locked: false,
          recent_thrashing_count: 0,
          collaborator_count: 1,
        }),
        getFrictionMatrix: async () => [
          { file_path: 'low.ts', conflict_count: 'not-a-number' as never },
          { file_path: 'low.ts', conflict_count: 2 },
        ],
      } as never;
      const riskLow = await getCrossAgentRisk(mockClientLowConflicts, 'low.ts');
      expect(riskLow.risk).toBe(0);

      // 3. summarizeFriction with non-number conflict_count (lines 237, 240, 241, 244)
      const summaryEdge = summarizeFriction({
        total_collisions: 5,
        edges: [
          {
            author_model: 'a',
            overwriter_model: 'b',
            conflict_count: 'invalid' as never,
            is_self_thrash: true,
          },
        ],
      });
      expect(summaryEdge.topPair).toContain('a ↔ b');
      expect(summaryEdge.selfThrashRatioPct).toBe(20);

      // 4. getRecentActivity sorting equality & fallback actor (lines 308, 315)
      const actClientTie: WrongTraceClient = {
        isAvailable: true,
        getFrictionMatrix: async () => ({
          events: [
            {
              file_path: 'tie.ts',
              author_time: '2026-08-01T10:00:00Z',
              author_model: 'model-author',
            },
            { file_path: 'tie.ts', overwriter_time: '2026-08-01T10:00:00Z' }, // no author_model or overwriter_model -> 'unknown'
            {
              file_path: 'tie.ts',
              author_time: '2026-08-01T12:00:00Z',
              overwriter_model: 'model-overwriter',
            },
            {
              file_path: 'tie.ts',
              author_time: '2026-08-01T08:00:00Z',
              author_model: 'model-early',
            }, // older timestamp to cover a.at > b.at in sort comparator
          ],
        }),
      } as never;
      const recentTie = await getRecentActivity(actClientTie, 'tie.ts');
      expect(recentTie).toHaveLength(4);
      expect(recentTie.some((e) => e.actor === 'unknown')).toBe(true);

      // 5. digestAtlas missing workspaces, packages, files, thrash <= 5 (lines 364, 365, 371, 373, 374, 388, 393)
      const digestNoThrash = digestAtlas({
        packages: [
          {
            name: 'pkg-ok',
            files: [
              { health_score: 90, is_fragile: false, recent_thrashing_count: 2 },
              { is_fragile: false }, // health_score and recent_thrashing_count undefined
            ],
          },
          {
            name: 'pkg-empty',
          },
        ],
      } as never);
      expect(digestNoThrash?.selfThrashWorkspaces).toEqual([]);
      expect(digestNoThrash?.prose).toContain('no self-thrash hotspots');

      const digestEmptyObj = digestAtlas({});
      expect(digestEmptyObj?.workspaceCount).toBe(0);
      expect(digestEmptyObj?.fragileFileCount).toBe(0);
    });

    it('covers client.ts branches: signature omit, IPC unlock/telemetry results, getRecentEvents defaults', async () => {
      globalThis.fetch = vi.fn(async (url: string) => {
        if (url.includes('/api/health')) {
          return new Response(JSON.stringify({ ok: true, status: 'ok' }), { status: 200 });
        }
        if (url.includes('/api/symbol/history')) {
          return new Response(JSON.stringify([{ symbol: 'sym1' }]), { status: 200 });
        }
        if (url.includes('/api/events/recent')) {
          return new Response(JSON.stringify([{ event: 'ev1' }]), { status: 200 });
        }
        return new Response('{}', { status: 200 });
      }) as never;

      // 1. getSymbolLineage with signature omitted (line 182)
      const clientHttp = await createWrongTraceClient({
        baseUrl: 'http://test:3444',
        socketPath: '',
      });
      const lineageNoSig = await clientHttp.getSymbolLineage('test.ts');
      expect(Array.isArray(lineageNoSig)).toBe(true);

      // 2. getAtlas with no query / empty query (lines 219, 229)
      const atlasNoQuery = await clientHttp.getAtlas();
      expect(atlasNoQuery).toBeDefined();

      // 3. getRecentEvents with no query (lines 348, 350)
      const recentNoQuery = await clientHttp.getRecentEvents();
      expect(Array.isArray(recentNoQuery)).toBe(true);

      // 4. IPC unlockFile returning result with file_path instead of path (line 299, 300)
      const _origConnect = _connectSocket.connect;
      const sockIpc = new EventEmitter() as any;
      sockIpc.destroy = vi.fn();
      sockIpc.write = vi.fn((data: string) => {
        const parsed = JSON.parse(data);
        if (parsed.method === 'guardrail/unlock') {
          setTimeout(() => {
            sockIpc.emit(
              'data',
              Buffer.from(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: parsed.id,
                  result: { file_path: 'ipc-unlocked.ts' },
                }) + '\n',
              ),
            );
          }, 5);
        } else if (parsed.method === 'telemetry/report_run') {
          setTimeout(() => {
            sockIpc.emit(
              'data',
              Buffer.from(
                JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { status: 'ok' } }) + '\n',
              ),
            );
          }, 5);
        }
      });
      // async iterable for sock
      sockIpc[Symbol.asyncIterator] = async function* () {
        while (true) {
          const chunk = await new Promise((res) => sockIpc.once('data', res));
          yield chunk;
        }
      };

      _connectSocket.connect = () => {
        setTimeout(() => sockIpc.emit('connect'), 2);
        return sockIpc;
      };

      // 5. non-array / report without recent_collisions responses (lines 184, 201, 350, 357)
      globalThis.fetch = vi.fn(async (url: string) => {
        if (url.includes('/api/health')) {
          return new Response(JSON.stringify({ ok: true, status: 'ok' }), { status: 200 });
        }
        if (url.includes('/api/metrics/friction')) {
          // report with edges but without recent_collisions
          return new Response(JSON.stringify({ edges: [{ edge: 'e2' }] }), { status: 200 });
        }
        // return non-array object for array endpoints
        return new Response(JSON.stringify({ notAnArray: true }), { status: 200 });
      }) as never;

      const lineageNonArray = await clientHttp.getSymbolLineage('test.ts');
      expect(lineageNonArray).toEqual([]);

      const frictionNoCollisions = await clientHttp.getFrictionMatrix();
      expect(frictionNoCollisions).toHaveLength(1);
      expect((frictionNoCollisions as any).recent_collisions).toBeUndefined();

      const eventsNonArray = await clientHttp.getRecentEvents();
      expect(eventsNonArray).toEqual([]);

      const locksNonArray = await clientHttp.listLocks();
      expect(locksNonArray).toEqual([]);

      // 6. MCP fallback branches when base URL is unavailable (lines 281, 307, 333)
      const _mcpOffline = createMcpTransport({
        lock_file: async () => ({ ok: true }),
        unlock_file: async () => ({ ok: true }),
        report_telemetry: async () => ({ ok: true }),
      });
      const clientMcpFallback = await createWrongTraceClient({
        baseUrl: 'http://127.0.0.1:1', // unreachable
        socketPath: '',
        mcpTools: {
          lock_file: async () => ({ ok: true }),
          unlock_file: async () => ({ ok: true }),
          report_telemetry: async () => ({ ok: true }),
        } as never,
      });
      // Mock discover to return available: false
      (clientMcpFallback as any)._discovery.available = false;
      const mcpLockRes = await clientMcpFallback.lockFile('f.ts', 'edit');
      expect(mcpLockRes?.ok).toBe(true);
      const mcpUnlockRes = await clientMcpFallback.unlockFile('f.ts');
      expect(mcpUnlockRes?.ok).toBe(true);
      const mcpTelRes = await clientMcpFallback.reportTelemetry({} as never);
      expect(mcpTelRes?.ok).toBe(true);
    });

    it('covers hooks.ts fallback, legacy sessionId, offline post-tool, and race handling', async () => {
      const origConnect = _connectSocket.connect;
      _connectSocket.connect = () => {
        const sock: any = new EventEmitter();
        sock.destroy = vi.fn();
        sock.write = vi.fn();
        setTimeout(() => sock.emit('error', new Error('ECONNREFUSED')), 1);
        return sock;
      };

      try {
        // 1. Friction report with total_collisions > 0 but empty edges
        const summary = summarizeFriction({ total_collisions: 5, edges: [] });
        expect(summary.topPair).toBeNull();
        expect(summary.crossAgentRatioPct).toBe(100);
        expect(summary.prose).not.toContain('Top friction pair');

        // 2. Post tool use when gate client is offline (wt.isAvailable === false)
        const { preToolUse, postToolUse } = createWrongTraceHookPair(() => 'offline-pair-sess');

        // Online client to acquire
        resetWrongTraceGate();
        globalThis.fetch = vi.fn(async (url: string) => {
          if (url.includes('/api/health'))
            return new Response(JSON.stringify({ ok: true, status: 'ok' }), { status: 200 });
          if (url.includes('/guardrail/lock'))
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          return new Response(JSON.stringify({}), { status: 200 });
        }) as never;

        await preToolUse({ toolName: 'edit', toolInput: { path: 'offline-test.ts' } });

        // Now switch gate client to offline before postToolUse
        resetWrongTraceGate();
        globalThis.fetch = vi.fn(async () => {
          throw new Error('offline');
        }) as never;
        await postToolUse({ toolName: 'edit', toolInput: { path: 'offline-test.ts' } });

        // 3. Legacy hooks: trigger racedSet with no claimed owner to invoke () => '' in createWrongTracePostToolUseHook
        resetWrongTraceGate();
        globalThis.fetch = vi.fn(async (url: string) => {
          if (url.includes('/api/health'))
            return new Response(JSON.stringify({ ok: true, status: 'ok' }), { status: 200 });
          if (url.includes('/file_health'))
            return new Response(JSON.stringify({ lock_owner: 'wrongstack:' }), { status: 200 });
          if (url.includes('/guardrail/lock'))
            return new Response(JSON.stringify({ ok: false }), { status: 409 });
          if (url.includes('/guardrail/unlock'))
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          return new Response(JSON.stringify({}), { status: 200 });
        }) as never;

        const legacyPre = createWrongTracePreToolUseHook(() => 'legacy-pre');
        const legacyPost = createWrongTracePostToolUseHook();

        await legacyPre({ toolName: 'edit', toolInput: { path: 'race-legacy.ts' } });
        await legacyPost({ toolName: 'edit', toolInput: { path: 'race-legacy.ts' } });
      } finally {
        resetWrongTraceGate();
        _connectSocket.connect = origConnect;
      }
    });

    it('covers client.ts query params, mcp fallbacks, and ipc result shapes', async () => {
      let lastIpcParams: any = null;
      let lastIpcResult: any = { files: [], total_files: 0 };

      const origConnect = _connectSocket.connect;
      _connectSocket.connect = () => {
        const sock: any = new EventEmitter();
        sock.destroy = vi.fn();
        sock.write = vi.fn((data: string) => {
          const parsed = JSON.parse(data);
          lastIpcParams = parsed.params;
          setTimeout(() => {
            sock.emit(
              'data',
              Buffer.from(
                JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: lastIpcResult }) + '\n',
              ),
            );
          }, 2);
        });
        sock[Symbol.asyncIterator] = async function* () {
          while (true) {
            const chunk = await new Promise((res) => sock.once('data', res));
            yield chunk;
          }
        };
        setTimeout(() => sock.emit('connect'), 2);
        return sock;
      };

      globalThis.fetch = vi.fn(async (url: string) => {
        if (url.includes('/api/health'))
          return new Response(JSON.stringify({ ok: true, status: 'ok' }), { status: 200 });
        return new Response(JSON.stringify({}), { status: 200 });
      }) as never;

      const clientWithIpc = await createWrongTraceClient({
        baseUrl: 'http://127.0.0.1:1',
        socketPath: 'fake.sock',
      });

      await clientWithIpc.getAtlas({
        workspace: 'ws1',
        summary: true,
        includeSymbols: false,
        limit: 10,
        offset: 5,
      });
      expect(lastIpcParams).toEqual({
        workspace: 'ws1',
        summary: true,
        include_symbols: false,
        limit: 10,
        offset: 5,
      });

      await clientWithIpc.getAtlas({
        workspace: '',
        summary: false,
        includeSymbols: true,
      });
      expect(lastIpcParams).toEqual({});

      await clientWithIpc.getAtlas();
      expect(lastIpcParams).toEqual({});

      // 2. unlockFile IPC shapes
      lastIpcResult = { file_path: 'fp.ts' };
      const unl1 = await clientWithIpc.unlockFile('default.ts');
      expect(unl1).toEqual({ ok: true, path: 'fp.ts', status: 'unlocked' });

      lastIpcResult = { path: 'p.ts', status: 'custom' };
      const unl2 = await clientWithIpc.unlockFile('default.ts');
      expect(unl2).toEqual({ ok: true, path: 'p.ts', status: 'custom' });

      lastIpcResult = {};
      const unl3 = await clientWithIpc.unlockFile('default.ts');
      expect(unl3).toEqual({ ok: true, path: 'default.ts', status: 'unlocked' });

      // 3. reportTelemetry IPC shapes
      lastIpcResult = { ok: true };
      const tel1 = await clientWithIpc.reportTelemetry({} as any);
      expect(tel1).toEqual({ ok: true });

      lastIpcResult = { status: 'ok' };
      const tel2 = await clientWithIpc.reportTelemetry({} as any);
      expect(tel2).toEqual({ ok: true });

      lastIpcResult = { status: 'failed' };
      const tel3 = await clientWithIpc.reportTelemetry({} as any);
      expect(tel3).toEqual({ ok: false });

      lastIpcResult = null;
      const telNull = await clientWithIpc.reportTelemetry({} as any);
      expect(telNull).toBeDefined();

      _connectSocket.connect = origConnect;

      // 4. MCP returning null when HTTP baseUrl is not available
      const clientMcpNull = await createWrongTraceClient({
        baseUrl: '',
        socketPath: '',
        mcpTools: {
          lock_file: async () => null,
          unlock_file: async () => null,
          report_telemetry: async () => null,
        } as any,
      });
      (clientMcpNull as any)._discovery.available = false;
      expect(await clientMcpNull.lockFile('f.ts', 'edit')).toBeNull();
      expect(await clientMcpNull.unlockFile('f.ts')).toBeNull();
      expect(await clientMcpNull.reportTelemetry({} as any)).toBeNull();
    });

    it('covers IPC response with undefined result field', async () => {
      const origConnect = _connectSocket.connect;
      _connectSocket.connect = () => {
        const sock: any = new EventEmitter();
        sock.destroy = vi.fn();
        sock.write = vi.fn((data: string) => {
          const parsed = JSON.parse(data);
          setTimeout(() => {
            sock.emit(
              'data',
              Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: parsed.id }) + '\n'),
            );
          }, 2);
        });
        sock[Symbol.asyncIterator] = async function* () {
          while (true) {
            const chunk = await new Promise((res) => sock.once('data', res));
            yield chunk;
          }
        };
        setTimeout(() => sock.emit('connect'), 2);
        return sock;
      };

      const transport = createIpcTransport('fake.pipe');
      const res = await transport.call('test', {});
      expect(res.result).toBeNull();
      _connectSocket.connect = origConnect;
    });
  });
});

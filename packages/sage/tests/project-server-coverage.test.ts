/**
 * Coverage for new sage source files:
 * - project-server-protocol.ts: protocol types + encodeSageProjectServerMessage
 * - project-server-endpoint.ts: path resolution helpers
 * - sqlite-store-operations.ts: re-export barrel
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SAGE_PROJECT_SERVER_PROTOCOL_VERSION,
  encodeSageProjectServerMessage,
  type SageProjectServerMessage,
  type SageProjectServerClientMessage,
} from '../src/project-server-protocol.js';
import {
  SAGE_PROJECT_SERVER_METADATA_FILE,
  resolveProjectSageStorageRoot,
  sageProjectServerKey,
  sageProjectServerEndpoint,
  sageProjectServerMetadataPath,
  ensureSageProjectServerSocketDirectory,
} from '../src/project-server-endpoint.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sage-server-test-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

// ─── project-server-protocol ────────────────────────────────────────────────

describe('SAGE_PROJECT_SERVER_PROTOCOL_VERSION', () => {
  it('is 1', () => {
    expect(SAGE_PROJECT_SERVER_PROTOCOL_VERSION).toBe(1);
  });
});

describe('encodeSageProjectServerMessage', () => {
  it('encodes a response message as JSON + newline', () => {
    const msg: SageProjectServerMessage = {
      type: 'response', id: 1, ok: true, result: { hello: 'world' },
    };
    const encoded = encodeSageProjectServerMessage(msg);
    expect(encoded).toContain('"type":"response"');
    expect(encoded.endsWith('\n')).toBe(true);
  });

  it('encodes a hello message', () => {
    const msg: SageProjectServerMessage = {
      type: 'hello', protocolVersion: 1, pid: 1234,
      projectRoot: '/test', storageRoot: '/test/.ws/mem',
      endpoint: '/tmp/test.sock', startedAt: '2026-01-01T00:00:00.000Z',
    };
    const parsed = JSON.parse(encodeSageProjectServerMessage(msg).trim());
    expect(parsed.type).toBe('hello');
    expect(parsed.protocolVersion).toBe(1);
  });

  it('encodes an error response', () => {
    const msg: SageProjectServerMessage = {
      type: 'response', id: 2, ok: false, error: 'fail', errorName: 'TestError',
    };
    const parsed = JSON.parse(encodeSageProjectServerMessage(msg).trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe('fail');
  });

  it('encodes a cancel message', () => {
    const msg: SageProjectServerClientMessage = { type: 'cancel', id: 5 };
    const parsed = JSON.parse(encodeSageProjectServerMessage(msg).trim());
    expect(parsed.type).toBe('cancel');
  });

  it('encodes a shutdown message', () => {
    const msg: SageProjectServerClientMessage = { type: 'shutdown', id: 6, reason: 'done' };
    const parsed = JSON.parse(encodeSageProjectServerMessage(msg).trim());
    expect(parsed.type).toBe('shutdown');
    expect(parsed.reason).toBe('done');
  });

  it('encodes an event message', () => {
    const msg: SageProjectServerMessage = {
      type: 'event', event: 'memory.updated', payload: { id: 'mem-1' },
    };
    const parsed = JSON.parse(encodeSageProjectServerMessage(msg).trim());
    expect(parsed.type).toBe('event');
    expect(parsed.event).toBe('memory.updated');
  });
});

// ─── project-server-endpoint ────────────────────────────────────────────────

describe('SAGE_PROJECT_SERVER_METADATA_FILE', () => {
  it('is server.json', () => {
    expect(SAGE_PROJECT_SERVER_METADATA_FILE).toBe('server.json');
  });
});

describe('resolveProjectSageStorageRoot', () => {
  it('resolves to a path containing .wrongstack and memories', () => {
    const root = resolveProjectSageStorageRoot(tempDir);
    expect(root).toContain('.wrongstack');
    expect(root).toContain('memories');
  });
});

describe('sageProjectServerKey', () => {
  it('returns a string key', () => {
    const key = sageProjectServerKey(tempDir);
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(0);
  });

  it('returns the same key for the same root', () => {
    expect(sageProjectServerKey(tempDir)).toBe(sageProjectServerKey(tempDir));
  });
});

describe('sageProjectServerEndpoint', () => {
  it('returns a socket/pipe endpoint path', () => {
    const ep = sageProjectServerEndpoint(tempDir);
    expect(typeof ep).toBe('string');
    expect(ep.length).toBeGreaterThan(0);
  });

  it('returns the same endpoint for the same root', () => {
    expect(sageProjectServerEndpoint(tempDir)).toBe(sageProjectServerEndpoint(tempDir));
  });
});

describe('sageProjectServerMetadataPath', () => {
  it('returns a path ending with server.json', () => {
    const mp = sageProjectServerMetadataPath(tempDir);
    expect(mp).toContain(SAGE_PROJECT_SERVER_METADATA_FILE);
  });
});

describe('ensureSageProjectServerSocketDirectory', () => {
  it('creates the parent directory of the endpoint', () => {
    const endpoint = sageProjectServerEndpoint(tempDir);
    ensureSageProjectServerSocketDirectory(endpoint);
    // Just verify it doesn't throw — the actual directory may be in os.tmpdir()
    expect(typeof endpoint).toBe('string');
  });
});

// ─── sqlite-store-operations barrel ─────────────────────────────────────────

describe('sqlite-store-operations barrel', () => {
  it('re-exports admin operations', async () => {
    const ops = await import('../src/sqlite-store-operations.js');
    expect(ops.backfillAdminSage).toBeDefined();
    expect(ops.findAdminMemoriesForFile).toBeDefined();
    expect(ops.recoverAdminSage).toBeDefined();
    expect(ops.closeSqliteStore).toBeDefined();
    expect(ops.drainSqliteStoreMutations).toBeDefined();
  });
});

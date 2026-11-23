import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeGraph } from '../src/knowledge-graph.js';

/**
 * F33 (WS-045 class): KnowledgeGraph._persist appends graph nodes — project
 * knowledge that may carry sensitive detail — via fsp.appendFile + mode 0o600 (a
 * Windows no-op) with no owner-only hardening (only compaction rewrites via
 * atomicWrite). On Windows the graph log stayed readable by other local accounts
 * where inheritance was not owner-only. The graph now hardens once per active
 * file via restrictFilePermissions and re-hardens after compaction.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the graph log path.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f33-'));
  icaclsCalls.length = 0;
  _filePermOps.platform = 'win32';
  _filePermOps.userInfo = (() => ({
    username: 'tester',
    uid: -1,
    gid: -1,
    homedir: 'C:\\Users\\tester',
    shell: null,
  })) as typeof _filePermOps.userInfo;
  _filePermOps.execFileAsync = async (file, args) => {
    icaclsCalls.push({ file, args });
    return { stdout: '', stderr: '' };
  };
});

afterEach(async () => {
  _filePermOps.platform = process.platform;
  _filePermOps.userInfo = undefined;
  _filePermOps.execFileAsync = undefined;
  await fs.rm(dir, { recursive: true, force: true });
});

const hardened = (t: string) => icaclsCalls.some((c) => c.file === 'icacls' && c.args[0] === t);
const node = (key: string) =>
  ({
    type: 'fact',
    category: 'bug',
    subject: 'SECRET subject',
    detail: 'auth/session.ts line 42',
    key,
    discoveredBy: 'test-agent',
    discoveredAt: new Date().toISOString(),
    tags: [],
    related: [],
  }) as never;

describe('KnowledgeGraph owner-only hardening (F33)', () => {
  it('hardens the graph log on add', async () => {
    const graph = new KnowledgeGraph(dir);
    await graph.add(node('k1'));
    const graphFile = path.join(dir, '_knowledge_graph', 'graph.jsonl');
    expect(hardened(graphFile), 'add issues icacls for the graph log').toBe(true);
  });

  it('hardens ONCE across multiple adds', async () => {
    const graph = new KnowledgeGraph(dir);
    await graph.add(node('k1'));
    await graph.add(node('k2'));
    const graphFile = path.join(dir, '_knowledge_graph', 'graph.jsonl');
    const count = icaclsCalls.filter((c) => c.file === 'icacls' && c.args[0] === graphFile).length;
    expect(count).toBe(1);
  });
});

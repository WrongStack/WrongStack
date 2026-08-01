/**
 * WS-015 — ACP session identity, storage paths, and working directory.
 *
 * Three defects with one root: the session id and cwd arrive from the ACP
 * client on the wire and were used verbatim.
 *
 *  1. `ACPSessionStore` joined `sessionId` onto its directory, so `../../..`
 *     escaped it. The `.json` suffix was the only thing narrowing the blast
 *     radius: `load` read any `.json` on the machine (the provider config
 *     holds API keys), `delete` unlinked any `.json`, and `save` was the worst
 *     — a loaded session keeps the traversing id as `state.id`, so the next
 *     persist WROTE to that path.
 *
 *  2. Session ids were `sess_1`, `sess_2`, … from a counter. The handler has
 *     no per-connection ownership, so anything that can name a session id can
 *     load, prompt, cancel or delete it. Over stdio that is academic — one
 *     client per process — but the agent also serves over HTTP, where a
 *     guessable id is the entire authorization story for any local process or
 *     page that reaches the port.
 *
 *  3. `cwd` was accepted with a bare `typeof === 'string'` check, and it is
 *     the directory the agent then reads, writes and executes in.
 *
 * NOT fixed here, and deliberately so: real per-connection session ownership.
 * Random ids remove the trivial enumeration that made its absence exploitable;
 * they are not a substitute for it. A caller that learns an id can still drive
 * that session.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACPProtocolHandler, type RunTurn } from '../src/agent/protocol-handler.js';
import { ACPSessionStore } from '../src/agent/session-store.js';
import type { AgentServerTransport } from '../src/agent/stdio-transport.js';

let root: string;
let storeDir: string;
let workDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'acp-sec-'));
  storeDir = path.join(root, 'store');
  workDir = path.join(root, 'work');
  await new ACPSessionStore({ dir: storeDir }).init();
  await mkdir(workDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

function session(id: string) {
  return {
    id,
    cwd: workDir,
    abort: new AbortController(),
    modeId: 'default',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('ACPSessionStore path containment (WS-015)', () => {
  const TRAVERSALS = [
    '../escaped',
    '../../escaped',
    '..\\escaped',
    'sub/escaped',
    'sub\\escaped',
    '..',
    '.',
    '',
    'C:evil',
    'has\0nul',
  ];

  it('refuses to READ outside the store directory', async () => {
    const store = new ACPSessionStore({ dir: storeDir });
    // A real, readable file one level up — the thing a traversal would reach.
    await writeFile(path.join(root, 'secret.json'), JSON.stringify({ id: 'secret' }), 'utf8');

    expect(await store.load('../secret')).toBeNull();
    for (const id of TRAVERSALS) {
      expect(await store.load(id), id).toBeNull();
    }
  });

  it('refuses to WRITE outside the store directory — the severe case', async () => {
    // `save` is the sharp end: after a traversing `session/load`, the session
    // keeps that id, so every subsequent persist targets the escaped path.
    const store = new ACPSessionStore({ dir: storeDir });
    for (const id of TRAVERSALS) {
      await expect(store.save(session(id)), id).rejects.toThrow(/unsafe session id/);
    }
    // Nothing leaked out of the store directory.
    expect((await readdir(root)).sort()).toEqual(['store', 'work']);
  });

  it('refuses to DELETE outside the store directory', async () => {
    const store = new ACPSessionStore({ dir: storeDir });
    const victim = path.join(root, 'victim.json');
    await writeFile(victim, '{}', 'utf8');

    await store.delete('../victim');
    for (const id of TRAVERSALS) await store.delete(id);

    // Still there.
    expect(await readFile(victim, 'utf8')).toBe('{}');
  });

  it('still round-trips an ordinary session id', async () => {
    const store = new ACPSessionStore({ dir: storeDir });
    const id = 'sess_1_0123456789abcdef0123456789abcdef';
    await store.save(session(id));
    const loaded = await store.load(id);
    expect(loaded?.id).toBe(id);
    await store.delete(id);
    expect(await store.load(id)).toBeNull();
  });
});

function makeHandler(defaultCwd: string): {
  handler: ACPProtocolHandler;
  sent: Array<{ id?: unknown; result?: Record<string, unknown>; error?: { code: number } }>;
} {
  const sent: Array<{ id?: unknown; result?: Record<string, unknown>; error?: { code: number } }> =
    [];
  const runTurn: RunTurn = async () => ({ stopReason: 'end_turn' });
  const handler = new ACPProtocolHandler({
    transport: {
      send: async (msg: unknown) => {
        sent.push(msg as never);
      },
    } as never as AgentServerTransport,
    defaultCwd,
    runTurn,
  });
  return { handler, sent };
}

async function newSession(
  handler: ACPProtocolHandler,
  params: Record<string, unknown>,
): Promise<void> {
  await handler.handleMessage({ id: 99, method: 'session/new', params });
}

describe('session id unpredictability (WS-015)', () => {
  it('does not hand out sequential ids an attacker can enumerate', async () => {
    const { handler, sent } = makeHandler(workDir);
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });

    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      sent.length = 0;
      await newSession(handler, {});
      const created = sent.find((m) => m.result?.['sessionId'])?.result?.['sessionId'];
      ids.push(created as string);
    }

    expect(new Set(ids).size).toBe(5);
    for (const id of ids) {
      expect(id).toMatch(/^sess_\d+_[0-9a-f]{32}$/);
    }
    // The pre-fix shape. If this ever passes again, enumeration is back.
    expect(ids).not.toContain('sess_1');
    expect(ids).not.toContain('sess_2');
  });

  it('mints ids that are themselves safe as store filenames', async () => {
    // The id becomes `<id>.json`; an id the store rejects would make the
    // session unpersistable.
    const { handler, sent } = makeHandler(workDir);
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await newSession(handler, {});
    const id = sent.find((m) => m.result?.['sessionId'])?.result?.['sessionId'] as string;

    const store = new ACPSessionStore({ dir: storeDir });
    await expect(store.save(session(id))).resolves.toBe(id);
  });
});

describe('session cwd validation (WS-015)', () => {
  const INVALID = ['relative/path', '.', '..', ''];

  it('rejects a cwd that is not an absolute path', async () => {
    const { handler, sent } = makeHandler(workDir);
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    for (const cwd of INVALID) {
      sent.length = 0;
      await newSession(handler, { cwd });
      expect(sent.at(-1)?.error?.code, cwd).toBe(-32602);
    }
  });

  it('rejects a cwd that does not exist', async () => {
    const { handler, sent } = makeHandler(workDir);
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    sent.length = 0;
    await newSession(handler, { cwd: path.join(root, 'definitely-missing') });
    expect(sent.at(-1)?.error?.code).toBe(-32602);
  });

  it('rejects a cwd that is a file rather than a directory', async () => {
    const file = path.join(root, 'a-file.txt');
    await writeFile(file, 'x', 'utf8');
    const { handler, sent } = makeHandler(workDir);
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    sent.length = 0;
    await newSession(handler, { cwd: file });
    expect(sent.at(-1)?.error?.code).toBe(-32602);
  });

  it('accepts a real directory — the editor workspace case this exists for', async () => {
    // ACP clients (Zed, JetBrains) legitimately name their own project root,
    // so this must NOT be confined to a fixed boundary.
    const { handler, sent } = makeHandler(workDir);
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    sent.length = 0;
    await newSession(handler, { cwd: workDir });
    expect(sent.at(-1)?.error).toBeUndefined();
    expect(sent.at(-1)?.result?.['sessionId']).toBeTruthy();
  });

  it('applies the same rule to session/fork', async () => {
    const { handler, sent } = makeHandler(workDir);
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await newSession(handler, { cwd: workDir });
    const sourceId = sent.find((m) => m.result?.['sessionId'])?.result?.['sessionId'] as string;

    sent.length = 0;
    await handler.handleMessage({
      id: 5,
      method: 'session/fork',
      params: { sessionId: sourceId, cwd: path.join(root, 'nope') },
    });
    expect(sent.at(-1)?.error?.code).toBe(-32602);
  });
});

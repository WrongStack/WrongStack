/**
 * End-to-end wire test for `memory.sage.forFile`.
 *
 * The unit suite in `memory-handlers.test.ts` mocks `@wrongstack/sage`, so it
 * can only assert the shape the mock was written to return. That is exactly
 * how the handler shipped for months emitting `payload: <buckets>` while every
 * client read `payload.response` — both sides had green tests and neither ever
 * saw the other's bytes.
 *
 * This file closes that gap: a real SQLite SAGE store in a tmpdir, a real
 * memory anchored to a real path, the real handler, and assertions written
 * from the *consumer's* point of view (`packages/webui/src/hooks/useMemoryForFile.ts`
 * and `packages/simpleui/src/memory-drawer.tsx` both read `payload.response`).
 *
 * It deliberately does NOT mock `@wrongstack/sage` — keep it in its own file.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isSqliteAvailable, SqliteMemoryPort } from '@wrongstack/sage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSageForFile } from '../src/server/memory-handlers.js';

const ANCHORED_FILE = 'packages/tools/src/codebase-index/dead-code-scan.ts';

let tempDir: string;
let store: SqliteMemoryPort;

function mockWs(): { readyState: number; send: ReturnType<typeof vi.fn> } {
  // `send()` in ws-utils only writes when readyState === OPEN (1).
  return { readyState: 1, send: vi.fn() };
}

function sentFrames(ws: { send: ReturnType<typeof vi.fn> }): Array<{
  type: string;
  payload: Record<string, unknown>;
}> {
  return ws.send.mock.calls.map((call) => JSON.parse(call[0] as string));
}

beforeEach(async () => {
  if (!isSqliteAvailable()) throw new Error('node:sqlite is required (Node >= 22.5).');
  tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wrongstack-forfile-wire-'));
  store = new SqliteMemoryPort({ projectRoot: tempDir });
  await store.initialize();
});

afterEach(async () => {
  try {
    store.close();
  } catch {
    // already closed
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  await fs.promises.rm(tempDir, { recursive: true, force: true });
});

describe('memory.sage.forFile wire contract (real store)', () => {
  it('delivers file-anchored memories under payload.response', async () => {
    const remembered = await store.rememberSage({
      text: 'Dead-code scan must stay incremental.',
      kind: 'decision',
      scope: 'project',
      anchors: [{ type: 'file', path: ANCHORED_FILE }],
    });

    const ws = mockWs();
    await handleSageForFile(ws as never, { payload: { filePath: ANCHORED_FILE } }, store);

    const [frame] = sentFrames(ws);
    expect(frame?.type).toBe('memory.sage.forFile');
    expect(frame?.payload).not.toHaveProperty('error');

    // The consumer contract: buckets live under `payload.response`, never as
    // the payload itself. Reading it the way the clients do must find the
    // memory that the store demonstrably holds.
    const response = frame?.payload['response'] as {
      filePath: string;
      primaryMatches: Array<{ memory: { id: string }; matchedVia: string }>;
      totalCount: number;
    };
    expect(response).toBeDefined();
    expect(response.filePath).toBe(ANCHORED_FILE);
    expect(response.totalCount).toBeGreaterThan(0);
    expect(response.primaryMatches.map((match) => match.memory.id)).toContain(remembered.id);
    expect(response.primaryMatches[0]?.matchedVia).toBe('anchor_file');

    // Guard the regression directly: the buckets must NOT be spread onto the
    // payload, which is what made every client render "no memories".
    expect(frame?.payload).not.toHaveProperty('primaryMatches');
  });

  it('answers with an empty bucket set for a file nothing is anchored to', async () => {
    await store.rememberSage({
      text: 'Unrelated note.',
      kind: 'fact',
      scope: 'project',
      anchors: [{ type: 'file', path: 'packages/core/src/unrelated.ts' }],
    });

    const ws = mockWs();
    await handleSageForFile(ws as never, { payload: { filePath: ANCHORED_FILE } }, store);

    const response = sentFrames(ws)[0]?.payload['response'] as { totalCount: number };
    expect(response).toBeDefined();
    expect(response.totalCount).toBe(0);
  });

  it('honours the wire-level showDeleted toggle against the real store', async () => {
    const remembered = await store.rememberSage({
      text: 'Recoverable note about the scanner.',
      kind: 'fact',
      scope: 'project',
      anchors: [{ type: 'file', path: ANCHORED_FILE }],
    });
    // Deletion requires explicit authorization — the store refuses an
    // unforced delete and records the flag in the audit log.
    await store.deleteSage(remembered.id, 'wire test', { force: true });

    const hidden = mockWs();
    await handleSageForFile(hidden as never, { payload: { filePath: ANCHORED_FILE } }, store);
    const withoutDeleted = sentFrames(hidden)[0]?.payload['response'] as { totalCount: number };
    expect(withoutDeleted.totalCount).toBe(0);

    const shown = mockWs();
    await handleSageForFile(
      shown as never,
      { payload: { filePath: ANCHORED_FILE, showDeleted: true } },
      store,
    );
    const withDeleted = sentFrames(shown)[0]?.payload['response'] as {
      totalCount: number;
      primaryMatches: Array<{ memory: { id: string } }>;
    };
    expect(withDeleted.totalCount).toBe(1);
    expect(withDeleted.primaryMatches[0]?.memory.id).toBe(remembered.id);
  });

  it('accepts an absolute path and answers with the normalized project-relative one', async () => {
    await store.rememberSage({
      text: 'Absolute-path lookup must normalize.',
      kind: 'fact',
      scope: 'project',
      anchors: [{ type: 'file', path: ANCHORED_FILE }],
    });

    const ws = mockWs();
    await handleSageForFile(
      ws as never,
      { payload: { filePath: path.join(tempDir, ANCHORED_FILE) } },
      store,
    );

    // The client's cross-instance guard compares this against what it sent,
    // which is why it normalizes before comparing.
    const response = sentFrames(ws)[0]?.payload['response'] as {
      filePath: string;
      totalCount: number;
    };
    expect(response.filePath).toBe(ANCHORED_FILE);
    expect(response.totalCount).toBeGreaterThan(0);
  });
});

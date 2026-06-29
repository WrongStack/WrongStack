import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultSessionRewinder } from '../../src/storage/session-rewinder.js';

describe('DefaultSessionRewinder', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-rewind-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function writeSession(events: object[]): Promise<string> {
    const id = Math.random().toString(36).slice(2);
    const file = path.join(tmp, `${id}.jsonl`);
    await fs.writeFile(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    return id;
  }

  function makeCheckpoint(promptIndex: number, preview: string) {
    return { type: 'checkpoint' as const, ts: new Date().toISOString(), promptIndex, promptPreview: preview };
  }

  function makeFileSnapshot(promptIndex: number, files: Array<{ path: string; action: string; before: string | null; after: string | null }>) {
    return { type: 'file_snapshot' as const, ts: new Date().toISOString(), promptIndex, files };
  }

  describe('listCheckpoints', () => {
    it('reads checkpoints from date-sharded session ids', async () => {
      const id = '2026-06-11/sess_01JX2S9V7T5M6N7P8Q9R0STXVW';
      const shardDir = path.join(tmp, '2026-06-11');
      await fs.mkdir(shardDir, { recursive: true });
      await fs.writeFile(
        path.join(shardDir, 'sess_01JX2S9V7T5M6N7P8Q9R0STXVW.jsonl'),
        JSON.stringify(makeCheckpoint(0, 'sharded prompt')) + '\n',
        'utf8',
      );

      const rewind = new DefaultSessionRewinder(tmp, tmp);
      expect(await rewind.listCheckpoints(id)).toMatchObject([
        { promptIndex: 0, promptPreview: 'sharded prompt' },
      ]);
    });

    it('returns empty array when no checkpoints', async () => {
      const id = await writeSession([
        { type: 'session_start', ts: new Date().toISOString(), id: 's1', model: 'm', provider: 'p' },
      ]);
      const rewind = new DefaultSessionRewinder(tmp, tmp);
      const checkpoints = await rewind.listCheckpoints(id);
      expect(checkpoints).toEqual([]);
    });

    it('returns all checkpoints with correct data', async () => {
      const id = await writeSession([
        makeCheckpoint(0, 'first prompt'),
        makeCheckpoint(1, 'second prompt'),
        makeCheckpoint(2, 'third prompt'),
      ]);
      const rewind = new DefaultSessionRewinder(tmp, tmp);
      const checkpoints = await rewind.listCheckpoints(id);
      expect(checkpoints).toHaveLength(3);
      expect(checkpoints[0]).toMatchObject({ promptIndex: 0, promptPreview: 'first prompt' });
      expect(checkpoints[1]).toMatchObject({ promptIndex: 1, promptPreview: 'second prompt' });
      expect(checkpoints[2]).toMatchObject({ promptIndex: 2, promptPreview: 'third prompt' });
    });

    it('includes fileCount from file_snapshot events', async () => {
      const id = await writeSession([
        makeCheckpoint(0, 'first'),
        makeFileSnapshot(0, [
          { path: '/a.txt', action: 'modified', before: 'x', after: 'y' },
          { path: '/b.txt', action: 'created', before: null, after: 'z' },
        ]),
        makeCheckpoint(1, 'second'),
      ]);
      const rewind = new DefaultSessionRewinder(tmp, tmp);
      const checkpoints = await rewind.listCheckpoints(id);
      expect(checkpoints[0]).toMatchObject({ promptIndex: 0, fileCount: 2 });
      expect(checkpoints[1]).toMatchObject({ promptIndex: 1, fileCount: 0 });
    });
  });

  describe('rewindToCheckpoint', () => {
    it('reverts files after target checkpoint', async () => {
      const testFile = path.join(tmp, 'test.txt');
      await fs.writeFile(testFile, 'original', 'utf8');

      const id = await writeSession([
        makeCheckpoint(0, 'first'),
        makeFileSnapshot(1, [{ path: testFile, action: 'modified', before: 'original', after: 'changed1' }]),
        makeCheckpoint(1, 'second'),
        makeFileSnapshot(2, [{ path: testFile, action: 'modified', before: 'changed1', after: 'changed2' }]),
        makeCheckpoint(2, 'third'),
      ]);

      const rewind = new DefaultSessionRewinder(tmp, tmp);
      const result = await rewind.rewindToCheckpoint(id, 1);

      expect(result.revertedFiles).toContain(testFile);
      const content = await fs.readFile(testFile, 'utf8');
      expect(content).toBe('changed1');
      expect(result.toPromptIndex).toBe(1);
      expect(result.removedEvents).toBeGreaterThanOrEqual(0);
    });

    it('throws when checkpoint not found', async () => {
      const id = await writeSession([makeCheckpoint(0, 'first')]);
      const rewind = new DefaultSessionRewinder(tmp, tmp);
      await expect(rewind.rewindToCheckpoint(id, 999)).rejects.toThrow('Checkpoint 999 not found');
    });

    it('handles file creation revert (deletes created file)', async () => {
      const createdFile = path.join(tmp, 'created.txt');

      // The correct event order in session:
      // checkpoint(n) is written AFTER prompt n is processed
      // file_snapshot(n) tracks changes MADE during prompt n
      // So file_snapshot(0) comes AFTER checkpoint(0) but REVERT means undoing prompt 1's changes
      const id = await writeSession([
        makeCheckpoint(0, 'first'),
        // file_snapshot(0) represents changes from prompt 0 - this is what we want to REVERT when going to checkpoint 1
        makeFileSnapshot(0, [{ path: createdFile, action: 'created', before: null, after: 'content' }]),
        makeCheckpoint(1, 'second'),
      ]);

      // File needs to exist (simulating state after prompt 0 ran)
      await fs.writeFile(createdFile, 'content', 'utf8');

      const rewind = new DefaultSessionRewinder(tmp, tmp);
      // Rewind to checkpoint 1 means "go back to state after prompt 0, before prompt 1"
      const result = await rewind.rewindToCheckpoint(id, 0);

      expect(result.revertedFiles).toContain(createdFile);
      await expect(fs.access(createdFile)).rejects.toThrow();
    });

    it('handles file deletion revert (restores deleted file)', async () => {
      const deletedFile = path.join(tmp, 'deleted.txt');
      await fs.writeFile(deletedFile, 'original content', 'utf8');

      const id = await writeSession([
        makeCheckpoint(0, 'first'),
        makeFileSnapshot(0, [{ path: deletedFile, action: 'deleted', before: 'original content', after: null }]),
        makeCheckpoint(1, 'second'),
      ]);

      const rewind = new DefaultSessionRewinder(tmp, tmp);
      const result = await rewind.rewindToCheckpoint(id, 0);

      expect(result.revertedFiles).toContain(deletedFile);
      const content = await fs.readFile(deletedFile, 'utf8');
      expect(content).toBe('original content');
    });

    // Test error collection is available (actual I/O errors are hard to trigger in temp dirs)
    it('returns empty errors for successful reverts', async () => {
      const testFile = path.join(tmp, 'success.txt');
      await fs.writeFile(testFile, 'modified content', 'utf8');

      const id = await writeSession([
        makeCheckpoint(0, 'first'),
        makeFileSnapshot(0, [{ path: testFile, action: 'modified', before: 'modified content', after: 'new content' }]),
        makeCheckpoint(1, 'second'),
      ]);

      const rewind = new DefaultSessionRewinder(tmp, tmp);
      const result = await rewind.rewindToCheckpoint(id, 0);

      expect(result.revertedFiles).toContain(testFile);
      expect(result.errors).toEqual([]);
    });
  });

  describe('rewindLastN', () => {
    it('reverts last N checkpoints', async () => {
      const testFile = path.join(tmp, 'test.txt');
      await fs.writeFile(testFile, 'v0', 'utf8');

      const id = await writeSession([
        makeCheckpoint(0, 'v0'),
        makeFileSnapshot(1, [{ path: testFile, action: 'modified', before: 'v0', after: 'v1' }]),
        makeCheckpoint(1, 'v1'),
        makeFileSnapshot(2, [{ path: testFile, action: 'modified', before: 'v1', after: 'v2' }]),
        makeCheckpoint(2, 'v2'),
      ]);

      const rewind = new DefaultSessionRewinder(tmp, tmp);
      const result = await rewind.rewindLastN(id, 1);

      expect(result.revertedFiles).toContain(testFile);
      const content = await fs.readFile(testFile, 'utf8');
      expect(content).toBe('v1');
    });

    it('reverts all when N exceeds checkpoint count', async () => {
      const testFile = path.join(tmp, 'test.txt');
      await fs.writeFile(testFile, 'v0', 'utf8');

      const id = await writeSession([
        makeCheckpoint(0, 'v0'),
        makeFileSnapshot(1, [{ path: testFile, action: 'modified', before: 'v0', after: 'v1' }]),
        makeCheckpoint(1, 'v1'),
      ]);

      const rewind = new DefaultSessionRewinder(tmp, tmp);
      const result = await rewind.rewindLastN(id, 10);

      expect(result.revertedFiles).toContain(testFile);
      const content = await fs.readFile(testFile, 'utf8');
      expect(content).toBe('v0');
    });

    it('returns empty result when no snapshots', async () => {
      const id = await writeSession([makeCheckpoint(0, 'only checkpoint')]);
      const rewind = new DefaultSessionRewinder(tmp, tmp);
      const result = await rewind.rewindLastN(id, 1);
      expect(result.revertedFiles).toEqual([]);
      expect(result.errors).toEqual([]);
    });
  });

  describe('rewindToStart', () => {
    it('reverts all changes to session start', async () => {
      const testFile = path.join(tmp, 'test.txt');
      await fs.writeFile(testFile, 'original', 'utf8');

      const id = await writeSession([
        makeCheckpoint(0, 'start'),
        makeFileSnapshot(1, [{ path: testFile, action: 'modified', before: 'original', after: 'changed' }]),
        makeCheckpoint(1, 'after change'),
        makeFileSnapshot(2, [{ path: testFile, action: 'modified', before: 'changed', after: 'changed2' }]),
        makeCheckpoint(2, 'final'),
      ]);

      const rewind = new DefaultSessionRewinder(tmp, tmp);
      const result = await rewind.rewindToStart(id);

      expect(result.revertedFiles).toContain(testFile);
      const content = await fs.readFile(testFile, 'utf8');
      expect(content).toBe('original');
    });

    it('handles multiple file changes', async () => {
      const file1 = path.join(tmp, 'file1.txt');
      const file2 = path.join(tmp, 'file2.txt');
      await fs.writeFile(file1, 'f1v0', 'utf8');
      await fs.writeFile(file2, 'f2v0', 'utf8');

      const id = await writeSession([
        makeCheckpoint(0, 'start'),
        makeFileSnapshot(1, [
          { path: file1, action: 'modified', before: 'f1v0', after: 'f1v1' },
          { path: file2, action: 'modified', before: 'f2v0', after: 'f2v1' },
        ]),
        makeCheckpoint(1, 'after'),
      ]);

      const rewind = new DefaultSessionRewinder(tmp, tmp);
      const result = await rewind.rewindToStart(id);

      expect(result.revertedFiles).toContain(file1);
      expect(result.revertedFiles).toContain(file2);
      expect(await fs.readFile(file1, 'utf8')).toBe('f1v0');
      expect(await fs.readFile(file2, 'utf8')).toBe('f2v0');
    });
  });

  describe('truncateToCheckpoint', () => {
    async function makeSessionStore(tmpDir: string) {
      const { DefaultSessionStore } = await import('../../src/storage/session-store.js');
      return new DefaultSessionStore({ dir: tmpDir });
    }

    it('removes events after target promptIndex', async () => {
      const store = await makeSessionStore(tmp);
      const writer = await store.create({ id: 's1', model: 'gpt4', provider: 'openai' });

      // promptIndex 0: user_input + llm_response + checkpoint
      await writer.append({ type: 'user_input', ts: '2024-01-01T00:00:00Z', content: 'first' });
      await writer.append({ type: 'llm_response', ts: '2024-01-01T00:00:01Z', content: [], stopReason: 'end_turn', usage: { input: 10, output: 20 } });
      await writer.writeCheckpoint(0, 'first prompt');

      // promptIndex 1
      await writer.append({ type: 'user_input', ts: '2024-01-01T00:00:02Z', content: 'second' });
      await writer.append({ type: 'llm_response', ts: '2024-01-01T00:00:03Z', content: [], stopReason: 'end_turn', usage: { input: 30, output: 40 } });
      await writer.writeCheckpoint(1, 'second prompt');

      // promptIndex 2
      await writer.append({ type: 'user_input', ts: '2024-01-01T00:00:04Z', content: 'third' });
      await writer.append({ type: 'llm_response', ts: '2024-01-01T00:00:05Z', content: [], stopReason: 'end_turn', usage: { input: 50, output: 60 } });
      await writer.writeCheckpoint(2, 'third prompt');

      await writer.close();

      // Reload and truncate
      const store2 = await makeSessionStore(tmp);
      const writer2 = await (await store2.resume('s1')).writer;
      const removed = await writer2.truncateToCheckpoint(1);
      await writer2.close();

      // Verify remaining events
      const data = await store2.load('s1');
      expect(data.events.filter((e) => e.type === 'user_input')).toHaveLength(2); // first + second
      expect(removed).toBeGreaterThan(0);
    });

    it('writes rewound event after truncate', async () => {
      const store = await makeSessionStore(tmp);
      const writer = await store.create({ id: 's2', model: 'gpt4', provider: 'openai' });
      await writer.append({ type: 'user_input', ts: '2024-01-01T00:00:00Z', content: 'first' });
      await writer.writeCheckpoint(0, 'first');
      await writer.append({ type: 'user_input', ts: '2024-01-01T00:00:01Z', content: 'second' });
      await writer.writeCheckpoint(1, 'second');
      await writer.close();

      const store2 = await makeSessionStore(tmp);
      const writer2 = await (await store2.resume('s2')).writer;
      await writer2.truncateToCheckpoint(0);
      await writer2.close();

      const data = await store2.load('s2');
      const rewound = data.events.find((e) => e.type === 'rewound');
      expect(rewound).toBeDefined();
      expect((rewound as { toPromptIndex: number }).toPromptIndex).toBe(0);
    });

    it('returns 0 when no filePath', async () => {
      const store = await makeSessionStore(tmp);
      const writer = await store.create({ id: 's3', model: 'gpt4', provider: 'openai' });
      const removed = await writer.truncateToCheckpoint(0);
      await writer.close();
      expect(removed).toBe(0);
    });
  });
});

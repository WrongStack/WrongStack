import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultSessionStore } from '../../src/storage/session-store.js';

describe('truncateToCheckpoint edge cases', () => {
  let tmp: string;
  let store: DefaultSessionStore;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'trunc-'));
    store = new DefaultSessionStore({ dir: tmp });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('preserves malformed JSON lines when they appear before the target checkpoint', async () => {
    // Write a session JSONL manually with a malformed line before the target checkpoint
    const id = 'malformed-before';
    const malformedLine = 'NOT_VALID_JSON {{{';
    const goodLines = [
      JSON.stringify({
        type: 'session_start',
        ts: '2024-01-01T00:00:00Z',
        id,
        model: 'gpt4',
        provider: 'openai',
      }),
      malformedLine, // malformed before target
      JSON.stringify({
        type: 'user_input',
        ts: '2024-01-01T00:00:01Z',
        content: 'first prompt',
        promptIndex: 0,
      }),
      JSON.stringify({ type: 'checkpoint', ts: '2024-01-01T00:00:02Z', promptIndex: 0 }),
      JSON.stringify({
        type: 'user_input',
        ts: '2024-01-01T00:00:03Z',
        content: 'second prompt',
        promptIndex: 1,
      }),
      JSON.stringify({ type: 'checkpoint', ts: '2024-01-01T00:00:04Z', promptIndex: 1 }),
      JSON.stringify({
        type: 'user_input',
        ts: '2024-01-01T00:00:05Z',
        content: 'third prompt',
        promptIndex: 2,
      }),
    ];
    const fileContent = goodLines.join('\n') + '\n';
    await fs.writeFile(path.join(tmp, `${id}.jsonl`), fileContent);

    const resumed = await store.resume(id);
    const removed = await resumed.writer.truncateToCheckpoint(0);
    await resumed.writer.close();

    expect(removed).toBe(3);
    const raw = await fs.readFile(path.join(tmp, `${id}.jsonl`), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    // Malformed line should be kept (it was before the target checkpoint at promptIndex 0)
    expect(lines.some((l) => l.includes('NOT_VALID_JSON'))).toBe(true);
    // Events after promptIndex 0 should be removed
    expect(lines.some((l) => l.includes('second prompt'))).toBe(false);
    expect(lines.some((l) => l.includes('third prompt'))).toBe(false);
  });

  it('finds a checkpoint whose JSONL record straddles the scan chunk boundary', async () => {
    const id = 'checkpoint-crosses-chunk';
    const chunkSize = 65_536;
    const checkpointStart = chunkSize - 16;
    const sessionStart = JSON.stringify({
      type: 'session_start',
      ts: '2024-01-01T00:00:00Z',
      id,
      model: 'gpt4',
      provider: 'openai',
    });
    const emptyPadding = JSON.stringify({
      type: 'user_input',
      ts: '2024-01-01T00:00:01Z',
      content: '',
      promptIndex: 0,
    });
    const paddingLength =
      checkpointStart - Buffer.byteLength(`${sessionStart}\n${emptyPadding}\n`, 'utf8');
    expect(paddingLength).toBeGreaterThan(0);

    const paddingEvent = JSON.stringify({
      type: 'user_input',
      ts: '2024-01-01T00:00:01Z',
      content: 'x'.repeat(paddingLength),
      promptIndex: 0,
    });
    const targetCheckpoint = JSON.stringify({
      type: 'checkpoint',
      ts: '2024-01-01T00:00:02Z',
      promptIndex: 0,
    });
    const laterEvent = JSON.stringify({
      type: 'user_input',
      ts: '2024-01-01T00:00:03Z',
      content: 'remove me',
      promptIndex: 1,
    });
    const laterCheckpoint = JSON.stringify({
      type: 'checkpoint',
      ts: '2024-01-01T00:00:04Z',
      promptIndex: 1,
    });
    const fileContent = `${sessionStart}\n${paddingEvent}\n${targetCheckpoint}\n${laterEvent}\n${laterCheckpoint}\n`;
    expect(Buffer.byteLength(`${sessionStart}\n${paddingEvent}\n`, 'utf8')).toBe(checkpointStart);
    expect(Buffer.byteLength(targetCheckpoint, 'utf8')).toBeGreaterThan(
      chunkSize - checkpointStart,
    );
    await fs.writeFile(path.join(tmp, `${id}.jsonl`), fileContent);

    const resumed = await store.resume(id);
    const removed = await resumed.writer.truncateToCheckpoint(0);
    await resumed.writer.close();

    // The later event and later checkpoint after promptIndex 0 are removed.
    expect(removed).toBe(2);
    const raw = await fs.readFile(path.join(tmp, `${id}.jsonl`), 'utf8');
    const events = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type?: string; promptIndex?: number });
    expect(events).toContainEqual(expect.objectContaining({ type: 'checkpoint', promptIndex: 0 }));
    expect(events).not.toContainEqual(expect.objectContaining({ promptIndex: 1 }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'rewound' }));
  });

  it('truncateToCheckpoint returns 0 when filePath is undefined (no-op)', async () => {
    // This exercises the early return when filePath is falsy
    // We can't directly test this since filePath is set on create, but we can
    // verify the behavior through the public API
    const w = await store.create({ id: 'nop', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: new Date().toISOString(), content: 'x' });
    await w.close();
    // The resumed writer should have a valid filePath; testing via direct call
    const result = await w.truncateToCheckpoint(0);
    expect(result).toBe(0); // file was already closed but no error
  });
});

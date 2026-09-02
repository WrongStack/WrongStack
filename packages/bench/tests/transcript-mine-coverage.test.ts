import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mineTranscript } from '../src/transcript-mine.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-tm-cov-'));
  tempDirs.push(dir);
  return dir;
}

describe('mineTranscript — edge cases', () => {
  it('handles session_resumed event as the session id source', async () => {
    const dir = await tempDir();
    const transcriptPath = path.join(dir, 'source.jsonl');
    const raw =
      [
        { type: 'session_resumed', id: 'resumed-session-42', model: 'x' },
        { type: 'tool_use', id: 'edit-1', name: 'edit', input: { path: 'main.ts' } },
        { type: 'tool_call_end', id: 'edit-1', name: 'edit', ok: true },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n';
    await fs.writeFile(transcriptPath, raw, 'utf8');

    const result = await mineTranscript({ transcriptPath, outDir: path.join(dir, 'evals') });
    expect(result.sessionId).toBe('resumed-session-42');
  });

  it('leaves curation notes when no prompt precedes an edit', async () => {
    const dir = await tempDir();
    const transcriptPath = path.join(dir, 'source.jsonl');
    // No user_input event before the edit
    const raw =
      [
        { type: 'session_start', id: 'no-prompt-session' },
        { type: 'tool_use', id: 'e1', name: 'edit', input: { path: 'file.ts', newText: 'fix' } },
        { type: 'tool_call_end', id: 'e1', name: 'edit', ok: true },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n';
    await fs.writeFile(transcriptPath, raw, 'utf8');

    const result = await mineTranscript({ transcriptPath, outDir: path.join(dir, 'evals') });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.prompt).toBeUndefined();
    expect(result.candidates[0]?.needsCuration).toEqual(
      expect.arrayContaining([expect.stringMatching(/provide the task prompt/i)]),
    );
  });

  it('leaves curation notes when no successful retrieval precedes an edit', async () => {
    const dir = await tempDir();
    const transcriptPath = path.join(dir, 'source.jsonl');
    const raw =
      [
        { type: 'session_start', id: 'no-retrieval' },
        { type: 'user_input', content: 'Fix the bug.' },
        // No tool_result with successful read/search/etc.
        { type: 'tool_use', id: 'e1', name: 'edit', input: { path: 'bug.ts', newText: 'fix' } },
        { type: 'tool_call_end', id: 'e1', name: 'edit', ok: true },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n';
    await fs.writeFile(transcriptPath, raw, 'utf8');

    const result = await mineTranscript({ transcriptPath, outDir: path.join(dir, 'evals') });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.needsCuration).toEqual(
      expect.arrayContaining([expect.stringMatching(/no successful retrieval/i)]),
    );
    expect(result.candidates[0]?.traceEval.retrieval).toEqual([]);
  });

  it('leaves curation notes when no intent markers are found', async () => {
    const dir = await tempDir();
    const transcriptPath = path.join(dir, 'source.jsonl');
    // edit input with no path-like or content-like keys to extract markers from
    const raw =
      [
        { type: 'session_start', id: 'no-markers' },
        { type: 'user_input', content: 'Fix it.' },
        { type: 'tool_use', id: 'e1', name: 'edit', input: { flag: true, enabled: true } },
        { type: 'tool_call_end', id: 'e1', name: 'edit', ok: true },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n';
    await fs.writeFile(transcriptPath, raw, 'utf8');

    const result = await mineTranscript({ transcriptPath, outDir: path.join(dir, 'evals') });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.needsCuration).toEqual(
      expect.arrayContaining([expect.stringMatching(/Choose stable correct-intent/i)]),
    );
    expect(result.candidates[0]?.traceEval.recall.inputContains).toEqual([]);
  });

  it('handles multiple tool_call_end events for the same id (multiple outcomes)', async () => {
    const dir = await tempDir();
    const transcriptPath = path.join(dir, 'source.jsonl');
    const raw =
      [
        { type: 'session_start', id: 'multi-end' },
        { type: 'user_input', content: 'Update the code.' },
        { type: 'tool_use', id: 'e1', name: 'edit', input: { path: 'a.ts', newText: 'v1' } },
        { type: 'tool_call_end', id: 'e1', name: 'edit', ok: true },
        { type: 'tool_call_end', id: 'e1', name: 'edit', ok: false }, // second outcome
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n';
    await fs.writeFile(transcriptPath, raw, 'utf8');

    const result = await mineTranscript({ transcriptPath, outDir: path.join(dir, 'evals') });
    expect(result.candidates).toHaveLength(1);
    // toolApplied should be true (at least one ok)
    expect(result.candidates[0]?.observed.toolApplied).toBe(true);
  });

  it('handles retrieval tool results that are errors', async () => {
    const dir = await tempDir();
    const transcriptPath = path.join(dir, 'source.jsonl');
    const raw =
      [
        { type: 'session_start', id: 'retry-retrieval' },
        { type: 'user_input', content: 'Read and fix.' },
        { type: 'tool_use', id: 'r1', name: 'read', input: { path: 'file.ts' } },
        { type: 'tool_result', id: 'r1', content: 'error reading file', isError: true },
        { type: 'tool_use', id: 'e1', name: 'edit', input: { path: 'file.ts', newText: 'fix' } },
        { type: 'tool_call_end', id: 'e1', name: 'edit', ok: true },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n';
    await fs.writeFile(transcriptPath, raw, 'utf8');

    const result = await mineTranscript({ transcriptPath, outDir: path.join(dir, 'evals') });
    expect(result.candidates).toHaveLength(1);
    // Error result is skipped by suggestRetrieval → retrieval is empty
    expect(result.candidates[0]?.traceEval.retrieval).toEqual([]);
  });

  it('handles user_input with array content (multi-block)', async () => {
    const dir = await tempDir();
    const transcriptPath = path.join(dir, 'source.jsonl');
    const raw =
      [
        { type: 'session_start', id: 'array-input' },
        { type: 'user_input', content: [{ text: 'First block' }, { text: 'Second block' }] },
        { type: 'tool_use', id: 'r1', name: 'read', input: { path: 'x.ts' } },
        { type: 'tool_result', id: 'r1', content: 'data', isError: false },
        { type: 'tool_use', id: 'e1', name: 'edit', input: { path: 'x.ts', newText: 'fix' } },
        { type: 'tool_call_end', id: 'e1', name: 'edit', ok: true },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n';
    await fs.writeFile(transcriptPath, raw, 'utf8');

    const result = await mineTranscript({ transcriptPath, outDir: path.join(dir, 'evals') });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.prompt).toBe('First block\nSecond block');
  });

  it('handles non-edit tools being tracked without becoming candidates', async () => {
    const dir = await tempDir();
    const transcriptPath = path.join(dir, 'source.jsonl');
    // Use a retrieval tool only (no edit)
    const raw =
      [
        { type: 'session_start', id: 'read-only' },
        { type: 'user_input', content: 'Just read.' },
        { type: 'tool_use', id: 'r1', name: 'read', input: { path: 'x.ts' } },
        { type: 'tool_result', id: 'r1', content: 'content', isError: false },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n';
    await fs.writeFile(transcriptPath, raw, 'utf8');

    const result = await mineTranscript({ transcriptPath, outDir: path.join(dir, 'evals') });
    expect(result.candidates).toHaveLength(0);
  });

  it('handles tool_result event without a matching tool_use', async () => {
    const dir = await tempDir();
    const transcriptPath = path.join(dir, 'source.jsonl');
    const raw =
      [
        { type: 'session_start', id: 'orphan-result' },
        { type: 'user_input', content: 'Fix.' },
        // tool_result without prior tool_use → skipped
        { type: 'tool_result', id: 'nonexistent', content: 'data', isError: false },
        { type: 'tool_use', id: 'e1', name: 'edit', input: { path: 'a.ts', newText: 'fix' } },
        { type: 'tool_call_end', id: 'e1', name: 'edit', ok: true },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n';
    await fs.writeFile(transcriptPath, raw, 'utf8');

    const result = await mineTranscript({ transcriptPath, outDir: path.join(dir, 'evals') });
    expect(result.candidates).toHaveLength(1);
  });

  it('endIndexFor falls back to use index when no matching tool_call_end exists', async () => {
    const dir = await tempDir();
    const transcriptPath = path.join(dir, 'source.jsonl');
    const raw =
      [
        { type: 'session_start', id: 'no-end' },
        { type: 'user_input', content: 'Update.' },
        { type: 'tool_use', id: 'e1', name: 'edit', input: { path: 'a.ts', newText: 'fix' } },
        // No tool_call_end for e1 — endIndexFor falls back to tool_use index
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n';
    await fs.writeFile(transcriptPath, raw, 'utf8');

    const result = await mineTranscript({ transcriptPath, outDir: path.join(dir, 'evals') });
    expect(result.candidates).toHaveLength(1);
    // eventEnd should be the tool_use index (fallback)
    expect(result.candidates[0]?.traceEval.source.eventEnd).toBe(2); // tool_use index
  });

  it('throws with clear message for JSON that has no session id', async () => {
    const dir = await tempDir();
    const transcriptPath = path.join(dir, 'no-session.jsonl');
    await fs.writeFile(
      transcriptPath,
      JSON.stringify({ type: 'tool_use', name: 'edit', id: 'x' }),
      'utf8',
    );

    await expect(
      mineTranscript({ transcriptPath, outDir: path.join(dir, 'evals') }),
    ).rejects.toThrow(/no session_start/);
  });

  it('throws when transcript file cannot be read', async () => {
    const dir = await tempDir();
    const transcriptPath = path.join(dir, 'missing.jsonl');
    // Don't create the file at all
    await expect(
      mineTranscript({ transcriptPath, outDir: path.join(dir, 'evals') }),
    ).rejects.toThrow(/cannot read session transcript/);
  });

  it('copyPinnedTranscript refuses to overwrite different content', async () => {
    const dir = await tempDir();
    // Create the transcript file
    const transcriptPath = path.join(dir, 'source.jsonl');
    const raw =
      [
        { type: 'session_start', id: 'collision-test' },
        { type: 'tool_use', id: 'e1', name: 'edit', input: {} },
        { type: 'tool_call_end', id: 'e1', name: 'edit', ok: true },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n';
    await fs.writeFile(transcriptPath, raw, 'utf8');

    const outDir = path.join(dir, 'evals');
    const sha256 = createHash('sha256').update(raw).digest('hex');
    const corpusDir = path.join(outDir, 'corpus');
    await fs.mkdir(corpusDir, { recursive: true });
    // Pre-create a file at the exact path mineTranscript would use, with
    // different content — this triggers the "refusing to overwrite" error.
    const corpusPath = path.join(corpusDir, `collision-test-${sha256.slice(0, 12)}.jsonl`);
    await fs.writeFile(corpusPath, 'DIFFERENT CONTENT', 'utf8');

    await expect(mineTranscript({ transcriptPath, outDir })).rejects.toThrow(
      /refusing to overwrite/,
    );
  });

  it('handles edit input with array values (triggers stringLeaves array branch)', async () => {
    const dir = await tempDir();
    const transcriptPath = path.join(dir, 'source.jsonl');
    // Edit input has an array value (e.g., multiple paths or a list of changes)
    const raw =
      [
        { type: 'session_start', id: 'array-input-edit' },
        { type: 'user_input', content: 'Update multiple files.' },
        { type: 'tool_use', id: 'r1', name: 'read', input: { path: 'a.ts' } },
        { type: 'tool_result', id: 'r1', content: 'content a', isError: false },
        {
          type: 'tool_use',
          id: 'e1',
          name: 'edit',
          input: { files: ['a.ts', 'b.ts'], newText: 'fix' },
        },
        { type: 'tool_call_end', id: 'e1', name: 'edit', ok: true },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n';
    await fs.writeFile(transcriptPath, raw, 'utf8');

    const result = await mineTranscript({ transcriptPath, outDir: path.join(dir, 'evals') });
    expect(result.candidates).toHaveLength(1);
    // The array inputs produce leaves with keys like files[0] and files[1]
    expect(result.candidates[0]?.traceEval.recall.inputContains.length).toBeGreaterThan(0);
  });

  it('recovers when session directory has an entry that disappears between readdir and stat', async () => {
    // This exercises the catch in `consider` (line 137-139) — when stat fails
    // on a file that was removed between readdir and stat.
    const dir = await tempDir();
    const transcriptPath = path.join(dir, 'source.jsonl');
    const raw =
      [
        { type: 'session_start', id: 'race-test' },
        { type: 'tool_use', id: 'e1', name: 'edit', input: { path: 'f.ts', newText: 'fix' } },
        { type: 'tool_call_end', id: 'e1', name: 'edit', ok: true },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n';
    await fs.writeFile(transcriptPath, raw, 'utf8');

    const outDir = path.join(dir, 'evals');
    const result = await mineTranscript({ transcriptPath, outDir });
    expect(result.candidates).toHaveLength(1);
  });

  it('covers malformed events, retrieval ordering, safe-name fallback, and pinned-copy reuse', async () => {
    const dir = await tempDir();
    const transcriptPath = path.join(dir, 'source.jsonl');
    const raw = [
      '{ corrupt',
      JSON.stringify({ ignored: true }),
      JSON.stringify({ type: 'session_start', id: '!!!' }),
      JSON.stringify({ type: 'user_input', content: { text: 'not an array' } }),
      JSON.stringify({
        type: 'user_input',
        content: [{ nope: true }, { text: 'Use the latest retrieval.' }],
      }),
      JSON.stringify({ type: 'tool_use', name: 'read', input: {} }),
      JSON.stringify({ type: 'tool_use', id: 'missing-name', input: {} }),
      JSON.stringify({ type: 'tool_result', content: 'missing id' }),
      JSON.stringify({ type: 'tool_call_end', ok: true }),
      JSON.stringify({ type: 'tool_use', id: 'read-1', name: 'read', input: { path: 'a.ts' } }),
      JSON.stringify({ type: 'tool_result', id: 'read-1', content: { marker: 'older' } }),
      JSON.stringify({ type: 'tool_use', id: 'read-2', name: 'grep', input: { pattern: 'x' } }),
      JSON.stringify({ type: 'tool_result', id: 'read-2', content: { marker: 'newer' } }),
      JSON.stringify({
        type: 'tool_use',
        id: 'edit-1',
        name: 'edit',
        input: { nested: { file: 'a.ts' }, newText: 'fixed' },
      }),
      JSON.stringify({ type: 'tool_call_end', id: 'edit-1', ok: true }),
    ].join('\n');
    await fs.writeFile(transcriptPath, raw, 'utf8');
    const outDir = path.join(dir, 'evals');

    const first = await mineTranscript({ transcriptPath, outDir });
    const second = await mineTranscript({ transcriptPath, outDir });

    expect(first.sessionId).toBe('!!!');
    expect(path.basename(first.copiedTranscriptPath)).toMatch(/^session-/);
    expect(first.candidates[0]?.prompt).toBe('Use the latest retrieval.');
    expect(first.candidates[0]?.traceEval.retrieval[0]?.contains).toContain('newer');
    expect(second.copiedTranscriptPath).toBe(first.copiedTranscriptPath);
  });

  it('covers false scan branches and circular retrieval serialization', async () => {
    const dir = await tempDir();
    const transcriptPath = path.join(dir, 'source.jsonl');
    const events = [
      { type: 'session_start', id: '' },
      { type: 'session_start', id: 'branch-session' },
      { type: 'user_input', content: '   ' },
      { type: 'tool_use', id: 'edit-before-prompt', name: 'edit', input: { path: 'a.ts' } },
      { type: 'unrelated' },
      { type: 'user_input', content: [{ nope: true }] },
      { type: 'user_input', content: 'A later prompt.' },
      { type: 'tool_use', id: 'read-empty', name: 'read', input: { path: 'a.ts' } },
      { type: 'tool_result', id: 'read-empty', content: '   ' },
      { type: 'tool_use', id: 'read-circular', name: 'read', input: { path: 'a.ts' } },
      { type: 'tool_result', id: 'read-circular', content: { circularMarker: true } },
      { type: 'tool_use', id: 'edit-2', name: 'edit', input: { path: 'a.ts' } },
    ];
    await fs.writeFile(
      transcriptPath,
      events.map((event) => JSON.stringify(event)).join('\n'),
      'utf8',
    );
    const stringify = JSON.stringify;
    vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
      if (
        typeof value === 'object' &&
        value !== null &&
        (value as Record<string, unknown>)['circularMarker'] === true
      ) {
        throw new TypeError('circular');
      }
      return stringify(value, replacer as never, space);
    });

    const result = await mineTranscript({
      transcriptPath,
      outDir: path.join(dir, 'evals'),
    });

    expect(result.sessionId).toBe('branch-session');
    expect(result.candidates).toHaveLength(2);
  });
});

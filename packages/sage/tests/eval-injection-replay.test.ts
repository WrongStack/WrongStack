import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mineReplayCases, replayInjection, summarizeReplay } from '../src/eval/injection-replay.js';
import { SqliteSageStore } from '../src/sqlite-store.js';

const line = (event: Record<string, unknown>) => JSON.stringify(event);

function sessionLog(memoryId = 'MEMORY_ID'): string {
  return [
    line({ type: 'session_start', checkout: '/repo' }),
    line({ type: 'user_input', content: [{ type: 'text', text: 'Fix the loader retry bug' }] }),
    line({
      type: 'message_appended',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading the loader first.' },
          { type: 'tool_use', id: 't1', name: 'read', input: { path: 'src/loader.ts' } },
        ],
      },
    }),
    line({ type: 'tool_result', id: 't1', content: 'export const retries = 3;' }),
    line({
      type: 'message_appended',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: `Per memory ${memoryId} the retry count must stay at 3.` },
          { type: 'tool_use', id: 't2', name: 'edit', input: { path: 'src/loader.ts' } },
        ],
      },
    }),
    line({ type: 'user_input', content: [{ type: 'text', text: 'Now the docs' }] }),
    line({
      type: 'message_appended',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't3', name: 'read', input: { path: 'README.md' } }],
      },
    }),
  ].join('\n');
}

describe('mineReplayCases', () => {
  it('pairs each tool call with what followed it in the same turn', () => {
    const cases = mineReplayCases(sessionLog(), 's1');
    expect(cases.map((c) => c.toolUseId)).toEqual(['t1', 't2', 't3']);
    const [read, edit, nextTurn] = cases;
    expect(read!.result).toBe('export const retries = 3;');
    expect(read!.userGoal).toBe('Fix the loader retry bug');
    expect(read!.followingText).toContain('must stay at 3');
    expect(read!.followingText).not.toContain('Reading the loader first');
    expect(read!.editedPaths).toEqual(['src/loader.ts']);
    expect(edit!.editedPaths).toEqual([]);
    expect(nextTurn!.followingText).toBe('');
    expect(nextTurn!.userGoal).toBe('Now the docs');
  });

  it('does not count a failed edit as a written path', () => {
    const log = [
      line({ type: 'user_input', content: [{ type: 'text', text: 'Fix the loader' }] }),
      line({
        type: 'message_appended',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'src/a.ts' } }],
        },
      }),
      line({ type: 'tool_result', id: 't1', content: 'export const a = 1;', isError: false }),
      line({
        type: 'message_appended',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't2', name: 'edit', input: { path: 'src/failed.ts' } },
            { type: 'tool_use', id: 't3', name: 'write', input: { path: 'src/written.ts' } },
          ],
        },
      }),
      line({ type: 'tool_result', id: 't2', content: 'stale guard: file changed', isError: true }),
      line({ type: 'tool_result', id: 't3', content: 'wrote 1 file', isError: false }),
      line({
        type: 'message_appended',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      }),
    ].join('\n');

    const read = mineReplayCases(log, 's1')[0]!;
    expect(read.editedPaths).toEqual(['src/written.ts']);
  });

  it('skips malformed lines instead of failing the session', () => {
    expect(mineReplayCases(`not json\n${sessionLog()}`, 's1')).toHaveLength(3);
  });
});

describe('replayInjection', () => {
  let tmpDir: string;
  let store: SqliteSageStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sage-eval-replay-'));
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'src', 'loader.ts'), 'export const retries = 3;\n');
    store = new SqliteSageStore({ projectRoot: tmpDir });
  });

  afterEach(async () => {
    store.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('scores what the production middleware injects without touching counters', async () => {
    const memory = await store.rememberSage({
      text: 'src/loader.ts retries must stay at 3: the upstream gateway bans a 4th attempt.',
      kind: 'warning',
      importance: 0.9,
      anchors: [{ type: 'file', path: 'src/loader.ts' }],
    });
    const getMemory = async (id: string) => (await store.getSage(id)) ?? undefined;
    const retriever = {
      retrieveForPath: (opts: { path: string }) => store.retrieveForPath([opts.path], opts),
      searchSage: (query: string, opts?: Record<string, unknown>) => store.searchSage(query, opts),
      findRelatedSage: (ids: string[], opts?: Record<string, unknown>) =>
        store.findRelatedSage(ids, opts),
      recordInjection: (ids: string[], trigger: string) => store.recordInjection(ids, trigger),
      recordUse: (ids: string[], source: string) => store.recordUse(ids, source),
    } as unknown as Parameters<typeof replayInjection>[0]['retriever'];

    const run = await replayInjection({
      projectRoot: tmpDir,
      retriever,
      getMemory,
      cases: mineReplayCases(sessionLog(memory.id), 's1'),
      config: { name: 'current' },
    });

    const read = run.results[0]!;
    expect(read.injected).toEqual([memory.id]);
    expect(read.cited).toEqual([memory.id]);
    expect(read.editTouched).toEqual([memory.id]);

    const summary = await summarizeReplay(run, tmpDir, getMemory);
    expect(summary.injections).toBe(1);
    expect(summary.usedRate).toBe(1);
    expect(summary.missingAnchorShare).toBe(0);
    // The snapshot is read-only for the replay: no injection was recorded.
    expect((await store.getSage(memory.id))?.injectionCount ?? 0).toBe(0);
  });
});

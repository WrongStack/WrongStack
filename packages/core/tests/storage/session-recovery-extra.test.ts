import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractInterruptedTools, SessionRecovery } from '../../src/storage/session-recovery.js';

// Covers detectStale (stale / clean / empty / missing / all-corrupt-tail),
// recover (checkpoint / legacy / empty / missing) and listResumable's
// directory-scan filters (dot dirs, shared/subagents, index/mailbox, sidecars).

let dir: string;
let rec: SessionRecovery;
const ts = '2026-01-01T00:00:00.000Z';

const write = (rel: string, lines: object[]) =>
  fs.writeFile(
    path.join(dir, `${rel}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    'utf8',
  );

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-srec-'));
  rec = new SessionRecovery(dir);
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('session-recovery — extra coverage', () => {
  it('detectStale flags a dangling in_flight_start', async () => {
    await write('a', [
      { type: 'session_start', ts, id: 'a', model: 'm', provider: 'p' },
      { type: 'in_flight_start', ts, context: { iteration: 1 } },
    ]);
    const stale = await rec.detectStale('a');
    expect(stale?.sessionId).toBe('a');
  });

  it('detectStale returns null for a cleanly-ended session', async () => {
    await write('b', [
      { type: 'in_flight_start', ts },
      { type: 'in_flight_end', ts },
    ]);
    expect(await rec.detectStale('b')).toBeNull();
  });

  it('detectStale returns null for an empty and a missing session', async () => {
    await fs.writeFile(path.join(dir, 'empty.jsonl'), '', 'utf8');
    expect(await rec.detectStale('empty')).toBeNull();
    expect(await rec.detectStale('missing')).toBeNull();
  });

  it('detectStale returns null when the tail is all-corrupt', async () => {
    await fs.writeFile(path.join(dir, 'corrupt.jsonl'), 'not json\nstill not json\n', 'utf8');
    expect(await rec.detectStale('corrupt')).toBeNull();
  });

  it('recover builds a plan from events after the last checkpoint', async () => {
    await write('c', [
      { type: 'session_start', ts, id: 'c', model: 'm', provider: 'p' },
      { type: 'checkpoint', ts, promptIndex: 0, promptPreview: 'hi' },
      { type: 'user_input', ts, content: 'after checkpoint' },
      { type: 'in_flight_start', ts },
    ]);
    const plan = await rec.recover('c');
    expect(plan?.stale).toBe(true);
    expect(plan?.lastCheckpoint?.type).toBe('checkpoint');
    expect(plan?.pendingEvents.length).toBe(2);
  });

  it('recover treats a checkpoint-less (legacy) session as all-pending', async () => {
    await write('legacy', [{ type: 'user_input', ts, content: 'x' }]);
    const plan = await rec.recover('legacy');
    expect(plan?.stale).toBe(false);
    expect(plan?.pendingEvents.length).toBe(1);
  });

  it('recover returns null for empty and missing sessions', async () => {
    await fs.writeFile(path.join(dir, 'blank.jsonl'), '\n\n', 'utf8');
    expect(await rec.recover('blank')).toBeNull();
    expect(await rec.recover('gone')).toBeNull();
  });

  it('listResumable scans flat + sharded sessions and skips non-session entries', async () => {
    // Real stale sessions: one flat, one sharded.
    await write('flat-stale', [{ type: 'in_flight_start', ts: '2026-01-02T00:00:00Z' }]);
    await fs.mkdir(path.join(dir, '2026-06-11'), { recursive: true });
    await write('2026-06-11/sharded-stale', [
      { type: 'in_flight_start', ts: '2026-01-03T00:00:00Z' },
    ]);
    // Skipped: dot dir, special dirs, index/mailbox, sidecar logs, clean session.
    await fs.mkdir(path.join(dir, '.hidden'), { recursive: true });
    await fs.mkdir(path.join(dir, 'shared'), { recursive: true });
    await fs.mkdir(path.join(dir, 'subagents'), { recursive: true });
    await fs.writeFile(path.join(dir, '_index.jsonl'), '{}\n', 'utf8');
    await fs.writeFile(path.join(dir, '_mailbox.jsonl'), '{}\n', 'utf8');
    await fs.writeFile(path.join(dir, 's.replay.jsonl'), '{}\n', 'utf8');
    await fs.writeFile(path.join(dir, 's.audit.jsonl'), '{}\n', 'utf8');
    await write('clean', [{ type: 'in_flight_end', ts }]);

    const stale = await rec.listResumable();
    const ids = stale.map((s) => s.sessionId);
    expect(ids).toContain('flat-stale');
    expect(ids).toContain('2026-06-11/sharded-stale');
    expect(ids).not.toContain('clean');
    // sorted by lastEventTs desc — sharded (Jan 03) before flat (Jan 02).
    expect(ids.indexOf('2026-06-11/sharded-stale')).toBeLessThan(ids.indexOf('flat-stale'));
  });

  it('does not recurse into subdirectories within date-shards', async () => {
    await fs.mkdir(path.join(dir, '2026-06-11', 'nested'), { recursive: true });
    await write('2026-06-11/nested/deep', [{ type: 'in_flight_start', ts: '2026-01-04T00:00:00.000Z' }]);
    const stale = await rec.listResumable();
    expect(stale.map((s) => s.sessionId)).not.toContain('2026-06-11/nested/deep');
  });

  it('extractInterruptedTools extracts open tool_use without matching tool_result', () => {
    const plan = {
      sessionId: 'test',
      stale: true,
      lastCheckpoint: null,
      inFlightStart: null,
      context: 'executing tools',
      pendingEvents: [
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'read_file',
          args: { path: 'a.txt' },
          ts: '2026-01-01T00:00:01Z',
        },
        { type: 'tool_result', toolUseId: 'call_1', name: 'read_file', output: 'content' },
        {
          type: 'tool_use',
          id: 'call_2',
          name: 'write_to_file',
          args: { path: 'b.txt', content: 'new' },
          ts: '2026-01-01T00:00:02Z',
        },
      ],
    };

    const interrupted = extractInterruptedTools(plan as never);
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]?.name).toBe('write_to_file');
    expect(interrupted[0]?.argsSummary).toContain('b.txt');
    expect(interrupted[0]?.ts).toBe('2026-01-01T00:00:02Z');
  });

  it('extractInterruptedTools extracts tool_use from llm_response and message_appended', () => {
    const plan = {
      sessionId: 'test-blocks',
      stale: true,
      lastCheckpoint: null,
      inFlightStart: null,
      context: 'executing assistant response',
      pendingEvents: [
        {
          type: 'llm_response',
          ts: '2026-01-01T00:00:01Z',
          content: [
            { type: 'text', text: 'let me run bash' },
            {
              type: 'tool_use',
              id: 'call_bash',
              name: 'run_command',
              input: { command: 'pnpm test' },
            },
          ],
        },
        {
          type: 'message_appended',
          ts: '2026-01-01T00:00:02Z',
          version: 1,
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call_edit',
                name: 'replace_file_content',
                input: { file: 'app.ts' },
              },
            ],
          },
        },
        {
          type: 'message_appended',
          ts: '2026-01-01T00:00:03Z',
          version: 1,
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_bash', content: 'ok' }],
          },
        },
      ],
    };

    const interrupted = extractInterruptedTools(plan as never);
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]?.name).toBe('replace_file_content');
    expect(interrupted[0]?.argsSummary).toContain('app.ts');
  });

  it('extractInterruptedTools extracts open tool_call_start without matching tool_call_end', () => {
    const plan = {
      sessionId: 'test-tool-calls',
      stale: true,
      lastCheckpoint: null,
      inFlightStart: null,
      context: 'executing tool calls',
      pendingEvents: [
        {
          type: 'tool_call_start',
          id: 'call_1',
          name: 'read_file',
          input: { path: 'a.txt' },
          ts: '2026-01-01T00:00:01Z',
        },
        { type: 'tool_call_end', id: 'call_1', name: 'read_file', ok: true },
        {
          type: 'tool_call_start',
          id: 'call_2',
          name: 'exec_command',
          input: { cmd: 'pnpm test' },
          ts: '2026-01-01T00:00:02Z',
        },
      ],
    };

    const interrupted = extractInterruptedTools(plan as never);
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]?.name).toBe('exec_command');
    expect(interrupted[0]?.argsSummary).toContain('pnpm test');
    expect(interrupted[0]?.ts).toBe('2026-01-01T00:00:02Z');
  });
});

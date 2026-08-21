import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  containedJsonlPath,
  enrichStubSummaries,
  selectPickerSessions,
} from '../src/boot/tui-session-stub-enrich.js';
import type { SessionSummary } from '@wrongstack/core/types';

let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stub-enrich-'));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function writeUserInput(ts: string, text: string): string {
  return `${JSON.stringify({ type: 'user_input', ts, content: text })}\n`;
}

async function writeJsonl(relId: string, lines: string[], mtime?: Date): Promise<void> {
  const file = path.join(dir, `${relId}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.join(''));
  if (mtime) await fs.utimes(file, mtime, mtime);
}

function stubSummary(id: string): SessionSummary {
  return {
    id,
    title: '',
    startedAt: '2026-08-21T17:00:42.918Z',
    model: 'test-model',
    provider: 'test',
    tokenTotal: 0,
    lastActivityAt: '2026-08-21T17:00:42.918Z',
  } as SessionSummary;
}

describe('enrichStubSummaries', () => {
  it('derives title, preview, and last activity from a stub session JSONL', async () => {
    const killTime = new Date('2026-08-21T17:30:00.000Z');
    await writeJsonl(
      '2026-08-21/sess_KILLED1',
      [
        `${JSON.stringify({ type: 'session_start', ts: '2026-08-21T17:00:42Z', id: 'x', model: 'm', provider: 'p' })}\n`,
        writeUserInput('2026-08-21T17:00:45Z', 'Fix the flaky\n\n   resume   picker test'),
        `${JSON.stringify({ type: 'llm_request', ts: '2026-08-21T17:00:46Z', model: 'm', messageCount: 1 })}\n`,
        writeUserInput('2026-08-21T17:29:59Z', 'follow-up question'),
      ],
      killTime,
    );

    const [out] = await enrichStubSummaries([stubSummary('2026-08-21/sess_KILLED1')], dir);
    expect(out.title).toBe('Fix the flaky resume picker test');
    expect(out.lastUserMessage).toBe('follow-up question');
    expect(out.lastActivityAt).toBe(killTime.toISOString());
  });

  it('leaves non-stub summaries untouched', async () => {
    const complete = {
      ...stubSummary('2026-08-21/sess_DONE'),
      title: 'Existing title',
      endedAt: '2026-08-21T18:00:00.000Z',
    } as SessionSummary;
    const [out] = await enrichStubSummaries([complete], dir);
    expect(out).toBe(complete);
  });

  it('returns the stub unchanged when the transcript file is missing', async () => {
    const stub = stubSummary('2026-08-21/sess_MISSING');
    const [out] = await enrichStubSummaries([stub], dir);
    expect(out).toEqual(stub);
  });

  it('skips a truncated trailing line at the slice boundary without failing', async () => {
    await writeJsonl('2026-08-21/sess_TRUNC', [
      writeUserInput('2026-08-21T17:00:45Z', 'hello world'),
      '{"type":"user_input","ts":"2026-08-21T17:',
    ]);
    const [out] = await enrichStubSummaries([stubSummary('2026-08-21/sess_TRUNC')], dir);
    expect(out.title).toBe('hello world');
  });

  it('rejects session ids that escape the sessions directory', () => {
    expect(containedJsonlPath(dir, '../../../etc/passwd')).toBeUndefined();
    expect(containedJsonlPath(dir, '/absolute/path')).toBeUndefined();
    // Well-formed shard-relative ids still resolve.
    expect(containedJsonlPath(dir, '2026-08-21/sess_OK')).toMatch(/sess_OK\.jsonl$/);
  });

  it('does not enrich a stub when its id escapes the sessions directory', async () => {
    const stub = stubSummary('../../../etc/passwd');
    const [out] = await enrichStubSummaries([stub], dir);
    expect(out).toEqual(stub);
  });

  it('strips control characters and ANSI escapes from derived title/preview', async () => {
    await writeJsonl('2026-08-21/sess_CTRL', [
      writeUserInput('2026-08-21T17:00:45Z', '\u0000\u001b[31mhello\u001b[0m\u0007 world\u001b[1m text\u001b[0m'),
      writeUserInput('2026-08-21T17:00:50Z', 'follow-up \u0002text'),
    ]);
    const [out] = await enrichStubSummaries([stubSummary('2026-08-21/sess_CTRL')], dir);
    expect(out.title).toBe('hello world text');
    expect(out.lastUserMessage).toBe('follow-up text');
  });

  it('selectPickerSessions enriches a pool then re-sorts most-recent-first', async () => {
    // Stale-order stub (old startedAt) but real mtime is today → must rank #1.
    await writeJsonl(
      '2026-08-21/sess_KILLED',
      [
        writeUserInput('2026-08-21T17:00:45Z', 'Recover my work please'),
      ],
      new Date('2026-08-21T17:30:00.000Z'),
    );
    // Healthy session with endedAt 16:00Z — fresh but older than the killed mtime.
    const healthy = {
      ...stubSummary('2026-08-21/sess_HEALTHY'),
      title: 'Healthy session',
      endedAt: '2026-08-21T16:00:00.000Z',
      startedAt: '2026-08-21T15:50:00.000Z',
    } as SessionSummary;
    const pool = [healthy, stubSummary('2026-08-21/sess_KILLED')];
    const selected = await selectPickerSessions(async () => pool, dir, 10);
    expect(selected.map((s) => s.id)).toEqual([
      '2026-08-21/sess_KILLED',
      '2026-08-21/sess_HEALTHY',
    ]);
    expect(selected[0]?.title).toBe('Recover my work please');
  });
});

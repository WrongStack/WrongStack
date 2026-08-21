import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { enrichStubSummaries } from '../src/boot/tui-session-stub-enrich.js';
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
        writeUserInput('2026-08-21T17:00:45Z', 'Fix the flaky\nresume   picker test'),
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
});

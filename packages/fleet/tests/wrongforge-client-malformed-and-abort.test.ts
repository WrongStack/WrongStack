import { describe, expect, it } from 'vitest';
import {
  followTask,
  terminalTaskRecord,
  toProgress,
  WfAborted,
  type WfCall,
  WfHttpError,
} from '../src/wrongforge-client.js';

describe('wrongforge-client malformed 200 responses and abort handling', () => {
  it('retries malformed 200 event pages in followTask and throws WfHttpError after exhaustion', async () => {
    let recoveredAttempts = 0;
    const recoveringCall: WfCall = async () => {
      recoveredAttempts++;
      if (recoveredAttempts === 1) return {} as never;
      return {
        status: 'completed',
        events: [{ seq: 1, type: 'agent.text', data: { text: 'ok' } }],
        terminal: true,
        next_after: 1,
      } as never;
    };
    const seen: unknown[] = [];
    for await (const ev of followTask(recoveringCall, 't1', new AbortController().signal, {
      retryDelayMs: 1,
    })) {
      seen.push(ev);
    }
    expect(recoveredAttempts).toBe(2);
    expect(seen).toHaveLength(1);

    let badAttempts = 0;
    const alwaysBad: WfCall = async () => {
      badAttempts++;
      return null as never;
    };
    await expect(async () => {
      for await (const _ of followTask(alwaysBad, 't2', new AbortController().signal, {
        retryDelayMs: 1,
      })) {
        // unreachable
      }
    }).rejects.toMatchObject({ status: 200, code: 'invalid_response' });
    expect(badAttempts).toBe(6);
  });

  it('rejects pre-aborted signals before calling transport and validates task shape in terminalTaskRecord', async () => {
    const ac = new AbortController();
    ac.abort();
    let called = false;
    await expect(
      terminalTaskRecord(
        async () => {
          called = true;
          return { task: { id: 't1', status: 'completed' } } as never;
        },
        't1',
        ac.signal,
      ),
    ).rejects.toBeInstanceOf(WfAborted);
    expect(called).toBe(false);

    let flakyAttempts = 0;
    const rec = await terminalTaskRecord(
      async () => {
        flakyAttempts++;
        if (flakyAttempts === 1) return { task: null } as never;
        return { task: { id: 't-ok', status: 'completed' } } as never;
      },
      't-ok',
      new AbortController().signal,
      { retryDelayMs: 1 },
    );
    expect(flakyAttempts).toBe(2);
    expect(rec.id).toBe('t-ok');

    await expect(
      terminalTaskRecord(async () => ({}) as never, 't-bad', new AbortController().signal, {
        retryDelayMs: 1,
      }),
    ).rejects.toBeInstanceOf(WfHttpError);
  });

  it('handles null ev.data and null agent.todos entries safely in toProgress', () => {
    expect(toProgress({ seq: 1, type: 'task.started', data: null as never })).toHaveLength(1);
    expect(
      toProgress({
        seq: 2,
        type: 'agent.todos',
        data: { todos: [null, 'bad', { content: 'done', status: 'completed' }] },
      }),
    ).toEqual([
      { type: 'plan', entries: [{ content: 'done', priority: 'medium', status: 'completed' }] },
    ]);
  });
});

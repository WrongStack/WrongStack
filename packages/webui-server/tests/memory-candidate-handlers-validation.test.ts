import { describe, expect, it, vi } from 'vitest';
import {
  handleSageBackfillRecoverable,
  handleSageCandidateResolve,
  handleSageListCandidates,
} from '../src/server/memory-candidate-handlers.js';
import { WebSocket } from '../src/ws-runtime.js';

function fakeWs() {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const ws = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: (raw: string) => sent.push(JSON.parse(raw)),
  } as unknown as WebSocket;
  return { ws, sent };
}

function portWith(surface: Record<string, unknown> | undefined) {
  return { getCapability: () => surface } as never;
}

describe('memory-candidate-handlers requestId correlation and payload validation', () => {
  it('echoes requestId on all memory.sage.backfillRecoverable responses and rejects invalid filters', async () => {
    const backfillRecoverable = vi.fn(async () => ({
      examined: 4,
      recovered: 1,
      recoverable: 1,
    }));

    // No-SAGE error still echoes requestId
    {
      const { ws, sent } = fakeWs();
      await handleSageBackfillRecoverable(
        ws,
        { type: 'memory.sage.backfillRecoverable', payload: { requestId: 'req-nosage' } },
        portWith(undefined),
      );
      expect(sent[0]?.payload).toMatchObject({
        requestId: 'req-nosage',
        error: expect.stringContaining('requires the SAGE backend'),
      });
    }

    // Invalid filter shapes are rejected with requestId before calling SAGE
    for (const filter of [
      'bad',
      ['fact'],
      { kinds: ['fact', 123] },
      { scopes: [null] },
      { updatedAfter: 9 },
    ]) {
      const { ws, sent } = fakeWs();
      await handleSageBackfillRecoverable(
        ws,
        { type: 'memory.sage.backfillRecoverable', payload: { requestId: 'req-badf', filter } },
        portWith({ backfillRecoverable }),
      );
      expect(sent[0]?.payload).toMatchObject({
        requestId: 'req-badf',
        error: expect.any(String),
      });
    }
    expect(backfillRecoverable).not.toHaveBeenCalled();

    // Valid call echoes requestId and forwards validated filter
    {
      const { ws, sent } = fakeWs();
      await handleSageBackfillRecoverable(
        ws,
        {
          type: 'memory.sage.backfillRecoverable',
          payload: {
            requestId: 'req-ok',
            apply: true,
            filter: { kinds: ['fact'], scopes: ['project'] },
          },
        },
        portWith({ backfillRecoverable }),
      );
      expect(sent[0]?.payload).toEqual({
        requestId: 'req-ok',
        examined: 4,
        recovered: 1,
        recoverable: 1,
        dryRun: false,
      });
      expect(backfillRecoverable).toHaveBeenCalledWith({
        dryRun: false,
        filter: { kinds: ['fact'], scopes: ['project'] },
      });
    }
  });

  it('rejects non-string or whitespace candidateId and non-string reason before mutating SAGE', async () => {
    const acceptCandidate = vi.fn();
    const rejectCandidate = vi.fn();
    const surface = {
      listCandidates: vi.fn(async () => []),
      acceptCandidate,
      rejectCandidate,
    };

    for (const payload of [
      { requestId: 'r1', candidateId: 12345, action: 'accept' },
      { requestId: 'r2', candidateId: '   ', action: 'reject' },
      { requestId: 'r3', candidateId: 'c1', action: 'reject', reason: { bad: true } },
    ]) {
      const { ws, sent } = fakeWs();
      await handleSageCandidateResolve(
        ws,
        { type: 'memory.sage.candidateResolve', payload },
        portWith(surface),
      );
      expect(sent[0]?.payload).toMatchObject({
        requestId: payload.requestId,
        error: expect.any(String),
      });
    }

    expect(acceptCandidate).not.toHaveBeenCalled();
    expect(rejectCandidate).not.toHaveBeenCalled();
  });

  it('handles null or non-object messages safely in handleSageListCandidates', async () => {
    const { ws, sent } = fakeWs();
    await handleSageListCandidates(
      ws,
      null,
      portWith({ listCandidates: async (includeResolved: boolean) => [{ includeResolved }] }),
    );
    expect(sent[0]?.payload).toEqual({ candidates: [{ includeResolved: false }] });
  });
});

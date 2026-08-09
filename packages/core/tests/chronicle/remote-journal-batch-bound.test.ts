/**
 * The client must never hand the daemon a batch it will refuse.
 *
 * `maxPending` permits a backlog ten times `CHRONICLE_MAX_APPEND_BATCH`, and the
 * client used to drain all of it into one `append` call. The server validates
 * the batch length and rejects an oversized one as malformed, so the moment a
 * slow or restarting daemon let the backlog past the bound, every queued event
 * was lost instead of being persisted a little later — the failure mode landing
 * exactly when the telemetry is most wanted.
 */
import { describe, expect, it } from 'vitest';
import { ChronicleRemoteJournal } from '../../src/chronicle/project-server-client.js';
import { CHRONICLE_MAX_APPEND_BATCH } from '../../src/chronicle/project-server-protocol.js';
import type { ChronicleEventInput } from '../../src/chronicle/types.js';

function input(i: number): ChronicleEventInput {
  return {
    eventType: 'tool.executed',
    scope: { installationId: 'inst', machineId: 'mach', sessionId: `s-${i}` },
    correlation: { traceId: `tr-${i}` },
  } as ChronicleEventInput;
}

/** A stand-in daemon that enforces the same bound the real one does. */
function makeClient(batchSizes: number[]) {
  return {
    call: async (op: string, params: unknown) => {
      if (op !== 'append') return undefined;
      const inputs = (params as { inputs: ChronicleEventInput[] }).inputs;
      batchSizes.push(inputs.length);
      if (inputs.length > CHRONICLE_MAX_APPEND_BATCH) {
        throw new TypeError(`Chronicle append requires 1..${CHRONICLE_MAX_APPEND_BATCH} inputs`);
      }
      return inputs.map((_, index) => ({ eventId: `e-${index}` }));
    },
    close: async () => {},
  };
}

describe('ChronicleRemoteJournal batch bound', () => {
  it('splits a backlog larger than the server bound instead of losing it', async () => {
    const batchSizes: number[] = [];
    const journal = new ChronicleRemoteJournal(
      {
        projectDir: 'D:/nonexistent',
        projectRoot: 'D:/nonexistent',
        projectId: 'p',
        workspaceId: 'w',
        // Hold everything until an explicit flush, so the queue is guaranteed to
        // exceed the bound rather than draining on the 5 ms window.
        batchWindowMs: 1_000_000,
      } as never,
      makeClient(batchSizes) as never,
    );

    const overflow = CHRONICLE_MAX_APPEND_BATCH + 1_500;
    const appends = Array.from({ length: overflow }, (_, i) =>
      journal.append(input(i)).catch(() => 'rejected' as const),
    );
    await journal.flush();
    const results = await Promise.all(appends);

    expect(batchSizes.every((size) => size <= CHRONICLE_MAX_APPEND_BATCH)).toBe(true);
    expect(batchSizes.reduce((a, b) => a + b, 0)).toBe(overflow);
    // Nothing was dropped: every append resolved to a persisted event.
    expect(results.filter((r) => r === 'rejected')).toHaveLength(0);
  });
});

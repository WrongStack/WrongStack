import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Count reads of the findings JSONL without disturbing anything else: the
// factory delegates to the real implementation (provider-store.test.ts shape).
const reads = vi.hoisted(() => ({ findingsFile: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: ((...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]).endsWith('review-findings.jsonl')) reads.findingsFile += 1;
      return actual.readFile(...args);
    }) as typeof actual.readFile,
  };
});

import { createChimeraRouteHandlers } from '../src/server/chimera-routes.js';

const REPORT_ID = 'rep-1';
const FINDING_IDS = ['f-1', 'f-2', 'f-3'];

/** One report plus one lifecycle event per finding — the detail payload shape. */
function fixtureLines(): { report: string; findings: string } {
  const report = JSON.stringify({
    __report: 1,
    data: {
      id: REPORT_ID,
      sessionId: 'sess-1',
      agentId: 'agent-1',
      reviewedAt: '2026-10-09T00:00:00.000Z',
      lifecycle: 'active',
      counts: { critical: 0, high: 3, medium: 0, low: 0 },
      totalFindings: FINDING_IDS.length,
      files: ['a.ts'],
    },
  });
  const lines: string[] = [];
  for (const id of FINDING_IDS) {
    lines.push(
      JSON.stringify({
        __finding: 1,
        data: {
          id,
          fingerprint: `fp-${id}`,
          severity: 'high',
          status: 'active',
          title: `finding ${id}`,
          createdAt: '2026-10-09T00:00:00.000Z',
          originReport: { reportId: REPORT_ID, sessionId: 'sess-1' },
        },
      }),
    );
    lines.push(
      JSON.stringify({
        __findingEvent: 1,
        data: {
          id: `ev-${id}`,
          findingId: id,
          eventType: 'created',
          fromStatus: null,
          toStatus: 'active',
          actorId: 'agent-1',
          actorKind: 'agent',
          timestamp: '2026-10-09T00:00:00.000Z',
        },
      }),
    );
  }
  return { report, findings: `${lines.join('\n')}\n` };
}

describe('chimera.report.get reads the findings file once', () => {
  let dir: string;

  beforeEach(async () => {
    reads.findingsFile = 0;
    dir = await fs.mkdtemp(path.join(tmpdir(), 'chimera-detail-'));
    const { report, findings } = fixtureLines();
    await fs.writeFile(path.join(dir, 'review-reports.jsonl'), `${report}\n`, 'utf8');
    await fs.writeFile(path.join(dir, 'review-findings.jsonl'), findings, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns every finding with its events from a single read', async () => {
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const handlers = createChimeraRouteHandlers({
      projectDir: () => dir,
      send: (_ws, msg) => sent.push(msg as { type: string; payload: Record<string, unknown> }),
    });

    await handlers.getReport!(
      {} as never,
      {
        type: 'chimera.report.get',
        payload: { reportId: REPORT_ID },
      } as never,
    );

    // Control: the detail payload itself must be complete and error-free.
    const payload = sent[0]!.payload;
    expect(payload['error']).toBeUndefined();
    const findings = payload['findings'] as Array<{ finding: { id: string }; events: unknown[] }>;
    expect(findings.map((f) => f.finding.id)).toEqual(FINDING_IDS);
    expect(findings.map((f) => f.events.length)).toEqual([1, 1, 1]);

    // Defect: the handler used to call getEvents() per finding, and each call
    // re-reads and re-parses the whole JSONL — one read per finding plus the
    // list() read. One request must read it once.
    expect(reads.findingsFile).toBe(1);
  });
});

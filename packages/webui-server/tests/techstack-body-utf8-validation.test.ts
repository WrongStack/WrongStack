import { Readable } from 'node:stream';
import type { Snapshot } from '@wrongstack/techstack';
import { describe, expect, it, vi } from 'vitest';
import {
  handleTechStackAnalyze,
  handleTechStackRemediationApply,
  handleTechStackRemediationPlan,
  type TechStackHandlerDeps,
} from '../src/server/techstack-handlers.js';

const snapshot: Snapshot = {
  id: 'snap-utf8',
  projectId: '/project',
  targetRoot: '/project',
  fingerprint: 'fp-utf8',
  createdAt: '2026-11-18T00:00:00.000Z',
  adapterVersion: '1.0.0',
  coverage: 'full',
  workspaces: [
    {
      id: 'ws-1',
      relativeRoot: 'packages/app',
      ecosystem: 'npm',
      manifests: [],
      lockfiles: [],
      confidence: 1,
      coverage: 'full',
    },
  ],
  dependencies: [
    {
      id: 'dep-1',
      workspaceId: 'ws-1',
      ecosystem: 'npm',
      name: 'react',
      sourceType: 'registry',
      direct: true,
      scope: 'runtime',
      locked: '18.0.0',
      latestStable: '19.0.0',
      status: 'update_available_breaking',
      evidence: [],
    },
  ],
  findings: [
    {
      id: 'finding-1',
      dependencyId: 'dep-1',
      type: 'upgrade',
      severity: 'medium',
      action: 'upgrade_major',
      confidence: 1,
      rationale: 'Upgrade React — fixes CVE-2026-0001 🚀',
      evidence: [],
    },
  ],
};

function makeRes() {
  const out = { status: 0, body: '' };
  return {
    out,
    res: {
      writeHead(status: number) {
        out.status = status;
      },
      end(body?: string) {
        out.body = body ?? '';
      },
    } as never,
  };
}

function makeDeps(execOp?: TechStackHandlerDeps['executePackageOperation']): TechStackHandlerDeps {
  return {
    projectId: '/project',
    projectRoot: '/project',
    store: {
      getSnapshot: () => snapshot,
      listSnapshots: () => [snapshot],
      saveJob: () => {},
      updateJobStatus: () => {},
      saveSnapshot: () => {},
    } as never,
    executePackageOperation: execOp,
  };
}

describe('TechStack HTTP body multi-byte UTF-8 chunking and validation', () => {
  it('preserves multi-byte UTF-8 sequences split across chunks in remediation apply and analyze', async () => {
    const execute = vi.fn().mockResolvedValue({ detail: 'applied' });
    const planRes = makeRes();
    await handleTechStackRemediationPlan(planRes.res, makeDeps());
    const plan = JSON.parse(planRes.out.body).plan as { snapshotId: string; items: unknown[] };

    const applyBytes = Buffer.from(
      JSON.stringify({
        approvedItems: ['ws-1:npm:react:upgrade_major'],
        expectedSnapshotId: plan.snapshotId,
        expectedItems: plan.items,
      }),
      'utf8',
    );
    const applyRes = makeRes();
    await handleTechStackRemediationApply(
      Readable.from(Array.from(applyBytes, (b) => Buffer.from([b]))) as never,
      applyRes.res,
      makeDeps(execute),
    );
    expect(applyRes.out.status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);

    const analyzeBytes = Buffer.from(
      JSON.stringify({ depth: 'enrich', model: 'local/şahin-ğ-🚀' }),
      'utf8',
    );
    let capturedModel = '';
    const analyzeRes = makeRes();
    await handleTechStackAnalyze(
      Readable.from(Array.from(analyzeBytes, (b) => Buffer.from([b]))) as never,
      analyzeRes.res,
      {
        ...makeDeps(),
        engine: {
          analyze: async (_pid: string, opts: { model?: string }) => {
            capturedModel = opts.model ?? '';
            return { snapshot };
          },
        } as never,
        runningJobs: new Map(),
      },
    );
    await new Promise((r) => setImmediate(r));
    expect(analyzeRes.out.status).toBe(202);
    expect(capturedModel).toBe('local/şahin-ğ-🚀');
  });

  it('returns 400 on non-object JSON payloads and drains oversized analyze bodies cleanly with 413', async () => {
    for (const raw of ['null', '[1,2]', '"str"', '42']) {
      const res = makeRes();
      await handleTechStackRemediationApply(
        Readable.from([Buffer.from(raw, 'utf8')]) as never,
        res.res,
        makeDeps(vi.fn()),
      );
      expect(res.out.status).toBe(400);
      expect(JSON.parse(res.out.body)).toMatchObject({
        error: 'Request body must be a JSON object',
      });
    }

    let destroyedMidStream = false;
    const oversizeStream = new Readable({
      read() {
        this.push(Buffer.alloc(18 * 1024, 0x20));
        this.push(Buffer.alloc(2 * 1024, 0x20));
        this.push(null);
      },
      destroy(err, cb) {
        if (this.readableLength > 0) destroyedMidStream = true;
        cb(err);
      },
    });
    const analyzeOversize = makeRes();
    await handleTechStackAnalyze(oversizeStream as never, analyzeOversize.res, {
      ...makeDeps(),
      engine: { analyze: async () => ({ snapshot }) } as never,
      runningJobs: new Map(),
    });
    expect(analyzeOversize.out.status).toBe(413);
    expect(destroyedMidStream).toBe(false);
  });
});

import { Readable } from 'node:stream';
import type { Snapshot } from '@wrongstack/techstack';
import { describe, expect, it, vi } from 'vitest';
import {
  handleTechStackAnalyze,
  handleTechStackCancel,
  handleTechStackDependencyResearch,
  handleTechStackInventory,
  handleTechStackJobStatus,
  handleTechStackRemediationApply,
  handleTechStackRemediationPlan,
  handleTechStackReport,
  handleTechStackSnapshot,
} from '../src/server/techstack-handlers.js';

function mockResponse() {
  const result = {
    status: 0,
    headers: {} as Record<string, string>,
    body: '',
  };
  return {
    result,
    value: {
      writeHead(status: number, headers?: Record<string, string>) {
        result.status = status;
        if (headers) Object.assign(result.headers, headers);
      },
      end(body?: string) {
        result.body = body ?? '';
      },
    } as never,
  };
}

const mockSnapshot: Snapshot = {
  id: 'snap-123',
  projectId: 'proj-1',
  targetRoot: '/fake/root',
  fingerprint: 'fp-1',
  createdAt: new Date().toISOString(),
  adapterVersion: '1.0.0',
  coverage: 'full',
  workspaces: [
    {
      id: 'ws-1',
      relativeRoot: '.',
      ecosystem: 'npm',
      manifests: ['package.json'],
      lockfiles: ['package-lock.json'],
      confidence: 1,
      coverage: 'full',
    },
  ],
  dependencies: [
    {
      id: 'dep-react',
      workspaceId: 'ws-1',
      ecosystem: 'npm',
      name: 'react',
      sourceType: 'registry',
      direct: true,
      scope: 'runtime',
      locked: '18.2.0',
      latestStable: '19.0.0',
      status: 'update_available_breaking',
      evidence: [],
    },
  ],
  findings: [],
};

describe('TechStack HTTP handlers extended coverage', () => {
  describe('handleTechStackSnapshot', () => {
    it('returns 404 when snapshot is not found in store', () => {
      const res = mockResponse();
      const store = { getSnapshot: vi.fn(() => null) } as never;
      handleTechStackSnapshot(res.value, { projectId: 'p1', store });

      expect(res.result.status).toBe(404);
      expect(JSON.parse(res.result.body)).toEqual({ snapshot: null, stale: false });
    });

    it('returns 200 with stale: false for recently created snapshot', () => {
      const res = mockResponse();
      const freshSnapshot = { ...mockSnapshot, createdAt: new Date().toISOString() };
      const store = { getSnapshot: vi.fn(() => freshSnapshot) } as never;
      handleTechStackSnapshot(res.value, { projectId: 'p1', store });

      expect(res.result.status).toBe(200);
      expect(JSON.parse(res.result.body)).toEqual({ snapshot: freshSnapshot, stale: false });
    });

    it('returns 200 with stale: true for snapshot older than 24 hours', () => {
      const res = mockResponse();
      const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      const oldSnapshot = { ...mockSnapshot, createdAt: staleDate };
      const store = { getSnapshot: vi.fn(() => oldSnapshot) } as never;
      handleTechStackSnapshot(res.value, { projectId: 'p1', store });

      expect(res.result.status).toBe(200);
      expect(JSON.parse(res.result.body)).toEqual({ snapshot: oldSnapshot, stale: true });
    });

    it('returns 500 when store throws an error', () => {
      const res = mockResponse();
      const store = {
        getSnapshot: vi.fn(() => {
          throw new Error('Database locked');
        }),
      } as never;
      handleTechStackSnapshot(res.value, { projectId: 'p1', store });

      expect(res.result.status).toBe(500);
      expect(JSON.parse(res.result.body)).toMatchObject({
        error: 'TechStack store unavailable',
      });
    });
  });

  describe('handleTechStackJobStatus', () => {
    it('returns 404 when job does not exist', () => {
      const res = mockResponse();
      const store = { getJob: vi.fn(() => null) } as never;
      handleTechStackJobStatus(res.value, { projectId: 'p1', store }, 'job-404');

      expect(res.result.status).toBe(404);
      expect(JSON.parse(res.result.body)).toEqual({ error: 'Job not found' });
    });

    it('returns 200 with job when found', () => {
      const res = mockResponse();
      const job = { id: 'job-1', status: 'completed' };
      const store = { getJob: vi.fn(() => job) } as never;
      handleTechStackJobStatus(res.value, { projectId: 'p1', store }, 'job-1');

      expect(res.result.status).toBe(200);
      expect(JSON.parse(res.result.body)).toEqual({ job });
    });
  });

  describe('handleTechStackReport', () => {
    it('returns 404 when snapshot by id is not found', () => {
      const res = mockResponse();
      const store = { getSnapshotById: vi.fn(() => null) } as never;
      handleTechStackReport(res.value, { projectId: 'p1', store }, 'rep-1', 'json');

      expect(res.result.status).toBe(404);
      expect(JSON.parse(res.result.body)).toEqual({ error: 'Report not found' });
    });

    it('returns raw JSON snapshot when engine is not provided', () => {
      const res = mockResponse();
      const store = { getSnapshotById: vi.fn(() => mockSnapshot) } as never;
      handleTechStackReport(res.value, { projectId: 'p1', store }, 'rep-1', 'json');

      expect(res.result.status).toBe(200);
      expect(JSON.parse(res.result.body)).toEqual(mockSnapshot);
    });

    it('generates markdown report with engine', () => {
      const res = mockResponse();
      const store = { getSnapshotById: vi.fn(() => mockSnapshot) } as never;
      const engine = {
        generateReport: vi.fn(() => '# Report'),
      } as never;
      handleTechStackReport(res.value, { projectId: 'p1', store, engine }, 'rep-1', 'md');

      expect(res.result.status).toBe(200);
      expect(res.result.headers['Content-Type']).toBe('text/markdown');
      expect(res.result.headers['Content-Disposition']).toBe(
        'attachment; filename="techstack-report.md"',
      );
      expect(res.result.body).toBe('# Report');
    });

    it('generates spdx sbom report with engine', () => {
      const res = mockResponse();
      const store = { getSnapshotById: vi.fn(() => mockSnapshot) } as never;
      const engine = {
        generateReport: vi.fn(() => '{"spdxVersion":"2.3"}'),
      } as never;
      handleTechStackReport(res.value, { projectId: 'p1', store, engine }, 'rep-1', 'spdx');

      expect(res.result.status).toBe(200);
      expect(res.result.headers['Content-Type']).toBe('application/json');
      expect(res.result.headers['Content-Disposition']).toBe(
        'attachment; filename="techstack-sbom-spdx.json"',
      );
    });

    it('generates cyclonedx sbom report with engine', () => {
      const res = mockResponse();
      const store = { getSnapshotById: vi.fn(() => mockSnapshot) } as never;
      const engine = {
        generateReport: vi.fn(() => '{"bomFormat":"CycloneDX"}'),
      } as never;
      handleTechStackReport(res.value, { projectId: 'p1', store, engine }, 'rep-1', 'cyclonedx');

      expect(res.result.status).toBe(200);
      expect(res.result.headers['Content-Disposition']).toBe(
        'attachment; filename="techstack-sbom-cyclonedx.json"',
      );
    });
  });

  describe('handleTechStackCancel', () => {
    it('aborts controller if running, updates job status, and emits cancelled event', () => {
      const res = mockResponse();
      const controller = new AbortController();
      const abortSpy = vi.spyOn(controller, 'abort');
      const runningJobs = new Map<string, AbortController>([['job-abc', controller]]);
      const updateJobStatus = vi.fn();
      const store = { updateJobStatus } as never;
      const emit = vi.fn();

      handleTechStackCancel(res.value, { projectId: 'p1', store, runningJobs, emit }, 'job-abc');

      expect(abortSpy).toHaveBeenCalled();
      expect(updateJobStatus).toHaveBeenCalledWith('job-abc', 'cancelled');
      expect(emit).toHaveBeenCalledWith({
        type: 'techstack.job.cancelled',
        payload: { jobId: 'job-abc' },
      });
      expect(res.result.status).toBe(200);
      expect(JSON.parse(res.result.body)).toEqual({ jobId: 'job-abc', status: 'cancelled' });
    });
  });

  describe('handleTechStackInventory and handleTechStackAnalyze', () => {
    it('returns 503 if engine or projectRoot is missing', () => {
      const res1 = mockResponse();
      handleTechStackInventory(res1.value, { projectId: 'p1', store: {} as never });
      expect(res1.result.status).toBe(503);

      const res2 = mockResponse();
      handleTechStackAnalyze(res2.value, {
        projectId: 'p1',
        projectRoot: '/root',
        store: {} as never,
      });
      expect(res2.result.status).toBe(503);
    });

    it('starts inventory job, runs engine analyze, and emits events on success', async () => {
      const res = mockResponse();
      const emit = vi.fn();
      const runningJobs = new Map<string, AbortController>();
      const engine = {
        analyze: vi.fn(async (_projectId, opts) => {
          opts.onProgress('discovery', 1, 2);
          return { snapshot: mockSnapshot };
        }),
      } as never;

      handleTechStackInventory(res.value, {
        projectId: 'p1',
        projectRoot: '/root',
        store: {} as never,
        engine,
        emit,
        runningJobs,
      });

      expect(res.result.status).toBe(202);
      const { jobId } = JSON.parse(res.result.body);
      expect(jobId).toBeDefined();

      expect(emit).toHaveBeenCalledWith({
        type: 'techstack.job.started',
        payload: { jobId, kind: 'inventory' },
      });

      // Allow background analyze promise to resolve
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(emit).toHaveBeenCalledWith({
        type: 'techstack.job.progress',
        payload: { jobId, phase: 'discovery', completed: 1, total: 2 },
      });

      expect(emit).toHaveBeenCalledWith({
        type: 'techstack.snapshot.updated',
        payload: { snapshot: mockSnapshot, stale: false },
      });

      expect(runningJobs.has(jobId)).toBe(false);
    });

    it('handles job failure and emits failed event', async () => {
      const res = mockResponse();
      const emit = vi.fn();
      const engine = {
        analyze: vi.fn().mockRejectedValue(new Error('Syntax error in manifest')),
      } as never;

      handleTechStackInventory(res.value, {
        projectId: 'p1',
        projectRoot: '/root',
        store: {} as never,
        engine,
        emit,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(emit).toHaveBeenCalledWith({
        type: 'techstack.job.failed',
        payload: {
          jobId: expect.any(String),
          error: expect.any(String),
        },
      });
    });

    it('handles aborted job and emits cancelled event', async () => {
      const res = mockResponse();
      const emit = vi.fn();
      const runningJobs = new Map<string, AbortController>();
      const engine = {
        analyze: vi.fn(async (_projectId, opts) => {
          opts.signal.addEventListener('abort', () => {});
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }),
      } as never;

      handleTechStackAnalyze(res.value, {
        projectId: 'p1',
        projectRoot: '/root',
        store: {} as never,
        engine,
        emit,
        runningJobs,
      });

      const { jobId } = JSON.parse(res.result.body);
      runningJobs.get(jobId)?.abort();

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(emit).toHaveBeenCalledWith({
        type: 'techstack.job.cancelled',
        payload: { jobId },
      });
    });
  });

  describe('handleTechStackDependencyResearch', () => {
    it('returns 404 when dependency is not found in snapshot', async () => {
      const res = mockResponse();
      const store = { getSnapshot: vi.fn(() => mockSnapshot) } as never;

      await handleTechStackDependencyResearch(res.value, { projectId: 'p1', store }, 'dep-missing');

      expect(res.result.status).toBe(404);
      expect(JSON.parse(res.result.body)).toEqual({
        error: 'Dependency not found in the current snapshot',
      });
    });

    it('returns cached research findings when available in store', async () => {
      const res = mockResponse();
      const cached = [{ id: 'cf-1', title: 'Security advisory' }];
      const store = {
        getSnapshot: vi.fn(() => mockSnapshot),
        getCachedResearch: vi.fn(() => cached),
      } as never;

      await handleTechStackDependencyResearch(res.value, { projectId: 'p1', store }, 'dep-react');

      expect(res.result.status).toBe(200);
      expect(JSON.parse(res.result.body)).toEqual({
        dependencyId: 'dep-react',
        findings: cached,
        cached: true,
      });
    });

    it('returns 503 when no LLM or provider is configured', async () => {
      const res = mockResponse();
      const store = {
        getSnapshot: vi.fn(() => mockSnapshot),
        getCachedResearch: vi.fn(() => []),
      } as never;

      await handleTechStackDependencyResearch(
        res.value,
        { projectId: 'p1', store, getLlm: undefined },
        'dep-react',
      );

      expect(res.result.status).toBe(503);
      expect(JSON.parse(res.result.body)).toMatchObject({
        error: expect.stringContaining('No model configured'),
      });
    });
  });

  describe('handleTechStackRemediationPlan and Apply edge cases', () => {
    it('returns 404 from remediation plan when snapshot is missing', async () => {
      const res = mockResponse();
      const store = { getSnapshot: vi.fn(() => null) } as never;

      await handleTechStackRemediationPlan(res.value, { projectId: 'p1', store });
      expect(res.result.status).toBe(404);
    });

    it('returns 503 from remediation apply when executePackageOperation is missing', async () => {
      const res = mockResponse();
      const req = Readable.from(['{}']) as never;

      await handleTechStackRemediationApply(req, res.value, {
        projectId: 'p1',
        store: {} as never,
        executePackageOperation: undefined,
      });

      expect(res.result.status).toBe(503);
    });

    it('returns 400 when request body exceeds 64KB', async () => {
      const res = mockResponse();
      const hugeData = 'x'.repeat(65 * 1024);
      const req = Readable.from([hugeData]) as never;

      await handleTechStackRemediationApply(req, res.value, {
        projectId: 'p1',
        store: {} as never,
        executePackageOperation: vi.fn(),
      });

      expect(res.result.status).toBe(400);
      expect(JSON.parse(res.result.body)).toMatchObject({
        error: 'Invalid request body',
      });
    });

    it('returns 404 from remediation apply when snapshot is missing', async () => {
      const res = mockResponse();
      const req = Readable.from([
        JSON.stringify({ approvedItems: ['ws-1:npm:react:upgrade'] }),
      ]) as never;
      const store = { getSnapshot: vi.fn(() => null) } as never;

      await handleTechStackRemediationApply(req, res.value, {
        projectId: 'p1',
        store,
        executePackageOperation: vi.fn(),
      });

      expect(res.result.status).toBe(404);
      expect(JSON.parse(res.result.body)).toMatchObject({
        error: 'No TechStack snapshot is available',
      });
    });
  });
});

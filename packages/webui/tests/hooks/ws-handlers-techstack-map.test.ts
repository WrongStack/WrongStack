import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTechStackStore } from '../../src/stores/techstack-store';
import {
  handleTechStackJobCancelled,
  handleTechStackJobFailed,
  handleTechStackJobProgress,
  handleTechStackJobStarted,
  handleTechStackReportReady,
  handleTechStackSnapshotUpdated,
  handleTechStackWorkspaceCompleted,
  techStackHandlerMap,
} from '../../src/hooks/ws-handlers/techstack-handlers';

function msg(type: string, payload: unknown) {
  return { type, payload } as never;
}

const store = () => useTechStackStore.getState();

describe('techstack ws-handler map', () => {
  beforeEach(() => {
    store().clear();
    useTechStackStore.setState({
      job: null,
      snapshot: null,
      stale: false,
      reportId: null,
      error: null,
    } as never);
  });

  it('registers a handler for every techstack wire type', () => {
    expect(Object.keys(techStackHandlerMap).sort()).toEqual(
      [
        'techstack.job.cancelled',
        'techstack.job.failed',
        'techstack.job.progress',
        'techstack.job.started',
        'techstack.report.ready',
        'techstack.snapshot.updated',
        'techstack.workspace.completed',
      ].sort(),
    );
  });

  it('wires each map entry to its exported handler', () => {
    expect(techStackHandlerMap['techstack.job.started']).toBe(handleTechStackJobStarted);
    expect(techStackHandlerMap['techstack.job.progress']).toBe(handleTechStackJobProgress);
    expect(techStackHandlerMap['techstack.workspace.completed']).toBe(
      handleTechStackWorkspaceCompleted,
    );
    expect(techStackHandlerMap['techstack.snapshot.updated']).toBe(handleTechStackSnapshotUpdated);
    expect(techStackHandlerMap['techstack.report.ready']).toBe(handleTechStackReportReady);
    expect(techStackHandlerMap['techstack.job.failed']).toBe(handleTechStackJobFailed);
    expect(techStackHandlerMap['techstack.job.cancelled']).toBe(handleTechStackJobCancelled);
  });

  // ── job.started ───────────────────────────────────────────────────────────

  describe('techstack.job.started', () => {
    it.each(['inventory', 'analyze'] as const)('starts a %s job', (kind) => {
      const spy = vi.fn();
      useTechStackStore.setState({ jobStarted: spy } as never);
      handleTechStackJobStarted(msg('techstack.job.started', { jobId: 'j1', kind }));
      expect(spy).toHaveBeenCalledWith('j1', kind);
    });

    it.each([
      ['no jobId', { kind: 'inventory' }],
      ['no kind', { jobId: 'j1' }],
      ['empty jobId', { jobId: '', kind: 'inventory' }],
      ['empty payload', {}],
    ])('ignores a frame with %s', (_label, payload) => {
      const spy = vi.fn();
      useTechStackStore.setState({ jobStarted: spy } as never);
      handleTechStackJobStarted(msg('techstack.job.started', payload));
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // ── job.progress ──────────────────────────────────────────────────────────

  describe('techstack.job.progress', () => {
    it('forwards a well-formed progress frame', () => {
      const spy = vi.fn();
      useTechStackStore.setState({ jobProgress: spy } as never);
      handleTechStackJobProgress(
        msg('techstack.job.progress', {
          jobId: 'j1',
          phase: 'scanning',
          completed: 3,
          total: 10,
        }),
      );
      expect(spy).toHaveBeenCalledWith('j1', { phase: 'scanning', completed: 3, total: 10 });
    });

    it('accepts a zero-progress frame', () => {
      const spy = vi.fn();
      useTechStackStore.setState({ jobProgress: spy } as never);
      handleTechStackJobProgress(
        msg('techstack.job.progress', { jobId: 'j1', phase: 'start', completed: 0, total: 0 }),
      );
      expect(spy).toHaveBeenCalledWith('j1', { phase: 'start', completed: 0, total: 0 });
    });

    it.each([
      ['no jobId', { phase: 'p', completed: 1, total: 2 }],
      ['no phase', { jobId: 'j1', completed: 1, total: 2 }],
      ['non-numeric completed', { jobId: 'j1', phase: 'p', completed: '1', total: 2 }],
      ['non-numeric total', { jobId: 'j1', phase: 'p', completed: 1, total: null }],
      ['NaN completed', { jobId: 'j1', phase: 'p', completed: Number.NaN, total: 2 }],
      [
        'Infinite total',
        { jobId: 'j1', phase: 'p', completed: 1, total: Number.POSITIVE_INFINITY },
      ],
      ['missing counters', { jobId: 'j1', phase: 'p' }],
    ])('ignores a frame with %s', (_label, payload) => {
      const spy = vi.fn();
      useTechStackStore.setState({ jobProgress: spy } as never);
      handleTechStackJobProgress(msg('techstack.job.progress', payload));
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // ── remaining events ──────────────────────────────────────────────────────

  describe('techstack.workspace.completed', () => {
    it('forwards the workspace id', () => {
      const spy = vi.fn();
      useTechStackStore.setState({ workspaceCompleted: spy } as never);
      handleTechStackWorkspaceCompleted(
        msg('techstack.workspace.completed', { workspaceId: 'w1' }),
      );
      expect(spy).toHaveBeenCalledWith('w1');
    });

    it('ignores a frame with no workspace id', () => {
      const spy = vi.fn();
      useTechStackStore.setState({ workspaceCompleted: spy } as never);
      handleTechStackWorkspaceCompleted(msg('techstack.workspace.completed', {}));
      handleTechStackWorkspaceCompleted(msg('techstack.workspace.completed', { workspaceId: '' }));
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('techstack.snapshot.updated', () => {
    it('stores the snapshot as fresh by default', () => {
      const spy = vi.fn();
      useTechStackStore.setState({ setSnapshot: spy } as never);
      const snapshot = { generatedAt: 1, workspaces: [] };
      handleTechStackSnapshotUpdated(msg('techstack.snapshot.updated', { snapshot }));
      expect(spy).toHaveBeenCalledWith(snapshot, false);
    });

    it('propagates the stale flag', () => {
      const spy = vi.fn();
      useTechStackStore.setState({ setSnapshot: spy } as never);
      const snapshot = { generatedAt: 1, workspaces: [] };
      handleTechStackSnapshotUpdated(msg('techstack.snapshot.updated', { snapshot, stale: true }));
      expect(spy).toHaveBeenCalledWith(snapshot, true);
    });

    it('ignores a frame with no snapshot', () => {
      const spy = vi.fn();
      useTechStackStore.setState({ setSnapshot: spy } as never);
      handleTechStackSnapshotUpdated(msg('techstack.snapshot.updated', {}));
      handleTechStackSnapshotUpdated(msg('techstack.snapshot.updated', { stale: true }));
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('techstack.report.ready', () => {
    it('forwards the report id', () => {
      const spy = vi.fn();
      useTechStackStore.setState({ reportReady: spy } as never);
      handleTechStackReportReady(msg('techstack.report.ready', { reportId: 'r1' }));
      expect(spy).toHaveBeenCalledWith('r1');
    });

    it('ignores a frame with no report id', () => {
      const spy = vi.fn();
      useTechStackStore.setState({ reportReady: spy } as never);
      handleTechStackReportReady(msg('techstack.report.ready', {}));
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('techstack.job.failed', () => {
    it('forwards the server error', () => {
      const spy = vi.fn();
      useTechStackStore.setState({ jobFailed: spy } as never);
      handleTechStackJobFailed(msg('techstack.job.failed', { jobId: 'j1', error: 'boom' }));
      expect(spy).toHaveBeenCalledWith('j1', 'boom');
    });

    it('substitutes a generic message when the server sends none', () => {
      const spy = vi.fn();
      useTechStackStore.setState({ jobFailed: spy } as never);
      handleTechStackJobFailed(msg('techstack.job.failed', { jobId: 'j1' }));
      expect(spy).toHaveBeenCalledWith('j1', 'TechStack job failed');
    });

    it('ignores a frame with no job id', () => {
      const spy = vi.fn();
      useTechStackStore.setState({ jobFailed: spy } as never);
      handleTechStackJobFailed(msg('techstack.job.failed', { error: 'boom' }));
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('techstack.job.cancelled', () => {
    it('forwards the job id', () => {
      const spy = vi.fn();
      useTechStackStore.setState({ jobCancelled: spy } as never);
      handleTechStackJobCancelled(msg('techstack.job.cancelled', { jobId: 'j1' }));
      expect(spy).toHaveBeenCalledWith('j1');
    });

    it('ignores a frame with no job id', () => {
      const spy = vi.fn();
      useTechStackStore.setState({ jobCancelled: spy } as never);
      handleTechStackJobCancelled(msg('techstack.job.cancelled', {}));
      expect(spy).not.toHaveBeenCalled();
    });
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { useTechStackStore } from '../../src/stores/techstack-store';

const SAMPLE_SNAPSHOT = {
  id: 'snap-1',
  projectId: 'proj-1',
  targetRoot: '/tmp/project',
  fingerprint: 'ts-abc',
  createdAt: new Date().toISOString(),
  workspaces: [],
  dependencies: [],
  findings: [],
  coverage: 'full' as const,
  adapterVersion: '0.1.0',
};

describe('techstack-store', () => {
  beforeEach(() => {
    useTechStackStore.getState().clear();
  });

  it('jobStarted sets an active job in queued status', () => {
    useTechStackStore.getState().jobStarted('job-1', 'inventory');
    const job = useTechStackStore.getState().activeJob;
    expect(job).not.toBeNull();
    expect(job?.id).toBe('job-1');
    expect(job?.kind).toBe('inventory');
    expect(job?.status).toBe('queued');
  });

  it('jobProgress updates only when jobId matches', () => {
    useTechStackStore.getState().jobStarted('job-1', 'inventory');
    useTechStackStore
      .getState()
      .jobProgress('job-2', { phase: 'enriching', completed: 1, total: 2 });
    // Mismatched id — should be ignored
    expect(useTechStackStore.getState().activeJob?.status).toBe('queued');
  });

  it('jobProgress rejects unknown phase strings (no cast leak)', () => {
    useTechStackStore.getState().jobStarted('job-1', 'inventory');
    useTechStackStore
      .getState()
      .jobProgress('job-1', { phase: 'analyzing', completed: 1, total: 2 });
    // 'analyzing' is not a valid TechStackJobStatus — ignored
    expect(useTechStackStore.getState().activeJob?.status).toBe('queued');
  });

  it('jobProgress accepts valid phase strings', () => {
    useTechStackStore.getState().jobStarted('job-1', 'inventory');
    useTechStackStore
      .getState()
      .jobProgress('job-1', { phase: 'enriching', completed: 1, total: 2 });
    expect(useTechStackStore.getState().activeJob?.status).toBe('enriching');
    expect(useTechStackStore.getState().activeJob?.progress).toEqual({
      phase: 'enriching',
      completed: 1,
      total: 2,
    });
  });

  it('jobFailed only on matching jobId', () => {
    useTechStackStore.getState().jobStarted('job-1', 'inventory');
    useTechStackStore.getState().jobFailed('job-2', 'boom');
    expect(useTechStackStore.getState().activeJob?.status).toBe('queued');
    useTechStackStore.getState().jobFailed('job-1', 'boom');
    expect(useTechStackStore.getState().activeJob?.status).toBe('failed');
    expect(useTechStackStore.getState().activeJob?.error).toBe('boom');
  });

  it('jobCancelled preserves activeJob for mismatched id', () => {
    useTechStackStore.getState().jobStarted('job-1', 'inventory');
    useTechStackStore.getState().jobCancelled('other');
    expect(useTechStackStore.getState().activeJob?.status).toBe('queued');
    useTechStackStore.getState().jobCancelled('job-1');
    expect(useTechStackStore.getState().activeJob?.status).toBe('cancelled');
  });

  it('setSnapshot marks active job as completed', () => {
    useTechStackStore.getState().jobStarted('job-1', 'inventory');
    useTechStackStore.getState().setSnapshot(SAMPLE_SNAPSHOT, false);
    expect(useTechStackStore.getState().snapshot).toEqual(SAMPLE_SNAPSHOT);
    expect(useTechStackStore.getState().activeJob?.status).toBe('completed');
    expect(useTechStackStore.getState().loading).toBe(false);
  });

  it('setSnapshot defaults stale to false when omitted', () => {
    useTechStackStore.getState().setSnapshot(SAMPLE_SNAPSHOT);
    expect(useTechStackStore.getState().stale).toBe(false);
  });

  it('reportReady stores the reportId', () => {
    useTechStackStore.getState().reportReady('rep-42');
    expect(useTechStackStore.getState().reportId).toBe('rep-42');
  });

  it('clear resets all fields', () => {
    useTechStackStore.getState().jobStarted('job-1', 'inventory');
    useTechStackStore.getState().setSnapshot(SAMPLE_SNAPSHOT, true);
    useTechStackStore.getState().reportReady('rep-1');
    useTechStackStore.getState().clear();
    const s = useTechStackStore.getState();
    expect(s.snapshot).toBeNull();
    expect(s.stale).toBe(false);
    expect(s.activeJob).toBeNull();
    expect(s.reportId).toBeNull();
  });
});

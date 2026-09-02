import { beforeEach, describe, expect, it } from 'vitest';
import { WS_HANDLERS } from '../../src/hooks/ws-handlers';
import { useTechStackStore } from '../../src/stores/techstack-store';
import type { WSServerMessage } from '../../src/types';

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

function dispatch(type: WSServerMessage['type'], payload: unknown): void {
  WS_HANDLERS[type]?.({ type, payload } as never);
}

describe('WS_HANDLERS — TechStack', () => {
  beforeEach(() => {
    useTechStackStore.getState().clear();
  });

  it('techstack.job.started creates an active job', () => {
    dispatch('techstack.job.started', { jobId: 'j1', kind: 'analyze' });
    expect(useTechStackStore.getState().activeJob?.id).toBe('j1');
    expect(useTechStackStore.getState().activeJob?.kind).toBe('analyze');
  });

  it('techstack.job.progress updates the active job phase', () => {
    dispatch('techstack.job.started', { jobId: 'j1', kind: 'inventory' });
    dispatch('techstack.job.progress', { jobId: 'j1', phase: 'enriching', completed: 3, total: 5 });
    expect(useTechStackStore.getState().activeJob?.status).toBe('enriching');
  });

  it('techstack.job.progress ignores non-finite numbers', () => {
    dispatch('techstack.job.started', { jobId: 'j1', kind: 'inventory' });
    dispatch('techstack.job.progress', {
      jobId: 'j1',
      phase: 'enriching',
      completed: NaN,
      total: 5,
    });
    expect(useTechStackStore.getState().activeJob?.status).toBe('queued');
  });

  it('techstack.snapshot.updated sets snapshot and marks job completed', () => {
    dispatch('techstack.job.started', { jobId: 'j1', kind: 'inventory' });
    dispatch('techstack.snapshot.updated', { snapshot: SAMPLE_SNAPSHOT });
    expect(useTechStackStore.getState().snapshot).toEqual(SAMPLE_SNAPSHOT);
    expect(useTechStackStore.getState().activeJob?.status).toBe('completed');
  });

  it('techstack.job.failed records the error', () => {
    dispatch('techstack.job.started', { jobId: 'j1', kind: 'analyze' });
    dispatch('techstack.job.failed', { jobId: 'j1', error: 'boom' });
    expect(useTechStackStore.getState().activeJob?.status).toBe('failed');
    expect(useTechStackStore.getState().activeJob?.error).toBe('boom');
  });

  it('techstack.job.cancelled marks the job cancelled', () => {
    dispatch('techstack.job.started', { jobId: 'j1', kind: 'inventory' });
    dispatch('techstack.job.cancelled', { jobId: 'j1' });
    expect(useTechStackStore.getState().activeJob?.status).toBe('cancelled');
  });

  it('techstack.workspace.completed stores last workspace id', () => {
    dispatch('techstack.workspace.completed', {
      jobId: 'j1',
      workspaceId: 'ws-3',
      ecosystem: 'npm',
      dependencyCount: 10,
    });
    expect(useTechStackStore.getState().lastWorkspaceId).toBe('ws-3');
  });

  it('techstack.report.ready stores the report id', () => {
    dispatch('techstack.report.ready', { reportId: 'rep-42', summary: 'ok' });
    expect(useTechStackStore.getState().reportId).toBe('rep-42');
  });
});

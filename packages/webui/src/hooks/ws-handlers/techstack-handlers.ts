import { useTechStackStore } from '@/stores/techstack-store';
import type { WSServerMessage } from '@/types';

type TechStackServerMessage = Extract<WSServerMessage, { type: `techstack.${string}` }>;

export function handleTechStackJobStarted(msg: WSServerMessage): void {
  const payload = msg.payload as { jobId?: string; kind?: 'inventory' | 'analyze' };
  if (!payload.jobId || !payload.kind) return;
  useTechStackStore.getState().jobStarted(payload.jobId, payload.kind);
}

export function handleTechStackJobProgress(msg: WSServerMessage): void {
  const payload = msg.payload as {
    jobId?: string;
    phase?: string;
    completed?: number;
    total?: number;
  };
  if (
    !payload.jobId ||
    !payload.phase ||
    !Number.isFinite(payload.completed) ||
    !Number.isFinite(payload.total)
  ) {
    return;
  }
  useTechStackStore.getState().jobProgress(payload.jobId, {
    phase: payload.phase,
    completed: payload.completed ?? 0,
    total: payload.total ?? 0,
  });
}

export function handleTechStackWorkspaceCompleted(msg: WSServerMessage): void {
  const payload = msg.payload as { workspaceId?: string };
  if (payload.workspaceId) useTechStackStore.getState().workspaceCompleted(payload.workspaceId);
}

export function handleTechStackSnapshotUpdated(msg: WSServerMessage): void {
  const payload = msg.payload as {
    snapshot?: import('@/stores/techstack-store').TechStackSnapshot;
    stale?: boolean;
  };
  if (!payload.snapshot) return;
  useTechStackStore.getState().setSnapshot(payload.snapshot, payload.stale ?? false);
}

export function handleTechStackReportReady(msg: WSServerMessage): void {
  const payload = msg.payload as { reportId?: string };
  if (payload.reportId) useTechStackStore.getState().reportReady(payload.reportId);
}

export function handleTechStackJobFailed(msg: WSServerMessage): void {
  const payload = msg.payload as { jobId?: string; error?: string };
  if (!payload.jobId) return;
  useTechStackStore.getState().jobFailed(payload.jobId, payload.error ?? 'TechStack job failed');
}

export function handleTechStackJobCancelled(msg: WSServerMessage): void {
  const payload = msg.payload as { jobId?: string };
  if (payload.jobId) useTechStackStore.getState().jobCancelled(payload.jobId);
}

export const techStackHandlerMap: Partial<
  Record<WSServerMessage['type'], (msg: WSServerMessage) => void>
> = {
  'techstack.job.started': handleTechStackJobStarted,
  'techstack.job.progress': handleTechStackJobProgress,
  'techstack.workspace.completed': handleTechStackWorkspaceCompleted,
  'techstack.snapshot.updated': handleTechStackSnapshotUpdated,
  'techstack.report.ready': handleTechStackReportReady,
  'techstack.job.failed': handleTechStackJobFailed,
  'techstack.job.cancelled': handleTechStackJobCancelled,
};

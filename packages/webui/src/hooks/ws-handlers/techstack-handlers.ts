import { useTechStackStore } from '@/stores/techstack-store';
import type {
  TechStackAnalyzeDepth,
  TechStackSnapshot,
} from '@/stores/techstack-store';
import type { WSServerMessage } from '@/types';

export function handleTechStackJobStarted(msg: WSServerMessage): void {
  const payload = msg.payload as {
    jobId?: string;
    kind?: 'inventory' | 'analyze';
    depth?: TechStackAnalyzeDepth;
    model?: string;
  };
  if (!payload.jobId || !payload.kind) return;
  const options: { depth?: TechStackAnalyzeDepth; model?: string } = {};
  if (payload.depth === 'inventory' || payload.depth === 'enrich' || payload.depth === 'full') {
    options.depth = payload.depth;
  }
  if (typeof payload.model === 'string' && payload.model.length > 0) {
    options.model = payload.model;
  }
  useTechStackStore
    .getState()
    .jobStarted(payload.jobId, payload.kind, options.depth || options.model ? options : undefined);
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
    snapshot?: TechStackSnapshot;
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

/**
 * `techstack.research.partial` — the server forwards dependency-scoped
 * research progress (not cluster-level updates) as a streaming event.
 * Valid partials update the store's deep-dive progress; general job progress
 * continues to arrive separately on `techstack.job.progress`.
 */
export function handleTechStackResearchPartial(msg: WSServerMessage): void {
  const payload = msg.payload as {
    dependencyId?: string;
    completed?: number;
    total?: number;
  };
  if (
    !payload.dependencyId ||
    !Number.isFinite(payload.completed) ||
    !Number.isFinite(payload.total)
  ) {
    return;
  }
  useTechStackStore.getState().setDeepDivePartial({
    dependencyId: payload.dependencyId,
    status: 'researching',
    completed: payload.completed ?? 0,
    total: payload.total ?? 0,
  });
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
  'techstack.research.partial': handleTechStackResearchPartial,
};

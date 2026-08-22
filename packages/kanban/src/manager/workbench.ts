import type { KanbanTask } from '../types.js';
import type {
  GetKanbanWorkbenchInput,
  KanbanOrchestrationSnapshot,
  KanbanSearchResult,
  KanbanWorkbenchAlert,
  KanbanWorkbenchItem,
  KanbanWorkbenchLane,
  KanbanWorkbenchSnapshot,
} from '../types-operations.js';
import { getKanbanOrchestrationSnapshot } from './assignment.js';

const DEFAULT_LANE_LIMIT = 8;
const DEFAULT_ALERT_LIMIT = 8;
const HEARTBEAT_DUE_WINDOW_MS = 60_000;

export async function getKanbanWorkbench(
  projectRoot: string,
  input: GetKanbanWorkbenchInput = {},
): Promise<KanbanWorkbenchSnapshot> {
  const kindFilter = input.includeBoardKinds
    ? { includeBoardKinds: input.includeBoardKinds }
    : { excludeBoardKinds: input.excludeBoardKinds ?? (['archive'] as const) };
  const snapshot = await getKanbanOrchestrationSnapshot(projectRoot, {
    ...kindFilter,
  });
  return buildKanbanWorkbench(snapshot, input);
}

/** Pure projection kept public so every UI can test the exact same semantics. */
export function buildKanbanWorkbench(
  snapshot: KanbanOrchestrationSnapshot,
  input: GetKanbanWorkbenchInput = {},
): KanbanWorkbenchSnapshot {
  const laneLimit = clampLimit(input.limitPerLane, DEFAULT_LANE_LIMIT);
  const alertLimit = clampLimit(input.alertLimit, DEFAULT_ALERT_LIMIT);
  const nowMs = Date.parse(input.now ?? snapshot.generatedAt);
  const effectiveNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const resultById = collectUniqueResults(snapshot);
  const completedIds = new Set(snapshot.completed.map(resultKey));

  const laneResults: Record<KanbanWorkbenchLane, KanbanSearchResult[]> = {
    now: unique(snapshot.running),
    next: unique([...snapshot.queued, ...snapshot.ready]).filter(
      (result) => !snapshot.running.some((running) => resultKey(running) === resultKey(result)),
    ),
    blocked: unique([...snapshot.blocked, ...snapshot.failed]),
    review: unique(snapshot.review),
  };

  const lanes = Object.fromEntries(
    (Object.keys(laneResults) as KanbanWorkbenchLane[]).map((lane) => {
      const ordered = [...laneResults[lane]].sort(compareResults);
      const items = ordered
        .slice(0, laneLimit)
        .map((result) => toWorkbenchItem(result, lane, resultById, completedIds));
      return [
        lane,
        { total: ordered.length, omitted: Math.max(0, ordered.length - items.length), items },
      ];
    }),
  ) as KanbanWorkbenchSnapshot['lanes'];

  const allActive = [...resultById.values()].filter(
    (result) => result.task.status !== 'completed' && result.task.status !== 'archived',
  );
  const alerts = buildAlerts(allActive, effectiveNow);
  const pendingCount = allActive.filter((result) => result.task.status === 'pending').length;
  const readyCount = laneResults.next.length;

  return {
    generatedAt: snapshot.generatedAt,
    boardCount: snapshot.boards.length,
    totals: {
      active: allActive.length,
      now: laneResults.now.length,
      next: laneResults.next.length,
      blocked: laneResults.blocked.length,
      review: laneResults.review.length,
      failed: unique(snapshot.failed).length,
      completed: unique(snapshot.completed).length,
    },
    flow: [
      {
        id: 'capture',
        label: 'Captured',
        count: pendingCount,
        explanation: 'Durable cards recorded before project action.',
      },
      {
        id: 'ready',
        label: 'Ready',
        count: readyCount,
        explanation: 'Detailed work whose dependencies permit a start.',
      },
      {
        id: 'execute',
        label: 'Executing',
        count: laneResults.now.length,
        explanation: 'Work with a live run or in-progress task state.',
      },
      {
        id: 'review',
        label: 'Review',
        count: laneResults.review.length,
        explanation: 'Implementation finished; evidence and acceptance remain.',
      },
      {
        id: 'verified',
        label: 'Verified',
        count: unique(snapshot.completed).length,
        explanation: 'Accepted work recorded as completed.',
      },
    ],
    lanes,
    alerts: alerts.slice(0, alertLimit),
    alertTotal: alerts.length,
    alertsOmitted: Math.max(0, alerts.length - alertLimit),
  };
}

function toWorkbenchItem(
  result: KanbanSearchResult,
  lane: KanbanWorkbenchLane,
  all: ReadonlyMap<string, KanbanSearchResult>,
  completedIds: ReadonlySet<string>,
): KanbanWorkbenchItem {
  const task = result.task;
  const blockedBy = (task.dependsOn ?? []).filter(
    (dependencyId) => !completedIds.has(`${result.board.id}:${dependencyId}`),
  ).length;
  const children = (task.childTaskIds ?? [])
    .map((taskId) => all.get(`${result.board.id}:${taskId}`)?.task)
    .filter((child): child is KanbanTask => Boolean(child));
  return {
    boardId: result.board.id,
    boardTitle: result.board.title,
    boardKind: result.board.kind ?? 'project',
    taskId: task.id,
    title: task.title,
    lane,
    status: task.status,
    priority: task.priority,
    updatedAt: task.updatedAt,
    reason:
      result.contractStatus && !result.contractStatus.startReady
        ? `${result.contractStatus.setupGaps} card readiness gap(s) block implementation`
        : laneReason(lane, task, blockedBy),
    source: result.board.kind === 'session_mirror' ? 'session' : 'managed',
    ...(task.assignee || task.assignedAgent
      ? { assignee: task.assignee ?? task.assignedAgent }
      : {}),
    ...(blockedBy > 0 ? { blockedBy } : {}),
    ...(children.length > 0
      ? {
          childProgress: {
            completed: children.filter((child) => child.status === 'completed').length,
            total: children.length,
          },
        }
      : {}),
    ...(result.contractStatus ? { contractStatus: result.contractStatus } : {}),
  };
}

function laneReason(lane: KanbanWorkbenchLane, task: KanbanTask, blockedBy: number): string {
  if (lane === 'now')
    return task.assignment?.status === 'running' ? 'Live agent execution' : 'Marked in progress';
  if (lane === 'next')
    return task.assignment?.status === 'queued'
      ? 'Queued for an agent'
      : 'Dependencies and detail permit work';
  if (lane === 'review') return 'Awaiting evidence, verification, or acceptance';
  if (task.status === 'failed') return 'Last execution failed';
  if (blockedBy > 0) return `${blockedBy} unresolved dependenc${blockedBy === 1 ? 'y' : 'ies'}`;
  return 'Explicitly marked blocked';
}

function buildAlerts(active: KanbanSearchResult[], nowMs: number): KanbanWorkbenchAlert[] {
  const alerts: KanbanWorkbenchAlert[] = [];
  for (const result of active) {
    const assignment = result.task.assignment;
    const leaseMs = assignment?.leaseExpiresAt ? Date.parse(assignment.leaseExpiresAt) : Number.NaN;
    const isLiveState = assignment?.status === 'running' || assignment?.status === 'queued';
    if (isLiveState && Number.isFinite(leaseMs) && leaseMs <= nowMs) {
      alerts.push(
        taskAlert(
          result,
          'critical',
          'stale_running',
          'Stale execution lease',
          'The task still looks active, but its execution lease has expired.',
        ),
      );
    } else if (
      assignment?.status === 'running' &&
      Number.isFinite(leaseMs) &&
      leaseMs - nowMs <= HEARTBEAT_DUE_WINDOW_MS
    ) {
      alerts.push(
        taskAlert(
          result,
          'warning',
          'heartbeat_due',
          'Heartbeat due',
          'The active execution lease is close to expiring.',
        ),
      );
    }
    if (
      (result.task.status === 'failed' || assignment?.status === 'failed') &&
      (assignment?.attempt ?? 0) < (assignment?.maxAttempts ?? 1)
    ) {
      alerts.push(
        taskAlert(
          result,
          'warning',
          'failed_retryable',
          'Retry available',
          'The task failed but still has retry budget.',
        ),
      );
    }
  }

  const byTitle = new Map<string, KanbanSearchResult[]>();
  for (const result of active) {
    // Session boards intentionally mirror tactical Todos. Treating that
    // projection as a duplicate of its durable card would create noise.
    if (result.board.kind === 'session_mirror') continue;
    const fingerprint = normalizeTitle(result.task.title);
    if (fingerprint.length < 5) continue;
    const group = byTitle.get(fingerprint) ?? [];
    group.push(result);
    byTitle.set(fingerprint, group);
  }
  for (const group of byTitle.values()) {
    if (group.length < 2) continue;
    const first = group[0]!;
    alerts.push({
      id: `duplicate:${normalizeTitle(first.task.title)}`,
      severity: 'warning',
      kind: 'duplicate_active',
      title: 'Possible duplicate active cards',
      detail: `${group.length} active cards share the title “${first.task.title}”.`,
      relatedTaskIds: group.map((result) => result.task.id),
    });
  }
  return alerts.sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
}

function taskAlert(
  result: KanbanSearchResult,
  severity: KanbanWorkbenchAlert['severity'],
  kind: KanbanWorkbenchAlert['kind'],
  title: string,
  detail: string,
): KanbanWorkbenchAlert {
  return {
    id: `${kind}:${result.board.id}:${result.task.id}`,
    severity,
    kind,
    title,
    detail,
    boardId: result.board.id,
    taskId: result.task.id,
  };
}

function collectUniqueResults(
  snapshot: KanbanOrchestrationSnapshot,
): Map<string, KanbanSearchResult> {
  const result = new Map<string, KanbanSearchResult>();
  for (const item of [
    ...snapshot.ready,
    ...snapshot.queued,
    ...snapshot.running,
    ...snapshot.blocked,
    ...snapshot.review,
    ...snapshot.failed,
    ...snapshot.completed,
  ]) {
    result.set(resultKey(item), item);
  }
  return result;
}

function unique(items: KanbanSearchResult[]): KanbanSearchResult[] {
  return [...new Map(items.map((item) => [resultKey(item), item])).values()];
}

function resultKey(result: KanbanSearchResult): string {
  return `${result.board.id}:${result.task.id}`;
}

function normalizeTitle(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function compareResults(left: KanbanSearchResult, right: KanbanSearchResult): number {
  const priority = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  return (
    priority[left.task.priority] - priority[right.task.priority] ||
    right.task.updatedAt.localeCompare(left.task.updatedAt)
  );
}

function severityRank(value: KanbanWorkbenchAlert['severity']): number {
  return value === 'critical' ? 0 : 1;
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(50, Math.max(1, Math.floor(value!)));
}

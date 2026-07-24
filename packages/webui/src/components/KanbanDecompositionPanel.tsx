/**
 * Decomposition surfaces:
 *
 *   KanbanDecompositionApprovalCard — alert strip above the board (the
 *   KanbanCleanerAlert pattern) listing every task whose proposal awaits
 *   approval, with inline Approve/Reject.
 *
 *   KanbanDecompositionPanel — task-inspector section showing the proposal
 *   lifecycle as a stage strip (assessed → proposed → approval → applied), the
 *   proposed subtask DAG rendered with the reused SddFlowGraph, and
 *   approve/reject actions while pending. Applied children deep-link back
 *   into the inspector.
 */
import type { KanbanBoard, KanbanTask } from '@wrongstack/kanban';
import { Check, ChevronDown, ChevronRight, Scissors, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { type FlowTask, SddFlowGraph } from './SddFlowGraph';

type SendKanban = (type: `kanban.${string}`, payload?: Record<string, unknown>) => void;

export function KanbanDecompositionApprovalCard({
  board,
  sendKanban,
  onSelectTask,
}: {
  board: KanbanBoard;
  sendKanban: SendKanban;
  onSelectTask: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const pending = board.tasks.filter((task) => task.decomposition?.status === 'proposed');
  if (!pending.length) return null;

  return (
    <div className="shrink-0 border-b border-warning/30 bg-warning/5 px-4 py-2">
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        className="flex w-full items-center gap-2 text-left text-xs font-semibold text-warning"
      >
        {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        <Scissors size={13} />
        {pending.length} decomposition proposal{pending.length > 1 ? 's' : ''} awaiting approval
      </button>
      {!collapsed && (
        <ul className="mt-1.5 space-y-1">
          {pending.map((task) => (
            <li key={task.id} className="flex items-center gap-2 text-xs">
              <button
                type="button"
                onClick={() => onSelectTask(task.id)}
                className="min-w-0 flex-1 truncate text-left hover:underline"
              >
                {task.title}
                <span className="ml-1.5 text-muted-foreground">
                  → {task.decomposition?.proposedSubtasks.length ?? 0} subtasks
                </span>
              </button>
              <button
                type="button"
                onClick={() =>
                  sendKanban('kanban.decomposition.approve', {
                    boardId: board.id,
                    taskId: task.id,
                    proposalId: task.decomposition!.id,
                  })
                }
                className="inline-flex items-center gap-1 rounded-md bg-success/10 px-2 py-1 text-[11px] font-medium text-success hover:bg-success/20"
              >
                <Check size={12} /> Approve
              </button>
              <button
                type="button"
                onClick={() =>
                  sendKanban('kanban.decomposition.reject', {
                    boardId: board.id,
                    taskId: task.id,
                    proposalId: task.decomposition!.id,
                  })
                }
                className="inline-flex items-center gap-1 rounded-md bg-destructive/10 px-2 py-1 text-[11px] font-medium text-destructive hover:bg-destructive/20"
              >
                <X size={12} /> Reject
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const STAGES = ['assessed', 'proposed', 'approval', 'applied'] as const;

function stageIndex(task: KanbanTask): number {
  const status = task.decomposition?.status;
  if (status === 'applied') return 3;
  if (status === 'approved') return 2;
  if (status === 'rejected') return 2;
  if (status === 'proposed') return 1;
  return task.atomicityAssessment ? 0 : -1;
}

export function KanbanDecompositionPanel({
  board,
  task,
  sendKanban,
  onSelectTask,
}: {
  board: KanbanBoard;
  task: KanbanTask;
  sendKanban: SendKanban;
  onSelectTask: (id: string) => void;
}) {
  const proposal = task.decomposition;
  const currentStage = stageIndex(task);

  // Map the proposal into the reused SddFlowGraph: parent node + proposed
  // subtasks. Applied children show their live status; proposed items are
  // 'pending' (or 'queued' once approved).
  const flow = useMemo(() => {
    if (!proposal) return null;
    const appliedChildren = (proposal.appliedChildTaskIds ?? [])
      .map((childId) => board.tasks.find((candidate) => candidate.id === childId))
      .filter((child): child is KanbanTask => Boolean(child));
    const tasks: FlowTask[] = [
      {
        id: task.id,
        shortId: 'parent',
        title: task.title,
        displayStatus: proposal.status === 'applied' ? 'completed' : 'in_progress',
        priority: task.priority,
        deps: [],
      },
      ...proposal.proposedSubtasks.map((subtask, index): FlowTask => {
        const applied = appliedChildren[index];
        return {
          id: applied?.id ?? `proposed-${index}`,
          shortId: `s${index}`,
          title: subtask.title,
          displayStatus: applied
            ? applied.status === 'completed'
              ? 'completed'
              : applied.status === 'failed'
                ? 'failed'
                : applied.status === 'in_progress'
                  ? 'in_progress'
                  : 'pending'
            : proposal.status === 'approved'
              ? 'queued'
              : 'pending',
          priority: task.priority,
          deps: (subtask.dependsOnIndex ?? []).map((depIndex) => `s${depIndex}`),
        };
      }),
    ];
    const columns = [
      { label: 'Parent', taskIds: ['parent'] },
      {
        label: proposal.status === 'applied' ? 'Subtasks' : 'Proposed subtasks',
        taskIds: proposal.proposedSubtasks.map((_, index) => `s${index}`),
      },
    ];
    return { tasks, columns, appliedChildren };
  }, [board, proposal, task]);

  if (!proposal && !task.atomicityAssessment) return null;

  return (
    <div className="mt-4 rounded-md border p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
        <Scissors size={13} />
        Decomposition
      </div>

      {/* Stage strip */}
      <div className="mb-2 flex items-center gap-1 text-[11px]">
        {STAGES.map((stage, index) => (
          <div key={stage} className="flex items-center gap-1">
            {index > 0 && <span className="text-muted-foreground/50">→</span>}
            <span
              className={cn(
                'rounded px-1.5 py-0.5',
                proposal?.status === 'rejected' && index === 2
                  ? 'bg-destructive/10 text-destructive'
                  : index <= currentStage
                    ? 'bg-primary/10 font-medium text-primary'
                    : 'bg-muted text-muted-foreground',
              )}
            >
              {proposal?.status === 'rejected' && index === 2 ? 'rejected' : stage}
            </span>
          </div>
        ))}
        {task.atomicityAssessment && (
          <span className="ml-auto text-muted-foreground">
            {task.atomicityAssessment.verdict} · score {task.atomicityAssessment.score}
          </span>
        )}
      </div>

      {/* Assessment reasons when a split is still needed */}
      {!proposal && task.atomicityAssessment?.verdict === 'needs_decomposition' && (
        <div className="rounded-md border border-warning/30 bg-warning/5 p-2 text-[11px] text-warning">
          This task should be split before dispatch:
          <ul className="ml-4 mt-1 list-disc">
            {task.atomicityAssessment.criteria
              .filter((criterion) => criterion.score < 1)
              .map((criterion) => (
                <li key={criterion.id}>{criterion.reason}</li>
              ))}
          </ul>
        </div>
      )}

      {proposal && flow && (
        <>
          {proposal.rationale && (
            <div className="mb-2 text-[11px] text-muted-foreground">“{proposal.rationale}”</div>
          )}
          <div className="h-64 overflow-hidden rounded-md border">
            <SddFlowGraph
              tasks={flow.tasks}
              columns={flow.columns}
              onTaskClick={(id) => {
                if (board.tasks.some((candidate) => candidate.id === id)) onSelectTask(id);
              }}
            />
          </div>
          <ul className="mt-2 space-y-1 text-[11px]">
            {proposal.proposedSubtasks.map((subtask, index) => (
              <li key={`${subtask.title}-${index}`} className="rounded bg-muted/40 px-2 py-1">
                <span className="font-medium">{subtask.title}</span>
                {subtask.successCriteria?.length ? (
                  <span className="ml-1.5 text-muted-foreground">
                    ✓ {subtask.successCriteria.join(' · ')}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {proposal.status === 'proposed' && (
            <div className="mt-2 flex gap-1.5">
              <button
                type="button"
                onClick={() =>
                  sendKanban('kanban.decomposition.approve', {
                    boardId: board.id,
                    taskId: task.id,
                    proposalId: proposal.id,
                  })
                }
                className="inline-flex items-center gap-1 rounded-md bg-success/10 px-2.5 py-1.5 text-xs font-medium text-success hover:bg-success/20"
              >
                <Check size={13} /> Approve &amp; split
              </button>
              <button
                type="button"
                onClick={() =>
                  sendKanban('kanban.decomposition.reject', {
                    boardId: board.id,
                    taskId: task.id,
                    proposalId: proposal.id,
                  })
                }
                className="inline-flex items-center gap-1 rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/20"
              >
                <X size={13} /> Reject
              </button>
            </div>
          )}
          {proposal.status === 'applied' && flow.appliedChildren.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {flow.appliedChildren.map((child) => (
                <button
                  key={child.id}
                  type="button"
                  onClick={() => onSelectTask(child.id)}
                  className="rounded-md border px-2 py-1 text-[11px] hover:bg-muted"
                >
                  {child.title}
                  <span className="ml-1 text-muted-foreground">[{child.status}]</span>
                </button>
              ))}
            </div>
          )}
          {proposal.status === 'rejected' && proposal.resolutionReason && (
            <div className="mt-2 text-[11px] text-muted-foreground">
              Rejected: {proposal.resolutionReason}
            </div>
          )}
        </>
      )}
    </div>
  );
}

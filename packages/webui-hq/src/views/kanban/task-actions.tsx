/**
 * Kanban task actions for the desktop inspector.
 *
 * The same three commands the phone has — transition, assign, dispatch. They
 * are not edits: each is queued to a connected client and applied by the
 * project owner through its lifecycle gate, so an illegal move is refused on
 * the machine, not trusted from here. The desktop used to be the LESS capable
 * surface, which made no sense for the operator's primary screen.
 */
import { Play, Send, TriangleAlert, UserRoundCog } from 'lucide-react';
import type * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { Select, Textarea } from '../../components/ui/input.js';
import { postCommand } from '../../data/api.js';
import { useHqStore } from '../../data/store/index.js';
import {
  canAssignKanbanTask,
  canDispatchKanbanTask,
  kanbanControlClients,
  kanbanTransitionOptions,
  type LifecycleStage,
  mobileKanbanAssignmentTargets,
  suggestedKanbanStage,
} from '../../domain/kanban-actions.js';
import type { HqKanbanBoardView, HqKanbanTaskView } from '../../domain/kanban-model.js';

export function KanbanTaskActions({
  task,
  board,
  projectId,
}: {
  task: HqKanbanTaskView;
  board: HqKanbanBoardView;
  projectId: string;
}): React.ReactElement {
  const snapshot = useHqStore((state) => state.snapshot);
  const { control, dispatch } = useMemo(
    () => kanbanControlClients(snapshot, projectId),
    [projectId, snapshot],
  );
  const targets = useMemo(
    () => mobileKanbanAssignmentTargets(snapshot, projectId),
    [projectId, snapshot],
  );
  const stages = kanbanTransitionOptions(task);
  const [stage, setStage] = useState<LifecycleStage>(suggestedKanbanStage(task));
  const [targetKey, setTargetKey] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  // A different task is a different decision: nothing carries over.
  useEffect(() => {
    setStage(suggestedKanbanStage(task));
    setComment('');
    setResult(null);
  }, [task]);
  useEffect(() => {
    if (!targets.some((target) => target.key === targetKey)) setTargetKey(targets[0]?.key ?? '');
  }, [targetKey, targets]);

  const run = async (
    clientId: string,
    type: 'kanban-transition' | 'kanban-assign' | 'kanban-dispatch',
    payload: Record<string, unknown>,
    label: string,
  ): Promise<void> => {
    setBusy(true);
    setResult(null);
    try {
      const queued = await postCommand(clientId, type, {
        boardId: board.id,
        taskId: task.id,
        comment: comment.trim() || `HQ: ${label} “${task.title}”`,
        ...payload,
      });
      setResult({ tone: 'ok', text: `${label} queued · ${queued.commandId}` });
    } catch (cause) {
      setResult({ tone: 'error', text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(false);
    }
  };

  if (control === null) {
    return (
      <p className="text-[11px] text-muted-foreground" data-testid="kanban-task-actions">
        Read only — no client of this project accepts commands right now.
      </p>
    );
  }
  const target = targets.find((candidate) => candidate.key === targetKey);

  return (
    <div className="space-y-2" data-testid="kanban-task-actions">
      <div className="text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
        Actions
      </div>
      <Textarea
        aria-label="Action comment"
        placeholder="Comment recorded with the change (optional)"
        rows={2}
        value={comment}
        onChange={(event) => setComment(event.target.value)}
      />
      <div className="flex gap-1.5">
        <Select
          aria-label="Move to stage"
          value={stage}
          disabled={stages.length === 0 || busy}
          onChange={(event) => setStage(event.target.value as LifecycleStage)}
        >
          {stages.length === 0 && <option value={stage}>terminal stage</option>}
          {stages.map((candidate) => (
            <option key={candidate} value={candidate}>
              {candidate}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          disabled={stages.length === 0 || busy}
          onClick={() => void run(control.clientId, 'kanban-transition', { to: stage }, 'move')}
        >
          <Send />
          Move
        </Button>
      </div>
      <div className="flex gap-1.5">
        <Select
          aria-label="Assign to agent"
          value={targetKey}
          disabled={targets.length === 0 || busy}
          onChange={(event) => setTargetKey(event.target.value)}
        >
          {targets.length === 0 && <option value="">no live agents</option>}
          {targets.map((candidate) => (
            <option key={candidate.key} value={candidate.key}>
              {candidate.label}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          variant="outline"
          disabled={target === undefined || !canAssignKanbanTask(task) || busy}
          onClick={() =>
            target !== undefined &&
            void run(
              control.clientId,
              'kanban-assign',
              { agentId: target.agentId, assignee: target.label },
              'assign',
            )
          }
        >
          <UserRoundCog />
          Assign
        </Button>
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={dispatch === null || !canDispatchKanbanTask(task) || busy}
        title={dispatch === null ? 'No client of this project runs a Director' : undefined}
        onClick={() =>
          dispatch !== null && void run(dispatch.clientId, 'kanban-dispatch', {}, 'dispatch')
        }
      >
        <Play />
        Dispatch through the Director
      </Button>
      {result !== null && (
        <p
          className={
            result.tone === 'ok'
              ? 'text-[11px] text-success'
              : 'flex items-center gap-1 text-[11px] text-destructive'
          }
        >
          {result.tone === 'error' && <TriangleAlert className="size-3" />}
          {result.text}
        </p>
      )}
    </div>
  );
}

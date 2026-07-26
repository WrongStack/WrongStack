import { Check, Pause, Play, Rocket, RotateCcw, Square, UserPlus, X } from 'lucide-react';
import { useState } from 'react';
import type { ModelCandidate } from '@/hooks/useProviderModels';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores';
import { ModelPicker } from './ModelPicker';

export interface RunLink {
  engine: 'sdd' | 'goal';
  runId?: string | undefined;
}

export function RunControlBar({
  runLink,
  sendRaw,
}: {
  runLink: RunLink;
  sendRaw: (type: string, payload?: Record<string, unknown>) => void;
}) {
  const isSdd = runLink.engine === 'sdd';
  const pfx = isSdd ? 'sdd.board' : 'goal';
  const setCurrentView = useUIStore((s) => s.setCurrentView);
  const btn =
    'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium hover:bg-muted';
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-primary/5 px-4 py-1.5">
      <span className="inline-flex items-center gap-1 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-primary">
        <Rocket size={11} /> {runLink.engine}
      </span>
      <span className="text-[11px] text-muted-foreground">Live run — steer it from here</span>
      {isSdd && (
        <button
          type="button"
          className={btn}
          title="Open the live run view (SDD Hub)"
          onClick={() => setCurrentView('sddhub')}
        >
          <Rocket size={12} /> Open live run
        </button>
      )}
      <div className="ml-auto flex items-center gap-1">
        <button type="button" className={btn} onClick={() => sendRaw(`${pfx}.pause`)}>
          <Pause size={12} /> Pause
        </button>
        <button type="button" className={btn} onClick={() => sendRaw(`${pfx}.resume`)}>
          <Play size={12} /> Resume
        </button>
        {isSdd && (
          <button
            type="button"
            className={btn}
            onClick={() => sendRaw('sdd.board.retry_all_failed')}
          >
            <RotateCcw size={12} /> Retry failed
          </button>
        )}
        <button
          type="button"
          className={cn(btn, 'text-destructive hover:bg-destructive/10')}
          onClick={() => sendRaw(`${pfx}.stop`)}
        >
          <Square size={12} /> Stop
        </button>
      </div>
    </div>
  );
}

export function StartAsBar({
  boardId,
  sendKanban,
}: {
  boardId: string;
  sendKanban: (type: `kanban.${string}`, payload?: Record<string, unknown>) => void;
}) {
  const btn =
    'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/10';
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-1.5">
      <Rocket size={13} className="text-primary" />
      <span className="text-[11px] text-muted-foreground">Run this board as a live agent job:</span>
      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          className={btn}
          onClick={() => sendKanban('kanban.run.start', { boardId, engine: 'goal' })}
        >
          Start as Goal
        </button>
        <button
          type="button"
          className={btn}
          onClick={() => sendKanban('kanban.run.start', { boardId, engine: 'sdd' })}
        >
          Start as SDD
        </button>
      </div>
    </div>
  );
}

/** Run-native per-task controls shown in the inspector for run-linked boards. */
export function RunTaskControls({
  runLink,
  runTaskId,
  modelCandidates,
  sendRaw,
}: {
  runLink: RunLink;
  runTaskId: string;
  modelCandidates: ModelCandidate[];
  sendRaw: (type: string, payload?: Record<string, unknown>) => void;
}) {
  const isSdd = runLink.engine === 'sdd';
  const [reassigning, setReassigning] = useState(false);
  const [reassignName, setReassignName] = useState('');
  const btn =
    'inline-flex flex-1 items-center justify-center gap-1 rounded-md border py-1.5 text-xs font-medium hover:bg-muted';
  const submitReassign = () => {
    const n = reassignName.trim();
    if (!n) return;
    sendRaw(isSdd ? 'sdd.board.reassign' : 'goal.assignTask', {
      taskId: runTaskId,
      agentName: n,
    });
    setReassigning(false);
    setReassignName('');
  };
  return (
    <div className="mt-4 rounded-md border bg-primary/5 p-2.5">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-primary">
        Run controls
      </div>
      {isSdd && (
        <div className="mb-2">
          <div className="mb-1 text-[10px] uppercase text-muted-foreground">Worker model</div>
          <ModelPicker
            candidates={modelCandidates}
            placeholder="Set model for this task…"
            onPick={(model, provider) =>
              sendRaw('sdd.board.set_task_model', { taskId: runTaskId, model, provider })
            }
          />
        </div>
      )}
      {reassigning ? (
        <div className="flex items-center gap-1.5">
          <input
            value={reassignName}
            onChange={(e) => setReassignName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitReassign();
              if (e.key === 'Escape') setReassigning(false);
            }}
            placeholder="New worker name"
            className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary"
          />
          <button
            type="button"
            onClick={submitReassign}
            className="rounded-md bg-primary/10 px-2 py-1.5 text-primary"
          >
            <Check size={14} />
          </button>
          <button
            type="button"
            onClick={() => setReassigning(false)}
            className="rounded-md bg-muted px-2 py-1.5"
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={btn}
            onClick={() =>
              sendRaw(isSdd ? 'sdd.board.retry' : 'goal.retryTask', { taskId: runTaskId })
            }
          >
            <RotateCcw size={13} /> Retry
          </button>
          <button type="button" className={btn} onClick={() => setReassigning(true)}>
            <UserPlus size={13} /> Reassign
          </button>
          {isSdd ? (
            <button
              type="button"
              className={cn(btn, 'text-destructive hover:bg-destructive/10')}
              onClick={() => sendRaw('sdd.board.cancel_task', { taskId: runTaskId })}
            >
              <Square size={13} /> Cancel
            </button>
          ) : (
            <button
              type="button"
              className={btn}
              onClick={() => sendRaw('goal.runTask', { taskId: runTaskId })}
            >
              <Play size={13} /> Run now
            </button>
          )}
        </div>
      )}
    </div>
  );
}

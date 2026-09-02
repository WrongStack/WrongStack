/**
 * Task inspector — read-only detail, in a right-hand Sheet.
 *
 * HQ is a command center, not an editor: nothing here mutates a board. The
 * "Open in WebUI" link is the escape hatch to the surface that can.
 */
import {
  CircleCheck,
  Clock3,
  ExternalLink,
  GitBranch,
  Layers,
  TriangleAlert,
  UserRound,
} from 'lucide-react';
import type * as React from 'react';
import { Mono } from '../../components/hq/primitives.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Separator } from '../../components/ui/separator.js';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '../../components/ui/sheet.js';
import type { HqKanbanBoardView, HqKanbanTaskView } from '../../domain/kanban-model.js';
import { taskPriorityTone, taskStatusTone } from './task-tone.js';

function DetailRow({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof Layers;
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className="flex w-24 shrink-0 items-center gap-1.5 text-muted-foreground">
        <Icon className="size-3" />
        {label}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

export function KanbanTaskInspector({
  task,
  board,
  dependencyTitles,
  webuiUrl,
  onClose,
}: {
  task: HqKanbanTaskView;
  board: HqKanbanBoardView;
  dependencyTitles?: ReadonlyMap<string, string>;
  webuiUrl?: string;
  onClose: () => void;
}): React.ReactElement {
  const dependencies = task.dependsOn.map((id) => ({
    id,
    title: dependencyTitles?.get(id) ?? id.slice(0, 8),
  }));
  const needsAttention = task.status === 'blocked' || task.status === 'failed';

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="right"
        aria-label="Task detail"
        data-testid="kanban-task-inspector"
        className="overflow-y-auto sm:max-w-lg"
      >
        <SheetHeader>
          <div className="flex items-center gap-2">
            <Badge tone={taskStatusTone(task.status)}>{task.status.replaceAll('_', ' ')}</Badge>
            <Badge tone={taskPriorityTone(task.priority)}>{task.priority}</Badge>
          </div>
          <SheetTitle>{task.title}</SheetTitle>
          <SheetDescription asChild>
            <Mono>{task.id}</Mono>
          </SheetDescription>
        </SheetHeader>

        {needsAttention && (
          <div className="flex items-center gap-2 border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
            <TriangleAlert className="size-3.5 shrink-0" />
            This task is {task.status} and may need attention.
          </div>
        )}

        {task.description !== undefined && (
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
            {task.description}
          </p>
        )}

        <Separator />

        <div className="space-y-1.5">
          <DetailRow icon={Layers} label="Board">
            {board.title}
          </DetailRow>
          {task.columnId !== '' && (
            <DetailRow icon={Layers} label="Column">
              {board.columns.find((column) => column.id === task.columnId)?.title ?? task.columnId}
            </DetailRow>
          )}
          {task.assignee !== undefined && (
            <DetailRow icon={UserRound} label="Assignee">
              {task.assignee}
              {task.assignmentStatus !== undefined && (
                <Mono className="ml-1.5">({task.assignmentStatus})</Mono>
              )}
            </DetailRow>
          )}
          {task.dueDate !== undefined && (
            <DetailRow icon={Clock3} label="Due">
              {new Date(task.dueDate).toLocaleString()}
            </DetailRow>
          )}
        </div>

        {task.labels.length > 0 && (
          <>
            <Separator />
            <div className="flex flex-wrap gap-1.5">
              {task.labels.map((label) => (
                <Badge key={label} tone="info">
                  {label}
                </Badge>
              ))}
            </div>
          </>
        )}

        {dependencies.length > 0 && (
          <>
            <Separator />
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
                <GitBranch className="size-3" />
                Dependencies ({dependencies.length})
              </div>
              <ul className="space-y-1">
                {dependencies.map((dependency) => (
                  <li key={dependency.id} className="flex items-center gap-2 text-xs">
                    <Mono>{dependency.id.slice(0, 8)}</Mono>
                    <span className="min-w-0 flex-1 truncate">{dependency.title}</span>
                    {task.status === 'completed' && (
                      <CircleCheck className="size-3.5 shrink-0 text-success" />
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}

        {webuiUrl !== undefined && (
          <Button asChild variant="outline" size="sm" className="mt-auto self-start">
            <a href={webuiUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink />
              Open in WebUI
            </a>
          </Button>
        )}
      </SheetContent>
    </Sheet>
  );
}

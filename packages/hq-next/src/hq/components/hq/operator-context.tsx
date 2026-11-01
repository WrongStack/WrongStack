import { MessageSquareText, X } from 'lucide-react';
import type * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useHqStore } from '../../data/store/index.js';
import { Button } from '../ui/button.js';

/** Keep the selected conversation visible when moving between operator surfaces. */
export function OperatorContext(): React.ReactElement {
  const { snapshot, sessionId, agentId } = useHqStore(
    useShallow((state) => ({
      snapshot: state.snapshot,
      sessionId: state.selectedSessionId,
      agentId: state.selectedAgentId,
    })),
  );
  const session = snapshot?.liveSessions?.find((candidate) => candidate.sessionId === sessionId);
  const agent = session?.agents?.find((candidate) => candidate.id === agentId);
  return (
    <div
      data-testid="operator-context"
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-muted/20 px-3 py-1.5 text-[11px] text-muted-foreground"
    >
      <span>
        {snapshot === null
          ? 'Awaiting fleet telemetry'
          : [
              count(snapshot.projects.length, 'project'),
              count(snapshot.machines?.length ?? 0, 'machine'),
              count(snapshot.liveSessions?.length ?? 0, 'session'),
            ].join(' · ')}
      </span>
      {sessionId !== null && (
        <div className="ml-auto flex min-w-0 max-w-full items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 min-w-0 px-1 text-[11px]"
            title={`Open selected conversation: ${sessionId}${agentId === null ? '' : ` / ${agentId}`}`}
            onClick={() => useHqStore.getState().setActiveView('console')}
          >
            <MessageSquareText className="size-3 shrink-0" />
            <span className="truncate">
              {session?.projectName ?? 'Selected session'} ·{' '}
              {agent?.name ?? session?.hostname ?? sessionId.slice(0, 8)}
            </span>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-6 shrink-0"
            aria-label="Clear selected conversation"
            onClick={() => useHqStore.getState().selectSession(null)}
          >
            <X className="size-3" />
          </Button>
        </div>
      )}
    </div>
  );
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

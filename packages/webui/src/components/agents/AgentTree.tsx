import { AgentRuntimeBadge } from '@wrongstack/project-surfaces/ui/AgentRuntimeBadge';
import { Bot, Crown } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { SubagentView } from '@/stores';
import { agentModelLabel } from '../OfficeMapCanvas/model-label.js';

const STATUS_META: Record<
  SubagentView['status'],
  { dot: string; labelKey: `activity:fleet.status${string}`; pulse: boolean }
> = {
  running: { dot: 'bg-success', labelKey: 'activity:fleet.statusRunning', pulse: true },
  completed: { dot: 'bg-success', labelKey: 'activity:fleet.statusDone', pulse: false },
  failed: { dot: 'bg-destructive', labelKey: 'activity:fleet.statusFailed', pulse: false },
  timeout: { dot: 'bg-warning', labelKey: 'activity:fleet.statusTimeout', pulse: false },
  stopped: { dot: 'bg-muted-foreground', labelKey: 'activity:fleet.statusStopped', pulse: false },
};

export interface AgentTreeProps {
  agents: readonly SubagentView[];
  leaderId?: string | undefined;
  selectedAgentId?: string | null | undefined;
  onSelectAgent: (agent: SubagentView) => void;
  ariaLabel: string;
  className?: string | undefined;
}

/**
 * Session-scoped fleet tree.
 *
 * The live fleet contract identifies one leader but does not expose delegation
 * parent ids, so the honest hierarchy is leader → workers. When no leader has
 * been announced yet, every agent is rendered as a root item rather than
 * inventing a parent relationship.
 */
export function AgentTree({
  agents,
  leaderId,
  selectedAgentId,
  onSelectAgent,
  ariaLabel,
  className,
}: AgentTreeProps): React.ReactElement {
  const { t } = useAppTranslation();
  const itemRefs = useRef(new Map<string, HTMLDivElement>());

  const { leader, workers, ordered } = useMemo(() => {
    const resolvedLeader =
      agents.find((agent) => agent.id === leaderId) ?? agents.find((agent) => agent.isLeader);
    const resolvedWorkers = resolvedLeader
      ? agents.filter((agent) => agent.id !== resolvedLeader.id)
      : [...agents];
    return {
      leader: resolvedLeader,
      workers: resolvedWorkers,
      ordered: resolvedLeader ? [resolvedLeader, ...resolvedWorkers] : resolvedWorkers,
    };
  }, [agents, leaderId]);

  const [leaderExpanded, setLeaderExpanded] = useState(true);
  const visibleAgents = leader && !leaderExpanded ? [leader] : ordered;
  const [focusedAgentId, setFocusedAgentId] = useState<string | null>(
    selectedAgentId ?? visibleAgents[0]?.id ?? null,
  );

  useEffect(() => {
    if (focusedAgentId && visibleAgents.some((agent) => agent.id === focusedAgentId)) return;
    const next =
      (selectedAgentId && visibleAgents.find((agent) => agent.id === selectedAgentId)?.id) ??
      visibleAgents[0]?.id ??
      null;
    setFocusedAgentId(next);
  }, [focusedAgentId, selectedAgentId, visibleAgents]);

  const focusAgent = (agent: SubagentView | undefined): void => {
    if (!agent) return;
    setFocusedAgentId(agent.id);
    itemRefs.current.get(agent.id)?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, agent: SubagentView): void => {
    const index = visibleAgents.findIndex((candidate) => candidate.id === agent.id);
    if (index < 0) return;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusAgent(visibleAgents[Math.min(index + 1, visibleAgents.length - 1)]);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusAgent(visibleAgents[Math.max(index - 1, 0)]);
        break;
      case 'Home':
        event.preventDefault();
        focusAgent(visibleAgents[0]);
        break;
      case 'End':
        event.preventDefault();
        focusAgent(visibleAgents.at(-1));
        break;
      case 'ArrowRight':
        if (leader?.id === agent.id && workers.length > 0) {
          event.preventDefault();
          if (!leaderExpanded) setLeaderExpanded(true);
          else focusAgent(workers[0]);
        }
        break;
      case 'ArrowLeft':
        if (leader && agent.id !== leader.id) {
          event.preventDefault();
          focusAgent(leader);
        } else if (leader?.id === agent.id && leaderExpanded && workers.length > 0) {
          event.preventDefault();
          setLeaderExpanded(false);
        }
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        onSelectAgent(agent);
        break;
    }
  };

  const renderRow = (
    agent: SubagentView,
    level: 1 | 2,
    position: number,
    setSize: number,
  ): React.ReactElement => {
    const isLeader = leader?.id === agent.id;
    const selected = selectedAgentId === agent.id;
    const route = agentModelLabel(agent.provider, agent.model);
    const status = STATUS_META[agent.status];
    const Icon = isLeader ? Crown : Bot;

    return (
      <div
        key={agent.id}
        ref={(node) => {
          if (node) itemRefs.current.set(agent.id, node);
          else itemRefs.current.delete(agent.id);
        }}
        role="treeitem"
        aria-level={level}
        aria-posinset={position}
        aria-setsize={setSize}
        aria-selected={selected}
        {...(isLeader && workers.length > 0 ? { 'aria-expanded': leaderExpanded } : {})}
        tabIndex={focusedAgentId === agent.id ? 0 : -1}
        onFocus={() => setFocusedAgentId(agent.id)}
        onClick={() => onSelectAgent(agent)}
        onKeyDown={(event) => handleKeyDown(event, agent)}
        className={cn(
          'group grid min-h-11 min-w-0 cursor-pointer grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-2 border border-transparent px-2 py-1.5 outline-none transition-colors',
          'hover:border-border hover:bg-muted/45 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
          selected && 'border-primary/40 bg-primary/10',
        )}
      >
        <span className="relative flex h-7 w-7 shrink-0 items-center justify-center bg-muted/50 text-muted-foreground">
          <Icon className={cn('h-3.5 w-3.5', isLeader && 'text-warning')} aria-hidden="true" />
          <span
            className={cn(
              'absolute right-0.5 bottom-0.5 h-1.5 w-1.5 rounded-full ring-1 ring-background',
              status.dot,
              status.pulse && 'animate-pulse',
            )}
            aria-hidden="true"
          />
        </span>

        <span className="min-w-0">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
            <span
              className="min-w-0 max-w-full break-words text-[11px] font-semibold leading-tight text-foreground [overflow-wrap:anywhere]"
              title={agent.name}
            >
              {agent.name}
            </span>
            {isLeader ? (
              <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-warning">
                {t('activity:fleet.leader')}
              </span>
            ) : null}
            <span className="shrink-0 text-[9px] text-muted-foreground">{t(status.labelKey)}</span>
          </span>
          <span
            className={cn(
              'mt-0.5 block min-w-0 break-words font-mono text-[10px] leading-tight [overflow-wrap:anywhere]',
              route ? 'text-muted-foreground' : 'italic text-muted-foreground/70',
            )}
            title={route}
          >
            {agent.provider === 'acp' ? (
              <AgentRuntimeBadge
                provider={agent.provider}
                model={agent.model}
                executionRole={isLeader ? 'leader' : 'subagent'}
              />
            ) : (
              (route ?? t('activity:agents.pending'))
            )}
          </span>
        </span>
      </div>
    );
  };

  return (
    <div role="tree" aria-label={ariaLabel} className={cn('min-w-0 space-y-0.5', className)}>
      {leader ? (
        <div role="none">
          {renderRow(leader, 1, 1, 1)}
          {leaderExpanded && workers.length > 0 ? (
            // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA trees require a role=group container for child treeitems; fieldset is not a tree group.
            <div role="group" className="ml-3 border-l border-border/70 pl-2">
              {workers.map((agent, index) => renderRow(agent, 2, index + 1, workers.length))}
            </div>
          ) : null}
        </div>
      ) : (
        ordered.map((agent, index) => renderRow(agent, 1, index + 1, ordered.length))
      )}
    </div>
  );
}

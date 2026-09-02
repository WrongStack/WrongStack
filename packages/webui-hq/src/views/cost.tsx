/**
 * Cost — where the money went.
 *
 * Two levels, deliberately: projects ranked by spend (the budget question),
 * then the costed sessions inside them (the "which run did this" question).
 * Session rows are clickable and land in the Console with that session
 * selected, because the next question after "what cost this" is always "what
 * was it doing".
 */
import { CircleDollarSign } from 'lucide-react';
import type * as React from 'react';
import { useMemo } from 'react';
import { useHqStore } from '../data/store/index.js';
import {
  HeroMetric,
  Section,
  ShareBar,
  ViewHero,
  ViewShell,
} from '../components/hq/view-chrome.js';
import { EmptyState, Mono } from '../components/hq/primitives.js';
import { Badge } from '../components/ui/badge.js';
import { Card } from '../components/ui/card.js';
import { formatCount, formatPercent, formatUsd } from '../lib/format.js';

export function CostView(): React.ReactElement {
  const snapshot = useHqStore((state) => state.snapshot);
  const projects = snapshot?.projects ?? [];
  const sessions = snapshot?.liveSessions ?? [];
  const total = snapshot?.totals.totalCostUsd ?? 0;

  const sessionRows = useMemo(() => {
    return sessions
      .map((session) => {
        let cost = 0;
        let tokens = 0;
        const models = new Set<string>();
        for (const agent of session.agents) {
          cost += agent.costUsd ?? 0;
          tokens += (agent.tokensIn ?? 0) + (agent.tokensOut ?? 0);
          if (agent.model !== undefined) models.add(agent.model);
        }
        return { session, cost, tokens, models: [...models] };
      })
      .filter((row) => row.cost > 0 || row.tokens > 0)
      .sort((left, right) => right.cost - left.cost);
  }, [sessions]);

  if (projects.length === 0) {
    return (
      <ViewShell>
        <EmptyState
          icon={CircleDollarSign}
          title="No cost data yet"
          hint="Cost appears once a client connects and starts spending tokens."
        />
      </ViewShell>
    );
  }

  const ranked = [...projects].sort((left, right) => right.totalCostUsd - left.totalCostUsd);
  const leader = ranked[0];
  const leaderShare = leader !== undefined && total > 0 ? leader.totalCostUsd / total : 0;
  const totalTokens = sessionRows.reduce((sum, row) => sum + row.tokens, 0);

  return (
    <ViewShell>
      <ViewHero
        eyebrow="Economics"
        headline={formatUsd(total)}
        description="Fleet spend, ranked by project and drilled into the sessions and models that produced it."
        // A single project past 60% of fleet spend is worth a second look —
        // usually a runaway loop rather than a deliberate concentration.
        tone={leaderShare > 0.6 ? 'warn' : undefined}
        metrics={
          <>
            <HeroMetric label="projects" value={projects.length} />
            <HeroMetric label="costed sessions" value={sessionRows.length} />
            <HeroMetric label="tokens" value={formatCount(totalTokens)} />
            <HeroMetric
              label="top share"
              value={formatPercent(leaderShare)}
              tone={leaderShare > 0.6 ? 'warn' : 'idle'}
            />
          </>
        }
      />

      <Section
        eyebrow="Spend distribution"
        title="By project"
        action={leader !== undefined && <Badge tone="info">leader: {leader.projectName}</Badge>}
      >
        <div className="space-y-2">
          {ranked.map((project, index) => {
            const share = total > 0 ? project.totalCostUsd / total : 0;
            return (
              <Card key={project.projectId} className="flex-row items-stretch">
                <div className="tabular flex w-10 shrink-0 items-center justify-center border-r border-border text-xs text-muted-foreground">
                  #{index + 1}
                </div>
                <div className="min-w-0 flex-1 space-y-1.5 p-3">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-sm font-medium">{project.projectName}</span>
                    <Mono title={project.projectId}>{project.projectId}</Mono>
                    <span className="tabular ml-auto text-sm font-semibold">
                      {formatUsd(project.totalCostUsd)}
                    </span>
                    <Mono className="tabular w-12 text-right">{formatPercent(share, 1)}</Mono>
                  </div>
                  <ShareBar fraction={share} />
                  <div className="flex flex-wrap gap-1.5">
                    <Badge tone="info">{project.activeSessions} sessions</Badge>
                    <Badge tone="active">{project.activeSubagents} subagents</Badge>
                    <Badge tone="idle">{project.activeClients} clients</Badge>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      </Section>

      {sessionRows.length > 0 && (
        <Section
          eyebrow="Drilldown"
          title="By session"
          action={<Mono>{sessionRows.length} costed</Mono>}
        >
          <Card className="divide-y divide-border">
            {sessionRows.map(({ session, cost, tokens, models }) => (
              <button
                key={session.sessionId}
                type="button"
                data-testid="cost-session-row"
                title="Open in Console"
                onClick={() => {
                  useHqStore.getState().selectSession(session.sessionId);
                  useHqStore.getState().setActiveView('console');
                }}
                className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/50"
              >
                <span className="font-medium">{session.projectName}</span>
                <Badge tone="idle">{session.clientKind}</Badge>
                {models.map((model) => (
                  <Badge key={model} tone="info">
                    {model}
                  </Badge>
                ))}
                <Mono className="tabular ml-auto">{formatCount(tokens)} tok</Mono>
                <span className="tabular w-20 text-right font-semibold">{formatUsd(cost)}</span>
              </button>
            ))}
          </Card>
        </Section>
      )}
    </ViewShell>
  );
}

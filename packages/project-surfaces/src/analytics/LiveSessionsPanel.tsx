import { Activity } from 'lucide-react';
import { displayLocale, useAppTranslation } from '../lib/i18n';

/** One agent of a live session, as the session registry reports it. */
export interface LiveSessionAgent {
  id: string;
  name: string;
  status: string;
  currentTool?: string;
  iterations: number;
  toolCalls: number;
  lastActivityAt: string;
}

/** A live session of the project, as the session registry reports it. */
export interface LiveSessionRow {
  sessionId: string;
  projectName: string;
  status: string;
  pid: number;
  startedAt: string;
  agents: LiveSessionAgent[];
}

const time = (iso: string) =>
  Number.isFinite(Date.parse(iso))
    ? new Date(iso).toLocaleTimeString(displayLocale(), { hour: '2-digit', minute: '2-digit' })
    : '';

/**
 * Every live session of the project with its agents: what each is doing, its tool calls and
 * iterations. For a host whose own engine runs no conversation (the desktop's project engine),
 * this is the analytics that is real; the engine's own session would read as zero everywhere.
 */
export function LiveSessionsPanel({ sessions }: { sessions: readonly LiveSessionRow[] }) {
  const { t } = useAppTranslation();
  return (
    <div className="ws-panel rounded-xl border border-border/70 bg-card/75 p-4 shadow-sm">
      <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
        <Activity className="h-3.5 w-3.5 text-primary" />
        {t('activity:analytics.liveSessions')}
      </h2>
      {sessions.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('activity:analytics.noLiveSessions')}</p>
      ) : (
        <div className="space-y-3">
          {sessions.map((session) => (
            <section key={session.sessionId} className="rounded-lg border border-border/60 p-3">
              <header className="mb-2 flex min-w-0 items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate font-mono text-foreground">
                  {session.sessionId}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {session.status} · {time(session.startedAt)}
                </span>
              </header>
              <ul className="space-y-1">
                {session.agents.map((agent) => (
                  <li
                    key={agent.id}
                    className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] items-center gap-3 text-xs"
                  >
                    <span className="min-w-0 truncate text-foreground">
                      <span
                        className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${agent.status === 'running' ? 'bg-success' : 'bg-muted-foreground/50'}`}
                      />
                      {agent.name}
                    </span>
                    <span className="min-w-0 truncate font-mono text-muted-foreground">
                      {agent.currentTool ?? agent.status}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {t('activity:analytics.toolCalls')}: {agent.toolCalls} ·{' '}
                      {t('activity:analytics.iterationsSub', { count: agent.iterations })}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

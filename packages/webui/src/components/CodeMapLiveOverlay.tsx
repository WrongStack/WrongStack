import { ExternalLink, Pause, Play, Radio, ShieldCheck, Target } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FileActivity, LiveAgentPresence } from '@/stores/codemap-activity-store';
import { agentColor, agentInitials, shortPath } from './CodeMapVisuals';
import { useAppTranslation } from '@/i18n';

function OperationBadge({ activity }: { activity: FileActivity }): React.ReactElement {
  return (
    <span
      className={cn(
        'shrink-0 border px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase',
        activity.type === 'delete'
          ? 'border-destructive/50 bg-destructive/10 text-destructive'
          : activity.type === 'read'
            ? 'border-info/50 bg-info/10 text-info'
            : activity.type === 'search' || activity.type === 'index'
              ? 'border-primary/50 bg-primary/10 text-primary'
              : 'border-warning/50 bg-warning/10 text-warning',
      )}
    >
      {activity.filePath.startsWith('(tool:') ? activity.toolName : activity.type}
    </span>
  );
}

export function LiveOperationRow({
  activity,
  onLocate,
  showAgent = false,
}: {
  activity: FileActivity;
  onLocate: (activity: FileActivity) => void;
  showAgent?: boolean;
}): React.ReactElement {
  const { t } = useAppTranslation();
  const name = activity.agentName ?? activity.agent ?? 'External process';
  const key = `${activity.sessionId ?? 'none'}:${activity.agentId ?? name}`;
  return (
    <button
      type="button"
      className="group flex w-full items-start gap-2 border-b px-3 py-2 text-left last:border-b-0 hover:bg-muted/70"
      onClick={() => !activity.filePath.startsWith('(') && onLocate(activity)}
      title={`Locate ${activity.filePath}`}
    >
      {showAgent && (
        <span
          className={cn(
            'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center font-mono text-[8px] font-black',
            agentColor(key),
          )}
        >
          {agentInitials(name)}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <OperationBadge activity={activity} />
          {showAgent && <span className="truncate text-[9px] font-semibold">{name}</span>}
          {activity.status === 'active' && (
            <span className="ml-auto flex items-center gap-1 font-mono text-[8px] font-bold text-success">
              <span className="h-1.5 w-1.5 animate-pulse bg-success" /> {t('activity:codeMap.live')}
            </span>
          )}
          {activity.watcherConfirmed && (
            <ShieldCheck
              className="ml-auto h-3 w-3 text-success"
              aria-label={t('activity:codeMap.filesystemConfirmed')}
            />
          )}
          {activity.attribution === 'correlated' && !activity.watcherConfirmed && (
            <span
              className="ml-auto font-mono text-[7px] uppercase text-warning"
              title={t('activity:codeMap.correlatedFromTheOnlyActiveTool')}
            >
              {t('activity:codeMap.correlated')}
            </span>
          )}
          {activity.attribution === 'external' && (
            <span className="ml-auto font-mono text-[7px] uppercase text-destructive">
              external
            </span>
          )}
        </div>
        <div className="mt-1 truncate font-mono text-[9px] font-semibold" title={activity.filePath}>
          {shortPath(activity.filePath)}
        </div>
        {(activity.symbol || activity.line) && (
          <div className="mt-0.5 flex items-center gap-1 truncate font-mono text-[8px] text-success">
            <Target className="h-2.5 w-2.5 shrink-0" />
            {activity.symbol?.name ?? `line ${activity.line}`}
            {activity.symbol?.kind && (
              <span className="text-muted-foreground">· {activity.symbol.kind}</span>
            )}
          </div>
        )}
        {activity.change && (
          <div className="mt-1 flex items-center gap-1 font-mono text-[8px]">
            <span className="border border-success/40 bg-success/10 px-1 text-success">
              +{activity.change.added}
            </span>
            <span className="border border-destructive/40 bg-destructive/10 px-1 text-destructive">
              −{activity.change.removed}
            </span>
            {activity.durationMs !== undefined && (
              <span className="ml-auto text-muted-foreground">{activity.durationMs}ms</span>
            )}
          </div>
        )}
        {activity.summary && activity.summary !== activity.toolName && (
          <div className="mt-1 line-clamp-2 text-[8px] leading-3 text-muted-foreground">
            {activity.summary}
          </div>
        )}
      </div>
      {!activity.filePath.startsWith('(') && (
        <ExternalLink className="mt-1 h-3 w-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
      )}
    </button>
  );
}

export function LiveAgentsHud({
  presences,
  onLocate,
}: {
  presences: LiveAgentPresence[];
  onLocate: (activity: FileActivity) => void;
}): React.ReactElement | null {
  const { t } = useAppTranslation();
  if (presences.length === 0) return null;
  return (
    <section className="pointer-events-auto absolute left-3 top-14 z-20 w-[304px] border bg-card/95 shadow-xl backdrop-blur">
      <div className="flex h-9 items-center gap-2 border-b px-3">
        <Radio className="h-3.5 w-3.5 animate-pulse text-success" />
        <h2 className="text-[9px] font-black uppercase tracking-[0.18em]">{t('activity:codeMap.liveAgentOperations')}</h2>
        <span className="ml-auto bg-success px-1.5 py-0.5 font-mono text-[8px] font-bold text-success-foreground">
          {presences.length} ONLINE
        </span>
      </div>
      <div className="max-h-[330px] overflow-y-auto">
        {presences.map((presence) => (
          <div key={presence.key} className="border-b last:border-b-0">
            <div className="flex items-center gap-2 bg-muted/35 px-3 py-1.5">
              <span
                className={cn(
                  'flex h-6 w-6 items-center justify-center font-mono text-[8px] font-black',
                  agentColor(presence.key),
                )}
              >
                {agentInitials(presence.agentName)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[9px] font-bold">{presence.agentName}</div>
                <div className="truncate font-mono text-[7px] text-muted-foreground">
                  session {presence.sessionId.slice(0, 12)} · agent {presence.agentId.slice(0, 12)}
                </div>
              </div>
              <span className="font-mono text-[8px] text-success">
                {presence.operations.length} op
              </span>
            </div>
            {presence.operations.map((activity) => (
              <LiveOperationRow
                key={activity.id ?? `${activity.toolUseId}:${activity.filePath}`}
                activity={activity}
                onLocate={onLocate}
              />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

export function LiveControlBar({
  paused,
  followLive,
  agentFilter,
  agents,
  onTogglePaused,
  onToggleFollow,
  onAgentFilter,
}: {
  paused: boolean;
  followLive: boolean;
  agentFilter: string;
  agents: LiveAgentPresence[];
  onTogglePaused: () => void;
  onToggleFollow: () => void;
  onAgentFilter: (key: string) => void;
}): React.ReactElement {
  const { t } = useAppTranslation();
  return (
    <div className="pointer-events-auto absolute right-3 top-14 z-20 flex h-9 items-center border bg-card/95 shadow-lg backdrop-blur">
      <button
        type="button"
        className={cn(
          'flex h-full items-center gap-1.5 border-r px-2.5 text-[8px] font-bold uppercase tracking-wider',
          followLive
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:bg-muted',
        )}
        onClick={onToggleFollow}
        title={t('activity:codeMap.automaticallyEnterTheFileFunctionUsedByTheNewestVisibleAgent')}
      >
        <Target className="h-3 w-3" /> {t('activity:codeMap.follow')}
      </button>
      <button
        type="button"
        className={cn(
          'flex h-full items-center gap-1.5 border-r px-2.5 text-[8px] font-bold uppercase tracking-wider',
          paused ? 'bg-warning text-warning-foreground' : 'text-success hover:bg-success/10',
        )}
        onClick={onTogglePaused}
        title={paused ? 'Resume the live telemetry stream' : 'Freeze the current telemetry frame'}
      >
        {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
        {paused ? 'Resume' : 'Live'}
      </button>
      <label className="flex h-full items-center gap-1.5 px-2 text-[8px] uppercase text-muted-foreground">
        {t('activity:codeMap.agent')}
        <select
          aria-label={t('activity:codeMap.filterCodemapByAgentAndSession')}
          className="h-6 max-w-[170px] border bg-background px-1.5 font-mono text-[8px] text-foreground outline-none focus:border-primary"
          value={agentFilter}
          onChange={(event) => onAgentFilter(event.target.value)}
        >
          <option value="all">{t('activity:codeMap.allAgents')}</option>
          {agents.map((agent) => (
            <option key={agent.key} value={agent.key}>
              {agent.agentName} · {agent.sessionId.slice(0, 10)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

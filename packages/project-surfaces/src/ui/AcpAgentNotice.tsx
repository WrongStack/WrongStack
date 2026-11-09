import { useAppTranslation } from '../lib/i18n';
import { AgentRuntimeBadge } from './AgentRuntimeBadge';

export function AcpAgentNotice({
  count,
  onShowAgents,
  selected,
}: {
  count: number;
  onShowAgents?: (() => void) | undefined;
  selected?: boolean;
}) {
  const { t } = useAppTranslation();
  if (count === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-primary/20 bg-primary/5 px-3 py-2 text-xs">
      <AgentRuntimeBadge provider="acp" executionRole="agent" showName={false} />
      <span className="min-w-0 flex-1 text-muted-foreground">
        {t('activity:acp.available', {
          defaultValue: 'Installed coding agents can also work as subagents.',
        })}
      </span>
      {onShowAgents ? (
        <button
          type="button"
          aria-pressed={selected}
          onClick={onShowAgents}
          className="shrink-0 rounded-sm border border-primary/35 px-2 py-1 font-medium text-foreground hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        >
          {t('activity:acp.showAgents', { defaultValue: 'Show agents' })} · {count}
        </button>
      ) : (
        <span className="font-mono text-primary">{count}</span>
      )}
    </div>
  );
}

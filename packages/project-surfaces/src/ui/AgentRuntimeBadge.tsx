import { acpAgentName, isAcpProvider } from '@wrongstack/contracts/types/agent-identity';
import { Bot } from 'lucide-react';
import { useAppTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';

/** A visible execution identity, never an availability/verification indicator. */
export function AgentRuntimeBadge({
  provider,
  providerType,
  model,
  executionRole = 'subagent',
  showName = true,
  className,
}: {
  provider?: string | undefined;
  providerType?: string | undefined;
  model?: string | undefined;
  executionRole?: 'agent' | 'subagent' | 'leader';
  showName?: boolean;
  className?: string;
}) {
  const { t } = useAppTranslation();
  if (!isAcpProvider(provider, providerType)) return null;
  const label = t(`activity:acp.${executionRole}`, { defaultValue: `ACP ${executionRole}` });
  return (
    <span
      data-agent-runtime="acp"
      title={`${label} · ${provider ?? 'acp'}/${model ?? ''}`}
      className={cn(
        'inline-flex w-fit min-w-0 max-w-full items-center gap-1 rounded-sm border border-primary/35 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium leading-tight text-foreground',
        className,
      )}
    >
      <Bot aria-hidden="true" className="h-3 w-3 shrink-0 text-primary" />
      <span className="shrink-0">{label}</span>
      {showName && model && <span className="truncate font-semibold">· {acpAgentName(model)}</span>}
    </span>
  );
}

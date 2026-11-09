import { acpAgentName, isAcpProvider } from '@wrongstack/contracts/types/agent-identity';
import { Bot } from 'lucide-react';

export function RuntimeBadge({ provider, model }: { provider?: string; model?: string }) {
  if (!isAcpProvider(provider)) return null;
  return (
    <span
      title={`ACP subagent · ${provider}/${model ?? ''}`}
      data-agent-runtime="acp"
      className="inline-flex max-w-full items-center gap-1 border border-primary/35 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-foreground"
    >
      <Bot aria-hidden className="size-3 shrink-0 text-primary" />
      <span className="shrink-0">ACP</span>
      {model && <span className="truncate">· {acpAgentName(model)}</span>}
    </span>
  );
}

import { ChevronDown, Loader2, Power, PowerOff, Search, Wrench } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { toast } from '@/components/Toaster';
import { useWebSocket } from '@/hooks/useWebSocket';
import type { WSServerMessage } from '@/types';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

export interface ToolInfo {
  name: string;
  owner: string;
  description: string;
  params: string[];
  disabled: boolean;
  mutating: boolean;
  permission: string;
}

/** Small indicator dot for tool status. */
function StatusDot({ disabled, mutating }: { disabled: boolean; mutating: boolean }) {
  const color = disabled
    ? 'bg-muted-foreground'
    : mutating
      ? 'bg-warning'
      : 'bg-success';
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`} title={disabled ? 'disabled' : mutating ? 'mutating' : 'read-only'} />;
}

/** Individual tool row with toggle. */
function ToolRow({
  tool,
  onToggle,
  busy,
}: {
  tool: ToolInfo;
  onToggle: () => void;
  busy: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="space-y-2 rounded-md border border-border/70 bg-card/70 p-3 transition-colors hover:bg-card">
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 items-start gap-2">
        <StatusDot disabled={tool.disabled} mutating={tool.mutating} />
          <div className="min-w-0 flex-1">
            <code className="block truncate text-sm font-mono font-semibold" title={tool.name}>
              {tool.name}
            </code>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className="px-1.5 text-[10px]">
                {tool.permission}
              </Badge>
              <Badge variant="outline" className="px-1.5 text-[10px]">
                {tool.mutating ? 'mutating' : 'read-only'}
              </Badge>
              <span className="truncate text-[11px] text-muted-foreground" title={tool.owner}>
                {tool.owner}
              </span>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-1">
          <Button
            variant={tool.disabled ? 'default' : 'secondary'}
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={onToggle}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : tool.disabled ? (
              <PowerOff className="h-3 w-3" />
            ) : (
              <Power className="h-3 w-3" />
            )}
            {tool.disabled ? 'Enable' : 'Disable'}
          </Button>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={() => setExpanded(!expanded)}
            aria-label={expanded ? 'Collapse' : 'Expand'}
          >
            <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </button>
        </div>
      </div>
      {expanded && (
        <div className="space-y-1 border-t border-border/60 pt-2 text-xs text-muted-foreground sm:ml-4">
          <p>{tool.description}</p>
          {tool.params.length > 0 && (
            <p>Params: <code className="break-all font-mono">{tool.params.join(', ')}</code></p>
          )}
        </div>
      )}
    </div>
  );
}

export function ToolsSection(): ReactElement {
  const { t } = useAppTranslation();
  const { client } = useWebSocket();
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [busyMap, setBusyMap] = useState<Set<string>>(new Set());

  useEffect(() => {
    const offTools = client.on('tools.list', (msg) => {
      const p = msg.payload as { tools: ToolInfo[] };
      setTools(p.tools);
      setLoading(false);
    });
    const handleToggleResponse = (msg: WSServerMessage) => {
      if (msg.type === 'tool.disabled' || msg.type === 'tool.enabled') {
        const p = msg.payload;
        setBusyMap((prev) => {
          const next = new Set(prev);
          next.delete(p.name);
          return next;
        });
        if (p.ok) {
          client.send({ type: 'tools.list' });
        } else {
          toast.error(`Tool "${p.name}" ${msg.type === 'tool.disabled' ? 'disable' : 'enable'} failed.`);
        }
      }
    };
    const offDisabled = client.on('tool.disabled', handleToggleResponse);
    const offEnabled = client.on('tool.enabled', handleToggleResponse);
    return () => {
      offTools();
      offDisabled();
      offEnabled();
    };
  }, [client]);

  // Fetch tools on mount
  useEffect(() => {
    client.send({ type: 'tools.list' });
  }, [client]);

  const handleToggle = useCallback(
    (name: string, currentlyDisabled: boolean) => {
      setBusyMap((prev) => new Set(prev).add(name));
      client.send({
        type: (currentlyDisabled ? 'tool.enable' : 'tool.disable') as ToolToggleMessageType,
        payload: { name },
      });
    },
    [client],
  );

  // Filter tools client-side
  const filtered = filter
    ? tools.filter(
        (t) =>
          t.name.toLowerCase().includes(filter.toLowerCase()) ||
          t.owner.toLowerCase().includes(filter.toLowerCase()),
      )
    : tools;

  const activeCount = tools.filter((t) => !t.disabled).length;
  const disabledCount = tools.filter((t) => t.disabled).length;

  return (
    <div className="space-y-4">
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-md border border-primary/20 bg-primary/10 text-primary">
          <Wrench className="h-5 w-5" />
        </span>
        <h3 className="text-base font-semibold">Tools</h3>
        </div>
        {!loading && (
          <span className="rounded-md border border-border/60 bg-muted/30 px-2 py-1 text-xs text-muted-foreground sm:ml-auto">
            {activeCount} active · {disabledCount} disabled · {tools.length} total
          </span>
        )}
      </div>

      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Filter tools by name or owner…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="pl-8 h-9 text-sm"
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading tools…
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">
          {filter ? `No tools matching "${filter}".` : 'No tools registered.'}
        </p>
      ) : (
        <div className="relative overflow-hidden rounded-lg border border-border/70 bg-background/35 shadow-inner">
          <div
            className="max-h-[min(58dvh,660px)] space-y-2 overflow-y-scroll p-2 pr-3 [scrollbar-gutter:stable]"
            aria-label="Tools list"
          >
            {filtered.map((tool) => (
              <ToolRow
                key={tool.name}
                tool={tool}
                onToggle={() => handleToggle(tool.name, tool.disabled)}
                busy={busyMap.has(tool.name)}
              />
            ))}
          </div>
          <div className="pointer-events-none absolute inset-x-0 top-0 h-4 bg-gradient-to-b from-background/90 to-transparent" />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-background/95 to-transparent" />
        </div>
      )}
    </div>
  );
}

type ToolToggleMessageType = 'tool.enable' | 'tool.disable';

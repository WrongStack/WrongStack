import { Loader2, Power, PowerOff, Search, Wrench } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
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
    ? 'bg-gray-400'
    : mutating
      ? 'bg-yellow-400'
      : 'bg-green-500';
  return <span className={`inline-block w-2 h-2 rounded-full ${color}`} title={disabled ? 'disabled' : mutating ? 'mutating' : 'read-only'} />;
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
    <div className="border rounded-lg p-3 space-y-1">
      <div className="flex items-center gap-2">
        <StatusDot disabled={tool.disabled} mutating={tool.mutating} />
        <code className="text-sm font-mono font-semibold flex-1">{tool.name}</code>
        <Badge variant="outline" className="text-[10px] px-1.5">
          {tool.permission}
        </Badge>
        <Badge variant="outline" className="text-[10px] px-1.5">
          {tool.mutating ? 'mut' : 'ro'}
        </Badge>
        <span className="text-[11px] text-muted-foreground">[{tool.owner}]</span>
        <Button
          variant={tool.disabled ? 'default' : 'secondary'}
          size="sm"
          className="h-7 px-2 text-xs gap-1"
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
          className="text-muted-foreground hover:text-foreground p-0.5"
          onClick={() => setExpanded(!expanded)}
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          <Chevron className={expanded ? 'rotate-180' : ''} />
        </button>
      </div>
      {expanded && (
        <div className="text-xs text-muted-foreground pl-6 pt-1 space-y-0.5">
          <p>{tool.description}</p>
          {tool.params.length > 0 && (
            <p>Params: <code className="font-mono">{tool.params.join(', ')}</code></p>
          )}
        </div>
      )}
    </div>
  );
}

function Chevron({ className = '' }: { className?: string }) {
  return (
    <svg
      className={`h-4 w-4 transition-transform ${className}`}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function ToolsSection(): ReactElement {
  const { t } = useAppTranslation();
  const { client } = useWebSocket();
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [busyMap, setBusyMap] = useState<Set<string>>(new Set());

  // Listen for tool list and enable/disable responses
  useEffect(() => {
    const handler = (msg: WSServerMessage) => {
      if (msg.type === 'tools.list') {
        const p = msg.payload as { tools: ToolInfo[] };
        setTools(p.tools);
        setLoading(false);
      } else if (msg.type === 'tool.disabled' || msg.type === 'tool.enabled') {
        const p = msg.payload as { name: string; ok: boolean };
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
    client.on('message', handler);
    return () => client.off('message', handler);
  }, [client]);

  // Fetch tools on mount
  useEffect(() => {
    client.send({ type: 'tools.list' });
  }, [client]);

  const handleToggle = useCallback(
    (name: string, currentlyDisabled: boolean) => {
      setBusyMap((prev) => new Set(prev).add(name));
      client.send({
        type: (currentlyDisabled ? 'tool.enable' : 'tool.disable') as WSMessageType,
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
      <div className="flex items-center gap-2">
        <Wrench className="h-5 w-5 text-primary" />
        <h3 className="text-lg font-semibold">Tools</h3>
        {!loading && (
          <span className="text-xs text-muted-foreground ml-auto">
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
        <div className="space-y-2 max-h-[500px] overflow-y-auto pr-1">
          {filtered.map((tool) => (
            <ToolRow
              key={tool.name}
              tool={tool}
              onToggle={() => handleToggle(tool.name, tool.disabled)}
              busy={busyMap.has(tool.name)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type WSMessageType = 'tools.list' | 'tool.enable' | 'tool.disable';

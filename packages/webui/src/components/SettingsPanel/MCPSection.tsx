import {
  Check,
  ChevronDown,
  ChevronRight,
  Edit3,
  Loader2,
  Moon,
  Plus,
  Search,
  Server,
  Star,
  Sun,
  Trash2,
} from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { toast } from '@/components/Toaster';
import { useWebSocket } from '@/hooks/useWebSocket';
import { i18n, useAppTranslation } from '@/i18n';
import type { WSServerMessage } from '@/types';
import { confirmModal } from '../ConfirmModal';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { OFFICIAL_SERVERS, type OfficialServer, toServerConfig } from './official-servers';

export interface MCPServer {
  name: string;
  transport: string;
  status: 'stopped' | 'connecting' | 'connected' | 'sleeping' | 'discovering' | 'error';
  enabled: boolean;
  description?: string;
  tools?: string[];
  error?: string;
  lastError?: string;
  pid?: number;
  lazy?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  health?: {
    healthState: 'disabled' | 'dormant' | 'connecting' | 'healthy' | 'degraded' | 'failed';
    consecutiveFailures: number;
    failures: { transport: number; protocol: number; tool: number };
    reconnectCount: number;
    wakeCount: number;
    sleepCount: number;
    restartCount: number;
    inFlightCalls: number;
    peakInFlightCalls: number;
    callLatency: { count: number; lastMs?: number; p50Ms?: number; p95Ms?: number };
  };
}

import type { MCPServerConfig } from './contracts.js';

export type { MCPServerConfig };

/** Map server status to a human-readable label and color */
function statusInfo(status: MCPServer['status']): { color: string } {
  switch (status) {
    case 'connected':
      return { color: 'bg-success' };
    case 'connecting':
      return { color: 'bg-warning animate-pulse' };
    case 'sleeping':
      return { color: 'bg-info' };
    case 'discovering':
      return { color: 'bg-primary animate-pulse' };
    case 'error':
      return { color: 'bg-destructive' };
    case 'stopped':
      return { color: 'bg-muted-foreground' };
    default:
      return { color: 'bg-muted-foreground/70' };
  }
}

/** Small colored dot for status indication */
function StatusDot({ status }: { status: MCPServer['status'] }) {
  const { color } = statusInfo(status);
  return <span className={`inline-block w-2 h-2 rounded-full ${color}`} />;
}

/** Expandable server card */
function ServerCard({
  server,
  onWake,
  onSleep,
  onDiscover,
  onEdit,
  onRemove,
}: {
  server: MCPServer;
  onWake: () => void;
  onSleep: () => void;
  onDiscover: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { color } = statusInfo(server.status);
  const { t } = useAppTranslation();

  return (
    <div className="rounded-md border border-border/70 bg-card/70 p-3 transition-colors hover:bg-card">
      <div className="flex items-center justify-between">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
          <StatusDot status={server.status} />
          <span className="min-w-0 truncate font-medium">{server.name}</span>
          <span className="rounded bg-muted/60 px-1.5 py-0.5 text-xs text-muted-foreground">
            {server.transport}
          </span>
          {!server.enabled && (
            <Badge variant="outline" className="text-xs">
              {t('settings:mcp.disabled')}
            </Badge>
          )}
        </button>
        <div className="flex items-center gap-1">
          {server.status === 'sleeping' && (
            <Button variant="ghost" size="sm" onClick={onWake} title={t('settings:mcp.wakeTitle')}>
              <Sun className="w-4 h-4" />
            </Button>
          )}
          {(server.status === 'connected' || server.status === 'connecting') && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onSleep}
              title={t('settings:mcp.sleepTitle')}
            >
              <Moon className="w-4 h-4" />
            </Button>
          )}
          {(server.status === 'stopped' || server.status === 'sleeping') && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onDiscover}
              title={t('settings:mcp.discoverTitle')}
            >
              <Search className="w-4 h-4" />
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onEdit} title={t('settings:mcp.editTitle')}>
            <Edit3 className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRemove}
            title={t('settings:mcp.removeTitle')}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="mt-3 space-y-2 border-t border-border/60 pl-6 pt-3 text-sm">
          <div className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
            <span className="text-muted-foreground">{t('settings:mcp.statusLabel')}</span>
            <span className="flex items-center gap-1">
              <span className={`inline-block w-2 h-2 rounded-full ${color}`} />
              {t(`settings:mcp.status.${server.status}`, { defaultValue: server.status })}
            </span>
            <span className="text-muted-foreground">{t('settings:mcp.enabledLabel')}</span>
            <span>{server.enabled ? t('settings:mcp.yes') : t('settings:mcp.no')}</span>
            {server.description && (
              <>
                <span className="text-muted-foreground">{t('settings:mcp.descriptionLabel')}</span>
                <span>{server.description}</span>
              </>
            )}
            {server.pid && (
              <>
                <span className="text-muted-foreground">{t('settings:mcp.pidLabel')}</span>
                <span>{server.pid}</span>
              </>
            )}
            {server.error && (
              <>
                <span className="text-muted-foreground">{t('settings:mcp.errorLabel')}</span>
                <span className="text-destructive">{server.error}</span>
              </>
            )}
            {server.health && (
              <>
                <span className="text-muted-foreground">
                  {t('activity:mCPSection.operationalHealth')}
                </span>
                <span>{server.health.healthState}</span>
                <span className="text-muted-foreground">
                  {t('activity:mCPSection.failuresTransportProtocolTool')}
                </span>
                <span>
                  {server.health.failures.transport}/{server.health.failures.protocol}/
                  {server.health.failures.tool}
                </span>
                <span className="text-muted-foreground">
                  {t('activity:mCPSection.callLatencyP50P95')}
                </span>
                <span>
                  {server.health.callLatency.p50Ms ?? '-'}ms /{' '}
                  {server.health.callLatency.p95Ms ?? '-'}ms
                </span>
                <span className="text-muted-foreground">
                  {t('activity:mCPSection.reconnectWakeSleep')}
                </span>
                <span>
                  {server.health.reconnectCount} / {server.health.wakeCount} /{' '}
                  {server.health.sleepCount}
                </span>
                <span className="text-muted-foreground">
                  {t('activity:mCPSection.callsInFlightPeak')}
                </span>
                <span>
                  {server.health.inFlightCalls} / {server.health.peakInFlightCalls}
                </span>
              </>
            )}
          </div>
          {server.tools && server.tools.length > 0 && (
            <div>
              <span className="text-muted-foreground">
                {t('settings:mcp.toolsLabel', { count: server.tools.length })}
              </span>
              <div className="flex flex-wrap gap-1 mt-1">
                {server.tools.map((tool) => (
                  <Badge key={tool} variant="secondary" className="text-xs">
                    {tool}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {(!server.tools || server.tools.length === 0) && server.status === 'connected' && (
            <span className="text-muted-foreground">{t('settings:mcp.noTools')}</span>
          )}
        </div>
      )}
    </div>
  );
}

/** Edit/Add Server Dialog */
function ServerDialog({
  open,
  onOpenChange,
  server,
  onSave,
  prefillConfig,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  server?: MCPServer;
  prefillConfig?: MCPServerConfig;
  onSave: (config: MCPServerConfig) => void;
}) {
  const { t } = useAppTranslation();
  const [name, setName] = useState(server?.name ?? prefillConfig?.name ?? '');
  const [transport, setTransport] = useState(
    server?.transport ?? prefillConfig?.transport ?? 'stdio',
  );
  const [description, setDescription] = useState(
    server?.description ?? prefillConfig?.description ?? '',
  );
  const [command, setCommand] = useState(prefillConfig?.command ?? '');
  const [args, setArgs] = useState(prefillConfig?.args?.join(' ') ?? '');
  const [env, setEnv] = useState('');
  const [url, setUrl] = useState(prefillConfig?.url ?? '');
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [lazy, setLazy] = useState(server?.lazy ?? prefillConfig?.lazy ?? false);

  // Reset form when dialog opens with new prefill data
  useEffect(() => {
    if (open) {
      if (server) {
        setName(server.name);
        setTransport(server.transport);
        setDescription(server.description ?? '');
        setEnabled(server.enabled);
        setLazy(server.lazy ?? false);
        setCommand(server.command ?? '');
        setArgs(server.args?.join(' ') ?? '');
        setEnv(
          server.env
            ? Object.entries(server.env)
                .map(([k, v]) => `${k}=${v}`)
                .join('\n')
            : '',
        );
        setUrl(server.url ?? '');
      } else if (prefillConfig) {
        setName(prefillConfig.name);
        setTransport(prefillConfig.transport);
        setDescription(prefillConfig.description ?? '');
        setEnabled(true);
        setLazy(prefillConfig.lazy ?? false);
        setCommand(prefillConfig.command ?? '');
        setArgs(prefillConfig.args?.join(' ') ?? '');
        setEnv(
          prefillConfig.env
            ? Object.entries(prefillConfig.env)
                .map(([k, v]) => `${k}=${v}`)
                .join('\n')
            : '',
        );
        setUrl(prefillConfig.url ?? '');
      } else {
        setName('');
        setTransport('stdio');
        setDescription('');
        setEnabled(true);
        setLazy(false);
        setCommand('');
        setArgs('');
        setEnv('');
        setUrl('');
      }
    }
  }, [server, prefillConfig, open]);

  const handleSave = () => {
    if (!name.trim()) {
      toast.error(t('settings:mcp.serverNameRequired'));
      return;
    }
    const parsedEnv: Record<string, string> = {};
    if (env.trim()) {
      for (const line of env.trim().split('\n')) {
        const idx = line.indexOf('=');
        if (idx > 0) {
          parsedEnv[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
      }
    }
    onSave({
      name: name.trim(),
      transport,
      description: description.trim() || undefined,
      enabled,
      command: command.trim() || undefined,
      args: args.trim() ? args.trim().split(/\s+/) : undefined,
      env: Object.keys(parsedEnv).length > 0 ? parsedEnv : undefined,
      url: url.trim() || undefined,
      lazy,
    });
    onOpenChange(false);
  };

  const isEdit = !!server;
  const isPrefill = !!prefillConfig;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t('settings:mcp.dialogTitleEdit')
              : isPrefill
                ? t('settings:mcp.dialogTitleAdd')
                : t('settings:mcp.dialogTitleAddCustom')}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <span className="text-sm font-medium">{t('settings:mcp.fieldName')}</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('settings:mcp.fieldNamePlaceholder')}
              disabled={isEdit || isPrefill}
            />
          </div>
          <div className="space-y-2">
            <span className="text-sm font-medium">{t('settings:mcp.fieldTransport')}</span>
            <select
              className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
              value={transport}
              onChange={(e) => setTransport(e.target.value)}
              disabled={isPrefill}
            >
              <option value="stdio">stdio</option>
              <option value="sse">sse</option>
              <option value="streamable-http">streamable-http</option>
              <option value="http">http</option>
            </select>
          </div>
          {(transport === 'streamable-http' || transport === 'sse' || transport === 'http') && (
            <div className="space-y-2">
              <span className="text-sm font-medium">{t('settings:mcp.fieldUrl')}</span>
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={t('activity:mCPSection.httpsMcpExampleComMcp')}
                disabled={isPrefill}
              />
            </div>
          )}
          {transport === 'stdio' && (
            <>
              <div className="space-y-2">
                <span className="text-sm font-medium">{t('settings:mcp.fieldCommand')}</span>
                <Input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder={t('settings:mcp.fieldCommandPlaceholder')}
                  disabled={isPrefill}
                />
              </div>
              <div className="space-y-2">
                <span className="text-sm font-medium">
                  {t('settings:mcp.fieldArgs')}{' '}
                  <span className="text-muted-foreground font-normal">
                    {t('settings:mcp.fieldArgsHint')}
                  </span>
                </span>
                <Input
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  placeholder={t('settings:mcp.fieldArgsPlaceholder')}
                  disabled={isPrefill}
                />
              </div>
            </>
          )}
          <div className="space-y-2">
            <span className="text-sm font-medium">
              {t('settings:mcp.fieldEnv')}{' '}
              <span className="text-muted-foreground font-normal">
                {t('settings:mcp.fieldEnvHint')}
              </span>
            </span>
            <textarea
              className="w-full h-20 px-3 py-2 rounded-md border border-input bg-background text-sm font-mono resize-none"
              value={env}
              onChange={(e) => setEnv(e.target.value)}
              placeholder={`GITHUB_TOKEN=ghp_...\nAWS_REGION=us-east-1`}
              // Env stays editable even for a prefilled official server — this is
              // where the user pastes the credentials it requires before enabling.
            />
          </div>
          <div className="space-y-2">
            <span className="text-sm font-medium">{t('settings:mcp.fieldDescription')}</span>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('settings:mcp.fieldDescriptionPlaceholder')}
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="server-enabled"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="rounded"
            />
            <label htmlFor="server-enabled" className="text-sm">
              {t('settings:mcp.enableServer')}
            </label>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="server-lazy"
              checked={lazy}
              onChange={(e) => setLazy(e.target.checked)}
              className="rounded"
            />
            <label htmlFor="server-lazy" className="text-sm">
              {t('settings:mcp.lazyConnect')}{' '}
              <span className="text-muted-foreground font-normal">
                {t('settings:mcp.lazyConnectHint')}
              </span>
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common:action.cancel')}
          </Button>
          <Button onClick={handleSave}>
            {isEdit ? t('settings:mcp.saveChanges') : t('settings:mcp.addServer')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Official/recommended server card */
function OfficialServerCard({
  server,
  isAdded,
  onAdd,
}: {
  server: OfficialServer;
  isAdded: boolean;
  onAdd: () => void;
}) {
  const { t } = useAppTranslation();
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-border/70 bg-card/70 p-3 transition-colors hover:bg-card">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">{server.name}</span>
          {server.badge && (
            <Badge variant="secondary" className="text-xs shrink-0">
              {server.badge}
            </Badge>
          )}
          <Badge variant="outline" className="text-xs shrink-0">
            {server.transport}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground mt-1">{server.description}</p>
        {server.requiresEnvVars && server.requiresEnvVars.length > 0 && (
          <p className="mt-1 text-xs text-warning">
            {t('settings:mcp.requires', { vars: server.requiresEnvVars.join(', ') })}
          </p>
        )}
      </div>
      <div className="shrink-0">
        {isAdded ? (
          <Button variant="ghost" size="sm" disabled>
            <Check className="w-4 h-4 mr-1" />
            {t('settings:mcp.added')}
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={onAdd}>
            <Plus className="w-4 h-4 mr-1" />
            {t('common:action.add')}
          </Button>
        )}
      </div>
    </div>
  );
}

export function MCPSection(): ReactElement {
  const ws = useWebSocket();
  const { t } = useAppTranslation();
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'list' | 'add' | 'recommended'>('list');
  const [editServer, setEditServer] = useState<MCPServer | undefined>();
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [prefillConfig, setPrefillConfig] = useState<MCPServerConfig | undefined>();
  const [_pendingOp, setPendingOp] = useState<string | null>(null);

  // Load server list on mount and when MCP events come in
  useEffect(() => {
    if (!ws.client) return;

    const handleMcpList = (msg: WSServerMessage) => {
      if (msg.type === 'mcp.list') {
        const p = msg.payload as { servers: MCPServer[] };
        setServers(p.servers ?? []);
        setLoading(false);
      }
    };

    const handleMcpServerAdded = (msg: WSServerMessage) => {
      if (msg.type === 'mcp.server.added') {
        const p = msg.payload as { server: MCPServer };
        setServers((prev) => [...prev.filter((s) => s.name !== p.server.name), p.server]);
        toast.success(i18n.t('settings:mcp.toastAdded', { name: p.server.name }));
      }
    };

    const handleMcpServerRemoved = (msg: WSServerMessage) => {
      if (msg.type === 'mcp.server.removed') {
        const p = msg.payload as { name: string };
        setServers((prev) => prev.filter((s) => s.name !== p.name));
        toast.success(i18n.t('settings:mcp.toastRemoved', { name: p.name }));
      }
    };

    const handleMcpServerUpdated = (msg: WSServerMessage) => {
      if (msg.type === 'mcp.server.updated') {
        const p = msg.payload as { server: MCPServer };
        setServers((prev) => prev.map((s) => (s.name === p.server.name ? p.server : s)));
      }
    };

    const handleMcpServerDiscovered = (msg: WSServerMessage) => {
      if (msg.type === 'mcp.server.discovered') {
        const p = msg.payload as { name: string; tools: string[] };
        setServers((prev) =>
          prev.map((s) =>
            s.name === p.name ? { ...s, status: 'sleeping' as const, tools: p.tools } : s,
          ),
        );
        setPendingOp(null);
        toast.success(
          i18n.t('settings:mcp.toastDiscovered', { count: p.tools.length, name: p.name }),
        );
      }
    };

    const handleMcpServerSleeping = (msg: WSServerMessage) => {
      if (msg.type === 'mcp.server.sleeping') {
        const p = msg.payload as { name: string };
        setServers((prev) =>
          prev.map((s) => (s.name === p.name ? { ...s, status: 'sleeping' as const } : s)),
        );
        setPendingOp(null);
        toast.info(i18n.t('settings:mcp.toastSleeping', { name: p.name }));
      }
    };

    const handleMcpServerWaking = (msg: WSServerMessage) => {
      if (msg.type === 'mcp.server.waking') {
        const p = msg.payload as { name: string };
        setServers((prev) =>
          prev.map((s) => (s.name === p.name ? { ...s, status: 'connecting' as const } : s)),
        );
      }
    };

    const handleMcpServerConnected = (msg: WSServerMessage) => {
      if (msg.type === 'mcp.server.connected') {
        const p = msg.payload as { name: string; pid?: number; toolCount?: number };
        setServers((prev) =>
          prev.map((s) =>
            s.name === p.name
              ? { ...s, status: 'connected', pid: p.pid, error: undefined, lastError: undefined }
              : s,
          ),
        );
        setPendingOp(null);
        toast.success(i18n.t('settings:mcp.toastConnected', { name: p.name }));
      }
    };

    const handleMcpServerReconnected = (msg: WSServerMessage) => {
      if (msg.type === 'mcp.server.reconnected') {
        const p = msg.payload as { name: string; toolCount?: number };
        setServers((prev) =>
          prev.map((s) =>
            s.name === p.name
              ? { ...s, status: 'connected', error: undefined, lastError: undefined }
              : s,
          ),
        );
        setPendingOp(null);
        toast.success(i18n.t('settings:mcp.toastReconnected', { name: p.name }));
      }
    };

    const handleMcpServerDisconnected = (msg: WSServerMessage) => {
      if (msg.type === 'mcp.server.disconnected') {
        const p = msg.payload as { name: string; reason: string };
        setServers((prev) =>
          prev.map((s) =>
            s.name === p.name
              ? { ...s, status: 'error', error: p.reason, lastError: p.reason, pid: undefined }
              : s,
          ),
        );
        setPendingOp(null);
        toast.warn(i18n.t('settings:mcp.toastDisconnected', { name: p.name, reason: p.reason }));
      }
    };

    const handleMcpServerError = (msg: WSServerMessage) => {
      if (msg.type === 'mcp.server.error') {
        const p = msg.payload as { name: string; error: string };
        setServers((prev) =>
          prev.map((s) => (s.name === p.name ? { ...s, status: 'error', error: p.error } : s)),
        );
        setPendingOp(null);
        toast.error(i18n.t('settings:mcp.toastError', { name: p.name, error: p.error }));
      }
    };

    const handleMcpOperationResult = (msg: WSServerMessage) => {
      if (msg.type === 'mcp.operation_result') {
        const p = msg.payload as { success: boolean; message: string };
        if (!p.success) {
          toast.error(p.message);
        }
        setPendingOp(null);
      }
    };

    const off1 = ws.client.on('mcp.list', handleMcpList);
    const off2 = ws.client.on('mcp.server.added', handleMcpServerAdded);
    const off3 = ws.client.on('mcp.server.removed', handleMcpServerRemoved);
    const off4 = ws.client.on('mcp.server.updated', handleMcpServerUpdated);
    const off5 = ws.client.on('mcp.server.discovered', handleMcpServerDiscovered);
    const off6 = ws.client.on('mcp.server.sleeping', handleMcpServerSleeping);
    const off7 = ws.client.on('mcp.server.waking', handleMcpServerWaking);
    const off8 = ws.client.on('mcp.server.connected', handleMcpServerConnected);
    const off9 = ws.client.on('mcp.server.error', handleMcpServerError);
    const off10 = ws.client.on('mcp.operation_result', handleMcpOperationResult);
    const off11 = ws.client.on('mcp.server.reconnected', handleMcpServerReconnected);
    const off12 = ws.client.on('mcp.server.disconnected', handleMcpServerDisconnected);

    setLoading(true);
    ws.client?.listMcpServers();

    return () => {
      off1?.();
      off2?.();
      off3?.();
      off4?.();
      off5?.();
      off6?.();
      off7?.();
      off8?.();
      off9?.();
      off10?.();
      off11?.();
      off12?.();
    };
  }, [ws.client]);

  const handleAddCustom = useCallback(
    (config: MCPServerConfig) => {
      ws.client?.addMcpServer(config);
    },
    [ws],
  );

  const handleAddOfficial = useCallback((official: OfficialServer) => {
    // Open the dialog pre-filled (disabled by default) so the user can add any
    // required credentials/env before the server starts — matches the
    // "click Add to pre-fill, then confirm" promise on the Recommended tab.
    setPrefillConfig(toServerConfig(official, false));
    setShowAddDialog(true);
  }, []);

  const handleRemove = useCallback(
    (name: string) => {
      void confirmModal({
        title: t('settings:mcp.removeConfirmTitle', { name }),
        message: t('settings:mcp.removeConfirmBody'),
        confirmLabel: t('common:action.remove'),
        danger: true,
      }).then((ok) => {
        if (ok) ws.client?.removeMcpServer(name);
      });
    },
    [ws],
  );

  const handleEdit = useCallback((server: MCPServer) => {
    setEditServer(server);
    setPrefillConfig(undefined);
    setShowEditDialog(true);
  }, []);

  const handleSaveEdit = useCallback(
    (config: MCPServerConfig) => {
      ws.client?.updateMcpServer(config);
    },
    [ws],
  );

  const handleWake = useCallback(
    (name: string) => {
      setPendingOp(name);
      ws.client?.wakeMcpServer(name);
    },
    [ws],
  );

  const handleSleep = useCallback(
    (name: string) => {
      setPendingOp(name);
      ws.client?.sleepMcpServer(name);
    },
    [ws],
  );

  const handleDiscover = useCallback(
    (name: string) => {
      setPendingOp(name);
      ws.client?.discoverMcpServer(name);
    },
    [ws],
  );

  const handleRefresh = useCallback(() => {
    setLoading(true);
    ws.client?.listMcpServers();
  }, [ws]);

  const connectedCount = servers.filter((s) => s.status === 'connected').length;
  const sleepingCount = servers.filter((s) => s.status === 'sleeping').length;

  const addedServerNames = new Set(servers.map((s) => s.name));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-md border border-primary/20 bg-primary/10 text-primary">
            <Server className="h-5 w-5" />
          </span>
          <h2 className="text-base font-semibold">{t('settings:mcp.heading')}</h2>
          {servers.length > 0 && (
            <span className="rounded-md border border-border/60 bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
              {t('settings:mcp.summary', {
                connected: connectedCount,
                sleeping: sleepingCount,
                total: servers.length,
              })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={loading}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {t('common:action.refresh')}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setPrefillConfig(undefined);
              setShowAddDialog(true);
            }}
          >
            <Plus className="w-4 h-4 mr-1" />
            {t('settings:mcp.addCustom')}
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="recommended">
            <Star className="w-3.5 h-3.5 mr-1" />
            {t('settings:mcp.tabRecommended')}
          </TabsTrigger>
          <TabsTrigger value="list">{t('settings:mcp.tabServers')}</TabsTrigger>
          <TabsTrigger value="add">{t('settings:mcp.tabAddCustom')}</TabsTrigger>
        </TabsList>

        {/* Recommended tab — official MCP servers from the community */}
        <TabsContent value="recommended" className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('settings:mcp.recommendedBody')}</p>
          <div className="grid gap-2">
            {OFFICIAL_SERVERS.map((server) => (
              <OfficialServerCard
                key={server.name}
                server={server}
                isAdded={addedServerNames.has(server.name)}
                onAdd={() => handleAddOfficial(server)}
              />
            ))}
          </div>
        </TabsContent>

        {/* My Servers tab */}
        <TabsContent value="list" className="space-y-3">
          {loading && servers.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              {t('settings:mcp.loadingServers')}
            </div>
          ) : servers.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Server className="w-10 h-10 mx-auto mb-2 opacity-50" />
              <p>{t('settings:mcp.noServers')}</p>
              <p className="text-sm">{t('settings:mcp.noServersHint')}</p>
            </div>
          ) : (
            servers.map((server) => (
              <ServerCard
                key={server.name}
                server={server}
                onWake={() => handleWake(server.name)}
                onSleep={() => handleSleep(server.name)}
                onDiscover={() => handleDiscover(server.name)}
                onEdit={() => handleEdit(server)}
                onRemove={() => handleRemove(server.name)}
              />
            ))
          )}
        </TabsContent>

        {/* Add Custom tab */}
        <TabsContent value="add">
          <div className="text-sm text-muted-foreground">
            <p>{t('settings:mcp.addCustomBody')}</p>
            <p className="mt-1">{t('settings:mcp.addCustomBodyHint')}</p>
          </div>
        </TabsContent>
      </Tabs>

      {/* Add / prefill dialog — rendered at the top level (not inside a tab) so
          it opens from any tab: the header "Add Custom" button (blank) and the
          Recommended tab's "Add" button (prefilled) both drive it. */}
      <ServerDialog
        open={showAddDialog}
        onOpenChange={(open) => {
          if (!open) {
            setShowAddDialog(false);
            setPrefillConfig(undefined);
          }
        }}
        prefillConfig={prefillConfig}
        onSave={handleAddCustom}
      />

      {/* Edit dialog */}
      <ServerDialog
        open={showEditDialog}
        onOpenChange={setShowEditDialog}
        server={editServer}
        onSave={handleSaveEdit}
      />
    </div>
  );
}

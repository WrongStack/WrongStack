// Types, formatting helpers, and layout constants extracted from OfficeMapCanvas.

type ClientKind = 'webui' | 'tui' | 'repl' | 'coordinator' | 'agent' | 'mailbox';
export type ClientStatus = 'idle' | 'active' | 'streaming' | 'completed' | 'error' | 'offline';

export interface OfficeNodeData extends Record<string, unknown> {
  label: string;
  sublabel?: string;
  kind: ClientKind;
  status: ClientStatus;
  unreadCount?: number;
  messageCount?: number;
  currentTask?: string;
  iteration?: number;
  toolCalls?: number;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  ctxPct?: number;
  model?: string;
  lastActivityAt?: string;
  lastSeenAt?: number;
  connections?: number;
  agentsActive?: number;
  agentsTotal?: number;
  sessionId?: string;
  serverId?: string;
  pid?: number;
  branch?: string;
  workingDir?: string;
  startedAt?: string;
  agentCount?: number;
  color?: string;
  vizActivity?: number;
}

/** Compact token/number formatting: 1234 → "1.2k", 1_500_000 → "1.5M". */
export function fmtCompact(n?: number): string {
  if (n == null || !Number.isFinite(n)) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtAgo(iso: string | undefined, now: number): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'never';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

export function fmtUptime(iso: string | undefined, now: number): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

export function shortModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const parts = model.split('/');
  return parts[parts.length - 1]?.slice(0, 18);
}

/** Keep live prompt/task text from becoming topology geometry. */
export function compactFlowLabel(value: string | undefined, maxLength = 56): string | undefined {
  if (!value) return undefined;
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return undefined;
  if (compact.length <= maxLength) return compact;
  if (maxLength <= 1) return '…';
  return `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

// ── Layout constants ──────────────────────────────────────────────────────────

export const CENTER_X = 600;
const HUB_Y = 50;
export const HUB_GAP = 230;
export const MAILBOX_Y = HUB_Y;
export const COORD_Y = HUB_Y;
const CLIENT_Y = 370;
const AGENT_Y0 = 640;
const CLIENT_COL_W = 380;
export const AGENT_COLS = 3;
const AGENT_FAN_W = 190;
const AGENT_ROW_H = 150;
export const CLIENT_AGENT_GAP = AGENT_Y0 - CLIENT_Y;
const CLIENT_ROW_GAP = 100;

interface ClientClusterInput {
  id: string;
  agentCount: number;
}

interface ClientClusterLayout {
  positions: Map<string, { x: number; y: number }>;
  columns: number;
  rows: number;
  columnWidth: number;
}

export function layoutClientXs(
  clientIds: string[],
  colW: number = CLIENT_COL_W,
): Map<string, number> {
  const map = new Map<string, number>();
  const n = Math.max(1, clientIds.length);
  clientIds.forEach((id, i) => {
    const offset = (i - (n - 1) / 2) * colW;
    map.set(id, CENTER_X + offset);
  });
  return map;
}

/**
 * Lay client/session clusters out in the grid that makes the best use of the
 * current canvas aspect ratio. Each candidate column count is scored by the
 * zoom level React Flow can use to fit it, so adding sessions grows the map in
 * both directions instead of producing one increasingly tiny horizontal row.
 */
export function layoutClientClusters(
  clients: ClientClusterInput[],
  viewport: { width: number; height: number },
): ClientClusterLayout {
  if (clients.length === 0) {
    return {
      positions: new Map(),
      columns: 0,
      rows: 0,
      columnWidth: CLIENT_COL_W,
    };
  }

  const maxAgents = Math.max(1, ...clients.map((client) => client.agentCount));
  const fanCols = Math.min(AGENT_COLS, maxAgents);
  const columnWidth = Math.max(CLIENT_COL_W, fanCols * AGENT_FAN_W + 80);
  const rowContentHeight = (rowClients: ClientClusterInput[]): number => {
    const maxRows = Math.max(
      1,
      ...rowClients.map((client) => Math.ceil(Math.max(1, client.agentCount) / AGENT_COLS)),
    );
    return CLIENT_AGENT_GAP + maxRows * AGENT_ROW_H;
  };

  // The two hub nodes span roughly this width. Including it in the estimate
  // avoids selecting a narrow single-column graph that the hubs widen anyway.
  const hubWidth = HUB_GAP * 2 + 200;
  const headerHeight = CLIENT_Y - HUB_Y;
  const viewWidth = Math.max(320, viewport.width);
  const viewHeight = Math.max(240, viewport.height);

  let bestColumns = 1;
  let bestScale = Number.NEGATIVE_INFINITY;
  let bestAspectDelta = Number.POSITIVE_INFINITY;

  for (let columns = 1; columns <= clients.length; columns += 1) {
    const rowHeights: number[] = [];
    for (let start = 0; start < clients.length; start += columns) {
      rowHeights.push(rowContentHeight(clients.slice(start, start + columns)));
    }

    const rows = rowHeights.length;
    const graphWidth = Math.max(hubWidth, Math.min(columns, clients.length) * columnWidth);
    const graphHeight =
      headerHeight +
      rowHeights.reduce((sum, height) => sum + height, 0) +
      Math.max(0, rows - 1) * CLIENT_ROW_GAP;
    const scale = Math.min(viewWidth / graphWidth, viewHeight / graphHeight);
    const aspectDelta = Math.abs(Math.log(graphWidth / graphHeight / (viewWidth / viewHeight)));

    if (
      scale > bestScale + 1e-9 ||
      (Math.abs(scale - bestScale) <= 1e-9 && aspectDelta < bestAspectDelta)
    ) {
      bestColumns = columns;
      bestScale = scale;
      bestAspectDelta = aspectDelta;
    }
  }

  const positions = new Map<string, { x: number; y: number }>();
  let y = CLIENT_Y;
  for (let start = 0; start < clients.length; start += bestColumns) {
    const rowClients = clients.slice(start, start + bestColumns);
    rowClients.forEach((client, column) => {
      positions.set(client.id, {
        x: CENTER_X + (column - (rowClients.length - 1) / 2) * columnWidth,
        y,
      });
    });
    y += rowContentHeight(rowClients) + CLIENT_ROW_GAP;
  }

  return {
    positions,
    columns: bestColumns,
    rows: Math.ceil(clients.length / bestColumns),
    columnWidth,
  };
}

export function agentFanPos(
  cx: number,
  j: number,
  total: number,
  y0: number = AGENT_Y0,
): { x: number; y: number } {
  const cols = Math.min(AGENT_COLS, total);
  const row = Math.floor(j / cols);
  const col = j % cols;
  const inRow = Math.min(cols, total - row * cols);
  const rowWidth = (inRow - 1) * AGENT_FAN_W;
  const x = cx - rowWidth / 2 + col * AGENT_FAN_W;
  const y = y0 + row * AGENT_ROW_H;
  return { x, y };
}

export function clientNodeType(clientType: string | undefined): 'tui' | 'webui' | 'repl' {
  if (clientType === 'tui') return 'tui';
  if (clientType === 'repl' || clientType === 'cli') return 'repl';
  return 'webui';
}

export function surfaceLabel(kind: 'tui' | 'webui' | 'repl'): string {
  return kind === 'tui' ? 'TUI' : kind === 'repl' ? 'REPL' : 'WebUI';
}

export function mapAgentStatus(raw: string | undefined): ClientStatus {
  switch (raw) {
    case 'running':
    case 'active':
      return 'active';
    case 'idle':
      return 'idle';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'error':
      return 'error';
    case 'stopped':
      return 'offline';
    default:
      return 'idle';
  }
}

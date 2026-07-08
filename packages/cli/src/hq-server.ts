/**
 * HQ server — the read-only command-center backend for `wstack --hq`.
 *
 * Single HTTP server, single port. Two WebSocket upgrade paths:
 *   /ws/client  — TUI/REPL/WebUI clients publish telemetry
 *   /ws/browser — HQ browser connects and receives snapshot + events
 *
 * Phase 1 is read-only: the HQ browser observes what clients publish. No
 * control commands are sent to clients from the browser yet.
 *
 * Mailbox aggregation: every `mailbox.snapshot` envelope from a client is
 * stored per-(client, mailbox) and merged into the global HqSnapshot on
 * each browser poll / broadcast. Mailbox events still flow through as
 * transient events; snapshots give us the authoritative rollups.
 *
 * @module hq-server
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_HQ_REDACTION_POLICY,
  HQ_PROTOCOL_VERSION,
  type EnsureHqFirstRunAuthResult,
  type HqBrowserMessage,
  type HqClientCapability,
  type HqClientRecord,
  type HqEventEnvelope,
  type HqFleetSnapshotPayload,
  type HqFleetSummary,
  type HqMachineRecord,
  type HqMailboxEventPayload,
  type HqMailboxSnapshotPayload,
  type HqMailboxSummary,
  type HqProjectIdentity,
  type HqProjectRecord,
  type HqRedactionPolicy,
  type HqSessionEndedPayload,
  type HqSessionSnapshotPayload,
  type HqSessionSummary,
  type HqSnapshot,
  type HqTimeseriesSample,
  type HqTranscriptAppendPayload,
  type HqTranscriptEntry,
  type HqWelcomePayload,
  buildTranscriptFromEvents,
  createHqPersistence,
  HqCommandAuditLog,
  HqAlertEngine,
  toAlertMessage,
  type HqCommand,
  type HqCommandAuditEntry,
  type HqPersistence,
  type HqQueuedCommand,
  ensureHqFirstRunAuthFile,
  parseHqEventPayload,
  validateHqCommand,
  parseHqFrame,
  resolveHqDataDir,
  scrubAndTruncateHqPreview,
  watchHqAuthFile,
} from '@wrongstack/core';
// Inlined from @wrongstack/webui/server — avoids a hard dependency on the webui package.
import { WebSocket, WebSocketServer } from 'ws';
import { HQ_HTML } from './hq-dashboard-html.js';
import { resolveHqDistDir, serveHqStatic } from './hq-static-serve.js';

export interface HqServerOptions {
  host?: string;
  port?: number;
  strictPort?: boolean;
  /**
   * When true, the server binds exactly to `port` and fails with an error
   * if that port is already in use — no port scanning. Use this when the
   * user explicitly selected a port and we should not silently pick another.
   */
  exactPort?: boolean;
  /**
   * HQ data directory. When omitted, the server resolves one via
   * `resolveHqDataDir()` (honoring `WRONGSTACK_HQ_DATA_DIR` then falling
   * back to `~/.wrongstack/hq`). The directory holds `auth.json` and, in
   * later phases, the persistent event log and snapshot cache.
   */
  dataDir?: string;
}

export interface HqStartupConnectionInfo {
  dataDir: string;
  browserUrl: string;
  clientUrl: string;
  clientEnv: {
    WRONGSTACK_HQ_URL: string;
    WRONGSTACK_HQ_TOKEN?: string;
  };
  createdAuth: boolean;
}

export type HqFirstRunSetup = HqStartupConnectionInfo;

export interface HqServerHandle {
  host: string;
  port: number;
  firstRunSetup?: HqFirstRunSetup;
  close(): Promise<void>;
}

interface ConnectedClient {
  ws: WebSocket;
  clientId: string;
  projectId: string;
  project: HqProjectIdentity;
  kind: string;
  connectedAt: string;
  lastSeenAt: string;
  hostname?: string;
  pid?: number;
  version?: string;
  capabilities: readonly string[];
  /**
   * Latest mailbox snapshot keyed by mailboxId — replaces (not merges) on
   * each new `mailbox.snapshot` envelope from this client.
   */
  mailboxes: Map<string, HqMailboxSnapshotPayload>;
  machineId?: string;
  /**
   * Latest live session/terminal snapshot keyed by sessionId — replaced on
   * each `session.snapshot` envelope and removed on `session.ended`.
   */
  sessions: Map<string, HqSessionSnapshotPayload>;
  /**
   * Latest fleet (multi-agent coordinator) snapshot keyed by runId —
   * replaced on each `fleet.snapshot` envelope from this client. Feeds the
   * `fleets[]` rollup in {@link buildSnapshot}.
   */
  fleets: Map<string, HqFleetSnapshotPayload>;
  /**
   * Per-client command queue (Phase 3 control plane). Commands enqueued by
   * a browser via `POST /api/command` land here and are drained when the
   * client sends `client.command_poll`. Bounded; overflow drops oldest.
   */
  commandQueue: HqQueuedCommand[];
}

/**
 * Per-session transcript ring buffer (most-recent-capped). Fed by
 * `session.transcript` envelopes from remote clients so the HQ browser can
 * render a remote terminal's full chat history even though HQ can't read that
 * machine's on-disk JSONL. Local sessions are served from disk instead.
 */
const TRANSCRIPT_RING_MAX = 4000;
/** Bound how many distinct sessions/subagents we keep transcripts for, so a
 * long-lived HQ doesn't accumulate rings for every session that ever connected.
 * Eviction is least-recently-active (the maps are kept in LRU order). */
const MAX_TRANSCRIPT_SESSIONS = 400;
const MAX_AGENT_RINGS = 800;

/** Evict least-recently-active entries until the map is within `max`. The maps
 * are maintained in LRU order (callers re-insert on each write). */
function evictOldest(map: Map<string, unknown>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

interface TranscriptRing {
  entries: HqTranscriptEntry[];
  /** machineId of the publishing client, so the server can tell local from remote. */
  machineId?: string;
}

/** Map a raw `agent.message` payload to a transcript entry for the subagent ring. */
function agentMessageToEntry(p: Record<string, unknown>): HqTranscriptEntry {
  const kind = typeof p['kind'] === 'string' ? p['kind'] : 'text';
  const role: HqTranscriptEntry['role'] =
    kind === 'tool_use' || kind === 'tool_result'
      ? 'tool'
      : kind === 'error'
        ? 'error'
        : kind === 'status'
          ? 'system'
          : 'assistant';
  return {
    ts: typeof p['ts'] === 'string' ? p['ts'] : new Date().toISOString(),
    role,
    text: typeof p['content'] === 'string' ? p['content'] : '',
    ...(typeof p['toolName'] === 'string' ? { tool: p['toolName'] } : {}),
  };
}

const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 3499;
const MAX_EVENT_LOG = 5000;
const MAX_NON_STRICT_PORT_SCAN = 50;

/**
 * Stale client cleanup: clients that have not sent a message within this
 * window are considered dead and their sockets are terminated.  This handles
 * crash / network-drop disconnects where the WebSocket close event never
 * fires from the remote side.
 */
const CLIENT_TTL_MS = 60_000; // 60 s
const CLIENT_CLEANUP_INTERVAL_MS = 30_000; // every 30 s

function displayHost(host: string): string {
  return host === '0.0.0.0' ? '127.0.0.1' : host;
}

/** Read the full body of an HTTP request as a UTF-8 string (capped at 1 MB). */
function readRequestBody(req: http.IncomingMessage, maxBytes = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function buildHttpUrl(host: string, port: number, token?: string): string {
  const url = new URL(`http://${displayHost(host)}:${port}/`);
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

function buildClientWsUrl(host: string, port: number, token?: string): string {
  const url = new URL(`ws://${displayHost(host)}:${port}/ws/client`);
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

interface HqRuntimeMarker {
  url?: string;
  pid?: number;
  updatedAt?: string;
}

function hqRuntimeMarkerPath(dataDir: string): string {
  return path.join(dataDir, 'runtime.json');
}

async function writeHqRuntimeMarker(dataDir: string, url: string): Promise<void> {
  const file = hqRuntimeMarkerPath(dataDir);
  const payload = JSON.stringify({ url, pid: process.pid, updatedAt: new Date().toISOString() }, null, 2);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${payload}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function clearHqRuntimeMarker(dataDir: string, url: string): Promise<void> {
  const file = hqRuntimeMarkerPath(dataDir);
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as HqRuntimeMarker;
    if (parsed.url === url && parsed.pid === process.pid) await fs.rm(file, { force: true });
  } catch {
    // Best-effort cleanup only.
  }
}

/** Non-internal IPv4 addresses, so we can print URLs reachable from other machines. */
function lanIPv4Addresses(): string[] {
  const out: string[] = [];
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const ni of ifaces[name] ?? []) {
        if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
      }
    }
  } catch {
    // best-effort
  }
  return out;
}

function browserTokenFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).searchParams.get('token') ?? undefined;
  } catch {
    return undefined;
  }
}

function writeHqStartupInfo(write: (line: string) => void, handle: HqServerHandle): void {
  const startup = handle.firstRunSetup;
  write(`WrongStack HQ listening on http://${handle.host}:${handle.port}\n`);
  if (!startup) {
    write(`Browser endpoint: ${buildHttpUrl(handle.host, handle.port)}\n`);
    write(`Client endpoint:  ${buildClientWsUrl(handle.host, handle.port)}\n`);
    writeHqLanEndpoints(write, handle, undefined);
    return;
  }

  write(`Browser endpoint: ${startup.browserUrl}\n`);
  write(`Client endpoint:  ${startup.clientUrl}\n`);
  if (startup.createdAuth) {
    write(`\nFirst-run HQ auth created in ${startup.dataDir}\n`);
  } else {
    write(`\nHQ auth loaded from ${startup.dataDir}\n`);
  }
  write(`Start clients with:\n`);
  write(`  WRONGSTACK_HQ_URL=${startup.clientEnv.WRONGSTACK_HQ_URL}\n`);
  if (startup.clientEnv.WRONGSTACK_HQ_TOKEN) {
    write(`  WRONGSTACK_HQ_TOKEN=${startup.clientEnv.WRONGSTACK_HQ_TOKEN}\n`);
  }
  writeHqLanEndpoints(write, handle, browserTokenFromUrl(startup.browserUrl));
}

/** When bound to all interfaces, print LAN URLs so other machines can reach HQ. */
function writeHqLanEndpoints(
  write: (line: string) => void,
  handle: HqServerHandle,
  browserToken: string | undefined,
): void {
  if (handle.host !== '0.0.0.0' && handle.host !== '::') return;
  const ips = lanIPv4Addresses();
  if (ips.length === 0) return;
  write(`\nReachable from other machines on your network:\n`);
  for (const ip of ips) {
    write(`  ${buildHttpUrl(ip, handle.port, browserToken)}\n`);
  }
  write(`  On another machine, set WRONGSTACK_HQ_URL=http://${ips[0]}:${handle.port}\n`);
}

// The HQ dashboard HTML lives in its own module (a large self-contained
// React + React Flow document). Import it for local use by the `/` route and
// re-export it so existing importers keep working unchanged.
export { HQ_HTML };

/** GET /api/sessions — list live sessions from the cross-process registry. */
async function handleApiSessions(res: http.ServerResponse): Promise<void> {
  const { SessionRegistry } = await import('@wrongstack/core');
  const globalRoot = path.dirname(resolveHqDataDir());
  try {
    const registry = new SessionRegistry(globalRoot);
    const sessions = await registry.list();
    const result = sessions.filter(s => s.status !== 'stale').map((s) => ({
      sessionId: s.sessionId,
      projectSlug: s.projectSlug,
      projectName: s.projectName,
      projectRoot: s.projectRoot,
      workingDir: s.workingDir,
      status: s.status,
      pid: s.pid,
      startedAt: s.startedAt,
      lastHeartbeatAt: s.lastHeartbeatAt,
      agentCount: s.agentCount,
      agents: s.agents.map((a) => ({
        id: a.id, name: a.name, status: a.status,
        currentTool: a.currentTool, iterations: a.iterations,
        toolCalls: a.toolCalls, lastActivityAt: a.lastActivityAt,
      })),
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

/** GET /api/sessions/:id/events — replay JSONL events for a session watch. */
/**
 * GET /api/sessions/:id/events — full chat history for a terminal.
 *
 * Local sessions (present in this host's registry) are replayed from disk so
 * the operator sees the complete, correlated transcript. Remote sessions are
 * served from the in-memory transcript ring fed by `session.transcript`
 * envelopes. `full` drops the tail cap and returns everything available.
 */
async function handleApiSessionEvents(
  res: http.ServerResponse,
  sessionId: string,
  limit: number,
  full: boolean,
  transcripts: Map<string, TranscriptRing>,
): Promise<void> {
  const { SessionRegistry, resolveWstackPaths, DefaultSessionStore } = await import('@wrongstack/core');
  const globalRoot = path.dirname(resolveHqDataDir());
  try {
    const registry = new SessionRegistry(globalRoot);
    const entry = await registry.get(sessionId).catch(() => null);

    let entries: HqTranscriptEntry[] = [];
    let source: 'disk' | 'stream' = 'stream';
    let status: string | undefined;
    let clientType: string | undefined;
    let projectName: string | undefined;

    if (entry) {
      // Local session — replay the full JSONL from disk.
      const paths = resolveWstackPaths({ projectRoot: entry.projectRoot, globalRoot });
      const store = new DefaultSessionStore({ dir: paths.projectSessions });
      const data = await store.load(sessionId).catch(() => null);
      if (data) {
        entries = buildTranscriptFromEvents(
          (data.events as unknown[]).map((e) => e as Record<string, unknown>),
        );
        source = 'disk';
        status = entry.status;
        clientType = entry.clientType;
        projectName = entry.projectName;
      }
    }

    if (entries.length === 0) {
      // Remote (or not-yet-on-disk) session — serve the streamed ring.
      const ring = transcripts.get(sessionId);
      if (!ring && !entry) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      entries = ring ? ring.entries : [];
      source = 'stream';
      if (entry) {
        status = entry.status;
        clientType = entry.clientType;
        projectName = entry.projectName;
      }
    }

    const total = entries.length;
    const tail = full ? entries : entries.slice(-limit);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        sessionId,
        source,
        ...(status !== undefined ? { status } : {}),
        ...(clientType !== undefined ? { clientType } : {}),
        ...(projectName !== undefined ? { projectName } : {}),
        total,
        entries: tail,
      }),
    );
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

export async function startHqServer(options: HqServerOptions = {}): Promise<HqServerHandle> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const dataDir = resolveHqDataDir(options.dataDir);

  // First run should be usable without manual token/config setup: if
  // auth.json is missing, create browser + client tokens. Existing auth.json
  // remains operator-owned, including explicit empty-token open mode.
  const firstRunAuth = await ensureHqFirstRunAuthFile(dataDir, {
    warn: (msg: string) => console.warn(JSON.stringify({ level: 'warn', event: 'hq.auth_load_failed', message: msg, timestamp: new Date().toISOString() })),
  });
  return startHqServerWithAuth(options, host, port, dataDir, firstRunAuth);
}

/**
 * Extract a browser token from an HTTP request. Accepts:
 *   1. `?token=…` query parameter (for browser navigation / dashboard)
 *   2. `Authorization: Bearer …` header (for programmatic / curl access)
 * Returns the token string if found, otherwise `undefined`.
 */
function extractBrowserToken(req: http.IncomingMessage, url: URL): string | undefined {
  const queryToken = url.searchParams.get('token');
  if (queryToken) return queryToken;

  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }

  return undefined;
}

function startHqServerWithAuth(
  options: HqServerOptions,
  host: string,
  port: number,
  dataDir: string,
  firstRunAuth: EnsureHqFirstRunAuthResult,
): Promise<HqServerHandle> {
  const authFile = firstRunAuth.authFile;
  // Operator override merges over the default; publisher claims are
  // clamped against this at broadcast time (see scrubAndTruncateHqPreview
  // call sites + the welcome handshake redactionPolicy field).
  // Mutable: the file-watcher below refreshes these on auth.json change
  // (Phase 4 live reload).
  const mutableAuth: {
    operatorPolicy: HqRedactionPolicy;
    browserTokens: Set<string>;
    clientTokens: Set<string>;
    /** Browser token objects keyed by token string — for capability checks. */
    browserTokenObjs: Map<string, { id: string; capabilities?: string[] }>;
  } = {
    operatorPolicy: {
      ...DEFAULT_HQ_REDACTION_POLICY,
      ...(authFile.redactionPolicy ?? {}),
    },
    browserTokens: new Set((authFile.browserTokens ?? []).map((t) => t.token)),
    clientTokens: new Set((authFile.clientTokens ?? []).map((t) => t.token)),
    browserTokenObjs: new Map(
      (authFile.browserTokens ?? []).map((t) => [t.token, { id: t.id, ...(t.capabilities !== undefined ? { capabilities: t.capabilities } : {}) }]),
    ),
  };

  // Surface the resolved data directory + whether an operator override
  // is in effect. Helps the operator confirm `--data-dir` took hold.
  console.warn(JSON.stringify({
    level: 'info',
    event: 'hq.startup',
    message: 'WrongStack HQ starting',
    dataDir,
    host,
    port,
    operatorPolicyActive: authFile.redactionPolicy !== undefined,
    browserTokenMode: mutableAuth.browserTokens.size > 0,
    clientTokenMode: mutableAuth.clientTokens.size > 0,
    timestamp: new Date().toISOString(),
  }));
  void options;

  return new Promise((resolve, reject) => {
    const clients = new Map<WebSocket, ConnectedClient>();
    const browsers = new Set<WebSocket>();
    const eventLog: HqEventEnvelope[] = [];
    const transcripts = new Map<string, TranscriptRing>();
    // Per-subagent message history (keyed by subagentId), fed by agent.message
    // events so a late-connecting browser — including one on another machine —
    // can replay a subagent's full conversation, not just messages seen live.
    const agentMessages = new Map<string, HqTranscriptEntry[]>();

    // ── Persistence (Phase 2) ──────────────────────────────────────────────
    // Survives restart: event log, snapshot checkpoint, cost/activity trends.
    // All writes are best-effort and fire-and-forget so the server hot path is
    // never blocked. Hydrated from disk on boot so a restarted HQ shows prior
    // history immediately. Declared before the snapshot broadcaster because
    // the broadcaster checkpoints into the snapshot store on each serialize.
    const persistence = createHqPersistence(dataDir);
    const auditLog = new HqCommandAuditLog();
    // Stable mailbox identity for direct HQ writes (/api/mailbox-send). Lets
    // recipients attribute a zero-client HQ prompt to this server instance.
    const hqSessionTag = randomUUID().slice(0, 8);
    // ── Alerting (Phase 6) — evaluates the live snapshot against rules and
    // broadcasts `hq.alert` to browsers when a threshold is crossed.
    const alertEngine = new HqAlertEngine({
      onAlert: (alert) => {
        const msg = toAlertMessage(alert);
        const data = JSON.stringify(msg);
        for (const ws of browsers) {
          if (ws.readyState === WebSocket.OPEN) ws.send(data);
        }
      },
    });
    void persistence.eventLog.hydrate();
    void persistence.timeseries.load();
    // Seed the in-memory eventLog from the persisted log so a restarted HQ
    // shows recent history in the dashboard before new events arrive.
    persistence.eventLog.recent(MAX_EVENT_LOG).then((prior) => {
      // Newest-first from recent(); push oldest-first into the in-memory ring.
      for (let i = prior.length - 1; i >= 0; i--) eventLog.push(prior[i]!);
    }).catch(() => { /* best-effort */ });

    // Flush the timeseries store every 60s so buckets reach disk periodically
    // even under light load. Unref'd so it never keeps the process alive.
    const timeseriesFlushTimer = setInterval(() => {
      persistence.timeseries.flush();
    }, 60_000);
    timeseriesFlushTimer.unref?.();

    const snapshotBroadcaster = createSnapshotBroadcaster(clients, browsers, persistence);

    // Start periodic alert evaluation against the latest snapshot. The engine
    // reads the snapshot fresh on each tick (15s, unref'd) so alerts reflect
    // current state. Dedup prevents alert storms — only transitions emit.
    const stopAlertEngine = alertEngine.startPeriodic(
      () => buildSnapshot(clients),
      undefined,
    );
    // Stale-client cleanup: periodically evict clients that have gone silent.
    // This catches crash / network-drop disconnects where the remote never
    // sent a WebSocket close frame, so the 'close' event never fires.
    const cleanupTimer = setInterval(() => {
      const cutoff = Date.now() - CLIENT_TTL_MS;
      for (const [ws, client] of clients.entries()) {
        if (new Date(client.lastSeenAt).getTime() < cutoff) {
          // terminate() forces the socket closed immediately without going
          // through the WS close handshake — appropriate for dead peers.
          ws.terminate();
          clients.delete(ws);
        }
      }
      if (clients.size > 0) snapshotBroadcaster.broadcast();
    }, CLIENT_CLEANUP_INTERVAL_MS);

    const httpServer: HttpServer = http.createServer(async (req, res) => {
      try {
      const url = new URL(req.url ?? '/', `http://${host}:${port}`);

      // When browser TOKEN MODE is active, all HTTP routes require a valid
      // browser token EXCEPT static assets (/assets/, /wrongstack.svg) which
      // are public and don't need authentication. Token is accepted via
      // ?token= query param (for browser/dashboard use) or Authorization:
      // Bearer header (for programmatic / curl access).
      const isStaticAsset =
        url.pathname.startsWith('/assets/') || url.pathname === '/wrongstack.svg';
      if (mutableAuth.browserTokens.size > 0 && !isStaticAsset) {
        const supplied = extractBrowserToken(req, url);
        if (!supplied || !mutableAuth.browserTokens.has(supplied)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                code: 'INVALID_TOKEN',
                message: 'A valid ?token= or Authorization: Bearer is required for HTTP access in browser token mode.',
              },
            }),
          );
          return;
        }
      }

      // ── HQ dashboard — serve the React app if built, else inline fallback ──
      // The React app (packages/webui-hq) is the primary dashboard. When unbuilt
      // (or the package is absent), fall back to the self-contained inline HTML
      // so HQ is always functional — even offline with no build step.
      const hqDistDir = resolveHqDistDir();
      if (hqDistDir !== null && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/assets/') || url.pathname.startsWith('/'))) {
        const served = serveHqStatic(req, res, url.pathname, hqDistDir);
        if (served.handled) return;
      }

      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(HQ_HTML);
        return;
      }

      // ── HQ API routes ──────────────────────────────────────────────
      if (url.pathname === '/api/snapshot') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(buildSnapshot(clients)));
        return;
      }

      if (url.pathname.startsWith('/api/projects/')) {
        const projectId = decodeURIComponent(url.pathname.slice('/api/projects/'.length));
        if (!projectId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'projectId is required' } }),
          );
          return;
        }
        const detail = buildProjectDetail(clients, projectId);
        if (!detail) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: { code: 'NOT_FOUND', message: `Unknown project: ${projectId}` },
            }),
          );
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(detail));
        return;
      }

      // ── Fleet tree (machines → projects → terminals → agents) ──────
      if (url.pathname === '/api/fleet' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(buildSnapshot(clients)));
        return;
      }

      // ── Persistence-backed history + trends (Phase 2) ────────────────
      // GET /api/events?limit=&type= — recent persisted event envelopes.
      if (url.pathname === '/api/events' && req.method === 'GET') {
        const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10);
        const limit = Math.min(5000, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 200));
        const typeFilter = url.searchParams.get('type') ?? undefined;
        const events = await persistence.eventLog.recent(limit, typeFilter);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ events, total: events.length }));
        return;
      }

      // GET /api/trends/cost?since= — time-bucketed cost/activity samples.
      if (url.pathname === '/api/trends/cost' && req.method === 'GET') {
        const rawSince = Number.parseInt(url.searchParams.get('since') ?? '0', 10);
        const since = Number.isFinite(rawSince) ? rawSince : 0;
        const samples: HqTimeseriesSample[] = await persistence.timeseries.read(since);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ samples }));
        return;
      }

      // ── Control plane (Phase 3) ─────────────────────────────────────────
      // POST /api/command — enqueue a command to a connected client. Requires
      // a browser token with the `control.enqueue` capability (or open mode
      // where any browser token suffices). The target client must advertise
      // the `control.receive` capability.
      if (url.pathname === '/api/command' && req.method === 'POST') {
        // Auth: reuse the browser-token gate already active for this request.
        const suppliedToken = extractBrowserToken(req, url);
        const inBrowserTokenMode = mutableAuth.browserTokens.size > 0;
        if (inBrowserTokenMode) {
          if (!suppliedToken || !mutableAuth.browserTokens.has(suppliedToken)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'unauthorized' }));
            return;
          }
        }
        // Capability check: the browser token must grant control.enqueue.
        // In open mode (no browser tokens configured), control is allowed.
        const tokenObj = suppliedToken !== undefined ? mutableAuth.browserTokenObjs.get(suppliedToken) : undefined;
        const canEnqueue =
          !inBrowserTokenMode ||
          tokenObj?.capabilities === undefined ||
          tokenObj.capabilities.includes('control.enqueue');
        if (!canEnqueue) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden: token lacks control.enqueue capability' }));
          return;
        }

        let body: { clientId?: string; type?: string; payload?: unknown };
        try {
          body = JSON.parse(await readRequestBody(req)) as { clientId?: string; type?: string; payload?: unknown };
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid json body' }));
          return;
        }
        if (typeof body.clientId !== 'string' || typeof body.type !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'missing clientId or type' }));
          return;
        }

        // Find the target client across all connected sockets (dedupe by clientId).
        let target: ConnectedClient | undefined;
        for (const c of clients.values()) {
          if (c.clientId === body.clientId) {
            target = c;
            break;
          }
        }
        if (target === undefined) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'client not connected', clientId: body.clientId }));
          return;
        }
        // The target must advertise control.receive.
        if (!target.capabilities.includes('control.receive')) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'client does not accept control commands', clientId: body.clientId }));
          return;
        }

        const commandId = randomUUID();
        const queued: HqQueuedCommand = {
          commandId,
          type: body.type,
          createdAt: new Date().toISOString(),
          payload: body.payload ?? {},
          requiresAck: true,
        };
        // Validate the command shape before enqueuing.
        const validated: HqCommand | null = validateHqCommand(queued);
        if (validated === null) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unrecognized or malformed command', type: body.type }));
          return;
        }

        target.commandQueue.push(queued);
        // Bounded queue: drop oldest on overflow.
        if (target.commandQueue.length > 200) target.commandQueue.splice(0, target.commandQueue.length - 200);

        const auditEntry: HqCommandAuditEntry = {
          commandId,
          type: validated.type,
          clientId: target.clientId,
          enqueuedBy: tokenObj?.id ?? 'open-mode',
          enqueuedAt: queued.createdAt,
          status: 'queued',
        };
        auditLog.record(auditEntry);

        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ commandId, queued: true, clientId: target.clientId }));
        return;
      }

      // ── Direct mailbox write (Phase 4 — zero-client delivery) ────────────
      // POST /api/mailbox-send — write an HQ prompt straight into a project's
      // GlobalMailbox, bypassing the connected-client control plane. This is
      // the "send even when no active agent" path: the message lands in the
      // project mailbox file so the next agent to run (or any terminal/webui)
      // picks it up. The target project is identified by `sessionId` (or
      // `projectId`) and resolved to a `projectRoot` SERVER-SIDE via the
      // SessionRegistry — the browser never supplies a raw filesystem path,
      // so this cannot be abused to write outside known projects.
      if (url.pathname === '/api/mailbox-send' && req.method === 'POST') {
        // Auth mirrors /api/command: browser token + control.enqueue.
        const suppliedToken = extractBrowserToken(req, url);
        const inBrowserTokenMode = mutableAuth.browserTokens.size > 0;
        if (inBrowserTokenMode && (!suppliedToken || !mutableAuth.browserTokens.has(suppliedToken))) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        const tokenObj = suppliedToken !== undefined ? mutableAuth.browserTokenObjs.get(suppliedToken) : undefined;
        const canEnqueue =
          !inBrowserTokenMode ||
          tokenObj?.capabilities === undefined ||
          tokenObj.capabilities.includes('control.enqueue');
        if (!canEnqueue) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden: token lacks control.enqueue capability' }));
          return;
        }

        let mbody: {
          sessionId?: string;
          projectId?: string;
          type?: string;
          to?: string;
          subject?: string;
          body?: string;
          priority?: string;
        };
        try {
          mbody = JSON.parse(await readRequestBody(req));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid json body' }));
          return;
        }
        if (typeof mbody.type !== 'string' || typeof mbody.body !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'missing type or body' }));
          return;
        }
        if (typeof mbody.sessionId !== 'string' && typeof mbody.projectId !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'missing sessionId or projectId' }));
          return;
        }

        // Resolve projectRoot from the SessionRegistry — authoritative, so we
        // never trust a browser-supplied path. Prefer sessionId; fall back to
        // the newest live session in the given projectId.
        const { SessionRegistry } = await import('@wrongstack/core');
        // Derive the global root from THIS server's dataDir (honors
        // --data-dir / WRONGSTACK_HQ_DATA_DIR), not the default resolver, so
        // the mailbox and registry line up with the running instance.
        const mbGlobalRoot = path.dirname(dataDir);
        let projectRoot: string | undefined;
        try {
          const registry = new SessionRegistry(mbGlobalRoot);
          if (typeof mbody.sessionId === 'string') {
            const entry = await registry.get(mbody.sessionId).catch(() => null);
            projectRoot = entry?.projectRoot;
          }
          if (projectRoot === undefined && typeof mbody.projectId === 'string') {
            const all = await registry.list().catch(() => []);
            // HQ `projectId` maps to the registry `projectSlug`.
            const match = all.find((e) => e.projectSlug === mbody.projectId);
            projectRoot = match?.projectRoot;
          }
        } catch {
          projectRoot = undefined;
        }
        if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'could not resolve target project mailbox' }));
          return;
        }

        // Validate the mailbox message shape by reusing the command guard.
        const to = typeof mbody.to === 'string' ? mbody.to : 'leader';
        const subject = typeof mbody.subject === 'string' ? mbody.subject : 'HQ prompt';
        const priority = mbody.priority === 'high' ? 'high' : mbody.priority === 'low' ? 'low' : 'normal';
        const validated = validateHqCommand({
          commandId: randomUUID(),
          type: mbody.type,
          createdAt: new Date().toISOString(),
          payload: { to, subject, body: mbody.body, priority },
          requiresAck: false,
        });
        // Only the mailbox-writing command types are valid here.
        const mailboxType =
          validated?.type === 'steer' || validated?.type === 'btw'
            ? validated.type
            : validated?.type === 'queue'
              ? 'note'
              : validated?.type === 'broadcast'
                ? 'broadcast'
                : undefined;
        if (mailboxType === undefined) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unrecognized or malformed mailbox message', type: mbody.type }));
          return;
        }

        try {
          const { GlobalMailbox, resolveProjectDir } = await import('@wrongstack/core');
          const projectDir = resolveProjectDir(projectRoot, mbGlobalRoot);
          const mailbox = new GlobalMailbox(projectDir);
          const from = `hq@${hqSessionTag}`;
          const sent = await mailbox.send({
            from,
            to: mailboxType === 'broadcast' ? 'all' : to,
            type: mailboxType,
            subject,
            body: mbody.body,
            priority,
          });
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ delivered: true, messageId: sent?.id, to, type: mailboxType }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'mailbox write failed', detail: String(err) }));
        }
        return;
      }

      // GET /api/commands?limit= — recent command audit entries.
      if (url.pathname === '/api/commands' && req.method === 'GET') {
        const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10);
        const limit = Math.min(1000, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 200));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ commands: auditLog.recent(limit) }));
        return;
      }

      // GET /api/alerts?limit= — recent alert history + currently-active alerts.
      if (url.pathname === '/api/alerts' && req.method === 'GET') {
        const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '100', 10);
        const limit = Math.min(500, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 100));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ active: alertEngine.activeAlerts(), history: alertEngine.recentAlerts(limit) }));
        return;
      }

      // ── WrongStack session API — full chat history per terminal ────
      if (url.pathname === '/api/sessions' && req.method === 'GET') {
        await handleApiSessions(res);
        return;
      }

      const eventsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
      if (eventsMatch && req.method === 'GET') {
        const full = url.searchParams.get('full') === '1';
        const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10);
        const limit = Math.min(5000, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 200));
        await handleApiSessionEvents(res, decodeURIComponent(eventsMatch[1]!), limit, full, transcripts);
        return;
      }

      // ── Subagent message history (full conversation of one shadow agent) ──
      const agentMsgMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/messages$/);
      if (agentMsgMatch && req.method === 'GET') {
        const id = decodeURIComponent(agentMsgMatch[1]!);
        const full = url.searchParams.get('full') === '1';
        const ring = agentMessages.get(id) ?? [];
        const entries = full ? ring : ring.slice(-200);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ subagentId: id, total: ring.length, entries }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      } catch (err) {
        console.error(JSON.stringify({ level: 'error', event: 'hq.http_handler_error', message: String(err), timestamp: new Date().toISOString() }));
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      }
    });

    const wss = new WebSocketServer({ noServer: true, maxPayload: 1 * 1024 * 1024 });

    httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', `http://${host}:${port}`);
      const pathname = url.pathname;

      if (pathname !== '/ws/client' && pathname !== '/ws/browser') {
        socket.destroy();
        return;
      }

      // Token mode: each channel checks its own allowlist. Browser and
      // client tokens are separate — a browser-only token cannot be
      // replayed on /ws/client and vice versa. OPEN MODE for a channel
      // when its token set is empty (backwards compatible).
      const tokenSet = pathname === '/ws/browser' ? mutableAuth.browserTokens : mutableAuth.clientTokens;
      if (tokenSet.size > 0) {
        const supplied = url.searchParams.get('token') ?? '';
        if (!supplied || !tokenSet.has(supplied)) {
          socket.write(
            'HTTP/1.1 401 Unauthorized\r\n' +
              'Content-Type: application/json\r\n' +
              'Connection: close\r\n' +
              '\r\n' +
              JSON.stringify({
                error: {
                  code: 'INVALID_TOKEN',
                  message: `A valid ?token= is required for ${pathname} connections in token mode.`,
                },
              }),
          );
          socket.destroy();
          return;
        }
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, pathname);
      });
    });

    wss.on('connection', (ws: WebSocket, _req: http.IncomingMessage, pathname: string) => {
      if (pathname === '/ws/browser') {
        handleBrowser(ws, snapshotBroadcaster, browsers);
      } else {
        handleClient(ws, clients, browsers, eventLog, mutableAuth.operatorPolicy, snapshotBroadcaster, transcripts, agentMessages, persistence, auditLog);
      }
    });

    // Phase 4 — live reload of auth.json. The watcher re-reads the file on
    // change and atomically swaps the in-memory token sets + operator policy.
    // No active connections are dropped; subsequent upgrades and broadcasts
    // see the new state immediately.
    const authWatcher = watchHqAuthFile(
      dataDir,
      (next) => {
        mutableAuth.operatorPolicy = {
          ...DEFAULT_HQ_REDACTION_POLICY,
          ...(next.redactionPolicy ?? {}),
        };
        mutableAuth.browserTokens = new Set((next.browserTokens ?? []).map((t) => t.token));
        mutableAuth.clientTokens = new Set((next.clientTokens ?? []).map((t) => t.token));
        mutableAuth.browserTokenObjs = new Map(
          (next.browserTokens ?? []).map((t) => [t.token, { id: t.id, ...(t.capabilities !== undefined ? { capabilities: t.capabilities } : {}) }]),
        );
        console.warn(JSON.stringify({
          level: 'info',
          event: 'hq.auth.reloaded',
          message: 'HQ auth.json reloaded',
          browserTokenCount: mutableAuth.browserTokens.size,
          clientTokenCount: mutableAuth.clientTokens.size,
          timestamp: new Date().toISOString(),
        }));
      },
      {
        warn: (msg) => console.warn(JSON.stringify({
          level: 'warn',
          event: 'hq.auth.reload_failed',
          message: msg,
          timestamp: new Date().toISOString(),
        })),
      },
    );

    let bindAttempts = 0;
    const listen = (nextPort: number): void => {
      httpServer.listen(nextPort, host);
    };
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && !options.strictPort && !options.exactPort && bindAttempts < MAX_NON_STRICT_PORT_SCAN) {
        bindAttempts += 1;
        listen(port + bindAttempts);
      } else {
        authWatcher.close();
        snapshotBroadcaster.close();
        wss.close();
        reject(err);
      }
    };

    httpServer.on('error', onError);
    listen(port);
    httpServer.once('listening', () => {
      void (async () => {
        httpServer.removeListener('error', onError);
        const addr = httpServer.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : port;

        const browserToken = firstRunAuth.browserToken?.token ?? authFile.browserTokens?.find((t) => t.token.trim().length > 0)?.token;
        const clientToken = firstRunAuth.clientToken?.token ?? authFile.clientTokens?.find((t) => t.token.trim().length > 0)?.token;
        const hqUrl = `http://${displayHost(host)}:${actualPort}`;
        await writeHqRuntimeMarker(dataDir, hqUrl).catch(() => {
          // Best-effort discovery marker; startup output remains authoritative.
        });
        const startupInfo: HqStartupConnectionInfo = {
          dataDir,
          browserUrl: buildHttpUrl(host, actualPort, browserToken),
          clientUrl: buildClientWsUrl(host, actualPort, clientToken),
          clientEnv: {
            WRONGSTACK_HQ_URL: hqUrl,
            ...(clientToken ? { WRONGSTACK_HQ_TOKEN: clientToken } : {}),
          },
          createdAuth: firstRunAuth.created,
        };
        let closed = false;
        const handle: HqServerHandle = {
          host,
          port: actualPort,
          firstRunSetup: startupInfo,
          close: () =>
            new Promise<void>((res) => {
              if (closed) {
                res();
                return;
              }
              closed = true;
              clearInterval(cleanupTimer);
              clearInterval(timeseriesFlushTimer);
              stopAlertEngine();
              authWatcher.close();
              snapshotBroadcaster.close();
              // Final flush so the last batch of timeseries buckets reach disk.
              persistence.timeseries.flush();
              for (const ws of browsers) ws.close(1001, 'HQ shutting down');
              for (const ws of clients.keys()) ws.close(1001, 'HQ shutting down');
              wss.close();
              httpServer.close(() => {
                // Drain the queued persistence writes BEFORE resolving.
                // The event-log / snapshot / timeseries stores are all
                // fire-and-forget write chains; resolving close() while an
                // appendFile/atomicWrite is still in flight both drops the
                // final flush on real shutdowns and lets a caller's
                // `fs.rm(dataDir)` race the write (ENOTEMPTY on Windows).
                void Promise.all([
                  persistence.eventLog.drain(),
                  persistence.snapshotStore.drain(),
                  persistence.timeseries.drain(),
                ])
                  .then(() => clearHqRuntimeMarker(dataDir, hqUrl))
                  .catch(() => undefined)
                  .finally(() => res());
              });
            }),
        };
        writeHqStartupInfo((line) => console.log(line.trimEnd()), handle);
        resolve(handle);
      })();
    });
  });
}

function handleBrowser(
  ws: WebSocket,
  snapshotBroadcaster: HqSnapshotBroadcaster,
  browsers: Set<WebSocket>,
): void {
  browsers.add(ws);

  // Per-connection error handler. An oversized inbound frame makes the `ws`
  // receiver throw (`RangeError: Max payload size exceeded`, close 1009) and
  // emit 'error' on this socket — unhandled, that crashes the whole process.
  ws.on('error', (err) => {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'hq.browser_socket_error',
        message: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }),
    );
  });

  ws.send(snapshotBroadcaster.currentSerialized());

  ws.on('close', () => {
    browsers.delete(ws);
  });
}

function handleClient(
  ws: WebSocket,
  clients: Map<WebSocket, ConnectedClient>,
  browsers: Set<WebSocket>,
  eventLog: HqEventEnvelope[],
  operatorPolicy: HqRedactionPolicy,
  snapshotBroadcaster: HqSnapshotBroadcaster,
  transcripts: Map<string, TranscriptRing>,
  agentMessages: Map<string, HqTranscriptEntry[]>,
  persistence?: HqPersistence,
  auditLog?: HqCommandAuditLog,
): void {
  let registered = false;

  /**
   * Record an event into both the in-memory ring and the persistent log, and
   * fold any cost/tool signal into the timeseries store. Best-effort: never
   * throws into the message handler.
   */
  function persistEvent(event: HqEventEnvelope): void {
    eventLog.push(event);
    if (eventLog.length > MAX_EVENT_LOG) eventLog.splice(0, eventLog.length - MAX_EVENT_LOG);
    if (persistence !== undefined) {
      persistence.eventLog.append(event);
      recordTimeseriesSignal(persistence, event);
    }
  }

  // Per-connection error handler. An oversized inbound frame makes the `ws`
  // receiver throw (`RangeError: Max payload size exceeded`, close 1009) and
  // emit 'error' on this socket — unhandled, that crashes the whole process.
  ws.on('error', (err) => {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'hq.client_socket_error',
        message: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }),
    );
  });

  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    const raw =
      typeof data === 'string'
        ? data
        : Buffer.isBuffer(data)
          ? data
          : new TextDecoder().decode(data as ArrayBuffer);
    const parsed = parseHqFrame(raw);
    if (!parsed.ok) {
      // RFC 6455 §7.4.1: 1003 = invalid payload (not processable),
      // 1008 = policy violation (unknown type or malformed shape).
      const code = parsed.reason === 'invalid-json' ? 1003 : 1008;
      ws.close(code, `invalid frame: ${parsed.reason}`);
      return;
    }
    const frame = parsed.frame;

    if (frame.type === 'client.hello') {
      const payload = frame.payload;
      if (payload.protocolVersion !== HQ_PROTOCOL_VERSION) {
        ws.close(1008, 'protocol version mismatch');
        return;
      }

      const client: ConnectedClient = {
        ws,
        clientId: payload.client.clientId,
        projectId: payload.project.projectId,
        project: payload.project,
        kind: payload.client.kind,
        connectedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        ...(payload.client.hostname ? { hostname: payload.client.hostname } : {}),
        ...(payload.client.pid ? { pid: payload.client.pid } : {}),
        ...(payload.client.version ? { version: payload.client.version } : {}),
        capabilities: payload.capabilities,
        mailboxes: new Map(),
        machineId: payload.client.machineId || payload.project.machineId,
        sessions: new Map(),
        fleets: new Map(),
        commandQueue: [],
      };
      clients.set(ws, client);
      registered = true;

      // Phase 1 server-to-client acknowledgement: the client learns which
      // capabilities the server accepted and the active redaction policy.
      // Phase 2 will also use this socket to push `HqServerCommandBatchMessage`
      // frames via `client.command_poll`, but for now the welcome is a
      // one-shot handshake reply with no command queue attached.
      const welcome: HqWelcomePayload = {
        type: 'hq.welcome',
        protocolVersion: HQ_PROTOCOL_VERSION,
        serverTime: new Date().toISOString(),
        acceptedCapabilities: payload.capabilities,
        // The operator-configured override (from <dataDir>/auth.json) wins
        // over the default. The client learns the *effective* policy.
        redactionPolicy: operatorPolicy,
      };
      ws.send(JSON.stringify(welcome));

      const event: HqEventEnvelope = {
        id: randomUUID(),
        type: 'client.hello',
        schemaVersion: HQ_PROTOCOL_VERSION,
        timestamp: new Date().toISOString(),
        clientId: payload.client.clientId,
        projectId: payload.project.projectId,
        seq: 0,
        payload: { client: payload.client, project: payload.project },
      };
      persistEvent(event);
      snapshotBroadcaster.broadcast();
      broadcastEvent(event, browsers);
      return;
    }

    if (!registered) return;

    // ── Phase 3 control plane: client polls for commands & acks them ──────
    // The client SDK (HqPublisher) polls every ~2s with an `afterCommandId`
    // cursor; we drain the per-client queue back to it as a `hq.command_batch`.
    if (frame.type === 'client.command_poll') {
      const client = clients.get(ws);
      if (client) {
        client.lastSeenAt = new Date().toISOString();
        const afterId = frame.afterCommandId;
        let toSend: HqQueuedCommand[];
        if (afterId === undefined) {
          toSend = client.commandQueue.slice();
        } else {
          const idx = client.commandQueue.findIndex((c) => c.commandId === afterId);
          toSend = idx >= 0 ? client.commandQueue.slice(idx + 1) : client.commandQueue.slice();
        }
        if (toSend.length > 0) {
          const batch = JSON.stringify({ type: 'hq.command_batch', commands: toSend });
          if (ws.readyState === WebSocket.OPEN) ws.send(batch);
          for (const cmd of toSend) {
            auditLog?.update(cmd.commandId, { status: 'delivered' });
          }
        }
        // Bounded queue: drop delivered commands older than the cursor to
        // avoid unbounded growth on a long-lived client.
        const limit = frame.limit ?? 25;
        if (client.commandQueue.length > Math.max(limit * 4, 100)) {
          client.commandQueue.splice(0, client.commandQueue.length - Math.max(limit * 4, 100));
        }
      }
      return;
    }

    if (frame.type === 'client.command_ack') {
      const client = clients.get(ws);
      if (client) client.lastSeenAt = new Date().toISOString();
      auditLog?.update(frame.commandId, {
        status: 'acked',
        ackStatus: frame.status,
        ...(frame.message !== undefined ? { ackMessage: frame.message } : {}),
        ackedAt: new Date().toISOString(),
      });
      return;
    }

    if (frame.type === 'client.event') {
      const event = frame.event;
      const client = clients.get(ws);
      if (client) client.lastSeenAt = new Date().toISOString();

      // Mailbox snapshots are authoritative rollups — adopt them into the
      // per-client mailbox map and re-broadcast the global snapshot so the
      // browser counters reflect the latest rollup. We validate the
      // payload via `parseHqEventPayload` so a malformed snapshot cannot
      // poison the per-client mailbox map; other event types are not
      // validated yet and pass through unchanged.
      if (event.type === 'mailbox.snapshot' && client !== undefined) {
        const payloadResult = parseHqEventPayload(event.type, event.payload);
        if (payloadResult.ok) {
          const payload = payloadResult.payload as HqMailboxSnapshotPayload;
          client.mailboxes.set(client.projectId + ':' + payload.mailboxId, payload);
          persistEvent(event);
          snapshotBroadcaster.broadcast();
          broadcastEvent(event, browsers);
          return;
        }
        // Malformed mailbox.snapshot: drop without logging or broadcasting so
        // it cannot poison the per-client mailbox map.
        return;
      }

      // Mailbox events are transient — validate the payload so a malformed
      // envelope cannot leak garbage to the browser live feed, and scrub +
      // truncate the optional `summary` preview so unbounded or secret-laden
      // text is sanitized before being stored in the event log and
      // broadcast to browsers.
      if (event.type === 'mailbox.event') {
        const payloadResult = parseHqEventPayload(event.type, event.payload);
        if (!payloadResult.ok) {
          return;
        }
        const payload = payloadResult.payload as HqMailboxEventPayload;
        const sanitizedSummary = scrubAndTruncateHqPreview(payload.summary, 280);
        const sanitizedEvent =
          sanitizedSummary === undefined
            ? event
            : { ...event, payload: { ...payload, summary: sanitizedSummary } };
        persistEvent(sanitizedEvent);
        broadcastEvent(sanitizedEvent, browsers);
        return;
      }

      // ── Session telemetry — the spine of the fleet tree ────────────────
      if (event.type === 'session.snapshot' && client !== undefined) {
        const result = parseHqEventPayload(event.type, event.payload);
        if (result.ok) {
          const payload = result.payload as HqSessionSnapshotPayload;
          client.sessions.set(payload.sessionId, payload);
          snapshotBroadcaster.broadcast();
        }
        return;
      }

      if (event.type === 'session.ended' && client !== undefined) {
        const result = parseHqEventPayload(event.type, event.payload);
        if (result.ok) {
          const payload = result.payload as HqSessionEndedPayload;
          client.sessions.delete(payload.sessionId);
          snapshotBroadcaster.broadcast();
        }
        return;
      }

      // Fleet snapshots — authoritative coordinator rollups. Store per
      // (client, runId) so buildSnapshot can populate fleets[] the same way
      // it folds sessions. Validate via parseHqEventPayload so a malformed
      // snapshot cannot poison the map.
      if (event.type === 'fleet.snapshot' && client !== undefined) {
        const result = parseHqEventPayload(event.type, event.payload);
        if (result.ok) {
          const payload = result.payload as HqFleetSnapshotPayload;
          client.fleets.set(payload.runId, payload);
          snapshotBroadcaster.broadcast();
        }
        return;
      }

      if (event.type === 'session.transcript' && client !== undefined) {
        const result = parseHqEventPayload(event.type, event.payload);
        if (result.ok) {
          const payload = result.payload as HqTranscriptAppendPayload;
          let ring = transcripts.get(payload.sessionId);
          if (!ring) {
            ring = { entries: [], ...(client.machineId ? { machineId: client.machineId } : {}) };
          }
          for (const entry of payload.entries) ring.entries.push(entry);
          if (ring.entries.length > TRANSCRIPT_RING_MAX) {
            ring.entries.splice(0, ring.entries.length - TRANSCRIPT_RING_MAX);
          }
          // Re-insert to keep LRU order, then bound the number of sessions kept.
          transcripts.delete(payload.sessionId);
          transcripts.set(payload.sessionId, ring);
          evictOldest(transcripts, MAX_TRANSCRIPT_SESSIONS);
          // Forward to browsers so an open history pane streams live.
          broadcastEvent(event, browsers);
        }
        return;
      }

      // Subagent conversation — buffer per subagentId so late-connecting
      // browsers (incl. on other machines) can replay the full history.
      if (event.type === 'agent.message') {
        const p = event.payload as Record<string, unknown> | undefined;
        const subId = p && typeof p['subagentId'] === 'string' ? (p['subagentId'] as string) : undefined;
        if (subId) {
          let ring = agentMessages.get(subId);
          if (!ring) ring = [];
          ring.push(agentMessageToEntry(p as Record<string, unknown>));
          if (ring.length > TRANSCRIPT_RING_MAX) ring.splice(0, ring.length - TRANSCRIPT_RING_MAX);
          agentMessages.delete(subId);
          agentMessages.set(subId, ring);
          evictOldest(agentMessages, MAX_AGENT_RINGS);
        }
        persistEvent(event);
        broadcastEvent(event, browsers);
        return;
      }

      // Other event types pass through unchanged.
      persistEvent(event);
      broadcastEvent(event, browsers);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    snapshotBroadcaster.broadcast();
  });
}

/**
 * Stable per-machine key. Prefers hostname so the same physical computer maps
 * to one machine even when clients report different per-process machineIds
 * (older builds hashed `hostname:pid`). Falls back to machineId.
 */
function hqMachineKey(hostname: string | undefined, machineId: string | undefined): string {
  const hn = hostname?.trim();
  return hn ? `host:${hn.toLowerCase()}` : `mid:${machineId || 'local'}`;
}

/**
 * Fold a cost/tool signal from an event envelope into the timeseries store.
 * Recognizes `session.usage` (cost/tokens) and `tool.completed` (tool call).
 * Best-effort, never throws.
 */
function recordTimeseriesSignal(persistence: HqPersistence, event: HqEventEnvelope): void {
  try {
    if (event.type === 'session.usage') {
      const p = event.payload as { costUsd?: number; inputTokens?: number; outputTokens?: number };
      persistence.timeseries.record({
        ts: Date.parse(event.timestamp) || Date.now(),
        ...(typeof p.costUsd === 'number' ? { costUsd: p.costUsd } : {}),
        ...(typeof p.inputTokens === 'number' ? { inputTokens: p.inputTokens } : {}),
        ...(typeof p.outputTokens === 'number' ? { outputTokens: p.outputTokens } : {}),
      });
    } else if (event.type === 'tool.completed') {
      persistence.timeseries.record({
        ts: Date.parse(event.timestamp) || Date.now(),
        toolCalls: 1,
      });
    }
  } catch {
    /* best-effort */
  }
}

function buildSnapshot(clients: Map<WebSocket, ConnectedClient>): HqSnapshot {
  const now = new Date().toISOString();
  // Dedupe client records by clientId — one process may hold two sockets (a
  // mailbox publisher + a telemetry publisher) sharing the same clientId.
  const clientRecordById = new Map<string, HqClientRecord>();
  const projectMap = new Map<string, HqProjectRecord>();
  const mailboxSummaries: HqMailboxSummary[] = [];
  // Live sessions, deduped by sessionId across sockets (latest wins).
  const sessionById = new Map<string, HqSessionSnapshotPayload>();
  // Fleet snapshots, deduped by runId across sockets (latest wins).
  const fleetByRunId = new Map<string, { payload: HqFleetSnapshotPayload; clientId: string; projectId: string; lastActivityAt: string }>();

  for (const client of clients.values()) {
    const machineId = client.machineId || client.project.machineId || '';
    if (!clientRecordById.has(client.clientId)) {
      clientRecordById.set(client.clientId, {
        clientId: client.clientId,
        kind: client.kind as HqClientRecord['kind'],
        machineId,
        ...(client.hostname ? { hostname: client.hostname } : {}),
        ...(client.pid ? { pid: client.pid } : {}),
        ...(client.version ? { version: client.version } : {}),
        connected: true,
        connectedAt: client.connectedAt,
        lastSeenAt: client.lastSeenAt,
        projectId: client.projectId,
        capabilities: client.capabilities as readonly HqClientCapability[],
      });
    }

    let project = projectMap.get(client.projectId);
    if (!project) {
      project = {
        projectId: client.projectId,
        projectName: client.project.projectName || client.projectId,
        projectRootDisplay: client.project.projectRoot,
        machineIds: [machineId],
        ...(client.project.gitBranch ? { gitBranch: client.project.gitBranch } : {}),
        activeClients: 0,
        activeSessions: 0,
        activeSubagents: 0,
        totalCostUsd: 0,
        lastActivityAt: now,
        status: 'active',
      };
      projectMap.set(client.projectId, project);
    } else if (machineId && !project.machineIds.includes(machineId)) {
      project.machineIds = [...project.machineIds, machineId];
    }

    for (const session of client.sessions.values()) {
      sessionById.set(session.sessionId, session);
    }

    for (const snapshot of client.mailboxes.values()) {
      mailboxSummaries.push({
        mailboxId: snapshot.mailboxId,
        projectId: client.projectId,
        scope: snapshot.scope,
        messageCount: snapshot.totals.messages,
        unreadCount: snapshot.totals.unread,
        incompleteCount: snapshot.totals.incomplete,
        highPriorityCount: snapshot.totals.highPriority,
        onlineAgentCount: snapshot.totals.onlineAgents,
        lastActivityAt: now,
      });
    }

    // Collect fleet snapshots — latest per runId wins.
    for (const fleet of client.fleets.values()) {
      fleetByRunId.set(fleet.runId, { payload: fleet, clientId: client.clientId, projectId: client.projectId, lastActivityAt: now });
    }
  }

  // Per-project active-client counts from deduped client records.
  for (const rec of clientRecordById.values()) {
    const project = projectMap.get(rec.projectId);
    if (project) project.activeClients++;
  }

  // Fold live sessions into projects + machines.
  const liveSessions = Array.from(sessionById.values());
  const machineMap = new Map<string, { record: HqMachineRecord; projects: Set<string> }>();
  let totalAgents = 0;
  let totalSubagents = 0;
  let totalCostUsd = 0;

  for (const session of liveSessions) {
    // Ensure the project exists even if only a session (no mailbox/client
    // record under this projectId yet) reported it.
    let project = projectMap.get(session.projectId);
    if (!project) {
      project = {
        projectId: session.projectId,
        projectName: session.projectName || session.projectId,
        projectRootDisplay: session.projectRoot,
        machineIds: [session.machineId],
        ...(session.gitBranch ? { gitBranch: session.gitBranch } : {}),
        activeClients: 0,
        activeSessions: 0,
        activeSubagents: 0,
        totalCostUsd: 0,
        lastActivityAt: session.lastActivityAt,
        status: 'active',
      };
      projectMap.set(session.projectId, project);
    } else if (session.machineId && !project.machineIds.includes(session.machineId)) {
      project.machineIds = [...project.machineIds, session.machineId];
    }
    project.activeSessions++;

    let sessionCost = 0;
    for (const agent of session.agents) {
      totalAgents++;
      if (agent.id !== 'leader') totalSubagents++;
      if (typeof agent.costUsd === 'number') {
        sessionCost += agent.costUsd;
      }
    }
    project.activeSubagents += session.agents.filter((a) => a.id !== 'leader').length;
    project.totalCostUsd += sessionCost;
    totalCostUsd += sessionCost;

    // Machine aggregation — keyed by hostname so the SAME computer is one
    // machine even when clients report different per-process machineIds.
    const mKey = hqMachineKey(session.hostname, session.machineId);
    let machine = machineMap.get(mKey);
    if (!machine) {
      machine = {
        record: {
          machineId: session.machineId,
          ...(session.hostname ? { hostname: session.hostname } : {}),
          clientCount: 0,
          sessionCount: 0,
          agentCount: 0,
          projectIds: [],
          lastActivityAt: session.lastActivityAt,
        },
        projects: new Set<string>(),
      };
      machineMap.set(mKey, machine);
    }
    machine.record.sessionCount++;
    machine.record.agentCount += session.agents.length;
    machine.projects.add(session.projectId);
    if (session.lastActivityAt > machine.record.lastActivityAt) {
      machine.record.lastActivityAt = session.lastActivityAt;
    }
  }

  // Attribute connected clients to machines too (so a machine with a client
  // but no session yet still appears).
  for (const rec of clientRecordById.values()) {
    if (!rec.machineId && !rec.hostname) continue;
    const rKey = hqMachineKey(rec.hostname, rec.machineId);
    let machine = machineMap.get(rKey);
    if (!machine) {
      machine = {
        record: {
          machineId: rec.machineId,
          ...(rec.hostname ? { hostname: rec.hostname } : {}),
          clientCount: 0,
          sessionCount: 0,
          agentCount: 0,
          projectIds: [],
          lastActivityAt: rec.lastSeenAt,
        },
        projects: new Set<string>(),
      };
      machineMap.set(rKey, machine);
    }
    machine.record.clientCount++;
    machine.projects.add(rec.projectId);
    if (rec.hostname && !machine.record.hostname) machine.record.hostname = rec.hostname;
  }

  const machines: HqMachineRecord[] = Array.from(machineMap.values()).map((m) => ({
    ...m.record,
    projectIds: Array.from(m.projects),
  }));

  const clientRecords = Array.from(clientRecordById.values());
  const projects = Array.from(projectMap.values());

  let unread = 0;
  let incomplete = 0;
  for (const m of mailboxSummaries) {
    unread += m.unreadCount;
    incomplete += m.incompleteCount;
  }

  // Derive session summaries from live sessions (the spine of the fleet tree)
  // so the dashboard's sessions[] rollup is populated alongside liveSessions.
  const sessions: HqSessionSummary[] = liveSessions.map((s) => {
    let sessionCost = 0;
    for (const agent of s.agents) {
      if (typeof agent.costUsd === 'number') sessionCost += agent.costUsd;
    }
    const provider = s.agents.find((a) => a.model !== undefined)?.model;
    return {
      sessionId: s.sessionId,
      projectId: s.projectId,
      clientId: `${s.machineId}:${s.clientKind}`,
      status: s.status === 'active' ? 'running' : 'idle',
      ...(provider !== undefined ? { model: provider } : {}),
      startedAt: s.startedAt,
      lastActivityAt: s.lastActivityAt,
      ...(sessionCost > 0 ? { costUsd: sessionCost } : {}),
    };
  });

  // Derive fleet summaries from collected coordinator snapshots so the
  // dashboard's fleets[] rollup reflects every connected machine's fleet.
  const fleets: HqFleetSummary[] = Array.from(fleetByRunId.values()).map((f) => ({
    runId: f.payload.runId,
    projectId: f.projectId,
    clientId: f.clientId,
    activeSubagents: f.payload.activeSubagents,
    queuedTasks: f.payload.queuedTasks,
    completedTasks: f.payload.completedTasks,
    failedTasks: f.payload.failedTasks,
    ...(f.payload.totalCostUsd !== undefined ? { totalCostUsd: f.payload.totalCostUsd } : {}),
    lastActivityAt: f.lastActivityAt,
  }));

  return {
    generatedAt: now,
    clients: clientRecords,
    projects,
    sessions,
    fleets,
    mailboxes: mailboxSummaries,
    machines,
    liveSessions,
    totals: {
      activeProjects: projects.length,
      activeClients: clientRecords.length,
      activeSessions: liveSessions.length,
      activeSubagents: totalSubagents,
      unreadMailboxMessages: unread,
      incompleteMailboxMessages: incomplete,
      totalCostUsd,
      activeMachines: machines.length,
      activeAgents: totalAgents,
    },
  };
}

interface HqSnapshotBroadcaster {
  currentSerialized(): string;
  broadcast(): void;
  close(): void;
}

const HQ_SNAPSHOT_BROADCAST_DEBOUNCE_MS = 250;

function createSnapshotBroadcaster(
  clients: Map<WebSocket, ConnectedClient>,
  browsers: Set<WebSocket>,
  persistence?: HqPersistence,
): HqSnapshotBroadcaster {
  let cached = '';
  let dirty = true;
  let timer: NodeJS.Timeout | null = null;

  const serialize = (): string => {
    if (!dirty && cached.length > 0) return cached;
    const snapshot = buildSnapshot(clients);
    const msg: HqBrowserMessage = { type: 'hq.snapshot', snapshot };
    cached = JSON.stringify(msg);
    dirty = false;
    // Persist the snapshot checkpoint (best-effort, fire-and-forget) so a
    // restarted HQ can re-seed its in-memory state from disk.
    if (persistence !== undefined) persistence.snapshotStore.save(snapshot);
    return cached;
  };

  const flush = (): void => {
    timer = null;
    if (browsers.size === 0) return;
    const data = serialize();
    for (const ws of browsers) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  };

  return {
    currentSerialized: serialize,
    broadcast: () => {
      dirty = true;
      if (timer !== null) return;
      timer = setTimeout(flush, HQ_SNAPSHOT_BROADCAST_DEBOUNCE_MS);
      timer.unref?.();
    },
    close: () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

interface ProjectDetail {
  generatedAt: string;
  project: HqProjectRecord;
  clients: readonly HqClientRecord[];
  mailboxes: readonly HqMailboxSnapshotPayload[];
}

function buildProjectDetail(
  clients: Map<WebSocket, ConnectedClient>,
  projectId: string,
): ProjectDetail | null {
  const projectClients: ConnectedClient[] = [];
  for (const c of clients.values()) {
    if (c.projectId === projectId) projectClients.push(c);
  }
  if (projectClients.length === 0) return null;

  const now = new Date().toISOString();
  const clientRecords: HqClientRecord[] = projectClients.map((c) => ({
    clientId: c.clientId,
    kind: c.kind as HqClientRecord['kind'],
    machineId: '',
    ...(c.hostname ? { hostname: c.hostname } : {}),
    ...(c.pid ? { pid: c.pid } : {}),
    ...(c.version ? { version: c.version } : {}),
    connected: true,
    connectedAt: c.connectedAt,
    lastSeenAt: c.lastSeenAt,
    projectId: c.projectId,
    capabilities: c.capabilities as readonly HqClientCapability[],
  }));

  const mailboxPayloads: HqMailboxSnapshotPayload[] = [];
  let latestActivity = now;
  for (const c of projectClients) {
    for (const snap of c.mailboxes.values()) {
      mailboxPayloads.push(snap);
      if (snap.totals.messages > 0) latestActivity = now;
    }
  }

  const primaryProject = projectClients[0]!.project;
  const machineIds = Array.from(new Set(projectClients.map((client) => client.project.machineId)));
  const project: HqProjectRecord = {
    projectId,
    projectName: primaryProject.projectName || projectId,
    projectRootDisplay: primaryProject.projectRoot,
    machineIds,
    ...(primaryProject.gitBranch ? { gitBranch: primaryProject.gitBranch } : {}),
    activeClients: projectClients.length,
    activeSessions: 0,
    activeSubagents: 0,
    totalCostUsd: 0,
    lastActivityAt: latestActivity,
    status: 'active',
  };

  return {
    generatedAt: now,
    project,
    clients: clientRecords,
    mailboxes: mailboxPayloads,
  };
}

function broadcastEvent(event: HqEventEnvelope, browsers: Set<WebSocket>): void {
  const msg: HqBrowserMessage = { type: 'hq.event', event };
  const data = JSON.stringify(msg);
  for (const ws of browsers) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

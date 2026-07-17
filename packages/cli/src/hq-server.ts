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
import * as path from 'node:path';
import {
  DEFAULT_HQ_REDACTION_POLICY,
  type EnsureHqFirstRunAuthResult,
  type HqEventEnvelope,
  type HqFleetSnapshotPayload,
  type HqMailboxSnapshotPayload,
  type HqMcpServerHealth,
  type HqProjectIdentity,
  type HqRedactionPolicy,
  type HqSessionSnapshotPayload,
  type HqTimeseriesSample,
  type HqToken,
  type HqTranscriptEntry,
  buildTranscriptFromEvents,
  createHqPersistence,
  createMailboxHttpRouter,
  GlobalMailbox,
  MailboxEventEmitter,
  type MailboxHttpAccessDecision,
  MailboxHttpRateLimiter,
  resolveProjectDir,
  HqCommandAuditLog,
  HqAlertEngine,
  toAlertMessage,
  type HqAlertRuleConfig,
  type HqAlert,
  type HqCommand,
  type HqCommandAuditEntry,
  type HqQueuedCommand,
  assessHqExposure,
  HqInsecureExposureError as HqInsecureExposureErrorClass,
  ensureHqFirstRunAuthFile,
  validateHqCommand,
  verifyHqPassword,
  resolveHqDataDir,
  tokenHasCapability,
  watchHqAuthFile,
} from '@wrongstack/core';
// Pre-extracted modules under hq-server/ — local function definitions in this file
// delegate to the extracted implementations. The const-aliases preserve backward
// compatibility for internal callers. See hq-server/auth.ts, utils.ts, ws.ts, snapshot.ts.
import * as HqServerAuth from './hq-server/auth.js';
import * as HqServerUtils from './hq-server/utils.js';
import * as HqServerWs from './hq-server/ws.js';
import * as HqServerSnapshot from './hq-server/snapshot.js';


// Inlined from @wrongstack/webui-server — avoids a hard dependency on the webui package.
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
  /** Browser liveness frame interval. Primarily exposed for deterministic integration tests. */
  browserHeartbeatIntervalMs?: number;
  /** Connected-client inactivity timeout. Primarily exposed for deterministic integration tests. */
  clientTtlMs?: number;
  /** Stale-client scan interval. Primarily exposed for deterministic integration tests. */
  clientCleanupIntervalMs?: number;
  /** Session-snapshot freshness timeout. Primarily exposed for deterministic integration tests. */
  sessionSnapshotTtlMs?: number;
  /** Optional browser password login. When provided on first-run, the auth file stores a scrypt hash. */
  password?: string;
  /**
   * Allow a non-loopback bind while HQ is in open mode (no tokens, no
   * password). Off by default: that pairing serves POST /api/command
   * unauthenticated to the whole network. See assessHqExposure.
   */
  allowInsecureOpen?: boolean;
  /**
   * Set `Secure` flag on session cookies. Enable this when HQ is behind a
   * TLS-terminating reverse proxy. Defaults to `false` because HQ speaks
   * plain HTTP; setting `Secure` on an HTTP cookie makes it invisible to
   * the browser.
   */
  secureCookies?: boolean;
}

export { HqInsecureExposureError } from '@wrongstack/core';

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

interface TrackedSessionSnapshot {
  payload: HqSessionSnapshotPayload;
  /** Epoch ms of the last `session.snapshot` refresh — freshness authority for the cleanup timer. */
  receivedAt: number;
}

interface TrackedFleetSnapshot {
  payload: HqFleetSnapshotPayload;
  sessionId?: string;
  receivedAt: number;
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
  /** Auth token used for this socket; absent only in explicit open mode. */
  authToken?: HqToken;
  /** Client-declared privacy policy; operator overrides are clamped dynamically. */
  declaredRedactionPolicy: HqRedactionPolicy;
  /** Highest accepted event sequence for replay/duplicate protection. */
  lastEventSeq: number;
  /**
   * Latest mailbox snapshot keyed by mailboxId — replaces (not merges) on
   * each new `mailbox.snapshot` envelope from this client.
   */
  mailboxes: Map<string, HqMailboxSnapshotPayload>;
  machineId?: string;
  /**
   * Latest live session/terminal snapshot keyed by sessionId — replaced on
   * each `session.snapshot` envelope and removed on `session.ended`, or by
   * the cleanup timer once it goes {@link SESSION_SNAPSHOT_TTL_MS} without a
   * refresh (dead bridge on a still-heartbeating socket).
   */
  sessions: Map<string, TrackedSessionSnapshot>;
  /**
   * Latest fleet (multi-agent coordinator) snapshot keyed by runId —
   * replaced on each `fleet.snapshot` envelope from this client. Feeds the
   * `fleets[]` rollup in {@link buildSnapshot}.
   */
  fleets: Map<string, TrackedFleetSnapshot>;
  /**
   * Latest MCP operational-health snapshot keyed by sessionId — replaced on
   * each `mcp.health.snapshot` envelope from this client. Feeds the
   * `mcpServers[]` rollup in {@link buildSnapshot}.
   */
  mcpSnapshots: Map<string, HqMcpServerHealth[]>;
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
/** Bound how many distinct sessions/subagents we keep transcripts for, so a
 * long-lived HQ doesn't accumulate rings for every session that ever connected.
 * Eviction is least-recently-active (the maps are kept in LRU order). */



interface TranscriptRing {
  entries: HqTranscriptEntry[];
  /** machineId of the publishing client, so the server can tell local from remote. */
  machineId?: string;
}

/**
 * Ring key for one subagent's transcript. Scoped by session so same-named
 * agents in different sessions (every leader is id 'leader') stay separate.
 * Falls back to the bare subId when no session id is known (legacy clients).
 */
function agentRingKey(sessionId: string | undefined, subId: string): string {
  return sessionId !== undefined && sessionId.length > 0 ? `${sessionId}::${subId}` : subId;
}

/** Map a raw `agent.message` payload to a transcript entry for the subagent
 *  ring. Mirrors the client's entryFromAgentMessage so a disk replay renders
 *  identically to the live stream (thinking→thinking, system/status→system). */
function agentMessageToEntry(p: Record<string, unknown>): HqTranscriptEntry {
  const kind = typeof p['kind'] === 'string' ? p['kind'] : 'text';
  const role: HqTranscriptEntry['role'] =
    kind === 'thinking'
      ? 'thinking'
      : kind === 'tool_use' || kind === 'tool_result'
        ? 'tool'
        : kind === 'error'
          ? 'error'
          : kind === 'status' || kind === 'system'
            ? 'system'
            : 'assistant';
  return {
    ts: typeof p['ts'] === 'string' ? p['ts'] : new Date().toISOString(),
    role,
    text: typeof p['content'] === 'string' ? p['content'] : '',
    ...(typeof p['toolName'] === 'string' ? { tool: p['toolName'] } : {}),
    ...(kind === 'error' ? { isError: true } : {}),
  };
}

/**
 * Read one local subagent's FULL conversation from disk. The agent monitor
 * writes every timeline entry to
 *   <projectSessions>/<sessionId>/subagents/transcripts/<subId>/transcript.jsonl
 * so for sessions on THIS machine we can serve the complete history — not
 * just the ≤4000-entry live ring. Returns null when the session isn't local
 * or the file is absent (caller falls back to the ring).
 */
export async function readLocalSubagentTranscript(
  sessionId: string,
  subagentId: string,
): Promise<HqTranscriptEntry[] | null> {
  try {
    const { SessionRegistry, resolveWstackPaths, sessionScopedPath } = await import(
      '@wrongstack/core'
    );
    const globalRoot = path.dirname(resolveHqDataDir());
    const registry = new SessionRegistry(globalRoot);
    const entry = await registry.get(sessionId).catch(() => null);
    if (!entry) return null; // remote session — no local disk to read
    const paths = resolveWstackPaths({ projectRoot: entry.projectRoot, globalRoot });
    const sessionDir = sessionScopedPath(paths.projectSessions, sessionId, '');
    const file = path.join(sessionDir, 'subagents', 'transcripts', subagentId, 'transcript.jsonl');
    const raw = await fs.readFile(file, 'utf8').catch(() => null);
    if (raw === null) return null;
    const out: HqTranscriptEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        out.push(agentMessageToEntry(JSON.parse(trimmed) as Record<string, unknown>));
      } catch {
        // Skip a torn/partial trailing line — best-effort replay.
      }
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Library default: loopback. `startHqServer` is called programmatically
 * (tests, embedders) as well as from the CLI, and a caller that never
 * mentions a host has not asked to be reachable from the network.
 *
 * HQ is still the deliberate cross-machine surface — the CLI entry points
 * (`wstack hq`, the launch menu) pass HQ_CLI_DEFAULT_HOST explicitly, so
 * `wstack hq` binds every interface with no extra flag. Keeping the wide
 * bind at the CLI edge rather than in this default is what stops an
 * unrelated embedder from silently publishing HQ to its whole network.
 */
export const DEFAULT_HOST = '127.0.0.1';
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
const BROWSER_HEARTBEAT_INTERVAL_MS = 15_000;
/**
 * Session-snapshot freshness timeout. A live SessionTelemetryBridge
 * republishes its `session.snapshot` every ~2.5s, so a snapshot that hasn't
 * been refreshed within this window belongs to a bridge that died without a
 * final `session.ended` (crash, dropped queue). Without this, the terminal
 * would stay in the fleet tree forever as long as ANY traffic (e.g.
 * `client.heartbeat`) keeps the owning socket alive.
 */
const SESSION_SNAPSHOT_TTL_MS = 30_000;

const setHqSecurityHeaders = HqServerAuth.setHqSecurityHeaders;
/** Allow non-browser clients (no Origin) and same-host browser traffic only. */
const hasTrustedBrowserOrigin = HqServerAuth.hasTrustedBrowserOrigin;
const HQ_SESSION_COOKIE = 'hq.session';
/** Browser-session Max-Age (7 days) — see setHqSessionCookie Max-Age. */
const HQ_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const serializeHqSessionCookie = HqServerAuth.serializeHqSessionCookie;
const parseHqSessionCookie = HqServerAuth.parseHqSessionCookie;
const parseCookieHeader = HqServerAuth.parseCookieHeader;
const setHqSessionCookie = HqServerAuth.setHqSessionCookie;
const clearHqSessionCookie = HqServerAuth.clearHqSessionCookie;



const isTokenAuth = HqServerAuth.isTokenAuth;
const authenticateBrowserRequest = HqServerAuth.authenticateBrowserRequest;
const decodePathSegment = HqServerUtils.decodePathSegment;
const displayHost = HqServerUtils.displayHost;
/** Read the full body of an HTTP request as a UTF-8 string (capped at 1 MB). */


const readRequestBody = HqServerUtils.readRequestBody;
const writeInvalidBody = HqServerUtils.writeInvalidBody;
const buildHttpUrl = HqServerUtils.buildHttpUrl;
const buildClientWsUrl = HqServerUtils.buildClientWsUrl;
interface HqRuntimeMarker {
  url?: string;
  pid?: number;
  updatedAt?: string;
}

const hqRuntimeMarkerPath = HqServerUtils.hqRuntimeMarkerPath;
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
const lanIPv4Addresses = HqServerUtils.lanIPv4Addresses;
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
    write(`Credentials are stored in ${path.join(startup.dataDir, 'auth.json')}\n`);
  }
  writeHqLanEndpoints(write, handle, undefined);
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

/**
 * Resolve a projectRoot from a sessionId or an HQ projectId via the
 * SessionRegistry — authoritative, so a browser can never supply a raw
 * filesystem path. `projectId` is matched against BOTH id schemes in the
 * wild: the registry `projectSlug` (used by session telemetry) and the
 * `sha256(projectRoot)[:12]` hash HQ publishers stamp on event envelopes.
 */
async function resolveHqProjectRoot(
  globalRoot: string,
  ids: { sessionId?: string | undefined; projectId?: string | undefined },
): Promise<string | undefined> {
  const { SessionRegistry } = await import('@wrongstack/core');
  try {
    const registry = new SessionRegistry(globalRoot);
    if (typeof ids.sessionId === 'string') {
      const entry = await registry.get(ids.sessionId).catch(() => null);
      if (entry?.projectRoot) return entry.projectRoot;
    }
    if (typeof ids.projectId === 'string') {
      const { createHash } = await import('node:crypto');
      const all = await registry.list().catch(() => []);
      const match = all.find(
        (e) =>
          e.projectSlug === ids.projectId ||
          createHash('sha256').update(e.projectRoot).digest('hex').slice(0, 12) === ids.projectId,
      );
      if (match) return match.projectRoot;
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

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
    console.warn(JSON.stringify({ level: 'warn', event: 'hq.api_error', route: '/api/sessions', detail: String(err), timestamp: new Date().toISOString() }));
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: HqServerUtils.sanitizeApiError(err) }));
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
    console.warn(JSON.stringify({ level: 'warn', event: 'hq.api_error', route: '/api/sessions/:id/events', detail: String(err), timestamp: new Date().toISOString() }));
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: HqServerUtils.sanitizeApiError(err) }));
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
    ...(options.password !== undefined ? { password: options.password } : {}),
  });

  // Guard the bind before listening. Both entry points (`wstack hq` and the
  // launch menu) funnel through here, so this is the one place that sees the
  // resolved host and the resolved auth together.
  const exposure = assessHqExposure({
    host,
    hasBrowserTokens: (firstRunAuth.authFile.browserTokens ?? []).length > 0,
    hasPassword: firstRunAuth.authFile.passwordHash !== undefined,
    allowInsecure: options.allowInsecureOpen,
  });
  if (exposure.kind === 'refuse') {
    throw new HqInsecureExposureErrorClass(exposure.message);
  }
  if (exposure.kind === 'warn') {
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'hq.insecure_exposure',
      message: exposure.message,
      host,
      timestamp: new Date().toISOString(),
    }));
  }

  return startHqServerWithAuth(options, host, port, dataDir, firstRunAuth);
}

/**
 * Extract a browser token from an HTTP request. Accepts:
 *   1. `?token=…` query parameter (for browser navigation / dashboard)
 *   2. `Authorization: Bearer …` header (for programmatic / curl access)
 * Returns the token string if found, otherwise `undefined`.
 */
function startHqServerWithAuth(
  options: HqServerOptions,
  host: string,
  port: number,
  dataDir: string,
  firstRunAuth: EnsureHqFirstRunAuthResult,
): Promise<HqServerHandle> {
  const authFile = firstRunAuth.authFile;
  // Operator override merges over the default; publisher claims are
  // clamped against this at broadcast time (event redaction call sites +
  // the welcome handshake redactionPolicy field).
  // Mutable: the file-watcher below refreshes these on auth.json change
  // (Phase 4 live reload).
  const mutableAuth: {
    operatorPolicy: HqRedactionPolicy;
    operatorPolicyOverride: Partial<HqRedactionPolicy> | undefined;
    browserTokens: Set<string>;
    clientTokens: Set<string>;
    /** Browser token objects keyed by token string — for capability checks. */
    browserTokenObjs: Map<string, { id: string; capabilities?: string[] }>;
    clientTokenObjs: Map<string, HqToken>;
    passwordHash?: string | undefined;
    cookieSecret?: string | undefined;
    /** Operator-configured alert-rule thresholds, live-reloaded. */
    alertRules: HqAlertRuleConfig | undefined;
  } = {
    operatorPolicy: {
      ...DEFAULT_HQ_REDACTION_POLICY,
      ...(authFile.redactionPolicy ?? {}),
    },
    operatorPolicyOverride: authFile.redactionPolicy,
    browserTokens: new Set((authFile.browserTokens ?? []).map((t) => t.token)),
    clientTokens: new Set((authFile.clientTokens ?? []).map((t) => t.token)),
    browserTokenObjs: new Map(
      (authFile.browserTokens ?? []).map((t) => [t.token, { id: t.id, ...(t.capabilities !== undefined ? { capabilities: t.capabilities } : {}) }]),
    ),
    clientTokenObjs: new Map((authFile.clientTokens ?? []).map((token) => [token.token, token])),
    passwordHash: authFile.passwordHash,
    cookieSecret: authFile.cookieSecret,
    alertRules: authFile.alertRules,
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
    passwordMode: mutableAuth.passwordHash !== undefined,
    timestamp: new Date().toISOString(),
  }));
  void options;

  return new Promise((resolve, reject) => {
    const clients = new Map<WebSocket, ConnectedClient>();
    const browsers = new Set<WebSocket>();
    const sessions = new Map<string, { createdAt: number }>();
    const eventLog: HqEventEnvelope[] = [];
    const transcripts = new Map<string, TranscriptRing>();
    // Per-subagent message history (keyed by subagentId), fed by agent.message
    // events so a late-connecting browser — including one on another machine —
    // can replay a subagent's full conversation, not just messages seen live.
    const agentMessages = new Map<string, HqTranscriptEntry[]>();
    // Lazily-created local mailbox services used by the project-scoped HQ
    // gateway. Keeping one instance per project is required for SSE: writes
    // and subscribers must share the same MailboxEventEmitter.
    const mailboxGateways = new Map<
      string,
      {
        mailbox: GlobalMailbox;
        router: ReturnType<typeof createMailboxHttpRouter>;
      }
    >();
    const mailboxGatewayRateLimiter = new MailboxHttpRateLimiter();
    const mailboxGatewayRateLimitCleanup = setInterval(
      () => mailboxGatewayRateLimiter.cleanup(),
      120_000,
    );
    mailboxGatewayRateLimitCleanup.unref?.();

    // ── Login rate limiting ────────────────────────────────────────────────
    // Exponential backoff for password login: 1s → 2s → 4s → 8s → 16s (cap).
    // Uses the client IP for tracking; on loopback this is always ::1 or
    // 127.0.0.1, so repeated failures from the same machine are gated —
    // enough to blunt a brute-force without needing a full account lockout
    // or persisted state. Cleaned up alongside the session sweep below.
    const loginAttempts = new Map<string, { count: number; blockedUntil: number }>();

    // ── Browser-session lifecycle ──────────────────────────────────────────
    // Sessions live inside a Map with { createdAt } but no server-side
    // expiry. Sweep stale entries every 60 s so a copied/leaked cookie
    // cannot be used past the Max-Age window even if the process stays up.
    const SESSION_CLEANUP_INTERVAL_MS = 60_000;
    const sessionCleanupTimer = setInterval(() => {
      const cutoff = Date.now() - HQ_SESSION_MAX_AGE_MS;
      for (const [id, session] of sessions) {
        if (session.createdAt < cutoff) sessions.delete(id);
      }
      // Also sweep expired rate-limit blocks so the map doesn't grow unbounded.
      const now = Date.now();
      for (const [ip, entry] of loginAttempts) {
        if (entry.blockedUntil < now) loginAttempts.delete(ip);
      }
    }, SESSION_CLEANUP_INTERVAL_MS);
    sessionCleanupTimer.unref?.();

    // ── Persistence (Phase 2) ──────────────────────────────────────────────
    // Survives restart: event log, snapshot checkpoint, cost/activity trends.
    // All writes are best-effort and fire-and-forget so the server hot path is
    // never blocked. Hydrated from disk on boot so a restarted HQ shows prior
    // history immediately. Declared before the snapshot broadcaster because
    // the broadcaster checkpoints into the snapshot store on each serialize.
    const persistence = createHqPersistence(dataDir);
    // Command audit ring + durable sink. Every record/update persists the
    // latest entry snapshot to commands.jsonl so history survives restarts.
    const auditLog = new HqCommandAuditLog(
      1000,
      (entry) => persistence.commandLog.append(entry),
    );

    // Presence files predate HQ and may contain records from processes that
    // died days ago. Sweep every project once at startup so this upgrade
    // physically removes accumulated stale agents/clients, not merely hides
    // them from the current dashboard snapshot.
    void (async () => {
      const projectsDir = path.join(path.dirname(dataDir), 'projects');
      const entries = await fs.readdir(projectsDir, { withFileTypes: true }).catch(() => []);
      const { GlobalMailbox } = await import('@wrongstack/core');
      await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => {
            const mailbox = new GlobalMailbox(path.join(projectsDir, entry.name));
            await Promise.all([mailbox.getAgentStatuses(), mailbox.purgeClients()]);
          }),
      );
    })().catch(() => {
      // Best-effort cleanup must never delay or fail HQ startup.
    });
    // Stable mailbox identity for direct HQ writes (/api/mailbox-send). Lets
    // recipients attribute a zero-client HQ prompt to this server instance.
    const hqSessionTag = randomUUID().slice(0, 8);

    const authorizeMailboxGateway = (
      request: http.IncomingMessage,
      projectDir: string,
    ): MailboxHttpAccessDecision => {
      const requestUrl = new URL(request.url ?? '/', `http://${host}:${port}`);
      const auth = authenticateBrowserRequest(request, requestUrl, mutableAuth, sessions);
      const tokenMode = mutableAuth.browserTokens.size > 0;
      const passwordMode = mutableAuth.passwordHash !== undefined;
      if ((tokenMode || passwordMode) && auth === undefined) {
        return {
          allowed: false,
          status: 401,
          body: { error: { code: 'UNAUTHORIZED', message: 'unauthorized' } },
        };
      }
      const token = isTokenAuth(auth)
        ? mutableAuth.browserTokenObjs.get(auth.token)
        : undefined;
      const canUseMailbox =
        auth === 'cookie' ||
        !tokenMode ||
        token?.capabilities === undefined ||
        token.capabilities.includes('control.enqueue');
      if (!canUseMailbox) {
        return {
          allowed: false,
          status: 403,
          body: {
            error: {
              code: 'FORBIDDEN',
              message: 'forbidden: token lacks control.enqueue capability',
            },
          },
        };
      }
      const identity = isTokenAuth(auth) ? auth.id : auth === 'cookie' ? 'cookie' : 'open';
      return { allowed: true, rateLimitKey: `hq:${identity}:${projectDir}` };
    };

    const getMailboxGateway = (projectDir: string) => {
      const existing = mailboxGateways.get(projectDir);
      if (existing) return existing;

      const eventEmitter = new MailboxEventEmitter();
      const mailbox = new GlobalMailbox(projectDir, undefined, undefined, eventEmitter);
      const router = createMailboxHttpRouter({
        mailbox,
        eventEmitter,
        rateLimiter: mailboxGatewayRateLimiter,
        authorize: (request) => authorizeMailboxGateway(request, projectDir),
      });
      const gateway = { mailbox, router };
      mailboxGateways.set(projectDir, gateway);
      return gateway;
    };

    // ── Alerting — evaluates the live snapshot against rules and broadcasts
    // `hq.alert` to browsers when a threshold is crossed. Fired alerts are also
    // persisted to alerts.jsonl so history survives restarts.
    const alertEngine = new HqAlertEngine({
      onAlert: (alert) => {
        const msg = toAlertMessage(alert);
        const data = JSON.stringify(msg);
        for (const ws of browsers) {
          if (ws.readyState === WebSocket.OPEN) ws.send(data);
        }
      },
      onPersist: (alert) => persistence.alertLog.append(alert),
    });
    void persistence.eventLog.hydrate();
    void persistence.timeseries.load();
    // Seed the in-memory eventLog from the persisted log so a restarted HQ
    // shows recent history in the dashboard before new events arrive.
    persistence.eventLog.recent(MAX_EVENT_LOG).then((prior) => {
      // Newest-first from recent(); push oldest-first into the in-memory ring.
      for (let i = prior.length - 1; i >= 0; i--) eventLog.push(prior[i]!);
    }).catch(() => { /* best-effort */ });
    // Seed alert history + command audit from their durable logs so the
    // dashboard keeps its past after an HQ restart.
    persistence.alertLog.readAll().then((prior) => {
      alertEngine.seed(prior as readonly HqAlert[]);
    }).catch(() => { /* best-effort */ });
    persistence.commandLog.readAll().then((prior) => {
      auditLog.seed(prior as readonly HqCommandAuditEntry[]);
    }).catch(() => { /* best-effort */ });

    // Flush the timeseries store every 60s so buckets reach disk periodically
    // even under light load. Unref'd so it never keeps the process alive.
    const timeseriesFlushTimer = setInterval(() => {
      persistence.timeseries.flush();
    }, 60_000);
    timeseriesFlushTimer.unref?.();

    const snapshotBroadcaster = createSnapshotBroadcaster(clients, browsers, persistence);
    // Replace any prior-run checkpoint immediately. Persisted snapshots are a
    // cache, never a source of live presence.
    snapshotBroadcaster.currentSerialized();

    // Start periodic alert evaluation against the latest snapshot. The engine
    // reads the snapshot fresh on each tick (15s, unref'd) so alerts reflect
    // current state. Dedup prevents alert storms — only transitions emit.
    // Rule thresholds are read from auth.json's `alertRules` on each tick so
    // an operator editing the file sees the change without a restart.
    const stopAlertEngine = alertEngine.startPeriodic(
      () => buildSnapshot(clients),
      (): HqAlertRuleConfig | undefined => mutableAuth.alertRules,
    );
    // Stale-client cleanup: periodically evict clients that have gone silent.
    // This catches crash / network-drop disconnects where the remote never
    // sent a WebSocket close frame, so the 'close' event never fires.
    const cleanupTimer = setInterval(() => {
      const cutoff = Date.now() - (options.clientTtlMs ?? CLIENT_TTL_MS);
      const sessionCutoff = Date.now() - (options.sessionSnapshotTtlMs ?? SESSION_SNAPSHOT_TTL_MS);
      let changed = false;
      for (const [ws, client] of clients.entries()) {
        if (new Date(client.lastSeenAt).getTime() < cutoff) {
          // terminate() forces the socket closed immediately without going
          // through the WS close handshake — appropriate for dead peers.
          ws.terminate();
          clients.delete(ws);
          changed = true;
          continue;
        }
        // Session snapshots are periodically refreshed. When one expires,
        // remove every live-state rollup owned by it. Transcript rings remain
        // available as history, but are no longer presented as live topology.
        const expiredSessions = new Set<string>();
        for (const [sessionId, tracked] of client.sessions.entries()) {
          if (tracked.receivedAt < sessionCutoff) {
            client.sessions.delete(sessionId);
            client.mcpSnapshots.delete(sessionId);
            expiredSessions.add(sessionId);
            changed = true;
          }
        }
        for (const [runId, fleet] of client.fleets) {
          if (fleet.sessionId !== undefined && expiredSessions.has(fleet.sessionId)) {
            client.fleets.delete(runId);
            changed = true;
          }
        }

        // A session-summary publisher that has never produced (or no longer
        // retains) a live session is an orphan heartbeat, not a terminal.
        if (
          client.capabilities.includes('session.summary') &&
          client.sessions.size === 0 &&
          Date.now() - Date.parse(client.connectedAt) >
            (options.sessionSnapshotTtlMs ?? SESSION_SNAPSHOT_TTL_MS)
        ) {
          ws.terminate();
          clients.delete(ws);
          changed = true;
        }
      }
      if (changed) snapshotBroadcaster.broadcast();
    }, options.clientCleanupIntervalMs ?? CLIENT_CLEANUP_INTERVAL_MS);

    const httpServer: HttpServer = http.createServer(async (req, res) => {
      try {
      const url = new URL(req.url ?? '/', `http://${host}:${port}`);
      setHqSecurityHeaders(res);

      if (req.method !== 'GET' && req.method !== 'HEAD' && !hasTrustedBrowserOrigin(req, host, port)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden: cross-origin request' }));
        return;
      }

      // When browser TOKEN MODE or PASSWORD MODE is active, DATA routes
      // (/api/*) require a valid browser token OR a signed password session
      // cookie. WS upgrades are gated separately below. The dashboard shell —
      // index.html, /assets/*, the SPA fallback — is served publicly so an
      // unauthenticated browser can render the token/password entry gate
      // instead of a bare JSON 401; the shell carries no telemetry, every byte
      // of data flows through the gated channels.
      if (
        url.pathname.startsWith('/api/') &&
        url.pathname !== '/api/auth/status' &&
        url.pathname !== '/api/login' &&
        (mutableAuth.browserTokens.size > 0 || mutableAuth.passwordHash)
      ) {
        const auth = authenticateBrowserRequest(req, url, mutableAuth, sessions);
        if (!auth) {
          const tokenOnly = mutableAuth.browserTokens.size > 0 && !mutableAuth.passwordHash;
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                code: tokenOnly ? 'INVALID_TOKEN' : 'UNAUTHORIZED',
                message: tokenOnly
                  ? 'A valid ?token= or Authorization: Bearer is required for HTTP access in browser token mode.'
                  : 'A valid browser token or password session is required.',
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
      // API + WS paths must NEVER hit the static server: its SPA fallback
      // answers unknown routes with index.html, which would shadow every
      // /api/* route below with a 200 text/html response.
      const hqDistDir = resolveHqDistDir();
      const isApiOrWsPath = url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/');
      if (hqDistDir !== null && !isApiOrWsPath) {
        const served = serveHqStatic(req, res, url.pathname, hqDistDir);
        if (served.handled) return;
      }

      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(HQ_HTML);
        return;
      }

      // ── HQ API routes ──────────────────────────────────────────────
      if (url.pathname === '/api/auth/status' && req.method === 'GET') {
        const auth = authenticateBrowserRequest(req, url, mutableAuth, sessions);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            tokenMode: mutableAuth.browserTokens.size > 0,
            passwordMode: mutableAuth.passwordHash !== undefined,
            loggedIn: auth !== undefined,
          }),
        );
        return;
      }

      if (url.pathname === '/api/login' && req.method === 'POST') {
        if (!mutableAuth.passwordHash) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'PASSWORD_NOT_CONFIGURED', message: 'Password login is not enabled on this HQ server.' } }));
          return;
        }
        // Rate limiting with exponential backoff per client IP. Key on the real
        // socket peer only — HQ speaks plain HTTP directly with no trusted-proxy
        // gate, so honouring the client-supplied `X-Forwarded-For` here would let
        // an attacker send a fresh fabricated IP per request and never accumulate
        // backoff (and, conversely, pre-block a legitimate user's IP).
        const clientIp = req.socket.remoteAddress ?? 'unknown';
        const existing = loginAttempts.get(clientIp);
        if (existing && existing.blockedUntil > Date.now()) {
          const retryAfter = Math.ceil((existing.blockedUntil - Date.now()) / 1000);
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'Retry-After': String(retryAfter),
          });
          res.end(JSON.stringify({ error: { code: 'RATE_LIMITED', message: `Too many failed login attempts. Retry after ${retryAfter} seconds.` } }));
          return;
        }
        let body: { password?: unknown };
        try {
          body = JSON.parse(await readRequestBody(req)) as { password?: unknown };
        } catch (error) {
          writeInvalidBody(res, error);
          return;
        }
        if (typeof body.password !== 'string' || body.password.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'password is required' } }));
          return;
        }
        const ok = await verifyHqPassword(body.password, mutableAuth.passwordHash);
        if (!ok || !mutableAuth.cookieSecret) {
          // Exponential backoff: 2^count seconds, capped at 16 s.
          const prev = loginAttempts.get(clientIp);
          const count = (prev?.count ?? 0) + 1;
          const backoffMs = Math.min(Math.pow(2, count) * 1000, 16_000);
          loginAttempts.set(clientIp, { count, blockedUntil: Date.now() + backoffMs });
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'INVALID_PASSWORD', message: 'Invalid password.' } }));
          return;
        }
        // Success — reset rate limit for this IP.
        loginAttempts.delete(clientIp);
        const sessionId = randomUUID();
        sessions.set(sessionId, { createdAt: Date.now() });
        setHqSessionCookie(res, serializeHqSessionCookie(sessionId, mutableAuth.cookieSecret), options.secureCookies);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ loggedIn: true }));
        return;
      }

      if (url.pathname === '/api/logout' && req.method === 'POST') {
        const auth = authenticateBrowserRequest(req, url, mutableAuth, sessions);
        if (auth === 'cookie') {
          const cookies = parseCookieHeader(req.headers.cookie);
          const raw = cookies[HQ_SESSION_COOKIE];
          if (raw) {
            const sessionId = parseHqSessionCookie(raw, mutableAuth.cookieSecret ?? '');
            if (sessionId) sessions.delete(sessionId);
          }
        }
        clearHqSessionCookie(res, options.secureCookies);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ loggedIn: false }));
        return;
      }

      if (url.pathname === '/api/snapshot' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(buildSnapshot(clients)));
        return;
      }

      // ── Project-scoped GlobalMailbox HTTP gateway ───────────────────────
      // Mounts the same canonical router used by `wstack mailbox serve` while
      // resolving the target project server-side. A caller can name only a
      // registered project id/slug; raw filesystem paths are never accepted.
      const mailboxGatewayMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/mailbox(?:\/(.*))?$/,
      );
      if (mailboxGatewayMatch) {
        const projectId = decodePathSegment(mailboxGatewayMatch[1]!);
        if (projectId === null || projectId.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: { code: 'BAD_REQUEST', message: 'invalid projectId encoding' },
            }),
          );
          return;
        }
        const gatewayGlobalRoot = path.dirname(dataDir);
        // Enforce the mailbox capability before project lookup so a scoped
        // token cannot use the 403/404 distinction to enumerate projects.
        const preliminaryAccess = authorizeMailboxGateway(req, `project:${projectId}`);
        if (!preliminaryAccess.allowed) {
          res.writeHead(preliminaryAccess.status ?? 401, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(preliminaryAccess.body));
          return;
        }
        const projectRoot = await resolveHqProjectRoot(gatewayGlobalRoot, { projectId });
        if (!projectRoot) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: { code: 'NOT_FOUND', message: `Unknown project: ${projectId}` },
            }),
          );
          return;
        }
        const suffix = mailboxGatewayMatch[2];
        const canonicalPath = suffix ? `/mailbox/${suffix}` : '/mailbox';
        const projectDir = resolveProjectDir(projectRoot, gatewayGlobalRoot);
        await getMailboxGateway(projectDir).router.handle(req, res, canonicalPath);
        return;
      }

      if (url.pathname.startsWith('/api/projects/') && req.method === 'GET') {
        const projectId = decodePathSegment(url.pathname.slice('/api/projects/'.length));
        if (projectId === null) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'invalid projectId encoding' } }));
          return;
        }
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
      // Alias of /api/snapshot — the full snapshot already carries fleets[],
      // machines[], and the session→agent tree. Kept for backward-compat with
      // existing dashboards/tests; prefer /api/snapshot for new consumers.
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
        const auth = authenticateBrowserRequest(req, url, mutableAuth, sessions);
        const inBrowserTokenMode = mutableAuth.browserTokens.size > 0;
        const inPasswordMode = mutableAuth.passwordHash !== undefined;
        if ((inBrowserTokenMode || inPasswordMode) && !auth) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        const tokenObj = isTokenAuth(auth) ? mutableAuth.browserTokenObjs.get(auth.token) : undefined;
        // Capability check: a token must grant control.enqueue; password-session
        // logins inherit full browser access. In open mode (no browser tokens or
        // password configured), control is allowed.
        const canEnqueue =
          auth === 'cookie' ||
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
        } catch (error) {
          writeInvalidBody(res, error);
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

        if (validated.type === 'run-command' && !tokenHasCapability(target.authToken, 'control.execute')) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'forbidden: target client token lacks control.execute capability',
            }),
          );
          return;
        }

        target.commandQueue.push(queued);
        // Bounded queue: drop oldest on overflow.
        if (target.commandQueue.length > 200) target.commandQueue.splice(0, target.commandQueue.length - 200);

        const auditEntry: HqCommandAuditEntry = {
          commandId,
          type: validated.type,
          clientId: target.clientId,
          enqueuedBy: auth === 'cookie' ? 'password-session' : tokenObj?.id ?? 'open-mode',
          enqueuedAt: queued.createdAt,
          status: 'queued',
        };
        auditLog.record(auditEntry);
        HqServerSnapshot.broadcastCommandStatus(auditEntry, browsers);

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
        const auth = authenticateBrowserRequest(req, url, mutableAuth, sessions);
        const inBrowserTokenMode = mutableAuth.browserTokens.size > 0;
        const inPasswordMode = mutableAuth.passwordHash !== undefined;
        if ((inBrowserTokenMode || inPasswordMode) && !auth) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        const tokenObj = isTokenAuth(auth) ? mutableAuth.browserTokenObjs.get(auth.token) : undefined;
        const canEnqueue =
          auth === 'cookie' ||
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
        } catch (error) {
          writeInvalidBody(res, error);
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
        // the projectId (slug or sha-derived — see resolveHqProjectRoot).
        // Derive the global root from THIS server's dataDir (honors
        // --data-dir / WRONGSTACK_HQ_DATA_DIR), not the default resolver, so
        // the mailbox and registry line up with the running instance.
        const mbGlobalRoot = path.dirname(dataDir);
        const projectRoot = await resolveHqProjectRoot(mbGlobalRoot, {
          sessionId: mbody.sessionId,
          projectId: mbody.projectId,
        });
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
          const projectDir = resolveProjectDir(projectRoot, mbGlobalRoot);
          const mailbox = getMailboxGateway(projectDir).mailbox;
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

      // ── Mailbox message actions (mark-read / acknowledge / reopen /
      // soft-delete / restore) ───────────────────────────────────────────
      // POST /api/mailbox/messages/:mailId/action — apply one verb to one
      // message in a project's GlobalMailbox. The target project is resolved
      // SERVER-SIDE from sessionId/projectId (same trust model as
      // /api/mailbox-send). Auth mirrors /api/command: browser token +
      // control.enqueue capability.
      const mailboxActionMatch = url.pathname.match(/^\/api\/mailbox\/messages\/([^/]+)\/action$/);
      if (mailboxActionMatch && req.method === 'POST') {
        const auth = authenticateBrowserRequest(req, url, mutableAuth, sessions);
        const inBrowserTokenMode = mutableAuth.browserTokens.size > 0;
        const inPasswordMode = mutableAuth.passwordHash !== undefined;
        if ((inBrowserTokenMode || inPasswordMode) && !auth) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        const tokenObj = isTokenAuth(auth) ? mutableAuth.browserTokenObjs.get(auth.token) : undefined;
        const canEnqueue =
          auth === 'cookie' ||
          !inBrowserTokenMode ||
          tokenObj?.capabilities === undefined ||
          tokenObj.capabilities.includes('control.enqueue');
        if (!canEnqueue) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden: token lacks control.enqueue capability' }));
          return;
        }

        let abody: {
          action?: string;
          readerId?: string;
          sessionId?: string;
          projectId?: string;
        };
        try {
          abody = JSON.parse(await readRequestBody(req));
        } catch (error) {
          writeInvalidBody(res, error);
          return;
        }
        const mailId = decodePathSegment(mailboxActionMatch[1]!);
        if (mailId === null) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid mailId encoding' }));
          return;
        }
        const MAILBOX_ACTIONS = ['mark-read', 'acknowledge', 'reopen', 'soft-delete', 'restore'] as const;
        const action = MAILBOX_ACTIONS.find((a) => a === abody.action);
        if (action === undefined) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unrecognized action', action: abody.action }));
          return;
        }
        if (typeof abody.readerId !== 'string' || abody.readerId.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'missing readerId' }));
          return;
        }
        if (typeof abody.sessionId !== 'string' && typeof abody.projectId !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'missing sessionId or projectId' }));
          return;
        }

        const actGlobalRoot = path.dirname(dataDir);
        const projectRoot = await resolveHqProjectRoot(actGlobalRoot, {
          sessionId: abody.sessionId,
          projectId: abody.projectId,
        });
        if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'could not resolve target project mailbox' }));
          return;
        }

        try {
          const { actionToAckInput } = await import('@wrongstack/core');
          const projectDir = resolveProjectDir(projectRoot, actGlobalRoot);
          const mailbox = getMailboxGateway(projectDir).mailbox;
          const readerId = abody.readerId;
          const message =
            action === 'soft-delete'
              ? await mailbox.softDelete(mailId, readerId)
              : action === 'restore'
                ? await mailbox.restore(mailId)
                : await mailbox.ack(actionToAckInput(action, { action, mailId, readerId }));
          if (message === null) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'message not found', mailId }));
            return;
          }
          // Deliberately echo `message: null`: the full MailboxMessage
          // carries the raw body, which would bypass the HQ redaction
          // policy applied to every other browser-bound preview. The UI
          // reconciles from the mailbox.event the mutation just published.
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ action, mailId, message: null, changed: true }));
        } catch (err) {
          console.warn(JSON.stringify({ level: 'warn', event: 'hq.api_error', route: '/api/mailbox/messages/:id/action', detail: String(err), timestamp: new Date().toISOString() }));
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'mailbox action failed', detail: HqServerUtils.sanitizeApiError(err) }));
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
        const sessionId = decodePathSegment(eventsMatch[1]!);
        if (sessionId === null) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid sessionId encoding' }));
          return;
        }
        await handleApiSessionEvents(res, sessionId, limit, full, transcripts);
        return;
      }

      // ── Subagent message history, session-scoped (preferred) ──
      // GET /api/sessions/:sid/agents/:aid/messages — the (sessionId, agentId)
      // key keeps same-named leaders from different sessions distinct.
      const sessionAgentMsgMatch = url.pathname.match(
        /^\/api\/sessions\/([^/]+)\/agents\/([^/]+)\/messages$/,
      );
      if (sessionAgentMsgMatch && req.method === 'GET') {
        const sid = decodePathSegment(sessionAgentMsgMatch[1]!);
        const aid = decodePathSegment(sessionAgentMsgMatch[2]!);
        if (sid === null || aid === null) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid session or agent id encoding' }));
          return;
        }
        const full = url.searchParams.get('full') === '1';
        // Prefer the FULL on-disk transcript for local sessions (complete
        // history, start to end); fall back to the live ring for remote or
        // not-yet-persisted sessions. The bare-id ring covers a legacy
        // client that published without a session id.
        const disk = await readLocalSubagentTranscript(sid, aid);
        const source: 'disk' | 'stream' = disk !== null ? 'disk' : 'stream';
        const all =
          disk !== null ? disk : agentMessages.get(agentRingKey(sid, aid)) ?? agentMessages.get(aid) ?? [];
        const entries = full ? all : all.slice(-200);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ subagentId: aid, sessionId: sid, source, total: all.length, entries }));
        return;
      }

      // ── Subagent message history (legacy, un-scoped) ──
      // GET /api/agents/:aid/messages — kept for back-compat. When multiple
      // sessions share an agent id, this merges their rings; prefer the
      // session-scoped route above.
      const agentMsgMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/messages$/);
      if (agentMsgMatch && req.method === 'GET') {
        const id = decodePathSegment(agentMsgMatch[1]!);
        if (id === null) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid agent id encoding' }));
          return;
        }
        const full = url.searchParams.get('full') === '1';
        // Concatenate every ring for this bare id across sessions (best-effort
        // for old callers), plus any exact bare-key ring.
        const merged: HqTranscriptEntry[] = [];
        for (const [key, ring] of agentMessages) {
          if (key === id || key.endsWith(`::${id}`)) merged.push(...ring);
        }
        merged.sort((a, b) => a.ts.localeCompare(b.ts));
        const entries = full ? merged : merged.slice(-200);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ subagentId: id, total: merged.length, entries }));
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

    const browserHeartbeatTimer = setInterval(() => {
      const heartbeat = JSON.stringify({
        type: 'hq.heartbeat',
        serverTime: new Date().toISOString(),
      });
      for (const browser of browsers) {
        if (browser.readyState === WebSocket.OPEN) browser.send(heartbeat);
      }
    }, options.browserHeartbeatIntervalMs ?? BROWSER_HEARTBEAT_INTERVAL_MS);
    browserHeartbeatTimer.unref?.();

    httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', `http://${host}:${port}`);
      const pathname = url.pathname;

      if (pathname !== '/ws/client' && pathname !== '/ws/browser') {
        socket.destroy();
        return;
      }

      if (!hasTrustedBrowserOrigin(req, host, port)) {
        socket.write(
          'HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n' +
            JSON.stringify({ error: { code: 'INVALID_ORIGIN', message: 'Cross-origin WebSocket upgrade rejected.' } }),
        );
        socket.destroy();
        return;
      }

      // Token mode: each channel checks its own allowlist. Browser and
      // client tokens are separate — a browser-only token cannot be
      // replayed on /ws/client and vice versa. OPEN MODE for a channel
      // when its token set is empty (backwards compatible).
      // Browser channel also accepts a signed password session cookie so
      // password-logged-in tabs can open the WebSocket without exposing the
      // password in the URL.
      const tokenSet = pathname === '/ws/browser' ? mutableAuth.browserTokens : mutableAuth.clientTokens;
      const needsAuth = pathname === '/ws/browser'
        ? tokenSet.size > 0 || mutableAuth.passwordHash !== undefined
        : tokenSet.size > 0;
      if (needsAuth) {
        const supplied = url.searchParams.get('token') ?? '';
        const tokenValid = supplied && tokenSet.has(supplied);
        const cookieValid =
          pathname === '/ws/browser' &&
          mutableAuth.passwordHash !== undefined &&
          mutableAuth.cookieSecret !== undefined &&
          ((): boolean => {
            const cookies = parseCookieHeader(req.headers.cookie);
            const raw = cookies[HQ_SESSION_COOKIE];
            if (!raw) return false;
            const sessionId = parseHqSessionCookie(raw, mutableAuth.cookieSecret!);
            return sessionId !== undefined && sessions.has(sessionId);
          })();
        if (!tokenValid && !cookieValid) {
          socket.write(
            'HTTP/1.1 401 Unauthorized\r\n' +
              'Content-Type: application/json\r\n' +
              'Connection: close\r\n' +
              '\r\n' +
              JSON.stringify({
                error: {
                  code: 'UNAUTHORIZED',
                  message:
                    pathname === '/ws/browser'
                      ? 'A valid ?token= or password session is required for browser connections.'
                      : 'A valid ?token= is required for client connections in token mode.',
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

    wss.on('connection', (ws: WebSocket, req: http.IncomingMessage, pathname: string) => {
      if (pathname === '/ws/browser') {
        handleBrowser(ws, snapshotBroadcaster, browsers);
      } else {
        const token = new URL(req.url ?? '/', `http://${host}:${port}`).searchParams.get('token');
        handleClient(
          ws,
          clients,
          browsers,
          eventLog,
          {
            ...(token ? { token: mutableAuth.clientTokenObjs.get(token) } : {}),
            getOperatorPolicy: () => mutableAuth.operatorPolicyOverride,
          },
          snapshotBroadcaster,
          transcripts,
          agentMessages,
          persistence,
          auditLog,
        );
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
        mutableAuth.operatorPolicyOverride = next.redactionPolicy;
        mutableAuth.browserTokens = new Set((next.browserTokens ?? []).map((t) => t.token));
        mutableAuth.clientTokens = new Set((next.clientTokens ?? []).map((t) => t.token));
        mutableAuth.browserTokenObjs = new Map(
          (next.browserTokens ?? []).map((t) => [t.token, { id: t.id, ...(t.capabilities !== undefined ? { capabilities: t.capabilities } : {}) }]),
        );
        mutableAuth.clientTokenObjs = new Map(
          (next.clientTokens ?? []).map((token) => [token.token, token]),
        );
        mutableAuth.passwordHash = next.passwordHash;
        mutableAuth.cookieSecret = next.cookieSecret;
        mutableAuth.alertRules = next.alertRules;
        console.warn(JSON.stringify({
          level: 'info',
          event: 'hq.auth.reloaded',
          message: 'HQ auth.json reloaded',
          browserTokenCount: mutableAuth.browserTokens.size,
          clientTokenCount: mutableAuth.clientTokens.size,
          passwordMode: mutableAuth.passwordHash !== undefined,
          alertRulesActive: mutableAuth.alertRules !== undefined,
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
              clearInterval(browserHeartbeatTimer);
              clearInterval(timeseriesFlushTimer);
              clearInterval(mailboxGatewayRateLimitCleanup);
              clearInterval(sessionCleanupTimer);
              stopAlertEngine();
              authWatcher.close();
              snapshotBroadcaster.close();
              // Final flush so the last batch of timeseries buckets reach disk.
              persistence.timeseries.flush();
              for (const ws of browsers) ws.close(1001, 'HQ shutting down');
              for (const ws of clients.keys()) ws.close(1001, 'HQ shutting down');
              wss.close();
              for (const { router } of mailboxGateways.values()) router.close();
              httpServer.close(() => {
                const mailboxCloses = [...mailboxGateways.values()].map(({ mailbox }) =>
                  mailbox.close().catch(() => undefined),
                );
                mailboxGateways.clear();
                // Drain mailbox state alongside queued persistence writes
                // before resolving close(), so Windows temp-dir cleanup cannot
                // race an in-flight mailbox read/write.
                // Drain the queued persistence writes BEFORE resolving.
                // The event-log / snapshot / timeseries stores are all
                // fire-and-forget write chains; resolving close() while an
                // appendFile/atomicWrite is still in flight both drops the
                // final flush on real shutdowns and lets a caller's
                // `fs.rm(dataDir)` race the write (ENOTEMPTY on Windows).
                void Promise.all([
                  ...mailboxCloses,
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

const handleBrowser = HqServerWs.handleBrowser;
const handleClient = HqServerWs.handleClient;
const buildSnapshot = HqServerSnapshot.buildSnapshot;
const createSnapshotBroadcaster = HqServerSnapshot.createSnapshotBroadcaster;
const buildProjectDetail = HqServerSnapshot.buildProjectDetail;

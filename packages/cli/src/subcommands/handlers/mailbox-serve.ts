/**
 * `wstack mailbox serve` — run a loopback HTTP façade over the project's
 * shared `GlobalMailbox`, so external coding agents (Claude Code, Aider,
 * custom scripts) can read and send messages on the same channel that
 * WrongStack-internal agents use.
 *
 * ## Design
 *
 * The server is intentionally tiny: one `node:http` server, a single
 * `GlobalMailbox` instance, and a bearer-token gate. Every route is a
 * thin JSON-in / JSON-out wrapper over a `GlobalMailbox` method, so all
 * file locking, mtime-cached reads, agent heartbeats, and HQ telemetry
 * happen exactly as they do for WrongStack-internal callers. External
 * agents are NOT given raw file access — they go through `GlobalMailbox`
 * so they cannot race the file lock during acks.
 *
 * ## Authentication
 *
 * On startup we mint a 32-byte random bearer token and write it to
 * `<projectDir>/.mailbox.token` with mode `0600`. The token is rotated
 * every time the server starts; clients must present it as
 * `Authorization: Bearer <token>`. Tokens are compared in constant
 * time. The token file is unlinked on clean shutdown.
 *
 * ## Bind safety
 *
 * Default bind is `127.0.0.1` — loopback only. Pass `--host` to expose
 * to LAN (NOT recommended without a reverse proxy that re-authenticates
 * and rate-limits; the bearer token is the only auth).
 *
 * ## Routes
 *
 *   POST /mailbox/send              → send({from,to,type,subject,body,...})
 *   POST /mailbox/query             → query({to?,from?,unreadBy?,...})
 *   POST /mailbox/ack               → ack({messageId,readerId,...})
 *   POST /mailbox/ack-many          → ackMany({acks:[...]})
 *   POST /mailbox/unread-count      → unreadCount({forAgentId})
 *   POST /mailbox/agents/register   → registerAgent({...})  source='http'
 *   POST /mailbox/agents/heartbeat  → heartbeat({...})
 *   POST /mailbox/register-client   → registerClient({...}) source='http'
 *   POST /mailbox/heartbeat         → clientHeartbeat({clientId})
 *   GET  /mailbox/agents            → getAgentStatuses()
 *   GET  /mailbox/agents/online     → getOnlineAgents()
 *
 * @module subcommands/handlers/mailbox-serve
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  GlobalMailbox,
  type AgentHeartbeatInput,
  type AgentRegistrationInput,
  type ClientHeartbeatInput,
  type ClientRegistrationInput,
  type MailboxAckBatchInput,
  type MailboxAckInput,
  type MailboxQuery,
  type MailboxSendInput,
  resolveProjectDir,
  wstackGlobalRoot,
} from '@wrongstack/core';
import type { SubcommandDeps, SubcommandHandler } from '../index.js';

const TOKEN_FILENAME = '.mailbox.token';
/** Cap inbound JSON bodies. The mailbox message format is small — a 256 KB
 *  limit leaves room for long bodies + attachments-as-base64 while still
 *  rejecting pathological payloads before they reach `JSON.parse`. */
const MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 7788;

export const mailboxServeCmd: SubcommandHandler = async (args, deps) => {
  const sub = args[0];

  if (!sub || sub === 'serve') {
    return startServer(deps);
  }
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    printHelp(deps);
    return 0;
  }

  deps.renderer.writeError(`Unknown mailbox subcommand: ${sub}\n`);
  printHelp(deps);
  return 1;
};

async function startServer(deps: SubcommandDeps): Promise<number> {
  const flags = deps.flags ?? {};
  const host = typeof flags['host'] === 'string' ? flags['host'] : DEFAULT_HOST;
  const portRaw = typeof flags['port'] === 'string' ? Number.parseInt(flags['port'], 10) : DEFAULT_PORT;
  const strictPort = flags['strict-port'] === true;
  if (!Number.isInteger(portRaw) || portRaw <= 0 || portRaw > 65535) {
    deps.renderer.writeError(`Invalid --port: ${String(flags['port'])}\n`);
    return 1;
  }

  const projectDir = resolveProjectDir(deps.projectRoot, wstackGlobalRoot());
  const mailbox = new GlobalMailbox(projectDir);

  const token = randomBytes(32).toString('hex');
  const tokenPath = `${projectDir}${process.platform === 'win32' ? '\\' : '/'}${TOKEN_FILENAME}`;
  // 0600: owner read/write only. On POSIX this is enforced; on Windows the
  // mode is recorded but the OS uses ACLs, which we do not tighten here —
  // the token is single-use per session and rotated on every start.
  await fsp.writeFile(tokenPath, token, { mode: 0o600 });

  const server = createServer((req, res) => {
    void handle(mailbox, token, req, res);
  });

  // Listen semantics:
  //  - strictPort: bind to the exact port requested; reject on EADDRINUSE
  //    so the operator knows their port is taken.
  //  - !strictPort: ask the OS for a free port (pass 0). Operator gets a
  //    working URL no matter what else is bound to the default port.
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      const requestedPort = strictPort ? portRaw : 0;
      server.listen(requestedPort, host);
    });
  } catch (err) {
    // Cleanup before failing — token file is rotated on every start, so
    // a failed listen must not leave a stale token on disk.
    await fsp.unlink(tokenPath).catch(() => undefined);
    deps.renderer.writeError(`Failed to bind ${host}:${strictPort ? portRaw : '0'}: ${(err as Error).message}\n`);
    return 1;
  }
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr !== null ? addr.port : portRaw;

  writeStartupInfo(deps, { host, port: boundPort, projectDir, tokenPath });

  // Keep the process alive until SIGINT/SIGTERM. We resolve once the
  // server has fully closed and the token file is gone.
  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = async (sig: NodeJS.Signals) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(JSON.stringify({ event: 'mailbox_serve_stopping', signal: sig, host, port: boundPort }));
      // Stop accepting new connections; in-flight requests get to finish.
      await new Promise<void>((closeResolve) => server.close(() => closeResolve()));
      await mailbox.close().catch((err) => {
        deps.renderer.writeWarning(`mailbox close error: ${(err as Error).message}\n`);
      });
      await fsp.unlink(tokenPath).catch(() => {
        /* file may already be gone — ignore */
      });
      resolve();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
  return 0;
}

// ── HTTP request handling ─────────────────────────────────────────────────

async function handle(
  mailbox: GlobalMailbox,
  expectedToken: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    // Health probe is unauthenticated by design — liveness checks should
    // not require a token (k8s liveness probes, container orchestrators,
    // `curl http://host/healthz` from a shell all benefit). It reveals no
    // project data; only that the server is up.
    if (method === 'GET' && url === '/healthz') {
      return writeJson(res, 200, { ok: true });
    }

    if (!authorize(req, expectedToken)) {
      return writeJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'invalid or missing bearer token' } });
    }

    // Routing — POST routes carry JSON bodies; GET routes take nothing.

    if (method === 'POST' && url === '/mailbox/send') {
      const body = await readJsonBody(req);
      const input = validateSend(body);
      const msg = await mailbox.send(input);
      return writeJson(res, 201, msg);
    }
    if (method === 'POST' && url === '/mailbox/query') {
      const body = await readJsonBody(req);
      const input = validateQuery(body);
      const msgs = await mailbox.query(input);
      return writeJson(res, 200, { data: msgs, count: msgs.length });
    }
    if (method === 'POST' && url === '/mailbox/ack') {
      const body = await readJsonBody(req);
      const input = validateAck(body);
      const msg = await mailbox.ack(input);
      return writeJson(res, 200, { updated: msg });
    }
    if (method === 'POST' && url === '/mailbox/ack-many') {
      const body = await readJsonBody(req);
      const input = validateAckMany(body);
      const msgs = await mailbox.ackMany(input);
      return writeJson(res, 200, { updated: msgs, count: msgs.length });
    }
    if (method === 'POST' && url === '/mailbox/unread-count') {
      const body = await readJsonBody(req);
      const agentId = requireString(body, 'forAgentId');
      const count = await mailbox.unreadCount(agentId);
      return writeJson(res, 200, { count });
    }
    if (method === 'POST' && url === '/mailbox/agents/register') {
      const body = await readJsonBody(req);
      const input = validateAgentRegistration(body);
      await mailbox.registerAgent(input);
      return writeJson(res, 200, { ok: true });
    }
    if (method === 'POST' && url === '/mailbox/agents/heartbeat') {
      const body = await readJsonBody(req);
      const input = validateAgentHeartbeat(body);
      await mailbox.heartbeat(input);
      return writeJson(res, 200, { ok: true });
    }
    if (method === 'POST' && url === '/mailbox/register-client') {
      const body = await readJsonBody(req);
      const input = validateClientRegistration(body);
      await mailbox.registerClient(input);
      return writeJson(res, 200, { ok: true });
    }
    if (method === 'POST' && url === '/mailbox/heartbeat') {
      const body = await readJsonBody(req);
      const input = validateClientHeartbeat(body);
      await mailbox.clientHeartbeat(input);
      return writeJson(res, 200, { ok: true });
    }
    if (method === 'GET' && url === '/mailbox/agents') {
      const statuses = await mailbox.getAgentStatuses();
      return writeJson(res, 200, { data: statuses, count: statuses.length });
    }
    if (method === 'GET' && url === '/mailbox/agents/online') {
      const statuses = await mailbox.getOnlineAgents();
      return writeJson(res, 200, { data: statuses, count: statuses.length });
    }

    return writeJson(res, 404, { error: { code: 'NOT_FOUND', message: `no route for ${method} ${url}` } });
  } catch (err) {
    const code = classifyError(err);
    const message = (err as Error).message ?? 'unknown error';
    const status = code === 'VALIDATION_ERROR' ? 400 : 500;
    return writeJson(res, status, { error: { code, message } });
  }
}

function authorize(req: IncomingMessage, expectedToken: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (m === null) return false;
  const presented = m[1] ?? '';
  // Constant-time comparison so an attacker can't probe the token byte-by-byte.
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expectedToken, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const lengthHeader = req.headers['content-length'];
  if (typeof lengthHeader === 'string') {
    const declared = Number.parseInt(lengthHeader, 10);
    if (Number.isInteger(declared) && declared > MAX_BODY_BYTES) {
      throw validationError(`request body too large: ${declared} bytes (max ${MAX_BODY_BYTES})`);
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw validationError(`request body too large: > ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(buf);
  }
  if (total === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw validationError(`invalid JSON body: ${(err as Error).message}`);
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

// ── Input validation ──────────────────────────────────────────────────────
//
// Each validator does the smallest check that rejects the request with
// `400 VALIDATION_ERROR`. We trust the resulting object to satisfy the
// `GlobalMailbox` method's input shape — runtime validation lives one
// layer below at the file-lock boundary, so even a malformed-but-typed
// input would surface as a clear error there.

class ValidationError extends Error {}

function validationError(message: string): ValidationError {
  return new ValidationError(message);
}

function classifyError(err: unknown): string {
  if (err instanceof ValidationError) return 'VALIDATION_ERROR';
  return 'INTERNAL_ERROR';
}

function requireString(obj: unknown, key: string): string {
  if (typeof obj !== 'object' || obj === null) {
    throw validationError(`expected JSON object body`);
  }
  const v = (obj as Record<string, unknown>)[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw validationError(`field "${key}" is required (string)`);
  }
  return v;
}

function requireNumber(obj: unknown, key: string): number {
  if (typeof obj !== 'object' || obj === null) {
    throw validationError(`expected JSON object body`);
  }
  const v = (obj as Record<string, unknown>)[key];
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw validationError(`field "${key}" is required (integer)`);
  }
  return v;
}

function optionalString(obj: unknown, key: string): string | undefined {
  if (typeof obj !== 'object' || obj === null) return undefined;
  const v = (obj as Record<string, unknown>)[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw validationError(`field "${key}" must be a string when present`);
  return v;
}

function optionalNumber(obj: unknown, key: string): number | undefined {
  if (typeof obj !== 'object' || obj === null) return undefined;
  const v = (obj as Record<string, unknown>)[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number') throw validationError(`field "${key}" must be a number when present`);
  return v;
}

function optionalBoolean(obj: unknown, key: string): boolean | undefined {
  if (typeof obj !== 'object' || obj === null) return undefined;
  const v = (obj as Record<string, unknown>)[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw validationError(`field "${key}" must be a boolean when present`);
  return v;
}

const VALID_TYPES = new Set(['note', 'ask', 'assign', 'steer', 'btw', 'broadcast', 'status', 'result', 'control']);
const VALID_PRIORITIES = new Set(['low', 'normal', 'high']);

function validateSend(body: unknown): MailboxSendInput {
  if (typeof body !== 'object' || body === null) throw validationError('expected JSON object body');
  const o = body as Record<string, unknown>;
  const type = requireString(o, 'type');
  if (!VALID_TYPES.has(type)) throw validationError(`field "type" must be one of ${[...VALID_TYPES].join(', ')}`);
  const priority = optionalString(o, 'priority');
  if (priority !== undefined && !VALID_PRIORITIES.has(priority)) {
    throw validationError(`field "priority" must be one of ${[...VALID_PRIORITIES].join(', ')}`);
  }
  const result: MailboxSendInput = {
    from: requireString(o, 'from'),
    to: requireString(o, 'to'),
    type: type as MailboxSendInput['type'],
    subject: requireString(o, 'subject'),
    body: requireString(o, 'body'),
    priority: priority as MailboxSendInput['priority'],
  };
  const replyTo = optionalString(o, 'replyTo');
  if (replyTo !== undefined) result.replyTo = replyTo;
  return result;
}

function validateQuery(body: unknown): MailboxQuery {
  if (typeof body !== 'object' || body === null) throw validationError('expected JSON object body');
  const o = body as Record<string, unknown>;
  const result: MailboxQuery = {};
  const to = optionalString(o, 'to');
  const from = optionalString(o, 'from');
  const unreadBy = optionalString(o, 'unreadBy');
  const type = optionalString(o, 'type');
  const minPriority = optionalString(o, 'minPriority');
  const since = optionalString(o, 'since');
  const limit = optionalNumber(o, 'limit');
  const incompleteOnly = optionalBoolean(o, 'incompleteOnly');
  if (to !== undefined) result.to = to;
  if (from !== undefined) result.from = from;
  if (unreadBy !== undefined) result.unreadBy = unreadBy;
  if (type !== undefined) {
    if (!VALID_TYPES.has(type)) throw validationError(`field "type" must be one of ${[...VALID_TYPES].join(', ')}`);
    result.type = type as MailboxQuery['type'];
  }
  if (minPriority !== undefined) {
    if (!VALID_PRIORITIES.has(minPriority)) {
      throw validationError(`field "minPriority" must be one of ${[...VALID_PRIORITIES].join(', ')}`);
    }
    result.minPriority = minPriority as MailboxQuery['minPriority'];
  }
  if (since !== undefined) result.since = since;
  if (limit !== undefined) result.limit = limit;
  if (incompleteOnly !== undefined) result.incompleteOnly = incompleteOnly;
  return result;
}

function validateAck(body: unknown): MailboxAckInput {
  if (typeof body !== 'object' || body === null) throw validationError('expected JSON object body');
  const o = body as Record<string, unknown>;
  const result: MailboxAckInput = {
    messageId: requireString(o, 'messageId'),
    readerId: requireString(o, 'readerId'),
  };
  const read = optionalBoolean(o, 'read');
  const completed = optionalBoolean(o, 'completed');
  const outcome = optionalString(o, 'outcome');
  if (read !== undefined) result.read = read;
  if (completed !== undefined) result.completed = completed;
  if (outcome !== undefined) result.outcome = outcome;
  return result;
}

function validateAckMany(body: unknown): MailboxAckBatchInput {
  if (typeof body !== 'object' || body === null) throw validationError('expected JSON object body');
  const o = body as Record<string, unknown>;
  const raw = o['acks'];
  if (!Array.isArray(raw)) throw validationError('field "acks" is required (array)');
  const acks: MailboxAckInput[] = [];
  for (const entry of raw) {
    acks.push(validateAck(entry));
  }
  return { acks };
}

function validateAgentRegistration(body: unknown): AgentRegistrationInput {
  if (typeof body !== 'object' || body === null) throw validationError('expected JSON object body');
  const o = body as Record<string, unknown>;
  // sessionId defaults to 'external' so external agents that don't model a
  // real WrongStack session still register consistently with the mailbox.
  const sessionId = optionalString(o, 'sessionId') ?? 'external';
  const result: AgentRegistrationInput = {
    agentId: requireString(o, 'agentId'),
    sessionId,
    name: requireString(o, 'name'),
    pid: requireNumber(o, 'pid'),
    source: 'http',
  };
  const role = optionalString(o, 'role');
  if (role !== undefined) result.role = role;
  return result;
}

function validateAgentHeartbeat(body: unknown): AgentHeartbeatInput {
  if (typeof body !== 'object' || body === null) throw validationError('expected JSON object body');
  const o = body as Record<string, unknown>;
  const result: AgentHeartbeatInput = { agentId: requireString(o, 'agentId') };
  const status = optionalString(o, 'status');
  const currentTool = optionalString(o, 'currentTool');
  const currentTask = optionalString(o, 'currentTask');
  const iterations = optionalNumber(o, 'iterations');
  const toolCalls = optionalNumber(o, 'toolCalls');
  if (status !== undefined) result.status = status as AgentHeartbeatInput['status'];
  if (currentTool !== undefined) result.currentTool = currentTool;
  if (currentTask !== undefined) result.currentTask = currentTask;
  if (iterations !== undefined) result.iterations = iterations;
  if (toolCalls !== undefined) result.toolCalls = toolCalls;
  return result;
}

function validateClientRegistration(body: unknown): ClientRegistrationInput {
  if (typeof body !== 'object' || body === null) throw validationError('expected JSON object body');
  const o = body as Record<string, unknown>;
  const result: ClientRegistrationInput = {
    clientId: requireString(o, 'clientId'),
    sessionId: optionalString(o, 'sessionId') ?? 'external',
    name: requireString(o, 'name'),
    source: 'http',
    pid: requireNumber(o, 'pid'),
  };
  return result;
}

function validateClientHeartbeat(body: unknown): ClientHeartbeatInput {
  if (typeof body !== 'object' || body === null) throw validationError('expected JSON object body');
  const o = body as Record<string, unknown>;
  return { clientId: requireString(o, 'clientId') };
}

// ── Startup info / help ───────────────────────────────────────────────────

interface StartupInfo {
  host: string;
  port: number;
  projectDir: string;
  tokenPath: string;
}

function writeStartupInfo(deps: SubcommandDeps, info: StartupInfo): void {
  // One structured JSON line to stdout for log-shippers; human-readable
  // mirror to stderr (renderer.writeWarning/etc. go to stderr).
  console.log(
    JSON.stringify({
      event: 'mailbox_serve_started',
      host: info.host,
      port: info.port,
      projectDir: info.projectDir,
      tokenFile: info.tokenPath,
    }),
  );
  deps.renderer.write(`WrongStack mailbox bridge listening on http://${info.host}:${info.port}\n`);
  deps.renderer.write(`Project dir:  ${info.projectDir}\n`);
  deps.renderer.write(`Token file:   ${info.tokenPath} (mode 0600)\n`);
  deps.renderer.write('\n');
  deps.renderer.write('Routes:\n');
  deps.renderer.write('  POST /mailbox/send              send a message\n');
  deps.renderer.write('  POST /mailbox/query             query messages\n');
  deps.renderer.write('  POST /mailbox/ack               acknowledge one message\n');
  deps.renderer.write('  POST /mailbox/ack-many          acknowledge many in one batch\n');
  deps.renderer.write('  POST /mailbox/unread-count      count unread messages for an agent\n');
  deps.renderer.write('  POST /mailbox/agents/register   register an external agent\n');
  deps.renderer.write('  POST /mailbox/agents/heartbeat  update agent heartbeat\n');
  deps.renderer.write('  POST /mailbox/register-client   register an external client\n');
  deps.renderer.write('  POST /mailbox/heartbeat         update client heartbeat\n');
  deps.renderer.write('  GET  /mailbox/agents            list all registered agents\n');
  deps.renderer.write('  GET  /mailbox/agents/online     list agents with a live heartbeat\n');
  deps.renderer.write('  GET  /healthz                   health probe (no auth)\n');
  deps.renderer.write('\n');
  deps.renderer.write('Send the bearer token in: Authorization: Bearer <token>\n');
  deps.renderer.write('Cat the token from another shell:\n');
  deps.renderer.write(`  cat ${info.tokenPath}\n`);
  deps.renderer.write('\nPress Ctrl+C to stop.\n');
}

function printHelp(deps: SubcommandDeps): void {
  deps.renderer.write(`Usage: wstack mailbox <serve>\n`);
  deps.renderer.write('\n');
  deps.renderer.write(`  wstack mailbox serve           Start the loopback HTTP bridge.\n`);
  deps.renderer.write('\n');
  deps.renderer.write('Flags:\n');
  deps.renderer.write(`  --host <ip>         Bind host (default ${DEFAULT_HOST}). Exposing beyond\n`);
  deps.renderer.write('                     loopback requires network-layer protection.\n');
  deps.renderer.write(`  --port <n>          Bind port (default ${DEFAULT_PORT}).\n`);
  deps.renderer.write('  --strict-port       Fail if the requested port is already in use.\n');
}
import { spawn } from 'node:child_process';
import {
  emitProcessCompleted,
  emitProcessOutput,
  emitProcessStarted,
} from '@wrongstack/core/observability';
import { buildChildEnv } from '@wrongstack/core/utils';
import { WIN32_TREE_KILL_BUDGET_MS } from '@wrongstack/core/utils/tree-kill';
import { redactSecrets } from '@wrongstack/primitives';
import { getProcessRegistry } from '../process-registry.js';

export interface ProjectKitContext {
  projectRoot: string;
  kitRoot: string;
  runId: string;
  signal: AbortSignal;
  /** Structured, bounded log; do not include credentials or private inputs. */
  log(message: string): void;
  /** Resolve a project-relative path, rejecting lexical traversal. Not a sandbox. */
  resolvePath(relative: string): string;
}
export interface ProjectKitModule<I = Record<string, unknown>, O = unknown> {
  run(input: I, context: ProjectKitContext): Promise<O> | O;
}

// Executed by an external Node runtime, never imported into the host. Passing
// input over stdin avoids putting project data/secrets in process arguments.
const BOOTSTRAP = `
import path from 'node:path';
import { pathToFileURL } from 'node:url';
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const request = JSON.parse(raw);
const send = (message) => process.send(message);
// Terminal messages close the channel instead of exiting from inside the send
// callback. That callback fires once the message is queued, not once the parent
// has actually read it, so exiting there can drop the result entirely and leave
// the run recorded as "Node exited without a successful result (0)".
const respond = (message, code) => {
  if (typeof process.send !== 'function') { process.exit(code); return; }
  process.send(message, () => {
    if (process.connected) process.disconnect();
    // A kit may leave handles open; exit on a later turn so the channel close can
    // flush first, without letting those handles stall an otherwise finished run.
    setTimeout(() => process.exit(code), 0).unref();
  });
};
const controller = new AbortController();
process.on('message', (m) => { if (m === 'abort') controller.abort(); });
const ctx = Object.freeze({
  projectRoot: request.projectRoot,
  kitRoot: request.kitRoot,
  runId: request.runId,
  signal: controller.signal,
  log(message) { send({ type: 'log', text: String(message).slice(0, 4096) }); },
  resolvePath(relative) {
    if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('Expected project-relative path');
    const resolved = path.resolve(request.projectRoot, relative);
    const rel = path.relative(request.projectRoot, resolved);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Path escapes project');
    return resolved;
  },
});
try {
  const module = await import(pathToFileURL(path.join(request.kitRoot, request.entry)).href);
  if (typeof module.run !== 'function') throw new Error('Entry must export run(input, ctx)');
  const output = await module.run(request.input, ctx);
  if (output === undefined) throw new Error('run must return a JSON value');
  const json = JSON.stringify(output);
  if (Buffer.byteLength(json) > 262144) throw new Error('Result exceeds 256 KiB');
  respond({ type: 'result', output: JSON.parse(json) }, 0);
} catch (error) {
  respond({ type: 'failure', text: String(error?.message ?? error).slice(0, 4096) }, 1);
}
`;

export interface KitProcessResult {
  ok: boolean;
  output?: unknown;
  error?: string | undefined;
  logs: string[];
  /** Child exit code; undefined when the child never started or was killed without one. */
  exitCode?: number | undefined;
  /** Redacted tail of the child's stderr, capped at the last 4096 characters. */
  stderrTail?: string | undefined;
  /** Whether the child delivered its terminal IPC message before the run settled. */
  resultReceived?: boolean | undefined;
  /** Milliseconds from spawn to that terminal message; undefined when none arrived. */
  receiveMs?: number | undefined;
}

/** Maximum characters of child stderr retained for post-mortem diagnosis. */
export const STDERR_TAIL_LIMIT = 4096;
/** After a stopped child has exited: how long inherited pipes may stay open. */
const PIPE_GRACE_MS = 3000;
/** After a stop: how long the forced kill may take before the run settles anyway. */
const KILL_GRACE_MS =
  process.platform === 'win32' ? WIN32_TREE_KILL_BUDGET_MS + PIPE_GRACE_MS : 15_000;

export async function runKitProcess(request: {
  projectRoot: string;
  kitRoot: string;
  entry: string;
  runId: string;
  name: string;
  sessionId?: string | undefined;
  input: unknown;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<KitProcessResult> {
  if (request.signal.aborted) return { ok: false, error: 'Cancelled', logs: [] };
  const body = JSON.stringify({ ...request, signal: undefined });
  if (Buffer.byteLength(body) > 262144) throw new Error('Project Kit input exceeds 256 KiB');
  return new Promise((resolve) => {
    const registry = getProcessRegistry();
    const env = buildChildEnv();
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    const child = spawn('node', ['--input-type=module', '-e', BOOTSTRAP], {
      cwd: request.projectRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const startedAt = Date.now();
    emitProcessStarted({
      pid: child.pid,
      parentPid: process.pid,
      command: `Project Kit ${request.name} (${request.runId})`,
      args: [],
      cwd: request.projectRoot,
      background: false,
      startedAt: new Date(startedAt).toISOString(),
    });
    const logs: string[] = [];
    let logBytes = 0;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stderrTail = '';
    let timedOut = false;
    let failure: string | undefined;
    let output: unknown;
    let received = false;
    let receiveMs: number | undefined;
    let settled = false;
    let stopping = false;
    let exited = false;
    let exitCodeSeen: number | null = null;
    let backstop: ReturnType<typeof setTimeout> | undefined;
    function finish(code: number | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (backstop) clearTimeout(backstop);
      request.signal.removeEventListener('abort', abort);
      if (child.pid) registry.unregister(child.pid);
      emitProcessCompleted({
        pid: child.pid,
        exitCode: code ?? 1,
        durationMs: Date.now() - startedAt,
        stdoutBytes,
        stderrBytes,
        timedOut,
        endedAt: new Date().toISOString(),
      });
      resolve({
        ok: !failure && received && code === 0,
        output,
        error:
          failure ??
          (received && code === 0
            ? undefined
            : `Node exited without a successful result (${code})`),
        logs,
        exitCode: code ?? undefined,
        stderrTail: stderrTail ? redactSecrets(stderrTail).slice(-STDERR_TAIL_LIMIT) : undefined,
        resultReceived: received,
        receiveMs,
      });
    }
    function stop(reason: string) {
      if (stopping || settled) return;
      stopping = true;
      timedOut = reason === 'Timed out';
      failure ??= reason;
      if (child.connected) child.send('abort', () => {});
      if (child.pid) registry.kill(child.pid, { force: true });
      else child.kill();
      // A forced kill can take seconds to land under load (Windows taskkill),
      // and resolving before it does leaves the child holding the project
      // directory with no exit code. The short pipe window therefore starts
      // only once the child has exited; the long one covers a kill that never
      // lands.
      armBackstop(exited ? PIPE_GRACE_MS : KILL_GRACE_MS);
    }
    // Never leave an agent waiting indefinitely on inherited pipes.
    function armBackstop(ms: number) {
      if (backstop) clearTimeout(backstop);
      backstop = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
        if (child.connected) child.disconnect();
        child.unref();
        finish(exitCodeSeen);
      }, ms);
    }
    function abort() {
      stop('Cancelled');
    }
    function log(text: string, stream: 'stdout' | 'stderr' = 'stdout') {
      const bytes = Buffer.byteLength(text);
      logBytes += bytes;
      if (stream === 'stdout') stdoutBytes += bytes;
      else {
        stderrBytes += bytes;
        // Keep only the last STDERR_TAIL_LIMIT characters raw; redaction and
        // the final cap happen in finish(), after the full tail is known.
        stderrTail = (stderrTail + text).slice(-STDERR_TAIL_LIMIT);
      }
      if (logBytes > 65536 || logs.length >= 256) {
        stop('Log output exceeds 64 KiB / 256 entries');
        return;
      }
      const safe = redactSecrets(text);
      logs.push(safe);
      emitProcessOutput({ pid: child.pid, stream, chunk: safe });
    }
    const timer = setTimeout(() => stop('Timed out'), request.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => log(chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => log(chunk.toString('utf8'), 'stderr'));
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const m = message as { type?: string; text?: unknown; output?: unknown };
      if (m.type === 'log') log(String(m.text));
      else if (m.type === 'failure') {
        // Parent-side arrival time of the terminal message: a lost result shows
        // here as undefined, a slow channel as an unusually large value.
        receiveMs ??= Date.now() - startedAt;
        failure ??= redactSecrets(String(m.text));
      } else if (m.type === 'result') {
        if (received || Buffer.byteLength(JSON.stringify(m.output) ?? '') > 262144) {
          stop('Invalid or oversized result');
          return;
        }
        receiveMs ??= Date.now() - startedAt;
        received = true;
        output = m.output;
      }
    });
    child.once('error', () => {
      failure = 'Unable to start Node; install Node.js 22.19+ on PATH';
      finish(null);
    });
    child.once('exit', (code) => {
      exited = true;
      exitCodeSeen = code;
      if (stopping && !settled) armBackstop(PIPE_GRACE_MS);
    });
    child.once('close', finish);
    child.stdin?.on('error', () => {});
    if (child.pid)
      registry.register({
        pid: child.pid,
        name: 'project_kit_run',
        command: `Project Kit ${request.name} (${request.runId})`,
        sessionId: request.sessionId,
        startedAt: Date.now(),
        child,
        processGroupLeader: process.platform !== 'win32',
      });
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    else child.stdin?.end(body);
  });
}

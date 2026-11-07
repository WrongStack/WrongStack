/**
 * `process_watch` / `process_watch_control` — stream a command's output lines
 * to the leader as runtime notices.
 *
 * "Tell me when the dev server says ready", "tell me each time an ERROR line
 * appears", "emit each CI step as it lands": the model starts a command whose
 * stdout/stderr lines are events. Lines that pass the optional `filter` are
 * batched (lines within {@link BATCH_WINDOW_MS} ride one notice) and queued
 * for the leader; a running loop reads them at the next iteration and an
 * idle session is woken for them. The tool call itself returns at once.
 *
 * Bounded on every axis: a lifetime (`timeout_s`, default 5 min, max 30), a
 * per-session watch cap, lines truncated and capped per batch, and a flood
 * guard that stops a watch emitting more than {@link MAX_BATCHES_PER_MINUTE}
 * notices a minute (narrow the filter and restart). The child is tracked by
 * the process registry like any shell command, so `/ps`, `/kill` and session
 * cleanup see and stop it; it never keeps the CLI alive on its own.
 *
 * Start is a separate tool from list/stop because only start runs a command
 * and therefore needs confirmation; stopping or listing never should.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import * as os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import type { Tool } from '@wrongstack/contracts/types';
import { ToolValidationError } from '@wrongstack/contracts/types';
import { enqueueRuntimeNotice, resolveRuntimeNoticeTarget } from '@wrongstack/coordination';
import { buildChildEnv } from './_env.js';
import { formatNoticeDuration } from './background-exit-notice.js';
import { checkAndBlockKillCommand } from './bash-kill-guard.js';
import { resolveBashShellPlan } from './bash-shell-plan.js';
import { getProcessRegistry, redactCommand } from './process-registry.js';

export const WATCH_DEFAULT_TIMEOUT_S = 300;
export const WATCH_MAX_TIMEOUT_S = 1_800;
export const WATCH_MIN_TIMEOUT_S = 5;
export const WATCH_MAX_PER_SESSION = 5;
export const BATCH_WINDOW_MS = 200;
export const MAX_LINES_PER_BATCH = 20;
export const MAX_LINE_CHARS = 400;
export const MAX_BATCHES_PER_MINUTE = 30;
const FILTER_MAX_CHARS = 500;
/** Unterminated output kept before it is emitted as a line anyway. */
const MAX_PARTIAL_CHARS = 8_192;

export interface ProcessWatchInput {
  command: string;
  description: string;
  filter?: string | undefined;
  timeout_s?: number | undefined;
}

export interface ProcessWatchControlInput {
  action: 'list' | 'stop';
  id?: string | undefined;
}

export interface ProcessWatchView {
  id: string;
  description: string;
  command: string;
  pid: number | null;
  filter?: string | undefined;
  started_at: string;
  expires_in_s: number;
  matched_lines: number;
  notices: number;
}

export interface ProcessWatchOutput {
  ok: true;
  message: string;
  watch?: ProcessWatchView | undefined;
  watches?: ProcessWatchView[] | undefined;
  stopped?: string[] | undefined;
}

type EndReason = 'stopped' | 'timeout' | 'flood';

interface Watch {
  id: string;
  sessionId: string;
  description: string;
  /** Redacted. */
  command: string;
  filter?: RegExp | undefined;
  filterSource?: string | undefined;
  child: ChildProcess;
  pid: number | null;
  startedAt: number;
  expiresAt: number;
  matched: number;
  notices: number;
  batch: string[];
  batchDropped: number;
  batchTimer: ReturnType<typeof setTimeout> | null;
  lifetimeTimer: ReturnType<typeof setTimeout> | null;
  windowStart: number;
  windowNotices: number;
  /** Set when WrongStack ended the watch; decides the final notice. */
  endReason: EndReason | null;
  ended: boolean;
}

const watches = new Map<string, Watch>();
let nextId = 1;

function view(w: Watch, now = Date.now()): ProcessWatchView {
  return {
    id: w.id,
    description: w.description,
    command: w.command,
    pid: w.pid,
    ...(w.filterSource ? { filter: w.filterSource } : {}),
    started_at: new Date(w.startedAt).toISOString(),
    expires_in_s: Math.max(0, Math.round((w.expiresAt - now) / 1000)),
    matched_lines: w.matched,
    notices: w.notices,
  };
}

function notify(w: Watch, title: string, body?: string, wake = true): void {
  w.notices += 1;
  try {
    enqueueRuntimeNotice(w.sessionId, {
      source: 'watch',
      handle: w.id,
      seq: w.notices,
      title,
      ...(body ? { body } : {}),
      wake,
    });
  } catch {
    // Delivery is best-effort; it must never break the watch's own teardown.
  }
}

function flush(w: Watch): void {
  if (w.batchTimer) clearTimeout(w.batchTimer);
  w.batchTimer = null;
  if (w.batch.length === 0) return;
  const lines = w.batch;
  const dropped = w.batchDropped;
  w.batch = [];
  w.batchDropped = 0;

  const now = Date.now();
  if (now - w.windowStart >= 60_000) {
    w.windowStart = now;
    w.windowNotices = 0;
  }
  w.windowNotices += 1;
  if (w.windowNotices > MAX_BATCHES_PER_MINUTE) {
    w.endReason = 'flood';
    terminate(w);
    return;
  }
  const count = lines.length + dropped;
  notify(
    w,
    `process_watch ${w.id} (${w.description}): ${count} new line${count === 1 ? '' : 's'}.`,
    lines.join('\n') + (dropped > 0 ? `\n… ${dropped} more line(s) in this batch` : ''),
  );
}

function onLine(w: Watch, raw: string, stream: 'stdout' | 'stderr'): void {
  if (w.ended || w.endReason) return;
  const line = raw.length > MAX_LINE_CHARS ? `${raw.slice(0, MAX_LINE_CHARS - 1)}…` : raw;
  if (line.trim() === '') return;
  if (w.filter && !w.filter.test(line)) return;
  w.matched += 1;
  if (w.batch.length < MAX_LINES_PER_BATCH) {
    w.batch.push(stream === 'stderr' ? `[stderr] ${line}` : line);
  } else {
    w.batchDropped += 1;
  }
  if (!w.batchTimer) {
    const timer = setTimeout(() => flush(w), BATCH_WINDOW_MS);
    timer.unref?.();
    w.batchTimer = timer;
  }
}

function attachLineReader(w: Watch, stream: 'stdout' | 'stderr'): void {
  const source = stream === 'stdout' ? w.child.stdout : w.child.stderr;
  if (!source) return;
  const decoder = new StringDecoder('utf8');
  let partial = '';
  source.on('data', (chunk: Buffer) => {
    partial += decoder.write(chunk);
    const parts = partial.split(/\r?\n/);
    partial = parts.pop() ?? '';
    if (partial.length > MAX_PARTIAL_CHARS) {
      parts.push(partial);
      partial = '';
    }
    for (const part of parts) onLine(w, part, stream);
  });
  source.on('end', () => {
    const rest = partial + decoder.end();
    partial = '';
    if (rest) onLine(w, rest, stream);
  });
  // A watch must never keep the host process alive on its own.
  (source as { unref?: () => void }).unref?.();
}

/** Kill the watch's process tree. Its 'close' handler sends the final notice. */
function terminate(w: Watch): void {
  if (w.lifetimeTimer) clearTimeout(w.lifetimeTimer);
  w.lifetimeTimer = null;
  if (w.ended) return;
  const registry = getProcessRegistry();
  if (typeof w.pid === 'number' && registry.kill(w.pid, { force: true })) return;
  try {
    w.child.kill();
  } catch {
    /* already exited */
  }
}

function onClose(w: Watch, code: number | null, signal: NodeJS.Signals | null): void {
  if (w.ended) return;
  // Lines still waiting for their batch window belong before the end notice.
  if (!w.endReason) flush(w);
  w.ended = true;
  if (w.batchTimer) clearTimeout(w.batchTimer);
  if (w.lifetimeTimer) clearTimeout(w.lifetimeTimer);
  w.batchTimer = null;
  w.lifetimeTimer = null;
  watches.delete(w.id);
  if (typeof w.pid === 'number') getProcessRegistry().unregister(w.pid);

  const duration = formatNoticeDuration(Date.now() - w.startedAt);
  const tally = `${w.matched} matching line${w.matched === 1 ? '' : 's'}`;
  switch (w.endReason) {
    case 'stopped':
      return; // The model stopped it and already knows.
    case 'timeout':
      notify(
        w,
        `process_watch ${w.id} (${w.description}) reached its ${formatNoticeDuration(w.expiresAt - w.startedAt)} limit and was stopped (${tally}).`,
        'Start a new watch if you still need it.',
      );
      return;
    case 'flood':
      notify(
        w,
        `process_watch ${w.id} (${w.description}) was stopped: more than ${MAX_BATCHES_PER_MINUTE} notices in a minute (${tally}).`,
        'Restart it with a narrower `filter` so only the lines you would act on become notices.',
      );
      return;
    default: {
      const how = signal ? `ended by signal ${signal}` : `exited with code ${code ?? 'unknown'}`;
      notify(
        w,
        `process_watch ${w.id} (${w.description}): the command ${how} after ${duration} (${tally}).`,
      );
    }
  }
}

function sessionWatches(sessionId: string): Watch[] {
  return [...watches.values()].filter((w) => w.sessionId === sessionId);
}

/** Active watches, optionally for one session (UI panels, diagnostics). */
export function listProcessWatches(sessionId?: string): ProcessWatchView[] {
  const now = Date.now();
  return [...watches.values()]
    .filter((w) => sessionId === undefined || w.sessionId === sessionId)
    .map((w) => view(w, now));
}

/** Stop one watch from a host surface (no notice). True when one was found. */
export function stopProcessWatch(id: string): boolean {
  const w = watches.get(id);
  if (!w) return false;
  w.endReason = 'stopped';
  terminate(w);
  watches.delete(w.id);
  return true;
}

/**
 * Test helper: stop every watch. Ids stay monotonic: the delivery hub dedupes
 * on `watch:<id>#<n>` for the life of the process.
 */
export function _resetProcessWatches(): void {
  for (const w of [...watches.values()]) {
    w.endReason = 'stopped';
    terminate(w);
    watches.delete(w.id);
  }
}

function requireSession(ctx: unknown, tool: string): string {
  const sessionId = resolveRuntimeNoticeTarget(ctx);
  if (!sessionId) {
    throw new Error(
      `${tool}: only the session leader receives watch notices. A sub-agent should run the command in the foreground instead.`,
    );
  }
  return sessionId;
}

function compileFilter(source: string | undefined): RegExp | undefined {
  if (source === undefined || source === '') return undefined;
  if (source.length > FILTER_MAX_CHARS) {
    throw new ToolValidationError({
      message: `filter is longer than ${FILTER_MAX_CHARS} characters`,
      field: 'filter',
    });
  }
  try {
    return new RegExp(source);
  } catch (err) {
    throw new ToolValidationError({
      message: `filter is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`,
      field: 'filter',
    });
  }
}

async function startWatch(input: ProcessWatchInput, ctx: unknown): Promise<ProcessWatchOutput> {
  const c = ctx as {
    projectRoot: string;
    workingDir?: string | undefined;
    session?: { id?: string } | undefined;
  };
  const command = typeof input?.command === 'string' ? input.command.trim() : '';
  if (!command) {
    throw new ToolValidationError({ message: 'command is required', field: 'command' });
  }
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (!description) {
    throw new ToolValidationError({
      message: 'description is required: a few words naming what you are watching for',
      field: 'description',
    });
  }
  const sessionId = requireSession(ctx, 'process_watch');
  const filter = compileFilter(input.filter);
  const rawTimeout =
    input.timeout_s === undefined || input.timeout_s === null
      ? WATCH_DEFAULT_TIMEOUT_S
      : Number(input.timeout_s);
  if (!Number.isFinite(rawTimeout)) {
    throw new ToolValidationError({ message: 'timeout_s must be a number', field: 'timeout_s' });
  }
  const timeoutS = Math.min(WATCH_MAX_TIMEOUT_S, Math.max(WATCH_MIN_TIMEOUT_S, rawTimeout));
  if (sessionWatches(sessionId).length >= WATCH_MAX_PER_SESSION) {
    throw new Error(
      `process_watch: this session already has ${WATCH_MAX_PER_SESSION} watches; stop one first (process_watch_control action=list).`,
    );
  }
  const killCheck = await checkAndBlockKillCommand(command);
  if (killCheck.blocked) {
    throw new Error(
      `process_watch: ${killCheck.reason || 'Kill command blocked: targets a protected WrongStack process.'}`,
    );
  }

  const isWin = os.platform() === 'win32';
  const { plan } = resolveBashShellPlan(command, { isWin, hermetic: false });
  const cwd = c.workingDir ?? c.projectRoot;
  let child: ChildProcess;
  try {
    child = spawn(plan.bin, [...plan.argv, plan.commandArg], {
      cwd,
      env: buildChildEnv(c.session?.id),
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group on POSIX so a stop kills the whole tree.
      detached: !isWin,
      windowsHide: true,
      ...(plan.verbatim ? { windowsVerbatimArguments: true } : {}),
    });
  } catch (err) {
    throw new Error(
      `process_watch: spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const now = Date.now();
  const w: Watch = {
    id: `pw-${nextId++}`,
    sessionId,
    description: description.length > 120 ? `${description.slice(0, 119)}…` : description,
    command: redactCommand(command),
    ...(filter ? { filter, filterSource: input.filter } : {}),
    child,
    pid: typeof child.pid === 'number' ? child.pid : null,
    startedAt: now,
    expiresAt: now + timeoutS * 1000,
    matched: 0,
    notices: 0,
    batch: [],
    batchDropped: 0,
    batchTimer: null,
    lifetimeTimer: null,
    windowStart: now,
    windowNotices: 0,
    endReason: null,
    ended: false,
  };

  // A launch failure surfaces as an async 'error' with no 'close' to follow
  // when the binary never started.
  const launchError = new Promise<Error | null>((resolve) => {
    child.once('error', (err) => resolve(err));
    child.once('spawn', () => resolve(null));
  });
  const err = await launchError;
  if (err || w.pid === null) {
    throw new Error(`process_watch: failed to start: ${err?.message ?? 'no pid'}`, {
      cause: err ?? undefined,
    });
  }

  getProcessRegistry().register({
    pid: w.pid,
    name: 'process_watch',
    command: w.command,
    startedAt: now,
    sessionId: c.session?.id,
    child,
    processGroupLeader: !isWin,
  });
  watches.set(w.id, w);
  attachLineReader(w, 'stdout');
  attachLineReader(w, 'stderr');
  child.on('close', (code, signal) => onClose(w, code, signal));
  // Errors after launch (a failed kill) do not end the watch; 'close' does.
  child.on('error', () => undefined);
  const lifetime = setTimeout(() => {
    if (w.ended) return;
    w.endReason = 'timeout';
    flush(w);
    terminate(w);
  }, timeoutS * 1000);
  lifetime.unref?.();
  w.lifetimeTimer = lifetime;
  child.unref();

  return {
    ok: true,
    message:
      `Watching ${w.id} (pid ${w.pid}) for up to ${formatNoticeDuration(timeoutS * 1000)}. ` +
      `Each ${filter ? 'matching ' : ''}output line arrives as a [RUNTIME NOTICE] (batched), and so does the command's exit; an idle session is woken for them. ` +
      'End your turn instead of polling. Stop it with process_watch_control action=stop once you have what you need.',
    watch: view(w, now),
  };
}

export const processWatchTool: Tool<ProcessWatchInput, ProcessWatchOutput> = {
  name: 'process_watch',
  category: 'Shell',
  description:
    'Run a command and deliver its output lines (optionally only those matching `filter`) to you as [RUNTIME NOTICE]s while it runs, plus its exit. An idle session is woken for them. Use for log tails, readiness lines, CI status loops; returns immediately.',
  usageHint:
    '- The command runs in the session shell like `bash`; every stdout/stderr line is an event. Lines within 200ms are batched into one notice.\n' +
    '- Set `filter` (a regex) to the lines you would act on, failures included: matching only the success line leaves you blind to a crash. Too many notices (>30/min) stops the watch.\n' +
    '- Never pipe through `head` or other commands that buffer; use `grep --line-buffered` if you filter in the shell. For a poll loop, emit one line per state change, not raw logs.\n' +
    '- `timeout_s` defaults to 300 (max 1800). Stop it with process_watch_control once done.\n' +
    '- For "tell me when it finishes" alone, a background bash/pwsh process already reports its exit; for a clock, use session_wakeup.',
  selection: {
    doNotUseWhen: 'you only need to know when a background process exits, or you need a timer.',
    useInstead: ['bash', 'session_wakeup'],
  },
  permission: 'confirm',
  mutating: true,
  riskTier: 'destructive',
  icon: 'logs',
  subjectKey: 'command',
  capabilities: ['shell.arbitrary'],
  estimatedDurationMs: 1_000,
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Shell command whose output lines are the events (e.g. `tail -f app.log`).',
      },
      description: {
        type: 'string',
        description: 'A few words naming what you watch for; shown in every notice.',
      },
      filter: {
        type: 'string',
        description:
          'Regex; only matching lines become notices. Include failure patterns, not only success.',
      },
      timeout_s: {
        type: 'number',
        description: `Lifetime in seconds (default ${WATCH_DEFAULT_TIMEOUT_S}, max ${WATCH_MAX_TIMEOUT_S}).`,
      },
    },
    required: ['command', 'description'],
  },
  async execute(input, ctx) {
    return startWatch(input, ctx);
  },
};

export const processWatchControlTool: Tool<ProcessWatchControlInput, ProcessWatchOutput> = {
  name: 'process_watch_control',
  category: 'Shell',
  description: 'List this session\'s process watches or stop one (id) or all (id="all").',
  permission: 'auto',
  mutating: false,
  riskTier: 'safe',
  icon: 'logs',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'stop'] },
      id: { type: 'string', description: 'stop: the watch id, or "all".' },
    },
    required: ['action'],
  },
  async execute(input, ctx) {
    const sessionId = requireSession(ctx, 'process_watch_control');
    if (input?.action === 'list') {
      const items = sessionWatches(sessionId).map((w) => view(w));
      return {
        ok: true,
        message: items.length === 0 ? 'No active watches.' : `${items.length} active watch(es).`,
        watches: items,
      };
    }
    if (input?.action !== 'stop') {
      throw new ToolValidationError({ message: 'action must be list or stop', field: 'action' });
    }
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) throw new ToolValidationError({ message: 'stop requires id (or "all")', field: 'id' });
    const targets =
      id === 'all'
        ? sessionWatches(sessionId)
        : [watches.get(id)].filter((w): w is Watch => w?.sessionId === sessionId);
    if (targets.length === 0) {
      if (id === 'all') return { ok: true, message: 'No watches to stop.', stopped: [] };
      throw new Error(`process_watch_control: no watch '${id}' in this session (see action=list).`);
    }
    for (const w of targets) {
      w.endReason = 'stopped';
      terminate(w);
      // Gone from list and the per-session cap now, not when 'close' lands.
      watches.delete(w.id);
    }
    const stopped = targets.map((w) => w.id);
    return { ok: true, message: `Stopped ${stopped.join(', ')}.`, stopped };
  },
};

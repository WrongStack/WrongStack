import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Two-way WS completeness guard.
 *
 * The WebUI must have a fully bidirectional protocol: every action the browser
 * takes reaches the server, and every message the server sends back is handled
 * by the browser. This test guards the SERVER→CLIENT direction (the parity test
 * guards CLIENT→SERVER coverage across the two servers): for every
 * `send(ws, { type })` / `broadcast({ type })` either WebUI server emits, the
 * client must register a handler — otherwise the response is silently dropped
 * (e.g. the standalone server's `mailbox.received` / `mailbox.agent_registered`
 * live events used to vanish because only `mailbox.event` was handled).
 *
 * Client handler surfaces: the `WS_HANDLERS` map in `hooks/ws-handlers.ts`,
 * `.on(...)` / `.on?.(...)` subscriptions anywhere in the webui src, and a few
 * messages consumed internally by the ws-client itself.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const webui = path.join(repoRoot, 'packages/webui');
const webuiServer = path.join(repoRoot, 'packages/webui-server');
const cli = path.join(repoRoot, 'packages/cli');

/** Recursively collect *.ts/*.tsx files under a dir. */
function srcFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, {
    withFileTypes: true,
    recursive: true,
  }) as fs.Dirent[]) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue;
    if (name.endsWith('.test.ts') || name.endsWith('.test.tsx')) continue;
    // recursive readdir gives parentPath on Node 18.17+/20+/22.
    const base = (entry as never as { parentPath?: string; path?: string }).parentPath ?? dir;
    out.push(path.join(base, name));
  }
  return out;
}

function read(files: string[]): string {
  return files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}

/** Types the servers send to the client via send(ws,{type}) / broadcast({type}). */
function serverSendTypes(): Set<string> {
  const sources = read([
    ...srcFiles(path.join(webui, 'src/server')),
    ...srcFiles(path.join(webuiServer, 'src/server')),
    path.join(cli, 'src/webui-server.ts'),
    ...srcFiles(path.join(cli, 'src/webui-server')),
  ]);
  const types = new Set<string>();
  // send(ws, { type: 'x' ...  /  broadcast(clients, { type: 'x'  /  broadcast({ type: 'x'
  for (const m of sources.matchAll(/(?:send\(ws,|broadcast\()[^{]*\{\s*type:\s*'([^']+)'/g)) {
    types.add(m[1] as string);
  }
  return types;
}

/** Types the client handles: WS_HANDLERS keys + .on()/.on?.() + internal. */
function clientHandledTypes(): Set<string> {
  const handlerMap = fs.readFileSync(path.join(webui, 'src/hooks/ws-handlers.ts'), 'utf8');
  // Also scan sub-handler modules extracted from ws-handlers.ts
  const subHandlerDir = path.join(webui, 'src/hooks/ws-handlers');
  const subHandlers = fs.existsSync(subHandlerDir) ? read(srcFiles(subHandlerDir)) : '';
  const all = read(srcFiles(path.join(webui, 'src')));
  const types = new Set<string>([
    // Consumed inside ws-client.handleMessage / heartbeat, not via .on().
    'session.frames_resumed',
    'session.start',
    'tool.confirm_needed',
    'pong',
  ]);
  // Quoted keys may be camelCase (`memory.sage.candidateResolve`) or contain
  // hyphens (`goal-state.updated`), so the character class must allow uppercase
  // and hyphens — otherwise a wired handler reads as missing and this guard
  // reports a false drop.
  for (const m of handlerMap.matchAll(/^\s*'([A-Za-z0-9_.-]+)'\s*:/gm)) types.add(m[1] as string);
  for (const m of handlerMap.matchAll(/^\s*([a-z][A-Za-z0-9_]*)\s*:\s*\(/gm)) {
    types.add(m[1] as string);
  }
  for (const m of subHandlers.matchAll(/^\s*'([A-Za-z0-9_.-]+)'\s*:/gm)) types.add(m[1] as string);
  for (const m of subHandlers.matchAll(/^\s*([a-z][A-Za-z0-9_]*)\s*:\s*\(/gm)) {
    types.add(m[1] as string);
  }
  for (const m of all.matchAll(/\.on\??\.?\(\s*'([^']+)'/g)) types.add(m[1] as string);
  return types;
}

/**
 * Server→client types that are intentionally NOT consumed by the browser.
 * These are observability/redundant streams, not responses to a user action —
 * so dropping them never makes a WebUI operation silently fail. Each entry has
 * a reason; if you wire one up, remove it from here.
 */
const INTENTIONALLY_UNHANDLED = new Set<string>([
  // Explicit desktop-owned content-search replies. The WebUI does not issue
  // files.search; its own search UI uses a separate implementation. The native
  // FileContentSearch consumes these correlated replies through EngineOperations.
  'files.search',
  // Desktop's GitWorkspace owns correlated hunk/conflict review requests;
  // the WebUI does not issue these requests (it uses git.diff instead).
  'git.hunks',
  'git.conflict',
  // Collab "observer mirror" stream — incomplete feature, no UI surface yet,
  // standalone-only (the CLI server no-ops collab). See webui-cli-ws-protocol-parity.
  'collab.event',
  'collab.injection.granted',
  // Eternal-autonomy iteration stream — observability only; the loop is started
  // from REPL/TUI/--eternal, not a WebUI action, and has no live consumer yet.
  'eternal.iteration',
  // Terminal error frame — sent fire-and-forget when a pty-spawn or pty-write
  // rejects. The terminal panel already shows pty output/exit on success paths;
  // this diagnostic frame is a best-effort surface for edge-case failures that
  // don't have a dedicated UI handler yet.
  'terminal.error',
  // Sandbox lifecycle telemetry (plan 28) — the WebUI reads the active tier via
  // the `/api/sandbox/status` poll (`useSandboxStatus`); these frames are
  // forward-looking live signal with no dedicated UI consumer yet.
  'sandbox.event',
  // Goal granular events — the client mirrors the full canonical state via
  // `goal.state` (handled), so these per-event signals are redundant.
  'goal.error',
  'goal.failed',
  'goal.list',
  'goal.paused',
  'goal.progress',
  'goal.resumed',
  'goal.saved',
  'goal.stopped',
  // Prompt-library fire-and-forget acks. The modal applies an optimistic update
  // when toggling a favorite / inserting a prompt and never reads the server
  // `{ success }` echo, so dropping it changes nothing the user sees.
  'prompts.favorite',
  'prompts.used',
  // Server-side prompt search. The WebUI modal filters the already-loaded
  // `prompts.list` payload locally and never issues `prompts.search`, so this
  // response has no browser consumer (it exists for other pickers).
  'prompts.search',
  // Skill-authoring/install acknowledgements are consumed by non-Website
  // clients. The Website refreshes `skills.list` after mutations and does not
  // register handlers for these one-shot acknowledgement frames.
  'skills.created',
  'skills.exported',
  'skills.installed',
  // Redundant design-state echo. The gallery mirrors activeKit/stack/overrides
  // from the `design.list` payload (handled) and never issues `design.state`.
  'design.state',
  // Bulk file-operation replies. The bulk copy/move/delete dialogs live in the
  // desktop client (`FileWorkspace.tsx` issues `files.copy_many`/`move_many`/
  // `delete_many` and awaits `['files.copied_many']`/`['files.moved_many']`/
  // `['files.deleted_many']`); the browser WebUI has no bulk-file UI and never
  // sends those requests, so these correlated replies have no browser consumer.
  'files.copied_many',
  'files.deleted_many',
  'files.moved_many',
  // SAGE injection audit reply. Only the desktop client's injection history
  // (`SageInjectionHistory.tsx`) requests `memory.sage.audit`; the browser
  // WebUI never sends it, so the correlated reply has no browser consumer.
  'memory.sage.audit',
  // Provider-failover signal. The desktop engine state consumes it
  // (`engine-state.ts` re-reads the active engine on `provider.fallback` /
  // `provider.primary_restored`); the browser renders provider state from its
  // own provider responses and registers no handler for this event.
  'provider.primary_restored',
  // Task-activity stream for the open-ledger panel enhancement. The handler is
  // registered via `ws.on.bind(ws)` in KanbanView.tsx, which the static
  // `.on('...')` regex cannot detect; non-critical — dropped messages merely
  // delay a telemetry refresh in the task detail drawer.
  'kanban.task.activity.changed',
]);

describe('WebUI two-way WS completeness (server→client)', () => {
  it('every server-sent message type has a client handler (or is allowlisted)', () => {
    const sent = serverSendTypes();
    const handled = clientHandledTypes();
    expect(sent.size).toBeGreaterThan(30);

    const dropped = [...sent]
      .filter((t) => !handled.has(t) && !INTENTIONALLY_UNHANDLED.has(t))
      .sort();
    // If this fails, a server broadcasts a message the browser never handles —
    // wire a handler in hooks/ws-handlers.ts (or a `.on(...)`), or stop sending
    // it, or (if it's a deliberate non-UI stream) add it to INTENTIONALLY_UNHANDLED.
    expect(dropped).toEqual([]);
  });
});

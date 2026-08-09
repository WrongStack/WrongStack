import type { AnnotationsStoreOptions } from '@wrongstack/core/storage';
import type { SlashCommand } from '@wrongstack/core/types';
import { color, toErrorMessage, truncate } from '@wrongstack/core/utils';
import type { SlashCommandContext } from './command-context.js';
import { parseSubcommand, unknownSubcommand } from './helpers.js';

/**
 * /collab — operator-side controls for the live-collaboration feature
 * (Phase 1 of idea #13 from IDEAS.md).
 *
 * The CLI doesn't speak the WebSocket protocol itself — the *observer*
 * client is a browser (webui). But the CLI user is the agent's owner
 * and needs to know:
 *
 *   - Is anyone watching this session right now?
 *   - How do I give someone a link to join?
 *   - What's been happening (so I can summarize for a teammate)?
 *
 * That's what these three subcommands do. The "actual join" flow
 * lives in the webui's `CollabPanel`.
 *
 * Note: the observer count is currently best-effort. The webui server
 * keeps a live participant list per session but the CLI doesn't see
 * that state directly. For now we show "observer count: unknown" and
 * the invite URL; a future iteration can pipe the count through the
 * kernel's EventBus (e.g. by listening to `collab.participant.joined`
 * in the CLI's own EventBus subscriber).
 */
export function buildCollabCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'collab',
    category: 'Agent',
    description: 'Live collaboration helpers (status / invite / history).',
    async run(args, ctx) {
      const { cmd, rest } = parseSubcommand(args);
      const sub = cmd || 'status';
      const sessionId = ctx?.session?.id;
      switch (sub) {
        case 'status':
          return statusCommand(sessionId ?? undefined);
        case 'invite':
          return inviteCommand(sessionId ?? undefined);
        case 'history':
          return historyCommand(opts, sessionId ?? undefined, rest);
        case 'annotations':
        case 'notes':
          return annotationsCommand(opts, sessionId ?? undefined);
        case 'help':
        case '--help':
        case '-h':
          return helpCommand();
        default:
          return {
            message: color.yellow(
              unknownSubcommand(sub, ['status', 'invite', 'history', 'annotations'], 'collab'),
            ),
          };
      }
    },
  };
}

function statusCommand(sessionId: string | undefined): { message: string } {
  const lines: string[] = [];
  lines.push(color.bold('Live collaboration'));
  lines.push(`  Session: ${color.cyan(sessionId ?? '(none)')}`);
  lines.push(`  Observers: ${color.dim('unknown (check webui)')}`);
  lines.push('');
  lines.push(color.dim('  Tip: /collab invite — print a webui join link for a teammate'));
  lines.push(color.dim('       /collab history 20 — show the last 20 events of this session'));
  return { message: lines.join('\n') };
}

function inviteCommand(sessionId: string | undefined): { message: string } {
  if (!sessionId) {
    return { message: color.yellow('No active session to invite to.') };
  }
  // The webui binds to 127.0.0.1:3456 by default (WS shares the HTTP port).
  // For a teammate to join, the operator must be running the webui and
  // expose the port; we print the canonical URL the webui logs on start.
  const url = `http://127.0.0.1:3456/?session=${encodeURIComponent(sessionId)}`;
  const lines: string[] = [
    color.bold('Live-collaboration invite'),
    `  Session ID: ${color.cyan(sessionId)}`,
    `  Share this URL with a teammate (they must be able to reach your machine):`,
    `    ${color.cyan(url)}`,
    '',
    color.dim('  The teammate opens the URL in their browser, then clicks "Join as observer"'),
    color.dim('  on the panel that appears above the chat. They will see a live mirror'),
    color.dim('  of tool calls, iterations, and subagent spawns — read-only.'),
    '',
    color.dim('  Reminder: expose the port with: pnpm --filter @wrongstack/webui dev'),
  ];
  return { message: lines.join('\n') };
}

async function historyCommand(
  opts: SlashCommandContext,
  sessionId: string | undefined,
  args: string[],
): Promise<{ message: string }> {
  const limit = Math.max(1, Math.min(200, Number.parseInt(args[0] ?? '20', 10) || 20));
  if (!sessionId) return { message: color.yellow('No active session.') };
  if (!opts.sessionStore) {
    return { message: color.yellow('No session store configured.') };
  }
  // Reuse the same reader shape the webui uses, scoped to the in-memory
  // session store the REPL is currently writing to.
  const { DefaultSessionReader } = await import('@wrongstack/core/storage');
  const reader = new DefaultSessionReader({ store: opts.sessionStore });
  const events: unknown[] = [];
  try {
    for await (const ev of reader.replay(sessionId)) {
      events.push(ev);
    }
  } catch (err) {
    return {
      message: color.yellow(`Failed to read session: ${toErrorMessage(err)}`),
    };
  }
  const tail = events.slice(-limit);
  if (tail.length === 0) {
    return { message: color.dim('No events recorded yet for this session.') };
  }
  const lines: string[] = [color.bold(`Last ${tail.length} events of ${sessionId}`), ''];
  for (const raw of tail) {
    const ev = raw as { type?: string | undefined; ts?: string | undefined; [k: string]: unknown };
    const t = ev.ts ? color.dim(ev.ts.slice(11, 19)) : color.dim('--:--:--');
    const kind = color.cyan((ev.type ?? 'unknown').padEnd(16));
    const summary = summarise(ev);
    lines.push(`  ${t}  ${kind}  ${summary}`);
  }
  return { message: lines.join('\n') };
}

/**
 * Read-side companion to webui annotations: prints the open
 * (unresolved) annotations stored on disk for the current session.
 * The CLI can read them but cannot create them — the annotator
 * role lives in the webui, by design.
 */
async function annotationsCommand(
  opts: SlashCommandContext,
  sessionId: string | undefined,
): Promise<{ message: string }> {
  if (!sessionId) return { message: color.yellow('No active session.') };
  if (!opts.sessionStore) {
    return { message: color.yellow('No session store configured.') };
  }
  // The annotations file lives in the same dir the webui writes to.
  // In the CLI we don't have direct access to the webui's wpaths, so
  // we fall back to the session store's dir (they are colocated in
  // the same `.wrongstack/sessions/` tree under normal setups).
  const { DefaultSessionReader, AnnotationsStore } = await import('@wrongstack/core/storage');
  const reader = new DefaultSessionReader({ store: opts.sessionStore });
  // We need the store's dir to instantiate AnnotationsStore. The
  // SessionStore interface doesn't expose `dir` directly, so we
  // probe via a private cast — AnnotationsStore expects a path
  // string and the SessionStore dir is set in the same boot config.
  const storeDir = (opts.sessionStore as never as { dir?: string | undefined }).dir;
  if (!storeDir) {
    return {
      message: color.yellow(
        'Annotations view needs the session store dir; not exposed in this build.',
      ),
    };
  }
  void reader; // reader is reserved for future /collab history expansion
  const annotationsOpts: AnnotationsStoreOptions = { dir: storeDir, events: opts.events };
  if (opts.context?.traceId !== undefined) annotationsOpts.traceId = opts.context.traceId;
  const annotations = new AnnotationsStore(annotationsOpts);
  const open = await annotations.listOpen(sessionId);
  if (open.length === 0) {
    return {
      message: color.dim('No open annotations for this session.'),
    };
  }
  const lines: string[] = [color.bold(`${open.length} open annotation(s) for ${sessionId}`), ''];
  for (const a of open) {
    const t = color.dim(a.createdAt.slice(11, 19));
    const author = color.cyan(a.authorId.slice(0, 8));
    const idx = color.dim(`#${a.atEventIndex}`);
    lines.push(`  ${t}  ${idx}  ${author}  ${a.text}`);
  }
  return { message: lines.join('\n') };
}

function summarise(ev: Record<string, unknown>): string {
  switch (ev['type']) {
    case 'user_input': {
      const text = typeof ev['text'] === 'string' ? ev['text'] : '';
      return color.dim(truncate(text, 80));
    }
    case 'llm_response': {
      const text = typeof ev['text'] === 'string' ? ev['text'] : '';
      return color.dim(truncate(text, 80));
    }
    case 'tool_result': {
      const name = String(ev['name'] ?? '?');
      const ok = ev['ok'] === false ? color.red('(failed)') : color.green('(ok)');
      return `${name} ${ok}`;
    }
    case 'compaction': {
      const before = ev['before'];
      const after = ev['after'];
      return `tokens ${before}→${after}`;
    }
    case 'error': {
      return color.red(String(ev['message'] ?? '(no message)'));
    }
    default: {
      return color.dim(JSON.stringify(ev).slice(0, 80));
    }
  }
}

function helpCommand(): { message: string } {
  const lines: string[] = [
    color.bold('/collab — live collaboration (read-only observers)'),
    '',
    'Subcommands:',
    `  ${color.cyan('status')}             Show current session's collaboration status`,
    `  ${color.cyan('invite')}            Print a webui join link for a teammate`,
    `  ${color.cyan('history [N]')}       Show the last N events of this session (default 20, max 200)`,
    `  ${color.cyan('annotations')}       List open (unresolved) annotations from webui annotators`,
    `  ${color.cyan('help')}              Show this help`,
    '',
    color.dim('  The observer flow itself lives in the webui: open the URL printed'),
    color.dim('  by `invite` and click "Join as observer" on the panel above the chat.'),
  ];
  return { message: lines.join('\n') };
}

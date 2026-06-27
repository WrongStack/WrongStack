import type { SlashCommand } from '@wrongstack/core';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveProjectDir, wstackGlobalRoot } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

/**
 * `/mailbox-serve` — start the mailbox HTTP bridge from inside the REPL.
 *
 * Spawns `wstack mailbox serve` as a detached child process so the REPL
 * stays interactive. The child prints its own bind URL + token path on
 * stdout; we just confirm the spawn, surface the token path, and let
 * the user know the bridge is up.
 *
 *   /mailbox-serve                  # defaults: 127.0.0.1, OS-assigned port
 *   /mailbox-serve --host 0.0.0.0   # expose to LAN
 *   /mailbox-serve --port 9000     # pin port (with strict-port semantics)
 *
 * The slash command is a thin REPL-friendly wrapper — it does NOT
 * duplicate the bridge logic. `wstack mailbox serve` is the single
 * source of truth, including auth, route table, and shutdown semantics.
 */
export function buildMailboxServeCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'mailbox-serve',
    category: 'Run',
    description: 'Start the mailbox HTTP bridge so external agents (Claude Code, Aider, scripts) can read/send messages on the project mailbox.',
    argsHint: '[--host <ip>] [--port <n>] [--strict-port]',
    help: [
      'Spawns `wstack mailbox serve` as a detached child process so the REPL stays interactive.',
      '',
      'Usage:',
      '  /mailbox-serve                          Bind 127.0.0.1, OS-assigned port',
      '  /mailbox-serve --host <ip>              Bind a specific host (e.g. 0.0.0.0 to expose on LAN)',
      '  /mailbox-serve --port <n>               Pin the port',
      '  /mailbox-serve --strict-port            Fail if the pinned port is in use',
      '',
      'Output:',
      '  - The child writes its bind URL, port, project dir, and token path',
      '    to its own stdout (look for the `mailbox_serve_started` JSON event).',
      '  - The slash command reads the freshly-written token file and prints',
      '    the path so you can hand it to an external agent.',
      '',
      'Stop the bridge with Ctrl+C in the terminal where the child is running,',
      'or send SIGTERM to its PID.',
      '',
      'Examples:',
      '  /mailbox-serve',
      '  /mailbox-serve --port 9000 --strict-port',
      '  /mailbox-serve --host 0.0.0.0 --port 9000',
    ].join('\n'),
    async run(args) {
      // Parse flags — keep parsing local to this slash command. The
      // bridge itself parses the same flags in `wstack mailbox serve`.
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const flags: string[] = [];
      for (const tok of tokens) {
        if (tok === '--strict-port') flags.push(tok);
        else if (tok.startsWith('--host=') || tok.startsWith('--port=')) flags.push(tok);
        else if (tok === '--host' || tok === '--port') flags.push(tok);
      }
      const cwd = opts.paths?.projectDir ?? opts.cwd;

      // Resolve the project dir up-front so we can show the token path
      // even if the child takes a moment to start. This matches the
      // bridge's `resolveProjectDir()` exactly so the printed path is
      // the actual file the child will create.
      const projectDir = resolveProjectDir(cwd, wstackGlobalRoot());
      const tokenPath = path.join(projectDir, '.mailbox.token');
      const pidFile = path.join(os.tmpdir(), `wstack-mailbox-bridge-${path.basename(projectDir)}.pid`);

      // Locate the `wstack` binary. Prefer process.argv[1]'s sibling — the
      // node entry of the running CLI — so dev builds (running from
      // source) also work. Falls back to `wstack` on PATH for installed
      // copies.
      const cliEntry = process.argv[1];
      const wstackCmd = cliEntry && /wstack|wrongstack|index\.(js|ts)$/.test(cliEntry)
        ? cliEntry
        : 'wstack';

      const child = spawn(wstackCmd, ['mailbox', 'serve', ...flags], {
        cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: process.env,
      });
      child.unref();

      // Record the child's PID so the user (or a future slash command)
      // can stop it cleanly. We write best-effort; if the file can't
      // be written, the bridge still works — the user can just kill
      // the process by name.
      try {
        await fs.writeFile(pidFile, String(child.pid ?? ''), { mode: 0o600 });
      } catch {
        // best-effort
      }

      // Buffer the first ~4 KB of the child's stdout so we can surface
      // the bind URL / token path once it starts up. We don't block —
      // the bridge takes a moment to bind, then prints.
      const head: Buffer[] = [];
      let total = 0;
      const MAX = 4096;
      child.stdout?.on('data', (chunk: Buffer) => {
        if (total >= MAX) return;
        const remaining = MAX - total;
        head.push(chunk.subarray(0, remaining));
        total += chunk.length;
      });

      // Wait up to 3 s for the bridge to print its startup banner.
      // `mailbox_serve_started` is the deterministic hook; we look for
      // either that JSON line or the human banner.
      const start = Date.now();
      while (Date.now() - start < 3000) {
        await new Promise((r) => setTimeout(r, 100));
        const text = Buffer.concat(head).toString('utf8');
        if (text.includes('mailbox_serve_started') || text.includes('mailbox bridge listening')) {
          break;
        }
      }
      const banner = Buffer.concat(head).toString('utf8').trim();

      const r = opts.renderer;
      r.write('Mailbox bridge spawned in the background.\n');
      if (child.pid !== undefined) r.write(`  PID:        ${child.pid}\n`);
      r.write(`  Project:    ${projectDir}\n`);
      r.write(`  Token file: ${tokenPath} (mode 0600, rotated per start)\n`);
      r.write(`  PID file:   ${pidFile}\n`);
      if (banner) {
        r.write('\n--- bridge startup banner ---\n');
        r.write(`${banner}\n`);
        r.write('--- end banner ---\n');
      } else {
        r.write('\n(Bridge did not print a banner within 3 s — check `tail -f` on its stdout if you redirected it.)\n');
      }
      r.write(`\nTo stop: kill the PID above, or run 'kill $(cat ${pidFile})'.\n`);
      r.write('The bridge survives this REPL exiting — it keeps running until you stop it.\n');
      return { message: 'Mailbox bridge spawned in the background.' };
    },
  };
}
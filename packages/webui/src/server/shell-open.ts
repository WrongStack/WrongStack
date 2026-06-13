// Open the OS file manager or a terminal at a given path (the
// `shell.open` WS message handler).
//
// Both the standalone `startWebUI` and the CLI's `runWebUI` needed
// the same logic \u2014 metacharacter guard, `path.resolve` to fold
// any `..` traversal, and a cross-platform `spawn()` for the
// platform's file manager (`explorer`/`open`/`xdg-open`) or
// terminal (`cmd /c start cmd /k` / `open -a Terminal` /
// `x-terminal-emulator` \u2192 `gnome-terminal` \u2192 `xterm` fallback chain).
// Phase 1.2 added the `spawn`-based version on the CLI side; the
// standalone got it shortly after. The two implementations have
// drifted slightly (CLI lacks the `logger.warn` on spawn failure),
// which is exactly the class of bug extraction prevents.
//
// This module returns a `ShellOpenResult` so the caller (the WS
// router in either entry point) can pipe it through `sendResult`
// with the same `success`/`message` shape both sides already use.
// Spawn is async + detached + unref'd so a missing terminal
// emulator (which fires `error` async) never crashes the server
// \u2014 the fallback chain tries the next one, the file-manager
// branch just logs.
//
// SECURITY: the path arrives over the WebSocket. The
// metacharacter guard (`/[&|<>^\"'`\n\r]/`) closes the cmd.exe
// re-parsing injection class (`"foo" && calc.exe`,
// `'$(...)'`, backticks, redirections) before anything reaches
// the argv array. The `path.resolve` then folds any
// `..` traversal, and `fs.access(resolved)` enforces that the
// target exists \u2014 callers can't ask us to open a non-existent
// path. Defense in depth: the spawn below uses an argv array
// (no string concatenation), and `windowsHide` keeps the
// launcher console out of the way.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { Logger } from '@wrongstack/core';

export type ShellOpenTarget = 'terminal' | 'file-manager';

export interface ShellOpenRequest {
  path: string;
  target: ShellOpenTarget;
}

export interface ShellOpenResult {
  success: boolean;
  message: string;
}

/** Metacharacters that would let a path slip past an argv-array
 *  spawn and into a shell re-parse on Windows. Real directory
 *  paths virtually never contain these. */
const METACHAR_REGEX = /[&|<>^"'`\n\r]/;

export async function handleShellOpen(
  req: ShellOpenRequest,
  logger: Logger,
): Promise<ShellOpenResult> {
  try {
    const resolved = path.resolve(req.path);
    await fs.access(resolved);
    if (METACHAR_REGEX.test(resolved)) {
      return { success: false, message: 'Path contains unsupported characters.' };
    }

    const platform = process.platform;
    const launch = (cmd: string, args: string[], onError?: () => void) => {
      const child = spawn(cmd, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      // `error` fires when the binary is missing (e.g. xterm not
      // installed) \u2014 log it, but never block the WS caller. The
      // fallback chain in the terminal branch uses onError to try
      // the next emulator.
      child.on('error', (err) => {
        logger.warn(`shell.open spawn failed: ${err.message}`);
        onError?.();
      });
      child.unref();
    };

    if (req.target === 'file-manager') {
      if (platform === 'win32') launch('explorer', [resolved]);
      else if (platform === 'darwin') launch('open', [resolved]);
      else launch('xdg-open', [resolved]);
    } else if (req.target === 'terminal') {
      if (platform === 'win32') {
        // `start` is a cmd builtin; each token is a separate argv
        // entry (Node quotes them individually \u2014 no string
        // concatenation). This replaces the previous
        // `start cmd /k cd /d "..."` exec() call that was
        // shell-injectable.
        launch('cmd', ['/c', 'start', 'cmd', '/k', 'cd', '/d', resolved]);
      } else if (platform === 'darwin') {
        launch('open', ['-a', 'Terminal', resolved]);
      } else {
        // Try several terminal emulators
        launch('x-terminal-emulator', [`--working-directory=${resolved}`], () =>
          launch('gnome-terminal', [`--working-directory=${resolved}`], () =>
            launch('xterm', ['-e', `cd '${resolved}' && ${process.env['SHELL'] ?? 'sh'}`]),
          ),
        );
      }
    } else {
      return { success: false, message: `Unknown shell.open target: ${String(req.target)}` };
    }
    return { success: true, message: `Opened ${req.target} at ${resolved}` };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

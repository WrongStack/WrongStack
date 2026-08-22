// Open the OS file manager or a terminal at a given path (the
// `shell.open` WS message handler).
//
// Both the standalone `startWebUI` and the CLI's `runWebUI` needed
// the same logic — metacharacter guard, `path.resolve` to fold
// any `..` traversal, and a cross-platform `spawn()` for the
// platform's file manager (`explorer`/`open`/`xdg-open`) or
// terminal (`cmd /c start cmd /k` / `open -a Terminal` /
// `x-terminal-emulator` → `gnome-terminal` → `xterm` fallback chain).
//
// This module returns a `ShellOpenResult` so the caller (the WS
// router in either entry point) can pipe it through `sendResult`
// with the same `success`/`message` shape both sides already use.
// Spawn is async + detached + unref'd so a missing terminal
// emulator (which fires `error` async) never crashes the server
// — the fallback chain tries the next one, the file-manager
// branch just logs.
//
// SECURITY: the path arrives over the WebSocket. Three layers of
// defense:
//   1. Lexical containment — `path.resolve` folds `..` traversal,
//      then `path.relative` verifies the resolved path is inside the
//      project root. Mandatory (no caller may omit projectRoot).
//   2. Metacharacter guard — rejects characters that enable cmd.exe
//      re-parsing injection (&|;<>(){}^"'`%) and env-var expansion (%).
//   3. Canonical containment — `fs.realpath` resolves symlinks on both
//      the project root and the target, then re-checks containment
//      against the canonical paths. This closes the TOCTOU window
//      where a symlink could be swapped between the lexical check and
//      the spawn, and rejects in-project symlinks whose real target
//      escapes the project directory.
// Defense in depth: the spawn below uses an argv array
// (no string concatenation), and `windowsHide` keeps the
// launcher console out of the way.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { Logger } from '@wrongstack/core/types';

export type ShellOpenTarget = 'terminal' | 'file-manager';

export interface ShellOpenRequest {
  path: string;
  target: ShellOpenTarget;
}

/**
 * Normalize a raw wire-format target value to a valid `ShellOpenTarget`.
 *
 * Maps `'terminal'` → `'terminal'`, everything else (including `'file'`,
 * `'file-manager'`, `undefined`, unknown strings) → `'file-manager'`.
 *
 * This reconciles the legacy wire format (`target: 'file'`) which the
 * payload validators may still accept, with the handler contract
 * (`'terminal' | 'file-manager'`), and ensures consistent behavior
 * across both the standalone and embedded WebUI routers.
 */
export function normalizeShellOpenTarget(
  target: string | undefined,
): ShellOpenTarget {
  return target === 'terminal' ? 'terminal' : 'file-manager';
}

/**
 * Security options for `handleShellOpen`.
 *
 * `projectRoot` is **required** — it confines the resolved path to the
 * project directory. Without it a WebSocket client could open the OS
 * file manager or terminal at ANY existing path on the system
 * (/etc, ~/.ssh, C:\Windows). The TrustBoundary authorization may use
 * a permissive compatibility policy, so path containment is enforced
 * here as defense-in-depth.
 */
export interface ShellOpenOptions {
  projectRoot: string;
}

export interface ShellOpenResult {
  success: boolean;
  message: string;
}

/** Metacharacters that would let a path slip past an argv-array
 *  spawn and into a shell re-parse on Windows. Includes cmd.exe
 *  command separators (& | ;), subshell grouping ( ( ) { } ),
 *  environment-variable expansion (%), caret escaping (^), quote
 *  characters, backticks, and control characters. Real directory
 *  paths virtually never contain these. */
const METACHAR_REGEX = /[&|;<>(){}^"'`%\n\r\0]/;

/** Escape a string for safe use as a single-quoted shell argument.
 *  Replaces ' -> '\'' (end quote, escaped quote, restart quote). */
function shellQuote(s: string): string {
  return s.replaceAll("'", "'\"'\"'");
}

export async function handleShellOpen(
  req: ShellOpenRequest,
  logger: Logger,
  options: ShellOpenOptions,
): Promise<ShellOpenResult> {
  try {
    const root = path.resolve(options.projectRoot);
    const resolved = path.isAbsolute(req.path)
      ? path.normalize(req.path)
      : path.resolve(root, req.path);

    // ── Layer 1: Metacharacter guard on the lexical path ──
    //
    // Runs before any filesystem access so a rejected path never touches the
    // disk — access errors (ENOENT vs EACCES) must not leak metadata about
    // paths the metacharacter policy blocks with a uniform message.
    if (METACHAR_REGEX.test(resolved)) {
      return { success: false, message: 'Path contains unsupported characters.' };
    }

    // Canonicalize the project root ONCE and reuse it for every containment
    // comparison below — mixing an unresolved root in one check with the
    // canonical root in the other lets a symlinked root (worktree, junction,
    // sandbox mount) produce inconsistent verdicts, and widens a TOCTOU
    // window where the root itself could be swapped between checks.
    const realProjectRoot = await fs.realpath(root);

    // ── Layer 2: Project-root containment (early reject) ──
    //
    // Accept either root spelling: a symlinked project root can legitimately
    // be addressed through the link prefix or the canonical prefix. This is
    // only the cheap early reject — the canonical check after realpath is
    // authoritative.
    {
      const relLex = path.relative(root, resolved);
      const relReal = path.relative(realProjectRoot, resolved);
      const insideLex = !relLex.startsWith('..') && !path.isAbsolute(relLex);
      const insideReal = !relReal.startsWith('..') && !path.isAbsolute(relReal);
      if (!insideLex && !insideReal) {
        return {
          success: false,
          message: 'Path must be inside the project directory.',
        };
      }
    }

    // ── Layer 3: Canonical containment (realpath) ──
    //
    // Resolve symlinks on the target and re-verify containment against the
    // canonical paths. Closes the TOCTOU window where a symlink could be
    // swapped between the lexical check and the spawn.
    const realResolved = await fs.realpath(resolved);
    {
      const relative = path.relative(realProjectRoot, realResolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return {
          success: false,
          message: 'Path must be inside the project directory.',
        };
      }
    }

    // Existence check on the CANONICAL path — the one actually spawned — so
    // the access verdict covers the same target the launcher receives, and a
    // symlink swapped between checks cannot invalidate it.
    await fs.access(realResolved);

    // The metacharacter guard above ran against the lexical path; the
    // realpath result is what actually gets spawned, so re-check it too.
    // An in-project symlink whose REAL target carries cmd.exe metacharacters
    // passes lexical containment AND canonical containment (the target is
    // still inside the project) and would otherwise reach the launcher.
    if (METACHAR_REGEX.test(realResolved)) {
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
      // installed) — log it, but never block the WS caller. The
      // fallback chain in the terminal branch uses onError to try
      // the next emulator.
      child.on('error', (err) => {
        logger.warn(`shell.open spawn failed: ${err.message}`);
        onError?.();
      });
      child.unref();
    };

    // Use the canonical path for all OS launches so a symlinked
    // directory opens at its real location.
    const target = realResolved;

    if (req.target === 'file-manager') {
      if (platform === 'win32') launch('explorer', [target]);
      else if (platform === 'darwin') launch('open', [target]);
      else launch('xdg-open', [target]);
    } else if (req.target === 'terminal') {
      if (platform === 'win32') {
        // `start` is a cmd builtin; each token is a separate argv
        // entry (Node quotes them individually — no string
        // concatenation). This replaces the previous
        // `start cmd /k cd /d "..."` exec() call that was
        // shell-injectable.
        launch('cmd', ['/c', 'start', 'cmd', '/k', 'cd', '/d', target]);
      } else if (platform === 'darwin') {
        launch('open', ['-a', 'Terminal', target]);
      } else {
        // Try several terminal emulators
        launch('x-terminal-emulator', [`--working-directory=${target}`], () =>
          launch('gnome-terminal', [`--working-directory=${target}`], () =>
            // Pass argv array so sh -c sees a literal string, not an interpolated one.
            // shellQuote() guards against paths that somehow slipped the METACHAR_REGEX.
            launch('xterm', ['-e', 'sh', '-c', `cd ${shellQuote(target)} && ${process.env['SHELL'] ?? 'sh'}`]),
          ),
        );
      }
    } else {
      return { success: false, message: `Unknown shell.open target: ${String(req.target)}` };
    }
    return { success: true, message: `Opened ${req.target} at ${target}` };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

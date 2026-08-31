/**
 * Owner-only file hardening, on both POSIX and Windows.
 *
 * WS-045: this lived as a private function inside `secret-vault.ts` and was
 * therefore reachable only by the config file. Every other secret WrongStack
 * writes — the HQ `auth.json` (bearer tokens), `runtime.json` (local client
 * token), the vault `.key` — got `chmod(0o600)` at best, which on Windows is
 * a no-op for everything except the read-only bit: the file stayed readable by
 * every other account on the machine. One exported module so a new secret file
 * has an obvious thing to call.
 *
 * ## Why it lives in `@wrongstack/persistence`
 *
 * It started in `@wrongstack/core/security`, which put it out of reach of the
 * one project daemon that needed it most: `@wrongstack/kanban` depends only on
 * this package, and it cannot depend on core — core already depends on kanban,
 * so that edge would close a cycle. Every project daemon writes a metadata
 * file holding its per-process IPC auth token, and every one of them needs the
 * same owner-only guarantee, so the helper belongs next to `atomicWrite`: a
 * dependency-free filesystem primitive that all of core, kanban, sage and
 * tools already import. `@wrongstack/core/security` re-exports it, so existing
 * callers are unchanged.
 *
 * @module file-permissions
 */

import * as childProcess from 'node:child_process';
import { chmod } from 'node:fs/promises';
import { promisify } from 'node:util';

let _execFileAsync:
  | ((
      file: string,
      args: readonly string[],
      options?: object,
    ) => Promise<{ stdout: string; stderr: string }>)
  | undefined;

function getExecFileAsync() {
  if (!_execFileAsync) {
    const fn = childProcess.execFile;
    if (typeof fn === 'function') {
      _execFileAsync = promisify(fn);
    }
  }
  return _execFileAsync;
}

/** Owner read/write, nothing for group or other. */
export const SECRET_FILE_MODE = 0o600;

/** Owner-only directory: enter + list + write. */
export const SECRET_DIR_MODE = 0o700;

export interface RestrictPermissionsOptions {
  warn?: ((msg: string) => void) | undefined;
  /** Label used in warnings, e.g. `secret-vault` or `hq-auth`. */
  label?: string | undefined;
}

/**
 * Restrict a file to owner-only access.
 *
 * POSIX: `chmod 0600`. Windows: `chmod` cannot express this, so we use
 * `icacls` to drop inherited ACEs and grant the current user alone.
 *
 * Failures are warned, never thrown — a hardening step must not be able to
 * block the write it protects, and `icacls` is absent in some minimal
 * environments (containers, WINE, restricted CI images).
 */
export async function restrictFilePermissions(
  filePath: string,
  opts?: RestrictPermissionsOptions,
): Promise<void> {
  const label = opts?.label ?? 'file-permissions';
  const warn = opts?.warn ?? ((msg: string) => console.warn(msg));
  if (process.platform === 'win32') {
    try {
      const user = windowsAccountName();
      if (!user) {
        warn(
          `[${label}] Could not determine the current Windows user for ${filePath}; skipping icacls hardening.`,
        );
        return;
      }
      // Remove inherited ACEs, grant full control only to current user.
      const execFn = getExecFileAsync();
      if (!execFn) {
        warn(`[${label}] child_process.execFile unavailable on this platform.`);
        return;
      }
      await execFn('icacls', [filePath, '/inheritance:r', '/grant:r', `${user}:(F)`], {
        windowsHide: true,
      });
    } catch {
      // Best-effort: icacls may not be available in all environments.
      warn(
        `[${label}] Could not restrict permissions on ${filePath} — it may be readable by other users on this system.`,
      );
    }
  } else {
    try {
      await chmod(filePath, SECRET_FILE_MODE);
    } catch {
      // Best-effort
    }
  }
}

/**
 * `restrictFilePermissions` for a directory: `chmod 0700` on POSIX, the same
 * icacls treatment (applied recursively to new children via inheritance) on
 * Windows. Use on the directory that holds secret files so a file created
 * there by a path we do not control still lands owner-only.
 */
export async function restrictDirPermissions(
  dirPath: string,
  opts?: RestrictPermissionsOptions,
): Promise<void> {
  if (process.platform === 'win32') {
    await restrictFilePermissions(dirPath, opts);
    return;
  }
  try {
    await chmod(dirPath, SECRET_DIR_MODE);
  } catch {
    // Best-effort
  }
}

function windowsAccountName(): string | undefined {
  const username = process.env['USERNAME'] ?? process.env['USER'];
  if (!username || username.includes('\0')) return undefined;
  const domain = process.env['USERDOMAIN'];
  if (domain && !domain.includes('\0')) return `${domain}\\${username}`;
  return username;
}

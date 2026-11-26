import * as path from 'node:path';
import {
  commandName,
  commandSegment,
  flagLetters,
  SHELL_OPERATORS,
  tokenizeShell,
} from './yolo-shell-scan.js';
import { rsyncDestination } from './yolo-vcs-risk.js';

// Top-level locations whose *recursive* deletion is catastrophic (the whole
// filesystem, a system directory, or the user's home). Deleting a file or a
// nested subdirectory *inside* one of these is NOT catastrophic — only the root
// directory itself.
const CATASTROPHIC_POSIX_ROOTS = new Set([
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/var',
  '/boot',
  '/dev',
  '/sys',
  '/proc',
  '/opt',
  '/root',
  '/home',
  '/srv',
  '/run',
  '/system',
  '/library',
  '/applications',
  '/users',
]);

const CATASTROPHIC_WIN_SUBDIRS = new Set([
  'windows',
  'system32',
  'winnt',
  'program files',
  'program files (x86)',
  'programdata',
  'users',
]);

/**
 * PowerShell switch-parameter spellings: any unambiguous prefix of `-Recurse`
 * or `-Force`, with the explicit `:$true` value form (`-Recurse:$true` ≡
 * `-Recurse`). `:$false` disables the switch and is deliberately not matched.
 * Shared by every Remove-Item spelling so the alias branches cannot drift.
 */
const POWERSHELL_RECURSE_SWITCH = /^-(?:r|re(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)(?::\$true)?$/;
const POWERSHELL_FORCE_SWITCH = /^-(?:f|fo(?:r(?:c(?:e)?)?)?)(?::\$true)?$/;

/** Recursive-OR-force: on Remove-Item either switch deletes a directory tree. */
function hasPowerShellRecurseOrForce(args: readonly string[]): boolean {
  return args.some((arg) => {
    const lower = arg.toLowerCase();
    return POWERSHELL_RECURSE_SWITCH.test(lower) || POWERSHELL_FORCE_SWITCH.test(lower);
  });
}

export function pathLooksInsideProject(rawPath: string, projectRoot: string | undefined): boolean {
  if (!projectRoot) return false;
  // A Windows-absolute target (drive letter + separator) can never be inside
  // a POSIX project root. Without this branch a POSIX-hosted agent emitting
  // `del /s C:\Users\...` resolves the target as a relative path *inside*
  // the project and the recursive-delete gates never fire. On win32 the
  // normal resolution below already treats drive-absolute paths correctly.
  if (process.platform !== 'win32' && /^[A-Za-z]:[\\/]/.test(rawPath)) {
    return false;
  }
  // A leading ~ is the home directory, never the project root. Without this,
  // path.resolve() treats "~/cache" as a relative path *inside* the project
  // (there is no shell tilde-expansion here), masking an escape like `rm -rf ~/cache`.
  if (rawPath === '~' || rawPath.startsWith('~/') || rawPath.startsWith('~\\')) return false;
  // An UNEXPANDED variable in the leading segment, for exactly the same reason:
  // there is no shell expansion here, so `path.resolve()` reads `$HOME/cache` as
  // a literal directory named `$HOME` *inside* the project. Probe-verified
  // 2026-09-22: `rm -rf ~/cache` was gated as an escape while `rm -rf $HOME/cache`
  // and `rm -rf ${HOME}/data` were classified in-project — the same delete in
  // three spellings. What the variable holds is unknowable statically, so the
  // honest answer is "not provably inside", which only makes the gates stricter.
  if (/^(?:\$|%[A-Za-z_])/.test(rawPath)) return false;
  // Backslash-separated traversal, for the same reason as the drive-letter
  // branch above: `\` is a legal filename character on POSIX, so path.resolve()
  // reads `..\..\shared-secrets` as ONE filename inside the root and the escape
  // goes unnoticed — `del /s ..\..\shared-secrets` was classified in-project by
  // a POSIX-hosted agent. Normalise to a separator before resolving. A POSIX
  // file whose name genuinely contains a backslash is then reported as outside
  // the project, which only makes the destructive gates stricter.
  const candidate = process.platform === 'win32' ? rawPath : rawPath.replace(/\\/g, '/');
  const resolved = path.resolve(projectRoot, candidate);
  const relative = path.relative(projectRoot, resolved);
  // Canonical escape test: `..hidden` is a legal in-root first segment; a bare
  // startsWith('..') would misclassify it as outside the project and skip the
  // in-project destructive-command gates.
  return (
    !!relative &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function hasRecursiveForceDelete(command: string, projectRoot: string | undefined): boolean {
  const tokens = tokenizeShell(command);
  for (let i = 0; i < tokens.length; i++) {
    // Normalized: `/bin/rm` and alias-escaped `\rm` are the same `rm`.
    const token = commandName(tokens[i]);
    if (!token) continue;

    if (token === 'rm' || token === 'rmdir') {
      const args = commandSegment(tokens, i + 1);
      const letters = flagLetters(args);
      const recursiveForce = letters.has('r') && letters.has('f');
      if (recursiveForce) {
        const targets = args.filter((arg) => !arg.startsWith('-') && !SHELL_OPERATORS.has(arg));
        if (targets.length > 0 && targets.every((target) => target.trim().length === 0)) {
          continue;
        }
        if (targets.length === 0) return true;
        if (targets.some(isCatastrophicDeleteTarget)) return true;
        if (targets.some((target) => !pathLooksInsideProject(target, projectRoot))) return true;
      }
    }

    // In PowerShell `del`, `erase` and `rd` are Remove-Item aliases too (the
    // cmd.exe `/s` form is handled below); only their PowerShell parameters
    // reach here. `rd` was missing, so `rd -Recurse -Force C:\Windows` — the
    // same wipe as the Remove-Item spelling — classified as safe.
    if (
      token === 'remove-item' ||
      token === 'ri' ||
      token === 'del' ||
      token === 'erase' ||
      token === 'rd'
    ) {
      const args = commandSegment(tokens, i + 1).map((arg) => arg.toLowerCase());
      // PowerShell switch parameters accept an explicit boolean value spelling:
      // `-Recurse:$true` ≡ `-Recurse` and `-Force:$true` ≡ `-Force` (switch ON);
      // `-Recurse:$false` / `-Force:$false` explicitly disable the switch and
      // must NOT count. `-WhatIf:$true` (like bare `-WhatIf`) is a dry-run and
      // exempt; `-WhatIf:$false` re-enables execution and is NOT exempt.
      // PowerShell also binds any unambiguous parameter-name PREFIX: `-rec`,
      // `-recu` … are -Recurse and `-fo`, `-forc` are -Force.
      const recurse = args.some((arg) => POWERSHELL_RECURSE_SWITCH.test(arg));
      const force = args.some((arg) => POWERSHELL_FORCE_SWITCH.test(arg));
      const dryRun = args.some((arg) => /^-whatif(?::\$true)?$/.test(arg));
      if (recurse && force && !dryRun) {
        const targets = args.filter((arg) => !arg.startsWith('-') && !SHELL_OPERATORS.has(arg));
        if (targets.length === 0) return true;
        if (targets.some(isCatastrophicDeleteTarget)) return true;
        if (targets.some((target) => !pathLooksInsideProject(target, projectRoot))) return true;
      }
    }

    if (token === 'rd' || token === 'rmdir') {
      const args = commandSegment(tokens, i + 1).map((arg) => arg.toLowerCase());
      if (args.includes('/s')) {
        const targets = args.filter(
          (arg) => !arg.startsWith('-') && !arg.startsWith('/') && !SHELL_OPERATORS.has(arg),
        );
        if (targets.length === 0) return true;
        if (targets.some(isCatastrophicDeleteTarget)) return true;
        if (targets.some((target) => !pathLooksInsideProject(target, projectRoot))) return true;
      }
    }

    // `rsync --delete*` makes the destination mirror the source, deleting every
    // destination file the source lacks — recursively, without a prompt. With a
    // destination outside the project (or on another host) it is a
    // project-escaping recursive delete like `rm -rf <dest>`.
    if (token === 'rsync') {
      const args = commandSegment(tokens, i + 1);
      if (args.some((arg) => /^--del(?:ete(?:-[a-z]+)?)?$/.test(arg))) {
        const dest = rsyncDestination(args);
        if (dest === undefined) return true;
        if (dest === null) continue;
        if (/^rsync:\/\//i.test(dest) || /^(?:[^/\\:\s]+@)?[^/\\:\s]{2,}:/.test(dest)) return true;
        if (isCatastrophicDeleteTarget(dest) || !pathLooksInsideProject(dest, projectRoot)) {
          return true;
        }
      }
    }

    // Windows `del` / `erase` (erase is a del alias): `/s` deletes matching
    // files in the whole subtree WITHOUT any per-file prompt, so it is the
    // recursive-force half — the tools-side rm-recursive rule (`_danger-detect.ts`)
    // flags `del`/`erase` + `/s` as destructive. This branch mirrors the
    // `rd`/`rmdir`+`/s` branch above so a project-escaping recursive file-tree
    // delete is gated here too (hasCatastrophicDelete only catches whole-disk/
    // home/system targets; it never checks pathLooksInsideProject).
    if (token === 'del' || token === 'erase') {
      const args = commandSegment(tokens, i + 1).map((arg) => arg.toLowerCase());
      if (args.includes('/s')) {
        const targets = args.filter(
          (arg) => !arg.startsWith('-') && !arg.startsWith('/') && !SHELL_OPERATORS.has(arg),
        );
        if (targets.length === 0) return true;
        if (targets.some(isCatastrophicDeleteTarget)) return true;
        if (targets.some((target) => !pathLooksInsideProject(target, projectRoot))) return true;
      }
    }
  }
  return false;
}

/**
 * True only when a delete TARGET is a whole-filesystem / whole-disk / whole-home
 * / system-directory wipe — the catastrophic case. A few files, a nested
 * subdirectory, or an arbitrary sibling directory outside the project are all
 * recoverable-scale and return false (frictionless under YOLO).
 */
function isCatastrophicDeleteTarget(rawTarget: string): boolean {
  const t = rawTarget.replace(/^['"]|['"]$/g, '').trim();
  if (!t) return false;
  // Wipe the current directory wholesale.
  if (t === '*' || t === '.' || t === './' || t === '.\\' || t === './*' || t === '.\\*')
    return true;
  // Strip a trailing `/*` / `\*` glob and any trailing separators so `/etc/`,
  // `/etc/*`, `~/`, `C:\*` collapse onto their root form. An all-separators
  // target ("/", "/*") collapses to '' → the filesystem root.
  const s = t.replace(/[\\/]\*+$/, '').replace(/[\\/]+$/, '');
  if (s === '') return true; // "/", "/*" → filesystem root
  // Home, in every spelling the shell expands to it. `${HOME}` is the same
  // variable as `$HOME` — probe-verified 2026-09-22: `rm -rf ${HOME}` classified
  // as not destructive while `rm -rf $HOME` was gated.
  // PowerShell's env drive (`$env:USERPROFILE`, `${env:HOME}`) is the same home.
  if (
    s === '~' ||
    /^\$(?:HOME|\{HOME\})$/i.test(s) ||
    /^%USERPROFILE%$/i.test(s) ||
    /^\$(?:env:(?:USERPROFILE|HOME)|\{env:(?:USERPROFILE|HOME)\})$/i.test(s)
  )
    return true;
  if (/^[A-Za-z]:$/.test(s)) return true; // Windows drive root: C:, C:\, C:\*
  const norm = s.toLowerCase().replace(/\\/g, '/');
  if (CATASTROPHIC_POSIX_ROOTS.has(norm)) return true; // /etc, /usr, /home, …
  const win = norm.match(/^[a-z]:\/([^/]+)$/); // C:\Windows, C:\Users, … (top level only)
  if (win?.[1] && CATASTROPHIC_WIN_SUBDIRS.has(win[1])) return true;
  return false;
}

/**
 * F17: GNU getopt_long accepts any unambiguous long-option prefix. True when
 * `arg` spells `--name` or a prefix of it at least `minLen` characters long
 * (the shortest unambiguous prefix for that option set); an attached `=value`
 * is ignored for the name match. Over-matching forms GNU would reject only
 * makes the gate stricter (fail-safe). Same semantics as flagLetters (F6).
 */
function longOptionIs(arg: string, name: string, minLen: number): boolean {
  if (!arg.startsWith('--')) return false;
  const opt = arg.slice(2).split('=', 1)[0]!;
  return opt.length >= minLen && name.startsWith(opt);
}

export function hasCatastrophicDelete(command: string): boolean {
  const tokens = tokenizeShell(command);
  for (let i = 0; i < tokens.length; i++) {
    // Normalized: `/bin/rm` and alias-escaped `\rm` are the same `rm`.
    const token = commandName(tokens[i]);
    if (!token) continue;

    // POSIX rm -rf / Remove-Item -Recurse-style recursive force delete.
    if (token === 'rm') {
      const args = tokens.slice(i + 1);
      // F17: flagLetters binds the GNU long-option prefixes (F6) for r/f;
      // --no-preserve-root is rm's only n-option (--n… unambiguous). Exact
      // equality let `rm --rec /` / `rm --fo ~` evade the catastrophic gate
      // (and the r-only form also slips past hasRecursiveForceDelete's r&&f).
      const letters = flagLetters(args);
      const recursiveOrForce =
        letters.has('r') ||
        letters.has('f') ||
        args.some((arg) => longOptionIs(arg, 'no-preserve-root', 1));
      if (!recursiveOrForce) continue;
      const targets = args.filter((arg) => !arg.startsWith('-') && !SHELL_OPERATORS.has(arg));
      // `rm -rf` with no operand is a whole-cwd wipe intent.
      if (targets.length === 0) return true;
      if (targets.some(isCatastrophicDeleteTarget)) return true;
    }

    if (token === 'remove-item' || token === 'ri') {
      const args = tokens.slice(i + 1);
      // F17: PowerShell binds any unambiguous parameter prefix (-rec ≡
      // -Recurse, -fo ≡ -Force), incl. :$true — the same patterns the
      // recursive-force gate above uses. This is recursive-OR-force: either
      // switch on a catastrophic target is gated.
      const recursive = hasPowerShellRecurseOrForce(args);
      if (!recursive) continue;
      const targets = args.filter((arg) => !arg.startsWith('-') && !SHELL_OPERATORS.has(arg));
      if (targets.some(isCatastrophicDeleteTarget)) return true;
    }

    // Windows rmdir /s and del/erase — flags use a leading slash, so a path is
    // any non-flag token (and on Windows paths use backslashes/drive letters,
    // never a leading slash).
    if (token === 'rmdir' || token === 'rd') {
      const args = tokens.slice(i + 1);
      // cmd's `/s` and PowerShell's `-Recurse`/`-Force` are the same recursive
      // delete: `rd` is a Remove-Item alias in PowerShell, so its parameter
      // spelling must gate identically to the Remove-Item branch above.
      const recursive =
        args.some((arg) => arg.toLowerCase() === '/s') || hasPowerShellRecurseOrForce(args);
      if (!recursive) continue;
      const targets = args.filter(
        (arg) => !arg.startsWith('-') && !arg.startsWith('/') && !SHELL_OPERATORS.has(arg),
      );
      if (targets.some(isCatastrophicDeleteTarget)) return true;
    }

    if (token === 'del' || token === 'erase') {
      const args = tokens.slice(i + 1);
      const targets = args.filter(
        (arg) => !arg.startsWith('-') && !arg.startsWith('/') && !SHELL_OPERATORS.has(arg),
      );
      if (targets.some(isCatastrophicDeleteTarget)) return true;
    }
  }
  return false;
}

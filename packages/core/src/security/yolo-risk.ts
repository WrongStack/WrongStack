import * as os from 'node:os';
import * as path from 'node:path';
import { wstackGlobalRoot } from '../utils/wstack-paths.js';

/**
 * Basenames under the wstack global root that constitute WrongStack's own
 * trusted state. Duplicated from permission-helpers.ts to avoid a circular
 * import (permission-helpers imports getInputString from yolo-risk).
 * Keep in sync with AGENT_STATE_SENSITIVE_BASENAMES.
 */
const PROTECTED_STATE_BASENAMES =
  /^(?:config(?:\.local)?\.json(?:\..+)?|trust\.json|auth\.json|\.key)$/i;

// Best-effort heuristic detection of destructive shell commands — NOT a
// complete security boundary. Static analysis of shell strings is inherently defeatable
// by obfuscation: env-variable indirection (`$RM -rf /`), quote-splitting
// (`r''m`), base64/eval pipes, command substitution, and aliases all evade
// these patterns. This is one defense-in-depth layer behind the permission
// policy; treat a miss here as expected, not a hole to be plugged with
// ever-more-clever regexes.
//
// CALIBRATION: this gate catches high-impact local/remote side effects that
// should not run solely because a model saw text in untrusted tool output:
// project-escaping or catastrophic recursive deletes, VCS history rewrites,
// public publishes/deploys, cluster-wide deletes, disk/system wipes, and
// network-fetch-then-execute patterns. Harmless reads, normal build/test
// commands, and in-project cleanups stay frictionless.
const CATASTROPHIC_PATTERNS: RegExp[] = [
  /\b(?:mkfs(?:\.[a-z0-9]+)?|mke2fs|newfs)\b/i, // make a filesystem — wipes a partition
  /\bformat\s+[A-Za-z]:/i, // format C: — wipes a Windows volume
  /\bdiskpart\b/i, // Windows partition editor
  /\bdd\b[^|]*\bof=(?:\/dev\/|\\\\[.?]\\)/i, // dd writing straight to a raw device
  />\s*\/dev\/(?:sd|hd|nvme|disk|mapper|vd)/i, // redirect into a raw block device
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/, // classic fork bomb
];

const HIGH_IMPACT_PATTERNS: RegExp[] = [
  /\b(?:curl|wget|fetch|httpie|http|irm|iwr|Invoke-WebRequest|Invoke-RestMethod)\b[\s\S]{0,300}\|\s*(?:sudo\s+)?(?:sh|bash|zsh|fish|pwsh|powershell|iex|Invoke-Expression)\b/i,
  /\b(?:powershell|pwsh)(?:\.exe)?\b[\s\S]{0,120}-(?:enc|encodedcommand)\b/i,
];

// B2 (AT-08 / CMDI-004): the literal `curl … | sh` shape was the only
// pipe-to-shell recognised. `bash -c "$(curl …)"`, `bash -c '<curl>'`, and the
// equivalent `node -e "require('child_process').execSync(...)"` /
// `python -c "import os; os.system(...)"` ship a payload into a brand-new
// interpreter that the classifier never sees as a network command.
//
// The interpreter SHAPE alone is not the risk, though, and neither is starting
// a process: this gate asks ONE question — would running this do serious damage
// to the machine or to the project? `node -e "execSync('id')"` is RCE-shaped and
// harms nothing, while a plain `bash script.sh` YOLO already auto-approves is
// every bit as arbitrary. Gating on shape is what made YOLO ask about
// `bash -c "echo hi"`, `docker run … sh -c "ls"` and
// `node -e "console.log(require('./package.json').version)"`.
//
// So an inline payload counts only when the payload itself DELETES, or when it
// fetches code off the network and runs it — the one case where the damage is
// unknowable in advance because the code is not in front of us.
const INLINE_PAYLOAD_INTERPRETERS: RegExp[] = [
  /\b(?:bash|sh|zsh|ksh|fish|pwsh|powershell)\b[\s\S]{0,200}-c\s*[\s$"'(]/i,
  /\b(?:node|python[0-9.]*|perl|ruby)\b[\s\S]{0,200}-[ecE]\b/i,
];

/** The payload reaches the network — the download half of download-and-run. */
const PAYLOAD_FETCHES_NETWORK =
  /\b(?:curl|wget|httpie|irm|iwr|Invoke-WebRequest|Invoke-RestMethod|DownloadString|DownloadFile|WebClient|XMLHttpRequest|urlretrieve|urllib)\b|\bfetch\s*\(|\brequests\.(?:get|post)\b|\bhttps?:\/\//i;

/**
 * The payload deletes. A quoted payload survives `tokenizeShell` as ONE token,
 * so the `rm -rf` gates below never see inside `bash -c "rm -rf /"` — this is
 * what keeps that shape classified.
 */
const PAYLOAD_DELETES =
  /\b(?:rmSync|unlinkSync|rmdirSync|rimraf|shutil\.rmtree|os\.remove|os\.unlink|Remove-Item)\b|\brm\s+-[A-Za-z]*[rf]|\bdel\s+\/[sq]/i;

/**
 * `shutdown` / `reboot` as the COMMAND BEING RUN, not as a substring.
 *
 * The bare `/\b(?:shutdown|reboot)\b/i` this replaces read prose: it fired on
 * `vitest run …/start-webui-shutdown.test.ts`, on `git add` of that same file,
 * and on `git commit -m "…shutdown…"` — so in any repo with "shutdown" in a
 * filename, YOLO asked about routine test and commit calls.
 */
const SYSTEM_HALT_COMMAND =
  /^\s*(?:sudo\s+|doas\s+)?(?:[\w.:\-\\/]*[\\/])?(?:shutdown|reboot)(?:\.exe)?(?:\s|$)/i;

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

const SHELL_OPERATORS = new Set(['&&', '||', '|', ';', '>', '>>', '<', '2>', '2>>']);

export function getInputString(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
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
  const resolved = path.resolve(projectRoot, rawPath);
  const relative = path.relative(projectRoot, resolved);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function tokenizeShell(command: string): string[] {
  return (
    command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^['"]|['"]$/g, '')) ?? []
  );
}

function commandSegment(tokens: string[], start: number): string[] {
  const out: string[] = [];
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined || SHELL_OPERATORS.has(token)) break;
    out.push(token);
  }
  return out;
}

/**
 * Every flag letter visible in `args`, presence-only: short clusters
 * (`-rf` → r,f — lowercased so GNU `-R` counts as recursive) plus the GNU
 * long forms (`--recursive` → r, `--force` → f). A mixed invocation
 * (`rm -r --force x`) must classify identically to either pure form — the
 * same shape-variance contract the tools-side danger rules enforce.
 */
function flagLetters(args: readonly string[]): Set<string> {
  const seen = new Set<string>();
  for (const arg of args) {
    if (/^-[a-zA-Z]+$/.test(arg)) {
      for (const ch of arg.replace(/^-+/, '')) seen.add(ch.toLowerCase());
    } else if (arg === '--recursive') {
      seen.add('r');
    } else if (arg === '--force') {
      seen.add('f');
    }
  }
  return seen;
}

function hasRecursiveForceDelete(command: string, projectRoot: string | undefined): boolean {
  const tokens = tokenizeShell(command);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]?.toLowerCase();
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

    if (token === 'remove-item' || token === 'ri') {
      const args = commandSegment(tokens, i + 1).map((arg) => arg.toLowerCase());
      // PowerShell switch parameters accept an explicit boolean value spelling:
      // `-Recurse:$true` ≡ `-Recurse` and `-Force:$true` ≡ `-Force` (switch ON);
      // `-Recurse:$false` / `-Force:$false` explicitly disable the switch and
      // must NOT count. `-WhatIf:$true` (like bare `-WhatIf`) is a dry-run and
      // exempt; `-WhatIf:$false` re-enables execution and is NOT exempt.
      const recurse = args.some((arg) => /^-(?:recurse|r)(?::\$true)?$/.test(arg));
      const force = args.some((arg) => /^-(?:force|f)(?::\$true)?$/.test(arg));
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

function hasGitHistoryRewrite(command: string): boolean {
  const tokens = tokenizeShell(command).map((token) => token.toLowerCase());
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'git') continue;
    const args = commandSegment(tokens, i + 1);
    if (
      args.includes('reset') &&
      args.some((arg) => arg === '--hard' || arg.startsWith('--hard='))
    ) {
      return true;
    }
    // Rewrites every commit in place. Pre-existing gap: the branch above only
    // covered `reset --hard`, so the one command that can destroy a repository's
    // whole history outright was auto-approved under YOLO.
    if (args.includes('filter-branch') || args.includes('filter-repo')) return true;
    const cleanIdx = args.indexOf('clean');
    if (cleanIdx >= 0) {
      const cleanArgs = args.slice(cleanIdx + 1);
      if (
        cleanArgs.some((arg) => arg === '-f' || arg === '--force' || /^-[a-z]*f[a-z]*$/i.test(arg))
      ) {
        return true;
      }
    }
    const pushIdx = args.indexOf('push');
    if (pushIdx >= 0) {
      const pushArgs = args.slice(pushIdx + 1);
      if (
        pushArgs.some(
          (arg) =>
            arg === '-f' ||
            arg === '--force' ||
            arg === '--force-with-lease' ||
            arg.startsWith('--force=') ||
            arg.startsWith('--force-with-lease=') ||
            // Combined short-flag cluster (`-fv` ≡ `-f -v`): git combines
            // short flags, so an `f` anywhere in a single-dash all-letter
            // cluster is a verbatim force-push. Mirrors the cluster-aware
            // pattern the `git clean` branch above already uses. Deliberately
            // no dry-run (`-n`) carve-out: this layer flags `--dry-run -f`
            // as destructive too (documented asymmetry vs the tools-side rule).
            /^-[a-z]*f[a-z]*$/i.test(arg) ||
            // Per-refspec force (`git push origin +main`,
            // `+HEAD:refs/heads/main`): documented git shorthand equivalent
            // to `--force` for that ref. A `+` anywhere else in a refspec
            // (branch `feature+fix`) and a leading `^` exclusion refspec are
            // not force syntax.
            arg.startsWith('+'),
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function hasExternalPublish(command: string): boolean {
  const tokens = tokenizeShell(command).map((token) => token.toLowerCase());
  for (let i = 0; i < tokens.length; i++) {
    const cmd = tokens[i];
    if (!cmd) continue;
    const args = commandSegment(tokens, i + 1);
    if (
      ['npm', 'pnpm', 'yarn', 'bun'].includes(cmd) &&
      (args.includes('publish') || args.includes('deploy'))
    ) {
      return true;
    }
    if (cmd === 'cargo' && (args.includes('publish') || args.includes('yank'))) return true;
    if ((cmd === 'docker' || cmd === 'podman') && args.includes('push')) return true;
    if (cmd === 'kubectl') {
      const deleteIdx = args.indexOf('delete');
      if (deleteIdx >= 0 && (args[deleteIdx + 1] === 'namespace' || args[deleteIdx + 1] === 'ns')) {
        return true;
      }
      if (args.includes('drain')) return true;
    }
  }
  return false;
}

/**
 * Programs that, run once per match by `find -exec`, destroy or overwrite.
 *
 * `find -exec` used to gate on the FLAG alone, so `find … -exec wc -l {} +` —
 * a line count — needed approval. What makes the shape dangerous is the fan-out
 * of a destructive program across every match, so the program is what decides.
 * Anything else the command does still faces every other gate here, which read
 * the whole line.
 */
const DESTRUCTIVE_EXEC_PROGRAMS: ReadonlySet<string> = new Set([
  'rm',
  'rmdir',
  'unlink',
  'shred',
  'srm',
  'del',
  'erase',
  'mv',
  'move',
  'chmod',
  'chown',
  'chgrp',
  'dd',
  'truncate',
  'ln',
  'remove-item',
]);

function hasFindExec(command: string): boolean {
  const tokens = tokenizeShell(command).map((token) => token.toLowerCase());
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'find') continue;
    const args = commandSegment(tokens, i + 1);
    for (let j = 0; j < args.length; j++) {
      const arg = args[j];
      if (arg !== '-exec' && arg !== '-ok' && arg !== '-execdir') continue;
      // Skip `sudo` so `-exec sudo rm {} ;` classifies as the `rm` it is.
      let k = j + 1;
      while (args[k] === 'sudo' || args[k] === 'doas') k++;
      const program = args[k];
      if (program === undefined) continue;
      const basename = program.split(/[\\/]/).pop() ?? program;
      if (DESTRUCTIVE_EXEC_PROGRAMS.has(basename.replace(/\.exe$/, ''))) return true;
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
  if (s === '~' || /^\$HOME$/i.test(s) || /^%USERPROFILE%$/i.test(s)) return true; // home
  if (/^[A-Za-z]:$/.test(s)) return true; // Windows drive root: C:, C:\, C:\*
  const norm = s.toLowerCase().replace(/\\/g, '/');
  if (CATASTROPHIC_POSIX_ROOTS.has(norm)) return true; // /etc, /usr, /home, …
  const win = norm.match(/^[a-z]:\/([^/]+)$/); // C:\Windows, C:\Users, … (top level only)
  if (win?.[1] && CATASTROPHIC_WIN_SUBDIRS.has(win[1])) return true;
  return false;
}

function hasCatastrophicDelete(command: string): boolean {
  const tokens = tokenizeShell(command);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]?.toLowerCase();
    if (!token) continue;

    // POSIX rm -rf / Remove-Item -Recurse-style recursive force delete.
    if (token === 'rm') {
      const args = tokens.slice(i + 1);
      const recursiveOrForce = args.some(
        (arg) =>
          /^-[^-]*[rf]/i.test(arg) ||
          arg === '--recursive' ||
          arg === '--force' ||
          arg === '--no-preserve-root',
      );
      if (!recursiveOrForce) continue;
      const targets = args.filter((arg) => !arg.startsWith('-') && !SHELL_OPERATORS.has(arg));
      // `rm -rf` with no operand is a whole-cwd wipe intent.
      if (targets.length === 0) return true;
      if (targets.some(isCatastrophicDeleteTarget)) return true;
    }

    if (token === 'remove-item' || token === 'ri') {
      const args = tokens.slice(i + 1);
      const recursive = args.some((arg) => {
        const a = arg.toLowerCase();
        return a === '-recurse' || a === '-force';
      });
      if (!recursive) continue;
      const targets = args.filter((arg) => !arg.startsWith('-') && !SHELL_OPERATORS.has(arg));
      if (targets.some(isCatastrophicDeleteTarget)) return true;
    }

    // Windows rmdir /s and del/erase — flags use a leading slash, so a path is
    // any non-flag token (and on Windows paths use backslashes/drive letters,
    // never a leading slash).
    if (token === 'rmdir' || token === 'rd') {
      const args = tokens.slice(i + 1);
      const recursive = args.some((arg) => arg.toLowerCase() === '/s');
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

/**
 * Best-effort detection of a shell command that writes to WrongStack's own
 * trusted state files (trust.json, config.local.json, auth.json, .key) via
 * redirection (`>`, `>>`), `tee`, `cp`/`mv`, or heredoc — even when the
 * command itself isn't "destructive" in the catastrophic sense. A write to
 * these files can disable every future confirmation prompt or inject code
 * execution at boot, so it must never be silently auto-approved under YOLO.
 *
 * Like every heuristic in this module, this is defeatable by obfuscation
 * (env-var indirection, eval, base64). It is a defense-in-depth layer, not
 * a security boundary.
 */
function hasWriteToAgentStateRoot(command: string): boolean {
  // Strategy: extract every plausible file-path token from the command, then
  // check each against isProtectedAgentStatePath. We scan:
  // 1. Redirection targets: `> path`, `>> path`, plus glued forms (`>path`,
  //    `>>path`, `2>path`, `2>>path`, `&>path`, `&>>path`, `>|path`, `>>|path`)
  // 2. `tee path` / `tee -a path`
  // 3. `cp src dst` / `mv src dst` — the last non-flag argument
  // 4. Heredoc-less `cat > path` patterns (covered by #1)
  const tokens = tokenizeShell(command);

  // 1a. Glued redirect targets — the token-based loop below only matches
  // `>` / `>>` as a standalone token, so `>~/.wrongstack/trust.json`
  // (no space) and `2>file` / `&>file` (fd-redirect with no space) are
  // missed. Scan the raw string for these forms before falling back to the
  // token loop. The `\|?` makes the bash noclobber-overriding forms
  // (`>|file`, `>>|file`) match too; the character class excludes fd-to-fd
  // redirects like `2>&1` (the `&` is in the excluded set).
  const GLUED_WRITE_REDIRECT_RE = /(?:>|>>|[&2]>|[&2]>>)\|?(?!\s)([^\s|&;()<>]+)/g;
  for (const m of command.matchAll(GLUED_WRITE_REDIRECT_RE)) {
    const target = m[1];
    if (target && looksLikeAgentStateTarget(target)) return true;
  }

  // 1b. Redirection targets — `>` or `>>` followed by a path.
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    if (t === '>' || t === '>>') {
      const target = tokens[i + 1];
      if (target && looksLikeAgentStateTarget(target)) return true;
    }
  }

  // 2. `tee` target — first non-flag argument after `tee`.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]?.toLowerCase();
    if (t === 'tee') {
      for (let j = i + 1; j < tokens.length; j++) {
        const arg = tokens[j];
        if (!arg || arg.startsWith('-')) continue;
        if (SHELL_OPERATORS.has(arg)) break;
        if (looksLikeAgentStateTarget(arg)) return true;
        break; // first non-flag arg is the target
      }
    }
  }

  // 3. `cp src dst` / `mv src dst` — if the destination (last non-flag arg)
  //    resolves into the agent state root.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]?.toLowerCase();
    if (t === 'cp' || t === 'copy' || t === 'mv' || t === 'move') {
      const args = commandSegment(tokens, i + 1);
      // The last non-flag, non-operator argument is the destination.
      const dst = args.filter((a) => !a.startsWith('-') && !SHELL_OPERATORS.has(a)).pop();
      if (dst && looksLikeAgentStateTarget(dst)) return true;
    }
  }

  return false;
}

/**
 * Quick check: does the token look like it could resolve into the wstack
 * global root, and does its basename match a protected file? We delegate the
 * full path resolution to isProtectedAgentStatePath, but we pre-filter on
 * the path containing `.wrongstack` or starting with `~/.wrongstack` so we
 * don't call realpath on every token in every command.
 *
 * Coverage:
 *   1. The protected config basenames (config.json, trust.json, etc.) — the
 *      original "agent state" set: a write here can disable the approval
 *      system or inject boot-time RCE via hooks/mcpServers/plugins.
 *   2. Anything under the global plugin root (`~/.wrongstack/plugins/`) —
 *      H-4: the global plugin root ships `defaultState: 'active'`, so a
 *      single bash `> ~/.wrongstack/plugins/x.mjs` becomes boot-time code
 *      execution on the next launch (the TOFU gate pins with no prompt).
 *      No basename whitelist is needed: the global plugin root is itself
 *      the trust anchor, and every file inside it is part of the closure
 *      a plugin load imports.
 */
function looksLikeAgentStateTarget(rawPath: string): boolean {
  // Expand ~ to the home directory for the comparison.
  const expanded = rawPath.replace(/^~([\\/])/, (_, sep) => `${os.homedir()}${sep}`);
  const resolved = path.resolve(expanded);
  // Fast lexical pre-filter: must contain `.wrongstack` or match the wstack
  // global root prefix.
  const rootStr = wstackGlobalRoot();
  const resolvedNorm = resolved.replace(/\\/g, '/').toLowerCase();
  const rootNorm = path.resolve(rootStr).replace(/\\/g, '/').toLowerCase();
  if (!resolvedNorm.startsWith(rootNorm) && !resolvedNorm.includes('.wrongstack')) {
    return false;
  }
  // Coverage (2): any path inside the global plugin root is a protected
  // write target — not just the .mjs/.js entry, but the whole closure the
  // entry imports. We resolve the plugins root once per call; cheap.
  const pluginsRoot = path.resolve(rootStr, 'plugins');
  const pluginsRootNorm = pluginsRoot.replace(/\\/g, '/').toLowerCase();
  if (resolvedNorm === pluginsRootNorm || resolvedNorm.startsWith(`${pluginsRootNorm}/`)) {
    return true;
  }
  // Coverage (1): basename against the protected list (inlined to avoid a
  // circular import with permission-helpers.ts).
  return PROTECTED_STATE_BASENAMES.test(path.basename(resolved));
}

/**
 * Split a command line into shell segments, ignoring separators inside quotes.
 *
 * Quote-awareness is the whole point: `git commit -m "…; shutdown now"` must
 * stay ONE segment whose head is `git`. The classifier has to read the command
 * being run, never the prose it carries as an argument.
 *
 * `|` splits here even though `curl … | sh` is a real risk shape — that shape
 * is matched against the WHOLE command by HIGH_IMPACT_PATTERNS[0], which never
 * goes through this splitter.
 */
function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '&' || ch === '|') {
      if (command[i + 1] === ch) i++; // consume the second half of && / ||
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.filter((segment) => segment.trim().length > 0);
}

/**
 * An interpreter running an inline payload that deletes, or that runs code it
 * just downloaded.
 *
 * Both halves must sit in the SAME segment, so `git status && node -e
 * "console.log(1)"` is not read as one risky command just because a
 * 200-character window happened to span the `&&`.
 */
function hasRiskyInlinePayload(command: string): boolean {
  for (const segment of splitShellSegments(command)) {
    if (!INLINE_PAYLOAD_INTERPRETERS.some((pattern) => pattern.test(segment))) continue;
    if (PAYLOAD_FETCHES_NETWORK.test(segment) || PAYLOAD_DELETES.test(segment)) return true;
  }
  return false;
}

/** `shutdown` / `reboot` in command position in any segment of the line. */
function haltsTheMachine(command: string): boolean {
  return splitShellSegments(command).some((segment) => SYSTEM_HALT_COMMAND.test(segment));
}

/**
 * WHAT kind of damage a command would do, as the user-facing categories the
 * YOLO confirmation menu is built from.
 *
 * These are not new taxonomy — each one is a check that already existed in this
 * file. Naming them is what lets the user keep, say, `git-history` gated while
 * letting `bulk-delete` through, instead of the all-or-nothing `yoloDestructive`
 * switch (which no surface ever wired up anyway).
 */
export type DestructiveKind =
  /** Wipes a disk or the machine: mkfs, dd to a raw device, format C:, fork bomb. */
  | 'disk-wipe'
  /** Powers the machine down or restarts it. */
  | 'system-halt'
  /** Recursive force-delete that escapes the project, or hits a system/home root. */
  | 'delete-outside'
  /** Deletes across many matches at once: `find -exec rm`, an inline `rmSync`. */
  | 'bulk-delete'
  /** Destroys VCS history or published refs: reset --hard, clean -f, push --force, filter-branch. */
  | 'git-history'
  /** Pushes outward and is hard to retract: npm publish, docker push, kubectl delete namespace. */
  | 'publish'
  /** Runs code fetched off the network — the damage is unknowable in advance. */
  | 'download-and-run'
  /** Writes WrongStack's own trusted state (config.json / trust.json / auth.json). */
  | 'agent-state'
  /** Binds a well-known third-party credential to a provider endpoint. */
  | 'credential-bind';

/**
 * The two kinds that can switch the approval system itself off, and so may
 * never be un-gated from a settings menu.
 *
 * Writing `trust.json` disables prompting permanently; writing `hooks` into
 * `config.json` is boot-time RCE on the next launch; binding
 * `ANTHROPIC_API_KEY` to an attacker-chosen `baseUrl` exfiltrates the key. All
 * three are reachable by prompt injection, and no workflow needs them
 * unattended — so a user "allow" here would only ever be someone being talked
 * into it.
 */
export const LOCKED_DESTRUCTIVE_KINDS: ReadonlySet<DestructiveKind> = new Set([
  'agent-state',
  'credential-bind',
]);

/**
 * Every kind, in the order a settings menu should list them: worst damage
 * first, the two locked ones last. Exhaustiveness is enforced by
 * `UncoveredDestructiveKind` below, so adding a kind to the union without
 * listing it here is a compile error rather than a silently un-gated category.
 */
export const ALL_DESTRUCTIVE_KINDS = [
  'disk-wipe',
  'system-halt',
  'delete-outside',
  'git-history',
  'publish',
  'download-and-run',
  'bulk-delete',
  'agent-state',
  'credential-bind',
] as const satisfies readonly DestructiveKind[];

/**
 * Compile gate for {@link ALL_DESTRUCTIVE_KINDS}. Resolves to `never` while the
 * list is complete; the moment a kind is added to the union without being
 * listed, this becomes that kind and every `never`-typed use of it errors —
 * naming the offender. Exported so it counts as used.
 */
export type UnlistedDestructiveKind = Exclude<
  DestructiveKind,
  (typeof ALL_DESTRUCTIVE_KINDS)[number]
>;
const _assertAllKindsListed: UnlistedDestructiveKind[] = [];
void _assertAllKindsListed;

/** True when `value` is a kind this build knows — for decoding user config. */
export function isDestructiveKind(value: unknown): value is DestructiveKind {
  return typeof value === 'string' && (ALL_DESTRUCTIVE_KINDS as readonly string[]).includes(value);
}

/**
 * The gated set a policy should actually use: unknown entries dropped, the
 * locked kinds always present.
 *
 * `undefined` means "the user has not chosen" and gates everything — the
 * fail-closed default. An EMPTY set is a real choice (gate only what is
 * locked), which is why it must not be collapsed into `undefined`.
 */
export function normalizeYoloConfirmKinds(
  kinds: Iterable<DestructiveKind> | undefined,
): ReadonlySet<DestructiveKind> {
  if (kinds === undefined) return new Set(ALL_DESTRUCTIVE_KINDS);
  const out = new Set<DestructiveKind>();
  for (const kind of kinds) if (isDestructiveKind(kind)) out.add(kind);
  for (const locked of LOCKED_DESTRUCTIVE_KINDS) out.add(locked);
  return out;
}

/**
 * Decode the user's `autonomy.yoloConfirm` map into the gated set.
 *
 * A key is gated unless the user explicitly wrote `false`, so an unknown or
 * partially-written map only ever un-gates what it names — a truncated file or
 * a kind added by a newer build stays gated rather than silently opening.
 */
export function resolveYoloConfirmKinds(
  preference: Record<string, boolean> | undefined,
): ReadonlySet<DestructiveKind> {
  if (preference === undefined) return new Set(ALL_DESTRUCTIVE_KINDS);
  return normalizeYoloConfirmKinds(
    ALL_DESTRUCTIVE_KINDS.filter((kind) => preference[kind] !== false),
  );
}

/** Set equality, so a no-op update does not flush the permission cache. */
export function sameKindSet(
  a: ReadonlySet<DestructiveKind>,
  b: ReadonlySet<DestructiveKind>,
): boolean {
  if (a.size !== b.size) return false;
  for (const kind of a) if (!b.has(kind)) return false;
  return true;
}

/**
 * Best-effort detection of a *catastrophic* shell command — system-/disk-/
 * home-wide, effectively irreversible destruction, OR a write to WrongStack's
 * own trusted state files that could disable security boundaries.
 *
 * `projectRoot` scopes the delete checks (an in-project cleanup is not an
 * escape); it is deliberately unused for catastrophic and state-root targets,
 * which are resolved absolutely.
 *
 * Returns WHICH kind matched so callers can honour a per-kind user preference.
 * Order matters only for reporting: the most severe kind wins the label.
 */
export function classifyDestructiveCommand(
  command: string,
  projectRoot: string | undefined,
): DestructiveKind | undefined {
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  if (CATASTROPHIC_PATTERNS.some((pattern) => pattern.test(trimmed))) return 'disk-wipe';
  if (haltsTheMachine(trimmed)) return 'system-halt';
  if (hasWriteToAgentStateRoot(trimmed)) return 'agent-state';
  if (HIGH_IMPACT_PATTERNS.some((pattern) => pattern.test(trimmed))) return 'download-and-run';
  if (hasCatastrophicDelete(trimmed)) return 'delete-outside';
  if (hasRecursiveForceDelete(trimmed, projectRoot)) return 'delete-outside';
  if (hasGitHistoryRewrite(trimmed)) return 'git-history';
  if (hasExternalPublish(trimmed)) return 'publish';
  if (hasFindExec(trimmed)) return 'bulk-delete';
  if (hasRiskyInlinePayload(trimmed)) {
    // Both halves already matched inside one segment; the network half is the
    // more severe reading, so it wins the label.
    return splitShellSegments(trimmed).some(
      (segment) =>
        INLINE_PAYLOAD_INTERPRETERS.some((pattern) => pattern.test(segment)) &&
        PAYLOAD_FETCHES_NETWORK.test(segment),
    )
      ? 'download-and-run'
      : 'bulk-delete';
  }
  return undefined;
}

/**
 * Boolean form of {@link classifyDestructiveCommand}, kept because most callers
 * only need "is this gated at all".
 */
export function isClearlyDestructiveBashCommand(
  command: string,
  projectRoot: string | undefined,
): boolean {
  return classifyDestructiveCommand(command, projectRoot) !== undefined;
}

/**
 * Environment variables that hold a credential for some OTHER service.
 *
 * Not a general "looks like a secret" list — `MYLLM_API_KEY` must stay usable,
 * because naming the env var that supplies a provider's key is the entire point
 * of `provider_manage`. These are the well-known names where attaching them to
 * a NEW provider means pointing an existing credential at a new destination.
 */
const WELL_KNOWN_CREDENTIAL_ENV_VARS: ReadonlySet<string> = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'COHERE_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'OPENROUTER_API_KEY',
  'PERPLEXITY_API_KEY',
  'TOGETHER_API_KEY',
  'FIREWORKS_API_KEY',
  'HUGGINGFACE_API_KEY',
  'HF_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AZURE_CLIENT_SECRET',
  'GITLAB_TOKEN',
  'SLACK_TOKEN',
  'STRIPE_SECRET_KEY',
  'TELEGRAM_BOT_TOKEN',
  'WRONGSTACK_VAULT_PASSPHRASE',
]);

/**
 * Input keys whose value NAMES environment variables — an array of names, a
 * single name string, or an object whose keys are the names (MCP-server
 * `env` maps). Matched case-insensitively with underscores ignored, so
 * `envVars` / `env_vars` / `ENVVARS` all hit.
 */
const ENV_NAME_CARRIER_KEYS = new Set(['envvars', 'env', 'environment']);

/** Bounds for the recursive carrier scan — tool inputs are untrusted. */
const MAX_CREDENTIAL_SCAN_DEPTH = 6;
const MAX_CREDENTIAL_SCAN_NODES = 500;

/**
 * True when a tool call would bind a well-known third-party credential to a
 * provider endpoint.
 *
 * `provider_manage` lets the model create a provider, choose its `baseUrl`
 * (no metadata-host gate) and name the environment variables its key is read
 * from. Nothing claims `ANTHROPIC_API_KEY` on a stock install, so
 * `rejectBorrowedEnvVars` — which only rejects names another provider already
 * lists — let it through. Combined with the sibling `fallback_chain_manage` /
 * `leader_model_set` tools in the same bundle, that is a complete "send my
 * real key to a host I chose" primitive, reachable by prompt injection.
 *
 * VULN-006 item 3: the scan is NOT limited to the top-level `envVars` key.
 * Config-sync and mass-assignment payloads carry credential carriers nested
 * one or more levels down, under alias keys (`env`, `env_vars`,
 * `environment`), as MCP-style env MAPS (the keys are the names), or as
 * single strings. The scan walks the whole input — depth- and node-bounded —
 * and flags a well-known name in any of those shapes.
 *
 * The tool stays usable: this only forces the decision back to the human
 * rather than letting YOLO auto-approve it.
 */
export function attachesWellKnownCredential(input: unknown): boolean {
  return inputNamesAWellKnownCredential(input, 0, { nodes: 0 });
}

function inputNamesAWellKnownCredential(
  node: unknown,
  depth: number,
  budget: { nodes: number },
): boolean {
  if (!node || typeof node !== 'object') return false;
  if (depth > MAX_CREDENTIAL_SCAN_DEPTH || ++budget.nodes > MAX_CREDENTIAL_SCAN_NODES) {
    // Fail closed (chimera review): a payload that exhausts the traversal
    // bounds cannot be proven clean, so treat it as risky — the callers turn
    // `true` into human approval instead of a silent YOLO auto-approve. A
    // crafted payload can weaponize the bounds ONLY into a spurious prompt,
    // never into a missed carrier.
    return true;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (isEnvCarrierKey(key) && namesAWellKnownCredential(value)) return true;
    if (value && typeof value === 'object') {
      if (inputNamesAWellKnownCredential(value, depth + 1, budget)) return true;
    }
  }
  return false;
}

function isEnvCarrierKey(key: string): boolean {
  return ENV_NAME_CARRIER_KEYS.has(key.toLowerCase().replace(/_/g, ''));
}

function namesAWellKnownCredential(value: unknown): boolean {
  if (typeof value === 'string') {
    return WELL_KNOWN_CREDENTIAL_ENV_VARS.has(value.toUpperCase());
  }
  if (Array.isArray(value)) {
    return value.some(
      (name) => typeof name === 'string' && WELL_KNOWN_CREDENTIAL_ENV_VARS.has(name.toUpperCase()),
    );
  }
  if (value && typeof value === 'object') {
    // MCP-server style env maps: the KEYS are the variable names.
    return Object.keys(value as Record<string, unknown>).some((name) =>
      WELL_KNOWN_CREDENTIAL_ENV_VARS.has(name.toUpperCase()),
    );
  }
  return false;
}

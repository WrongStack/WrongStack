/**
 * Exec Kill Guard — Intercepts exec tool kill commands and prevents them from
 * terminating WrongStack processes.
 *
 * Unlike bash-kill-guard.ts which parses a raw shell string, this module
 * works with the exec tool's (command, args) format. It handles:
 * - taskkill /F /IM node.exe (name-based)
 * - taskkill /F /PID 1234 (PID-based)
 * - Stop-Process -Name "node" -Force (PowerShell cmdlet)
 * - kill -9 12345 / pkill node (POSIX via allowlisted commands)
 * - wmic process where "name='node.exe'" delete
 * - node -e "process.kill(12345)" (eval-based kill)
 * - Any script that contains kill commands (exec'd via shell interpreters)
 *
 * This is one defense-in-depth layer — the primary guard is the
 * PreToolUse hook in the process-guard plugin, and the permission
 * policy's YOLO destructive detection.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { compileUserRegex } from './_regex.js';
import { wildcardNameMatches } from './bash-kill-guard.js';
import { getPersistentProcessRegistry } from './process-registry-persistent.js';

const isWin = os.platform() === 'win32';

export interface ExecKillCheckResult {
  blocked: boolean;
  reason?: string;
}

/**
 * Check if an exec (command, args) pair is a kill operation targeting
 * a protected WrongStack process. Returns { blocked: true, reason } when
 * the command should be blocked, or { blocked: false } when it's safe.
 */
export async function checkExecKillCommand(
  cmd: string,
  args: readonly string[],
): Promise<ExecKillCheckResult> {
  if (!cmd) return { blocked: false };

  // Compare the executable's base name: exec resolves `C:\Windows\System32\
  // taskkill.exe` and `/bin/kill` to the same programs, and the verbatim
  // comparisons below never matched a path-qualified command.
  const cmdLower = cmd
    .toLowerCase()
    .trim()
    .replace(/^.*[\\/]/, '')
    .replace(/\.exe$/, '');
  const fullCommand = [cmdLower, ...args].join(' ').replace(/\s+/g, ' ').trim();

  // node -e "process.kill(12345)" — eval-based kill
  if (cmdLower === 'node' || cmdLower === 'bun') {
    if (args.includes('-e') || args.includes('--eval')) {
      const evalIdx = args.indexOf('-e') !== -1 ? args.indexOf('-e') : args.indexOf('--eval');
      const evalCode = args[evalIdx + 1] ?? '';
      if (/\bprocess\.kill\s*\(/.test(evalCode)) {
        // Extract the PID from process.kill(...)
        const pidMatch = evalCode.match(/process\.kill\s*\(\s*(\d+)/);
        if (pidMatch?.[1]) {
          const pid = parseInt(pidMatch[1], 10);
          const result = await checkKillTarget({ pid, signal: 'SIGTERM', cmd: fullCommand });
          if (result.blocked) return result;
        }
        // Can't extract PID but it's process.kill — block conservatively
        return {
          blocked: true,
          reason: `Blocked: ${cmdLower} -e with process.kill() — would target protected WrongStack process(es).`,
        };
      }
    }
  }

  // On Windows, check for taskkill, Stop-Process, wmic kill
  if (isWin) {
    // taskkill /IM node.exe or taskkill /F /PID 1234
    if (cmdLower === 'taskkill' || cmdLower === 'taskkill.exe') {
      const hasForce = args.some((a) => a.toUpperCase() === '/F' || a.toUpperCase() === '-F');
      const signal = hasForce ? 'FORCE' : 'TERM';

      // /IM name-based kill
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (a.toUpperCase() === '/IM' || a.toUpperCase() === '-IM') {
          const nameArg = args[i + 1];
          if (nameArg) {
            const result = await checkKillTarget({ name: nameArg, signal, cmd: fullCommand });
            if (result.blocked) return result;
          }
        }
      }
      // /PID specific process (also the colon-attached `/PID:1234`, which
      // taskkill binds identically — the bash guard already reads it)
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        const attached = /^[/-]PID:(\d+)$/i.exec(a)?.[1];
        if (attached || a.toUpperCase() === '/PID' || a.toUpperCase() === '-PID') {
          const pidArg = attached ?? args[i + 1];
          if (pidArg && /^\d+$/.test(pidArg)) {
            const result = await checkKillTarget({
              pid: parseInt(pidArg, 10),
              signal,
              cmd: fullCommand,
            });
            if (result.blocked) return result;
          }
        }
      }
      // /FI "IMAGENAME eq node.exe" filter-based name kill (functionally
      // equivalent to /IM, documented taskkill idiom)
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (a.toUpperCase() === '/FI' || a.toUpperCase() === '-FI') {
          const filterArg = args[i + 1];
          if (filterArg) {
            const nameMatch = filterArg.match(/IMAGENAME\s+eq\s+"?([^"\s]+)/i);
            if (nameMatch?.[1]) {
              const result = await checkKillTarget({
                name: nameMatch[1],
                signal,
                cmd: fullCommand,
              });
              if (result.blocked) return result;
            }
          }
        }
      }
      // If it's taskkill with /IM but we didn't match a specific name,
      // still be conservative if it targets processes broadly
      return { blocked: false };
    }

    // Shell indirection: inspect the command after cmd /c or PowerShell
    // -Command/-c. Recurse through this guard rather than passing the wrapper
    // string to bash-kill-guard, which cannot parse a leading `cmd /c`.
    if (
      cmdLower === 'powershell' ||
      cmdLower === 'powershell.exe' ||
      cmdLower === 'pwsh' ||
      cmdLower === 'pwsh.exe' ||
      cmdLower === 'cmd' ||
      cmdLower === 'cmd.exe'
    ) {
      const shellFlagIndex = args.findIndex((arg) => {
        const lower = arg.toLowerCase();
        return lower === '-c' || lower === '-command' || lower === '/c' || lower === '/k';
      });
      if (shellFlagIndex >= 0) {
        const innerTokens = tokenizeShellCommand(args.slice(shellFlagIndex + 1).join(' '));
        const innerCommand = innerTokens[0];
        if (innerCommand) {
          const result = await checkExecKillCommand(innerCommand, innerTokens.slice(1));
          if (result.blocked) return result;
        }
      } else if (cmdLower.startsWith('powershell') || cmdLower.startsWith('pwsh')) {
        // No explicit -Command/-c: PowerShell still binds the first positional
        // argument as the -Command value (documented default), so the cmdlet
        // hides behind the launcher flags — `powershell Stop-Process -Id 123`
        // executes and killed a real process (live-verified). Recurse on the
        // effective command; -File script mode is opaque and stays
        // uninspected (argsAfterLauncherFlags returns [] for it).
        // PowerShell joins its positional arguments into one command string,
        // so `powershell "Stop-Process -Id 123"` (a single argv entry) runs
        // the cmdlet too — tokenize the joined text like the -Command branch.
        const innerTokens = tokenizeShellCommand(argsAfterLauncherFlags(args).join(' '));
        const innerCommand = innerTokens[0];
        if (innerCommand) {
          const result = await checkExecKillCommand(innerCommand, innerTokens.slice(1));
          if (result.blocked) return result;
        }
      }
    }

    // Direct Stop-Process / kill command (PowerShell alias)
    // `spps` is PowerShell's built-in Stop-Process alias.
    if (cmdLower === 'stop-process' || cmdLower === 'kill' || cmdLower === 'spps') {
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        // PowerShell parameter names are case-insensitive (`-name`, `-ID`,
        // `-iD` all bind exactly like the canonical spelling), so compare the
        // flag lowercased — the way the taskkill branch above compares its
        // flags. Exact-case matching let `Stop-Process -id <pid>` bypass the
        // guard: the bare-name fallback then read the pid as a process NAME.
        //
        // PowerShell ALSO binds the colon-attached value form `-Param:value`
        // (`Stop-Process -Id:12345`, `-name:node`) identically to the space
        // form — live-verified kill via `Stop-Process -Id:<pid>` — so split
        // the value off the flag token or the comparisons below never see it.
        const colon = a.indexOf(':');
        const attachedValue = colon > 1 ? a.slice(colon + 1) : undefined;
        const flag = (attachedValue === undefined ? a : a.slice(0, colon)).toLowerCase();
        // -Name "node", -Name node, or -Name:node
        // `-na` / `-nam`: PowerShell binds any unambiguous parameter prefix.
        if (flag === '-name' || flag === '-nam' || flag === '-na' || flag === '-n') {
          const nameArg = (attachedValue ?? args[i + 1])?.replace(/^['"]|['"]$/g, '');
          if (nameArg) {
            const result = await checkKillTarget({
              name: nameArg,
              signal: 'FORCE',
              cmd: fullCommand,
            });
            if (result.blocked) return result;
          }
        }
        // -Id 1234, -PID 1234, or -Id:1234
        if (flag === '-id' || flag === '-pid') {
          const pidArg = attachedValue ?? args[i + 1];
          if (pidArg && /^\d+$/.test(pidArg)) {
            const result = await checkKillTarget({
              pid: parseInt(pidArg, 10),
              signal: 'FORCE',
              cmd: fullCommand,
            });
            if (result.blocked) return result;
          }
        }
      }
      // Bare "kill node" (PowerShell alias) — name as first non-flag arg.
      // A numeric one (or comma list) binds to -Id, Stop-Process's first
      // positional parameter: `Stop-Process 1234` kills PID 1234, and reading
      // it as a process NAME never matched a protected entry.
      const firstNonFlag = args.find((a) => !a.startsWith('-'));
      const positionalPids = firstNonFlag?.replace(/,$/, '').split(',');
      if (positionalPids?.every((v) => /^\d+$/.test(v.trim()))) {
        for (const v of positionalPids) {
          const result = await checkKillTarget({
            pid: parseInt(v.trim(), 10),
            signal: 'FORCE',
            cmd: fullCommand,
          });
          if (result.blocked) return result;
        }
      }
      if (firstNonFlag) {
        const name = firstNonFlag.replace(/^['"]|['"]$/g, '');
        // pkill and process names like "node" — conservative check
        const result = await checkKillTarget({ name, signal: 'TERM', cmd: fullCommand });
        if (result.blocked) return result;
      }
    }

    // tskill <pid> — Terminal Services process kill, present on Windows Pro.
    if (cmdLower === 'tskill') {
      const pidArg = args.find((a) => /^\d+$/.test(a));
      if (pidArg) {
        const result = await checkKillTarget({
          pid: parseInt(pidArg, 10),
          signal: 'TERM',
          cmd: fullCommand,
        });
        if (result.blocked) return result;
      }
    }

    // WMIC process ... delete
    if (cmdLower === 'wmic' || cmdLower === 'wmic.exe') {
      const joined = args.join(' ').toLowerCase();
      if (/\bprocess\b/.test(joined) && /\bdelete\b/.test(joined)) {
        // Extract the name filter
        const nameMatch = joined.match(/name\s*=\s*['"]?([^'"]+)/);
        if (nameMatch?.[1]) {
          const result = await checkKillTarget({
            name: nameMatch[1].trim(),
            signal: 'FORCE',
            cmd: fullCommand,
          });
          if (result.blocked) return result;
        }
        // No name filter — block conservatively (wmic process delete is broad)
        return {
          blocked: true,
          reason:
            'Blocked: wmic process delete targets all matched processes — would include protected WrongStack processes.',
        };
      }
    }
  } else {
    // POSIX
    // Direct kill/pkill/killall via exec
    if (cmdLower === 'kill') {
      for (const a of args) {
        // kill 1234, kill -9 1234, kill -- -1234 (group)
        const num = a.replace(/^-/, '');
        if (/^\d+$/.test(num)) {
          const pid = parseInt(num, 10);
          const result = await checkKillTarget({ pid, signal: 'SIGTERM', cmd: fullCommand });
          if (result.blocked) return result;
        }
      }
    }
    if (cmdLower === 'pkill' || cmdLower === 'killall') {
      const selected = await checkPkillSelection(cmdLower, args, fullCommand);
      if (selected.blocked) return selected;
      const firstNonFlag = args.find((a) => !a.startsWith('-'));
      if (firstNonFlag) {
        const result = await checkKillTarget({
          name: firstNonFlag,
          signal: 'SIGTERM',
          cmd: fullCommand,
        });
        if (result.blocked) return result;
      }
    }
  }

  return { blocked: false };
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** PowerShell launcher flags that consume their own value (skipped with it). */
const POWERSHELL_LAUNCHER_VALUE_FLAGS = new Set([
  '-executionpolicy',
  '-inputformat',
  '-outputformat',
  '-windowstyle',
  '-version',
  '-configurationname',
  '-settings',
]);

/**
 * Args after the PowerShell launcher's own flags: powershell/pwsh treat the
 * first POSITIONAL argument as the -Command value (documented default), so
 * `powershell Stop-Process -Id 123` runs the cmdlet with no -Command flag.
 * Returns [] when there is no inspectable inner command — notably -File
 * script mode, which executes an opaque file we cannot parse.
 */
function argsAfterLauncherFlags(args: readonly string[]): string[] {
  let expectsValue = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    const lower = token.toLowerCase();
    if (expectsValue) {
      expectsValue = false;
      continue;
    }
    if (lower === '-file' || lower.startsWith('-file:')) return [];
    if (POWERSHELL_LAUNCHER_VALUE_FLAGS.has(lower)) {
      expectsValue = true;
      continue;
    }
    if (lower.startsWith('-')) continue;
    return args.slice(i);
  }
  return [];
}

/** Split a shell payload into argv-like tokens while preserving quoted names. */
function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (const char of command.trim()) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current) tokens.push(current);
  return tokens;
}

interface KillTarget {
  pid?: number;
  name?: string;
  signal: string;
  cmd: string;
}

/** pkill options that pick processes by user / parent / session / group / terminal. */
const PKILL_SELECTOR_RE =
  /^(?:-[uUGgPst]|--(?:euid|uid|group|pgroup|parent|session|terminal|ns|cgroup))(?:=|$)|^-[uUGgPst]./;
/** killall's pattern-free selector: every process of a user. */
const KILLALL_SELECTOR_RE = /^(?:-u|--user)(?:=|$)|^-u./;

/**
 * pkill/killall do not take a literal name: the pattern is a REGEX (`pkill
 * n.de`, `pkill .`, `killall -r 'wrong.*'`), and pkill also selects by user /
 * parent / session with no pattern (`pkill -u me`, `pkill -P <pid>` — whose
 * VALUE the first-non-flag rule below misread as the name). Whenever a
 * WrongStack process could be hit (a protected PID exists, or this host runs
 * on node), block a selector kill and test every non-option word as a
 * case-insensitive regex against the protected names; a word the ReDoS guard
 * refuses blocks too (fail closed).
 */
async function checkPkillSelection(
  cmd: 'pkill' | 'killall',
  args: readonly string[],
  fullCommand: string,
): Promise<ExecKillCheckResult> {
  const currentImage = path
    .basename(process.execPath)
    .toLowerCase()
    .replace(/\.exe$/, '');
  const protectedPids = await getPersistentProcessRegistry().getAllProtectedPids();
  const reason = `Blocked: ${fullCommand.slice(0, 80)} can select protected WrongStack processes.`;
  const selector = cmd === 'killall' ? KILLALL_SELECTOR_RE : PKILL_SELECTOR_RE;
  if (args.some((a) => selector.test(a))) return { blocked: true, reason };
  const targets = [
    'wrongstack',
    currentImage,
    ...(protectedPids.length > 0 ? ['node', 'bun'] : []),
  ];
  for (const word of args) {
    if (word.startsWith('-')) continue;
    const compiled = compileUserRegex(word, 'i');
    if (!compiled.ok || targets.some((t) => compiled.regex.test(t))) {
      return { blocked: true, reason };
    }
  }
  return { blocked: false };
}

/**
 * Check if a kill target maps to a protected WrongStack process by
 * consulting the persistent process registry (cross-instance PID store).
 */
async function checkKillTarget(target: KillTarget): Promise<ExecKillCheckResult> {
  const registry = getPersistentProcessRegistry();

  // PID-based check: is this PID known as protected?
  if (target.pid !== undefined) {
    const blocked = await registry.shouldBlockKill(target.pid);
    if (blocked) {
      return {
        blocked: true,
        reason: `Blocked: kill ${target.signal} PID ${target.pid} targets a protected WrongStack process (${target.cmd.slice(0, 80)}).`,
      };
    }
    // Also check if it's the current process or its parent
    if (target.pid === process.pid) {
      return {
        blocked: true,
        reason: 'Blocked: cannot kill the current WrongStack process.',
      };
    }
    if (target.pid === process.ppid) {
      return {
        blocked: true,
        reason: 'Blocked: cannot kill the parent terminal hosting WrongStack.',
      };
    }
    return { blocked: false };
  }

  // Name-based check: does the target name match any protected process?
  if (target.name) {
    const nameLower = target.name.toLowerCase().replace(/\.exe$/, '');

    // `taskkill /IM` and `Stop-Process -Name` take WILDCARDS: `nod*` / `*`
    // name node.exe without containing "node".
    const wildcard = /[*?[]/.test(nameLower);

    // Hard-block on "wrongstack" references
    if (
      nameLower.includes('wrongstack') ||
      (wildcard && wildcardNameMatches(nameLower, 'wrongstack'))
    ) {
      return {
        blocked: true,
        reason: `Blocked: kill ${target.signal} '${target.name}' targets a WrongStack process name.`,
      };
    }

    // The guard itself runs inside the current WrongStack process, which may
    // not have been written to the persistent registry yet (notably in fresh
    // CLI/test sessions). A broad image-name kill matching the current runtime
    // would therefore kill WrongStack even when the registry is empty.
    const currentImage = path
      .basename(process.execPath)
      .toLowerCase()
      .replace(/\.exe$/, '');
    const targetsNodeRuntime =
      nameLower === 'node' ||
      nameLower.startsWith('node') ||
      (wildcard && wildcardNameMatches(nameLower, 'node'));
    const targetsCurrentRuntime =
      nameLower === currentImage ||
      (wildcard && wildcardNameMatches(nameLower, currentImage)) ||
      (targetsNodeRuntime && currentImage === 'node');
    if (targetsCurrentRuntime) {
      return {
        blocked: true,
        reason: `Blocked: kill ${target.signal} '${target.name}' would kill the active WrongStack ${currentImage} runtime.`,
      };
    }

    // Also protect other registered WrongStack instances that use Node even
    // when this instance is running from a packaged executable.
    const protectedPids = await registry.getAllProtectedPids();
    const targetsBunRuntime =
      nameLower === 'bun' || (wildcard && wildcardNameMatches(nameLower, 'bun'));
    if (protectedPids.length > 0 && (targetsNodeRuntime || targetsBunRuntime)) {
      return {
        blocked: true,
        reason: `Blocked: kill ${target.signal} '${target.name}' would kill runtime processes including active WrongStack instance(s).`,
      };
    }

    return { blocked: false };
  }

  return { blocked: false };
}

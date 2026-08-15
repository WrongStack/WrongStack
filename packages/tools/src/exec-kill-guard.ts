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

  const cmdLower = cmd.toLowerCase().trim();
  const fullCommand = [cmdLower, ...args].join(' ').replace(/\s+/g, ' ').trim();

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
      // /PID specific process
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (a.toUpperCase() === '/PID' || a.toUpperCase() === '-PID') {
          const pidArg = args[i + 1];
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
        return lower === '-c' || lower === '-command' || lower === '/c';
      });
      if (shellFlagIndex >= 0) {
        const innerTokens = tokenizeShellCommand(args.slice(shellFlagIndex + 1).join(' '));
        const innerCommand = innerTokens[0];
        if (innerCommand) {
          const result = await checkExecKillCommand(innerCommand, innerTokens.slice(1));
          if (result.blocked) return result;
        }
      }
    }

    // Direct Stop-Process / kill command (PowerShell alias)
    if (cmdLower === 'stop-process' || cmdLower === 'kill') {
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        // -Name "node" or -Name node
        if (a === '-Name' || a === '-n') {
          const nameArg = args[i + 1]?.replace(/^['"]|['"]$/g, '');
          if (nameArg) {
            const result = await checkKillTarget({
              name: nameArg,
              signal: 'FORCE',
              cmd: fullCommand,
            });
            if (result.blocked) return result;
          }
        }
        // -Id 1234 or -PID 1234
        if (a === '-Id' || a === '-PID' || a === '-pid') {
          const pidArg = args[i + 1];
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
      // Bare "kill node" (PowerShell alias) — name as first non-flag arg
      const firstNonFlag = args.find((a) => !a.startsWith('-'));
      if (firstNonFlag) {
        const name = firstNonFlag.replace(/^['"]|['"]$/g, '');
        // pkill and process names like "node" — conservative check
        const result = await checkKillTarget({ name, signal: 'TERM', cmd: fullCommand });
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

    // node -e "process.kill(12345)" — eval-based kill
    if (cmdLower === 'node' || cmdLower === 'node.exe') {
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
            reason:
              'Blocked: node -e with process.kill() — would target protected WrongStack process(es).',
          };
        }
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

    // Hard-block on "wrongstack" references
    if (nameLower.includes('wrongstack')) {
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
    const targetsNodeRuntime = nameLower === 'node' || nameLower.startsWith('node');
    if (targetsNodeRuntime && currentImage === 'node') {
      return {
        blocked: true,
        reason: `Blocked: kill ${target.signal} '${target.name}' would kill the active WrongStack node.exe runtime.`,
      };
    }

    // Also protect other registered WrongStack instances that use Node even
    // when this instance is running from a packaged executable.
    const protectedPids = await registry.getAllProtectedPids();
    if (protectedPids.length > 0 && targetsNodeRuntime) {
      return {
        blocked: true,
        reason: `Blocked: kill ${target.signal} '${target.name}' would kill all node.exe processes including active WrongStack instance(s).`,
      };
    }

    return { blocked: false };
  }

  return { blocked: false };
}

/**
 * Bash Kill Guard — Intercepts bash kill commands and prevents them from
 * terminating WrongStack processes (either the agent itself or child processes
 * it has spawned).
 *
 * This module hooks into the bash tool's command parsing to detect and block
 * dangerous kill commands targeting protected PIDs.
 *
 * Handles:
 * - Direct kill commands: kill -9 12345
 * - Shell -c wrapped: bash -c "kill -9 12345" (any shell path — see P2 #10)
 * - Full path kills: /bin/kill -9 12345
 * - Name-based kills: pkill, killall, pgrep
 * - Windows equivalents: taskkill, tskill
 * - PowerShell Stop-Process / kill alias: Stop-Process -Name node, kill -Id 12345
 * - WMIC process termination: wmic process where "name='node.exe'" delete
 *   or wmic process where "ProcessId=1234" delete
 * - Script-based kill (script is named kill*.sh, kill*.ps1, kill*.bat)
 *
 * Security contract: every "Handles" bullet must map to both a detector
 * AND a block path in isKillRelatedCommand + parseKillCommand + isKillProtected.
 * Script-based kills are blocked conservatively (can't inspect script content).
 *
 * Known bypasses (NOT handled — this is a static regex parser, not a shell):
 * Static analysis of shell strings is inherently defeatable by obfuscation.
 * This guard is one defense-in-depth layer behind the permission policy and
 * the project-escape checks, not the sole gate. Treat a miss here as expected,
 * not as a hole to plug with ever-more-clever regexes. The patterns below are
 * known to evade detection:
 * - Base64 / decode pipes: `echo bCAtOSAxMjM0NQ== | base64 -d | sh`
 * - Variable indirection: `sig=-9; target=12345; kill $sig $target`
 * - Command substitution: `$(printf kill) -9 12345`
 * - String concatenation / quote-splitting: `ki''ll -9 12345`, `k"i"ll 12345`
 * - Aliases and functions: `alias x=kill; x -9 12345`
 * - eval / source: `eval "ki""ll -9 12345"`
 * - node -e eval: `node -e "process.kill(12345)"` (handled by exec-kill-guard.ts)
 * - Scripts not named kill/terminate/stop*: `runkill.sh`, `/tmp/cleanup.bat`
 *
 * Mitigation: rely on the permission policy (confirm/deny gate) and YOLO
 * destructive detection as the primary controls; this guard is a best-effort
 * fast path for the common non-obfuscated forms.
 */

import * as os from 'node:os';
import {
  getPersistentProcessRegistry,
  type PersistentProcessEntry,
} from './process-registry-persistent.js';

const isWin = os.platform() === 'win32';

/** Shared regex: scripts named kill/terminate/stop*.ps1|bat|cmd|sh. */
const SCRIPT_KILL_RE = /^(?:\.\\|\.\/)?(?:kill|terminate|stop)\S*\.(?:ps1|bat|cmd|sh)(?:\s|$)/i;
/** Shared regex: POSIX-only .sh script variant. */
const SCRIPT_KILL_RE_POSIX = /^(?:\.\/)?(?:kill|terminate|stop)\S*\.sh(?:\s|$)/i;
/**
 * Fallback broad check: used in checkAndBlockKillCommand when the parsed
 * kill struct doesn't carry a PID or name, as a last-resort block for
 * unparseable but suspicious script filenames.
 */
const SCRIPT_KILL_FALLBACK_RE = /^\S*(?:kill|terminate|stop)\S*\.(?:ps1|bat|cmd|sh)\b/i;

interface KillCommand {
  pid?: number;
  name?: string;
  signal?: string;
  isGroupKill: boolean;
  isAllKill: boolean;
  originalCommand: string;
}

interface KillCheckResult {
  blocked: boolean;
  reason?: string;
}

/**
 * Extract the actual kill command from a shell-wrapped command.
 * e.g., "bash -c 'kill -9 12345'" -> "kill -9 12345"
 * e.g., "/bin/bash -c \"pkill node\"" -> "pkill node"
 *
 * P2 #10 (before-release.md): the path pattern now matches any executable
 * followed by `-c`, not just `/bin` and `/usr/bin`. Real systems often have
 * bash at `/usr/local/bin/bash`, `/opt/homebrew/bin/bash`, or invoke it via
 * `/usr/bin/env bash`. Previously these bypassed the guard entirely.
 */
function extractKillCommand(command: string): string | null {
  const normalized = command.replace(/\s+/g, ' ').trim();

  // Pattern: <any executable path or name> -c "kill ..." or 'kill ...'
  // Matches /bin/bash, /usr/local/bin/bash, /opt/homebrew/bin/bash,
  // /usr/bin/env bash, plain bash/sh/zsh, etc. The executable is any run of
  // non-whitespace, optionally followed by a space and a second token (for
  // the `/usr/bin/env bash` form) before `-c`.
  const shellCMatch = normalized.match(/^.+?\s+-c\s+(['"])([\s\S]+)\1$/);
  if (shellCMatch?.[2]) {
    const inner = shellCMatch[2].trim();
    // Recursively check the inner command
    return isKillRelatedCommand(inner) ? inner : null;
  }

  // Pattern: <executable> -c kill -9 12345 (without quotes)
  const shellCUnquoted = normalized.match(
    /^.+?\s+-c\s+(kill(?:\s+-s\s+[a-zA-Z0-9]+|\s+-[a-zA-Z0-9]+)?\s+\d+)$/,
  );
  if (shellCUnquoted?.[1]) {
    return shellCUnquoted[1];
  }

  return null;
}

/**
 * Check if a command string is kill-related (for filtering).
 */
function isKillRelatedCommand(cmd: string): boolean {
  const normalized = cmd.toLowerCase().replace(/\s+/g, ' ').trim();

  // P3 #25 (before-release.md): filter by platform so each platform only
  // checks the kill commands it can actually encounter. On Windows, POSIX
  // kill/pkill/killall are dead code (they don't exist on cmd.exe/pwsh); on
  // POSIX, taskkill/tskill are dead code. This lets a single test suite
  // pass on both platforms without platform-conditional assertions.
  if (isWin) {
    // Windows taskkill
    if (/^taskkill\s/i.test(normalized)) return true;
    // Windows tskill
    if (/^tskill\s/i.test(normalized)) return true;
    // PowerShell Stop-Process and its aliases (kill, stop)
    if (/^(stop-process|kill|stop)\s/i.test(normalized)) return true;
    // WMIC process termination: wmic process where ... delete
    if (/^wmic\s+process\s/i.test(normalized) && /\bdelete\b/i.test(normalized)) return true;
    // Scripts named kill*, terminate*, stop* .ps1, .bat, .cmd, .sh (with or without args)
    if (SCRIPT_KILL_RE.test(normalized)) return true;
    return false;
  }

  // POSIX
  // Direct kill commands
  if (/^kill(\s|$)/.test(normalized)) return true;

  // Name-based kills
  if (/^(pkill|killall|pgrep|skill)\s/.test(normalized)) return true;

  // Process-related commands that might target specific PIDs
  if (/^\/proc\/\d+\/(?:kill|fd)/.test(normalized)) return true;

  // Scripts named kill*, terminate*, stop* .sh (with or without args)
  if (SCRIPT_KILL_RE_POSIX.test(normalized)) return true;

  return false;
}

/**
 * Parse a kill command string to extract PID and signal.
 */
export function parseKillCommand(command: string): KillCommand | null {
  const normalized = command.replace(/\s+/g, ' ').trim();

  // P3 #25 (before-release.md): skip platform-specific commands that cannot
  // run here. Windows still accepts the common POSIX `kill` forms because
  // Git Bash/WSL can invoke them; only pkill/killall/pgrep remain POSIX-only.
  if (isWin) {
    const hasTaskkillForce = /(?:^|\s)\/F(?=\s|$)/i.test(normalized);

    // ── taskkill /PID 1234 or taskkill /F /PID 1234 ──────────────────
    // Locate the target independently of flag order/arguments (`/T`, `/FI ...`).
    // Shell control operators stay unparsed so the conservative pipeline path runs.
    const isSimpleTaskkill = /^taskkill\s+/i.test(normalized) && !/[|&<>]/.test(normalized);
    const taskkillPidMatch = isSimpleTaskkill
      ? normalized.match(/(?:^|\s)\/PID\s+(\d+)(?=\s|$)/i)
      : null;
    if (taskkillPidMatch?.[1]) {
      return {
        pid: parseInt(taskkillPidMatch[1], 10),
        signal: hasTaskkillForce ? 'FORCE' : 'TERM',
        isGroupKill: false,
        isAllKill: false,
        originalCommand: command,
      };
    }

    // ── taskkill /F /IM node.exe (image-name-based broad kill) ──────
    const taskkillImMatch = isSimpleTaskkill
      ? normalized.match(/(?:^|\s)\/IM\s+([^\s/]+)(?=\s|$)/i)
      : null;
    if (taskkillImMatch?.[1]) {
      return {
        name: taskkillImMatch[1],
        signal: hasTaskkillForce ? 'FORCE' : 'TERM',
        isGroupKill: false,
        isAllKill: false,
        originalCommand: command,
      };
    }

    // ── taskkill /FI "IMAGENAME eq node.exe" (filter-based name kill) ──
    // /FI uses a quoted filter string instead of /IM. Extract the process
    // name after the `IMAGENAME eq` clause — the most common taskkill filter.
    const taskkillFiMatch = isSimpleTaskkill
      ? normalized.match(/(?:^|\s)\/FI\s+"IMAGENAME\s+eq\s+([^"]+)"(?=\s|$)/i)
      : null;
    if (taskkillFiMatch?.[1]) {
      return {
        name: taskkillFiMatch[1],
        signal: hasTaskkillForce ? 'FORCE' : 'TERM',
        isGroupKill: false,
        isAllKill: false,
        originalCommand: command,
      };
    }

    // ── tskill PID ──────────────────────────────────────────────────
    const tskillMatch = normalized.match(/^tskill\s+(\d+)/i);
    if (tskillMatch?.[1]) {
      return {
        pid: parseInt(tskillMatch[1], 10),
        signal: 'TERM',
        isGroupKill: false,
        isAllKill: false,
        originalCommand: command,
      };
    }

    // ── PowerShell Stop-Process -Id 1234 / kill -Id 1234 ─────────────
    // This must precede the POSIX signal form so `kill -Id` is not mistaken
    // for a signal named ID.
    const isStopProcIdCommand =
      /^(?:stop-process|kill)(?:\s+-(?:id|pid)\s+\d+|\s+-[a-zA-Z]+)+$/i.test(normalized);
    const stopProcIdMatch = normalized.match(/(?:^|\s)-(?:id|pid)\s+(\d+)(?=\s|$)/i);
    if (isStopProcIdCommand && stopProcIdMatch?.[1]) {
      return {
        pid: parseInt(stopProcIdMatch[1], 10),
        signal: 'FORCE',
        isGroupKill: false,
        isAllKill: false,
        originalCommand: command,
      };
    }

    // ── Git Bash / WSL: kill -s TERM 12345 ────────────────────────────
    const killSignalOptionMatch = normalized.match(/^kill\s+-s\s+([a-zA-Z0-9]+)\s+(\d+)$/i);
    if (killSignalOptionMatch?.[1] && killSignalOptionMatch[2]) {
      return {
        pid: parseInt(killSignalOptionMatch[2], 10),
        signal: killSignalOptionMatch[1].toUpperCase(),
        isGroupKill: false,
        isAllKill: false,
        originalCommand: command,
      };
    }

    // ── Git Bash / WSL: kill -9 12345 or kill -TERM 12345 or kill 12345 ──
    // This branch must precede name parsing so a numeric target stays a PID.
    const killPosixMatch = normalized.match(/^kill\s+(?:(-[a-zA-Z0-9]+)\s+)?(\d+)$/);
    if (killPosixMatch?.[2]) {
      const sig = killPosixMatch[1] ? killPosixMatch[1].slice(1).toUpperCase() : 'TERM';
      return {
        pid: parseInt(killPosixMatch[2], 10),
        signal: sig,
        isGroupKill: false,
        isAllKill: false,
        originalCommand: command,
      };
    }

    // ── PowerShell Stop-Process -Name "node" (multi-char name) ─────────
    // Uses greedier capture with end anchor to grab the full name.
    const stopProcNameMatch = normalized.match(
      /^(?:stop-process|kill)\s+-(?:name|n)\s+(?:['"]([a-zA-Z0-9_.-]+)['"]|([a-zA-Z0-9_.-]+))(?:\s|$)/i,
    );
    const stopProcName = stopProcNameMatch?.[1] ?? stopProcNameMatch?.[2];
    if (stopProcName) {
      return {
        name: stopProcName,
        signal: 'FORCE',
        isGroupKill: false,
        isAllKill: false,
        originalCommand: command,
      };
    }

    // ── Bare name via PowerShell alias: kill node, stop-process node ──
    const stopProcStandalone = normalized.match(
      /^(?:stop-process|kill)\s+['"]?([a-zA-Z][a-zA-Z0-9_.-]+)['"]?$/i,
    );
    if (stopProcStandalone?.[1]) {
      return {
        name: stopProcStandalone[1],
        signal: 'FORCE',
        isGroupKill: false,
        isAllKill: false,
        originalCommand: command,
      };
    }

    // ── WMIC process where "name='node.exe'" delete ────────────────────
    // Quote-stripping: capture everything between name=' and the next quote
    const wmicMatch = normalized.match(
      /^wmic\s+process\s+where\s+['"]?(?:name\s*=\s*['"]?)([a-zA-Z0-9_.-]+)/i,
    );
    if (wmicMatch?.[1]) {
      return {
        name: wmicMatch[1],
        signal: 'FORCE',
        isGroupKill: false,
        isAllKill: false,
        originalCommand: command,
      };
    }

    // ── WMIC process where "ProcessId=1234" delete ─────────────────────
    // Issue #360: the name= branch above misses PID-targeted wmic deletes;
    // extract the ProcessId so it flows through the same protected-PID check
    // (isKillProtected -> registry.shouldBlockKill) as taskkill /PID.
    const wmicPidMatch = normalized.match(
      /^wmic\s+process\s+where\s+['"]?processid\s*=\s*['"]?(\d+)/i,
    );
    if (wmicPidMatch?.[1]) {
      return {
        pid: parseInt(wmicPidMatch[1], 10),
        signal: 'FORCE',
        isGroupKill: false,
        isAllKill: false,
        originalCommand: command,
      };
    }

    // ── Scripts named kill*.ps1, kill*.bat, kill*.cmd, kill*.sh ──────
    // Blocked conservatively — we can't inspect script contents. Uses
    // SCRIPT_KILL_RE which ends with (?:\s|$) so zero-arg scripts match.
    // Signal is FORCE (matching other name-based windows branches) since
    // isKillProtected always returns true for the "kill-script" sentinel.
    const killScriptMatch = normalized.match(SCRIPT_KILL_RE);
    if (killScriptMatch) {
      return {
        name: 'kill-script', // sentinel — isKillProtected always blocks "kill-script"
        signal: 'FORCE',
        isGroupKill: false,
        isAllKill: false,
        originalCommand: command,
      };
    }

    return null;
  }

  // POSIX: explicit signal option, e.g. kill -s TERM 12345
  const signalOptionMatch = normalized.match(/^kill\s+-s\s+([a-zA-Z0-9]+)\s+(\d+|-?\d+)$/i);
  if (signalOptionMatch?.[1] && signalOptionMatch[2]) {
    const pidOrGroup = signalOptionMatch[2];
    const isGroupKill = pidOrGroup.startsWith('-');
    return {
      pid: parseInt(isGroupKill ? pidOrGroup.slice(1) : pidOrGroup, 10),
      signal: signalOptionMatch[1].toUpperCase(),
      isGroupKill,
      isAllKill: false,
      originalCommand: command,
    };
  }

  // Simple: kill -9 12345 or kill 12345
  const simpleMatch = normalized.match(/^kill\s+(?:(-[a-zA-Z0-9]+)\s+)?(\d+|-?\d+)$/);
  if (simpleMatch) {
    const signal = simpleMatch[1] ?? '-TERM';
    const pidOrGroup = simpleMatch[2];
    if (!pidOrGroup) return null;
    const isGroupKill = pidOrGroup.startsWith('-');
    const pid = isGroupKill ? parseInt(pidOrGroup.slice(1), 10) : parseInt(pidOrGroup, 10);

    return {
      pid,
      signal: signal.slice(1),
      isGroupKill,
      isAllKill: false,
      originalCommand: command,
    };
  }

  // pkill name or pkill -signal name
  const pkillMatch = normalized.match(/^pkill\s+(?:(-[a-zA-Z]+)\s+)?(.+)$/);
  if (pkillMatch?.[2]) {
    const name = pkillMatch[2];
    const signalMatch = pkillMatch[1];
    return {
      name,
      signal: signalMatch ? signalMatch.slice(1) : 'TERM',
      isGroupKill: false,
      isAllKill: false,
      originalCommand: command,
    };
  }

  // killall name or killall -signal name
  const killallMatch = normalized.match(/^killall\s+(?:(-[a-zA-Z]+)\s+)?(.+)$/);
  if (killallMatch?.[2]) {
    const name = killallMatch[2];
    const signalMatch = killallMatch[1];
    return {
      name,
      signal: signalMatch ? signalMatch.slice(1) : 'TERM',
      isGroupKill: false,
      isAllKill: false,
      originalCommand: command,
    };
  }

  // pgrep returns PIDs (not a kill, but could be used with kill)
  const pgrepMatch = normalized.match(/^pgrep\s+(.+)$/);
  if (pgrepMatch) {
    // pgrep by itself isn't dangerous, but log it
    return null;
  }

  // Scripts named kill*.sh / terminate*.sh / stop*.sh — same conservative
  // sentinel as the Windows branch. isKillProtected always blocks the
  // "kill-script" sentinel, and isKillProtected's POSIX path already flags
  // these via SCRIPT_KILL_RE_POSIX, so the parser must recognize them too.
  const posixScriptMatch = normalized.match(SCRIPT_KILL_RE_POSIX);
  if (posixScriptMatch) {
    return {
      name: 'kill-script',
      signal: 'FORCE',
      isGroupKill: false,
      isAllKill: false,
      originalCommand: command,
    };
  }

  return null;
}

/**
 * Get all protected process entries from the registry.
 */
async function getProtectedEntries(): Promise<PersistentProcessEntry[]> {
  const registry = getPersistentProcessRegistry();
  const status = await registry.getGlobalStatus();
  const entries: PersistentProcessEntry[] = [];

  for (const instanceEntries of status.instances.values()) {
    for (const entry of instanceEntries) {
      if (entry.protected && Date.now() - entry.lastHeartbeat < 30_000) {
        entries.push(entry);
      }
    }
  }

  return entries;
}

/**
 * Check if a parsed kill command targets a protected WrongStack process.
 */
async function isKillProtected(kill: KillCommand): Promise<boolean> {
  const registry = getPersistentProcessRegistry();

  // Sentinel: kill-script is always blocked (script contents are opaque)
  if (kill.name === 'kill-script') {
    return true;
  }

  // For name-based kills, check if any protected process matches the name
  if (kill.name) {
    const entries = await getProtectedEntries();
    const killNameLower = kill.name.toLowerCase();

    for (const entry of entries) {
      if (entry.name?.toLowerCase().includes(killNameLower)) {
        return true;
      }
    }

    // Also check against our own hostname/process name patterns
    if (killNameLower.includes('wrongstack')) {
      return true;
    }
    if (killNameLower.includes('node') && entries.length > 0) {
      // Conservative: block pkill node if we have protected node processes
      return true;
    }
    return false;
  }

  // For group kills, block if any protected processes exist
  if (kill.isGroupKill) {
    const protectedPids = await registry.getAllProtectedPids();
    return protectedPids.length > 0;
  }

  // Single process kill - check if the target PID is protected
  if (kill.pid !== undefined) {
    if (await registry.shouldBlockKill(kill.pid)) return true;
    // Parity with exec-kill-guard: block self/parent even when the
    // persistent registry has no live entry for them.
    if (kill.pid === process.pid || kill.pid === process.ppid) return true;
    return false;
  }

  return false;
}

/**
 * Main entry point: Check if a bash command contains a kill operation targeting protected PIDs.
 * Returns a result indicating whether to block and why.
 */
export async function checkAndBlockKillCommand(command: string): Promise<KillCheckResult> {
  const normalized = command.replace(/\s+/g, ' ').trim();

  // First, extract any kill command from shell-wrapped commands
  const killCmd =
    extractKillCommand(normalized) || (isKillRelatedCommand(normalized) ? normalized : null);

  if (!killCmd) {
    return { blocked: false };
  }

  const parsed = parseKillCommand(killCmd);
  if (!parsed) {
    // It's kill-related but couldn't parse - conservative approach
    // e.g., complex pipelines involving kill
    if (killCmd.includes('kill') && /kill\s+.*\|/.test(killCmd)) {
      // kill piped to something - might be "pkill node | xargs kill"
      return {
        blocked: true,
        reason: `Blocked: complex kill pipeline detected — "${killCmd.slice(0, 50)}..."`,
      };
    }
    // Script-based kill (named kill*.ps1, kill*.bat, kill*.cmd, kill*.sh)
    // detected by isKillRelatedCommand but couldn't parse PID/name — block
    // conservatively because script contents are opaque
    if (SCRIPT_KILL_FALLBACK_RE.test(killCmd)) {
      return {
        blocked: true,
        reason: `Blocked: script-based kill detected — "${killCmd.slice(0, 80)}" may target protected WrongStack processes (cannot inspect script body).`,
      };
    }
    return { blocked: false };
  }

  if (await isKillProtected(parsed)) {
    let target: string;
    if (parsed.name) {
      target = `process name "${parsed.name}"`;
    } else if (parsed.pid !== undefined) {
      target = `PID ${parsed.pid}`;
    } else {
      target = '(unknown target)';
    }

    const signal = parsed.signal ? ` (${parsed.signal})` : '';
    const groupNote = parsed.isGroupKill ? ' (process group)' : '';
    return {
      blocked: true,
      reason: `Blocked: kill${signal} ${target}${groupNote} targets a protected WrongStack process.`,
    };
  }

  return { blocked: false };
}

/**
 * Get a safe error message for blocked kill commands.
 */
export function getBlockedKillMessage(pid: number, signal?: string): string {
  return (
    `Kill command blocked: PID ${pid}${signal ? ` (signal ${signal})` : ''} is a protected WrongStack process. ` +
    `Use 'exit' or Ctrl+C to gracefully terminate a WrongStack session.`
  );
}

/**
 * Heuristic danger detection for `exec` tool commands.
 *
 * Layered on top of `BLOCKED_ARG_PATTERNS` (which is a hard-deny list for
 * clear sandbox escapes) and `bash-kill-guard.ts` (which protects WrongStack
 * itself from kill). This module assigns a danger level to a command/arg
 * pair so the caller can decide whether to:
 *
 *   - 'safe'        → execute normally
 *   - 'caution'     → execute and emit a warning line to the tool output
 *   - 'destructive' → route through the existing confirm flow
 *                     (`execTool.permission === 'confirm'`) instead of
 *                     hard-deny, so the user can still proceed if intentional
 *
 * Design constraints:
 *   - Deterministic: no randomness, no I/O, no time. Same input → same output.
 *   - No LLM calls. Patterns are regex / exact-match.
 *   - Per-rule `id` so config can override specific rules (e.g.
 *     `tools.exec.danger.bypass: ["rm-recursive-build"]` in a future PR).
 *   - Reasons are human-readable, joined with "; " for the confirm prompt.
 *
 * PR 1 (narrow): destructive file deletion + disk/boot operations.
 * PR 2 (broader, follow-up): git push --force, npm/cargo publish,
 *   kubectl delete namespace, network exfil, privilege escalation.
 */

export type DangerLevel = 'safe' | 'caution' | 'destructive';

export interface DangerAssessment {
  level: DangerLevel;
  reasons: string[];
  /** Stable id of the matched rule, for tests and future config-override. */
  matchedRule?: string;
}

interface DangerRule {
  id: string;
  level: DangerLevel;
  /** Match a (cmd, args) pair. Return true if this rule fires. */
  test: (cmd: string, args: readonly string[]) => boolean;
  /** Human-readable explanation, joined with "; " in the output. */
  reason: string;
}

const argHas = (args: readonly string[], value: string): boolean => args.includes(value);
const argMatches = (args: readonly string[], re: RegExp): boolean => args.some((a) => re.test(a));
/**
 * Check for a flag like `-rf`, `-fr`, `-r -f`, `-f -r` etc. where the *order*
 * of flags does not matter. Each short-flag letter is treated as an
 * independent `-x` token; we split joined shorts and look for the letters.
 */
const hasShortFlags = (args: readonly string[], letters: string): boolean => {
  for (const a of args) {
    if (!a.startsWith('-') || a.startsWith('--')) continue;
    // Strip leading dashes and compare letter set
    const letters_in = a.replace(/^-+/, '').split('');
    if (letters.split('').every((l) => letters_in.includes(l))) return true;
  }
  return false;
};

const RULES: readonly DangerRule[] = [
  // ----- rm / rmdir: recursive force delete (any path) -----
  // Note: BLOCKED_ARG_PATTERNS already hard-denies root/home/glob paths,
  // but `rm -rf ./build` is a normal dev workflow that the user might
  // want to do intentionally. We downgrade it to 'destructive' so the
  // confirm prompt can approve.
  {
    id: 'rm-recursive',
    level: 'destructive',
    test: (cmd, args) =>
      (cmd === 'rm' || cmd === 'rmdir') && hasShortFlags(args, 'rf'),
    reason: 'recursive force-delete',
  },
  // ----- Windows PowerShell Remove-Item: -Recurse -Force -----
  // Note: PowerShell is NOT in the default allowlist (deliberate, see
  // cf3fa2b4 commit message), so this only fires when the user has
  // explicitly added `powershell` to their config.allow. Even then, the
  // -Recurse -Force combo is dangerous enough to confirm.
  {
    id: 'powershell-remove-item-recursive-force',
    level: 'destructive',
    test: (cmd, args) => {
      if (cmd !== 'powershell' && cmd !== 'pwsh') return false;
      const hasRecurse = argMatches(args, /^-(?:R|Recurse|Recurse\s)/);
      const hasForce = argHas(args, '-Force') || argHas(args, '-F');
      // Allow `-WhatIf` (dry-run) without confirmation
      if (argHas(args, '-WhatIf')) return false;
      return hasRecurse && hasForce;
    },
    reason: 'Remove-Item with -Recurse -Force',
  },
  // ----- find -exec / -ok / -execdir -----
  {
    id: 'find-exec',
    level: 'destructive',
    test: (cmd, args) => {
      if (cmd !== 'find') return false;
      return args.some(
        (a) =>
          a === '-exec' ||
          a === '-exec;' ||
          a === '-ok' ||
          a === '-ok;' ||
          a === '-execdir' ||
          a === '-execdir;' ||
          a.startsWith('-exec=') ||
          a.startsWith('-ok=') ||
          a.startsWith('-execdir='),
      );
    },
    reason: 'find with -exec/-ok (executes arbitrary command on matches)',
  },
  // ----- git --exec= / --upload-pack= / --receive-pack= -----
  // These run arbitrary commands via the git transport layer.
  {
    id: 'git-exec',
    level: 'destructive',
    test: (cmd, args) =>
      cmd === 'git' &&
      args.some(
        (a) =>
          a.startsWith('--exec=') ||
          a.startsWith('--upload-pack=') ||
          a.startsWith('--receive-pack=') ||
          a === '--exec' ||
          a === '--upload-pack' ||
          a === '--receive-pack',
      ),
    reason: 'git with --exec/--upload-pack/--receive-pack (runs arbitrary code)',
  },
  // ----- Windows: format / diskpart / bcdedit -----
  {
    id: 'win32-format',
    level: 'destructive',
    test: (cmd) => cmd === 'format' || cmd === 'format.exe',
    reason: 'format (Windows disk format)',
  },
  {
    id: 'win32-diskpart',
    level: 'destructive',
    test: (cmd) => cmd === 'diskpart' || cmd === 'diskpart.exe',
    reason: 'diskpart (Windows partition editor)',
  },
  {
    id: 'win32-bcdedit',
    level: 'destructive',
    test: (cmd) => cmd === 'bcdedit' || cmd === 'bcdedit.exe',
    reason: 'bcdedit (Windows boot config editor)',
  },
  // ----- mkfs family -----
  {
    id: 'mkfs',
    level: 'destructive',
    test: (cmd) => /^mkfs(\.[a-z0-9]+)?$/.test(cmd) || cmd === 'mkswap',
    reason: 'mkfs (filesystem creation — destroys existing data)',
  },
  // ----- dd writing to a block device -----
  {
    id: 'dd-to-block-device',
    level: 'destructive',
    test: (cmd, args) => {
      if (cmd !== 'dd') return false;
      return args.some(
        (a) => /of=\/dev\/(sd|hd|nvme|vd|mmcblk|xvd|loop|disk)/.test(a),
      );
    },
    reason: 'dd writing to a block device',
  },
  // ----- Secure-erase tools -----
  {
    id: 'shred',
    level: 'destructive',
    test: (cmd) => cmd === 'shred' || cmd === 'shred.exe',
    reason: 'shred (secure file delete)',
  },
  {
    id: 'wipefs',
    level: 'destructive',
    test: (cmd) => cmd === 'wipefs' || cmd === 'wipefs.exe',
    reason: 'wipefs (signature wipe — destroys filesystem headers)',
  },
  {
    id: 'sdelete',
    level: 'destructive',
    test: (cmd) => cmd === 'sdelete' || cmd === 'sdelete.exe',
    reason: 'sdelete (Sysinternals secure delete)',
  },
];

/**
 * Evaluate the danger level of a (cmd, args) pair.
 *
 * Returns 'safe' if no rule fires, otherwise the highest level among all
 * matching rules. The 'matchedRule' field is the *last* rule that fired
 * (stable, since rules are evaluated in declaration order).
 *
 * This function is the single source of truth for danger classification;
 * it is pure (no side effects) and unit-tested in `danger-detect.test.ts`.
 */
export function detectDanger(cmd: string, args: readonly string[]): DangerAssessment {
  const reasons: string[] = [];
  let level: DangerLevel = 'safe';
  let matchedRule: string | undefined;

  for (const rule of RULES) {
    if (!rule.test(cmd, args)) continue;
    reasons.push(rule.reason);
    matchedRule = rule.id;
    if (levelRank(rule.level) > levelRank(level)) {
      level = rule.level;
    }
  }

  if (level === 'safe') return { level: 'safe', reasons: [] };
  // matchedRule is set above (last winning rule). For exactOptionalPropertyTypes
  // we build the object conditionally so the property is omitted when undefined.
  const result: DangerAssessment = { level, reasons };
  if (matchedRule !== undefined) result.matchedRule = matchedRule;
  return result;
}

function levelRank(level: DangerLevel): number {
  switch (level) {
    case 'safe':
      return 0;
    case 'caution':
      return 1;
    case 'destructive':
      return 2;
  }
}

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
 *   - Per-rule `id` so config can override specific rules via
 *     `tools.exec.danger.bypass`.
 *   - Reasons are human-readable, joined with "; " for the confirm prompt.
 *
 * Caution rules are deliberately permissive — they execute and emit a
 * warning rather than blocking. The rationale: many of these patterns
 * (python -c, sudo) are part of legitimate dev workflows,
 * so a hard deny would block too much. A warning gives the user a
 * chance to notice "wait, I didn't mean to do that" without forcing
 * them to add a config override for every script.
 */

export type DangerLevel = 'safe' | 'caution' | 'destructive';

export interface DangerAssessment {
  level: DangerLevel;
  reasons: string[];
  /** Stable id of the matched rule, for tests and config-override. */
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
 * (and whether the letters are joined into one token or split across
 * separate `-x` tokens) does not matter. We accumulate every short-flag
 * letter seen across all args, then check the required letters are all
 * present somewhere in that set.
 */
const hasShortFlags = (args: readonly string[], letters: string): boolean => {
  const seen = new Set<string>();
  for (const a of args) {
    if (!/^-[a-zA-Z]+$/.test(a)) continue;
    for (const ch of a.slice(1)) seen.add(ch);
  }
  return letters.split('').every((l) => seen.has(l));
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
    test: (cmd, args) => (cmd === 'rm' || cmd === 'rmdir') && hasShortFlags(args, 'rf'),
    reason: 'recursive force-delete',
  },
  // ----- Windows PowerShell Remove-Item: -Recurse -Force -----
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
  // ----- Windows PowerShell Disk & Volume destruction -----
  {
    id: 'powershell-disk-volume-destroy',
    level: 'destructive',
    test: (cmd, args) => {
      if (cmd !== 'powershell' && cmd !== 'pwsh') return false;
      return args.some((a) =>
        /^(?:Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition|Clear-Volume)(?:\s|$)/i.test(a),
      );
    },
    reason: 'PowerShell disk/volume partition destruction',
  },
  // ----- Windows PowerShell System Restart / Shutdown -----
  {
    id: 'powershell-stop-restart-computer',
    level: 'destructive',
    test: (cmd, args) => {
      if (cmd !== 'powershell' && cmd !== 'pwsh') return false;
      return args.some((a) => /^(?:Stop-Computer|Restart-Computer)(?:\s|$)/i.test(a));
    },
    reason: 'PowerShell system shutdown or restart',
  },
  // ----- Windows PowerShell ExecutionPolicy / Payload evasion -----
  {
    id: 'powershell-execution-policy-bypass',
    level: 'caution',
    test: (cmd, args) => {
      if (cmd !== 'powershell' && cmd !== 'pwsh') return false;
      return args.some((a) =>
        /Set-ExecutionPolicy\s+(?:Bypass|Unrestricted)|-(?:EncodedCommand|enc)\b/i.test(a),
      );
    },
    reason: 'PowerShell execution policy bypass or encoded command',
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
      return args.some((a) => /of=\/dev\/(sd|hd|nvme|vd|mmcblk|xvd|loop|disk)/.test(a));
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
  // ----- VCS history rewrite (destructive) -----
  // `git push --force` / `-f` rewrites remote history. `--force-with-lease`
  // is the safer variant (checks remote hasn't moved) but still rewrites.
  {
    id: 'git-push-force',
    level: 'destructive',
    test: (cmd, args) => {
      if (cmd !== 'git') return false;
      const pushIdx = args.indexOf('push');
      if (pushIdx < 0) return false;
      for (let i = pushIdx + 1; i < args.length; i++) {
        const a = args[i]!;
        if (a === '--force' || a === '-f' || a === '--force-with-lease') return true;
        if (!a.startsWith('-') && !a.includes('=')) continue;
        if (a.startsWith('--force') /* covers --force-with-lease already */) return true;
      }
      return false;
    },
    reason: 'git push with --force / -f (rewrites remote history)',
  },
  // ----- git reset --hard (destructive) -----
  {
    id: 'git-reset-hard',
    level: 'destructive',
    test: (cmd, args) =>
      cmd === 'git' && args.some((a) => a === '--hard' || a.startsWith('--hard=')),
    reason: 'git reset --hard (discards working tree + index)',
  },
  // ----- git clean -f / -fd (destructive) -----
  {
    id: 'git-clean-force',
    level: 'destructive',
    test: (cmd, args) => {
      if (cmd !== 'git') return false;
      const cleanIdx = args.indexOf('clean');
      if (cleanIdx < 0) return false;
      // Must include -f / --force (without it, git clean errors out and
      // does nothing). -fd / -fdX combinations are subsumed.
      return args
        .slice(cleanIdx + 1)
        .some(
          (a) =>
            a === '-f' ||
            a === '--force' ||
            a.startsWith('-f') /* -fd, -fdx, etc. */ ||
            a.startsWith('--force='),
        );
    },
    reason: 'git clean -f (deletes untracked files)',
  },
  // ----- package publish (destructive — public, irreversible) -----
  {
    id: 'npm-publish',
    level: 'destructive',
    test: (cmd, args) => {
      if (!['npm', 'pnpm', 'yarn', 'bun', 'cargo'].includes(cmd)) return false;
      // For npm/pnpm/yarn/bun: subcommand is "publish".
      // For cargo: subcommand is "publish" OR "yank" (both touch the
      // public registry; yank is reversible, publish is not, but yank
      // is rare enough we treat it the same).
      return args.includes('publish') || (cmd === 'cargo' && args.includes('yank'));
    },
    reason: 'publishing to a public package registry (hard to reverse)',
  },
  // ----- k8s cluster-wide destructive ops (destructive) -----
  {
    id: 'kubectl-delete-namespace',
    level: 'destructive',
    test: (cmd, args) => {
      if (cmd !== 'kubectl') return false;
      const delIdx = args.indexOf('delete');
      if (delIdx < 0) return false;
      // Match `kubectl delete namespace <name>` or `kubectl delete ns <name>`.
      // Generic `kubectl delete pod foo` is left out — too common.
      const after = args.slice(delIdx + 1);
      return after[0] === 'namespace' || after[0] === 'ns';
    },
    reason: 'kubectl delete namespace (deletes all resources in the namespace)',
  },
  {
    id: 'kubectl-drain',
    level: 'destructive',
    test: (cmd, args) => cmd === 'kubectl' && args.includes('drain'),
    reason: 'kubectl drain (evicts pods, marks node unschedulable)',
  },
  // ----- inline code evaluation (caution — high false-positive) -----
  // Common in scripts: `python -c "..."`, `node -e "..."`, `bash -c "..."`.
  // We tag 'caution' rather than 'destructive' because these are used in
  // many legitimate one-liners (e.g. `python -c "print(1)"`).
  {
    id: 'inline-eval',
    level: 'caution',
    test: (cmd, args) => {
      if (
        ![
          'python',
          'python3',
          'python2',
          'node',
          'bash',
          'sh',
          'zsh',
          'ruby',
          'perl',
          'lua',
        ].includes(cmd)
      ) {
        return false;
      }
      return args.some(
        (a) =>
          a === '-c' ||
          a === '-e' ||
          a === '--eval' ||
          a === '-eval' ||
          a === '-E' /* node --eval shorthand in some shells */,
      );
    },
    reason: 'inline script evaluation (-c / -e / --eval)',
  },
  // ----- pipe-to-shell (destructive — download-and-run pattern) -----
  // The classic `curl https://... | sh` download-and-run vector. Detected by
  // looking for a known fetcher piped into a shell or expression evaluator.
  // A shell command passed through `bash -c` / `pwsh -Command` arrives as one
  // argv string, so scan the reconstructed argv text rather than individual
  // tokens only.
  {
    id: 'pipe-to-shell',
    level: 'destructive',
    test: (cmd, args) =>
      /\b(?:curl|wget|fetch|httpie|http|irm|iwr|Invoke-WebRequest|Invoke-RestMethod)\b[\s\S]{0,300}\|\s*(?:sudo\s+)?(?:sh|bash|zsh|fish|pwsh|powershell|iex|Invoke-Expression)\b/i.test(
        [cmd, ...args].join(' '),
      ),
    reason: 'network fetch piped to a shell (download-and-run pattern)',
  },
  // ----- privilege escalation (caution) -----
  {
    id: 'sudo',
    level: 'caution',
    test: (cmd) => cmd === 'sudo' || cmd === 'doas',
    reason: 'privilege escalation (sudo / doas)',
  },
  {
    id: 'runas',
    level: 'caution',
    test: (cmd) => cmd === 'runas' || cmd === 'runas.exe',
    reason: 'Windows runas (run as different user)',
  },
  // ----- world-writable permissions (caution) -----
  // `chmod 777` is rarely correct. `chmod -R 777` is almost always wrong.
  // We only flag octal modes; symbolic modes like `chmod o+w` are
  // left to the operator's discretion.
  {
    id: 'chmod-world-writable',
    level: 'caution',
    test: (cmd, args) => {
      if (cmd !== 'chmod') return false;
      // Skip symbolic modes: anything starting with [ugoa]=\w or [ugoa]+\w.
      // The only thing we flag is a pure octal mode containing 7 anywhere
      // in the user/group/other triple (e.g. 777, 776, 747, 707).
      return args.some((a) => /^[0-7]{3,4}$/.test(a) && /7/.test(a));
    },
    reason: 'chmod with world-writable octal mode (e.g. 777)',
  },
  // ----- network recon / offensive scanners (caution) -----
  // These tools are purpose-built for network reconnaissance and offensive
  // security. They have legitimate uses in dev (security testing, infra
  // debugging) but their presence in an agent's command stream is worth a
  // caution banner so the user can notice an unexpected scan.
  {
    id: 'network-scanner',
    level: 'caution',
    test: (cmd) =>
      cmd === 'nmap' ||
      cmd === 'masscan' ||
      cmd === 'zmap' ||
      cmd === 'nuclei' ||
      cmd === 'hping3' ||
      cmd === 'naabu' ||
      cmd === 'katana' ||
      cmd === 'amass' ||
      cmd === 'subfinder' ||
      cmd === 'httpx' ||
      cmd === 'rustscan' ||
      cmd === 'zgrab',
    reason: 'network scanner / offensive reconnaissance tool',
  },
  // ----- process termination (caution) -----
  // kill/killall/pkill terminate processes. The exec kill guard
  // (exec-kill-guard.ts) hard-blocks attempts on protected WrongStack
  // processes; this rule adds a caution banner for generic process
  // termination so the user sees a warning even for non-protected targets.
  {
    id: 'process-kill',
    level: 'caution',
    test: (cmd) => cmd === 'kill' || cmd === 'killall' || cmd === 'pkill',
    reason: 'process termination command',
  },
  // ----- shell/interpreter launchers (caution) -----
  // `env bash -c '…'`, `timeout sh`, `nohup perl -e '…'` etc. wrap a child
  // binary that bypasses the allowlist name-gate entirely (the wrapper
  // resolves the child from PATH, not from the allowlist). We flag caution
  // when a known launcher has a shell/interpreter as its target program.
  {
    id: 'shell-launcher',
    level: 'caution',
    test: (cmd, args) => {
      const launchers = [
        'env',
        'timeout',
        'nohup',
        'nice',
        'script',
        'expect',
        'tmux',
        'screen',
        'byobu',
        'dtach',
      ];
      if (!launchers.includes(cmd)) return false;
      const shells = [
        'sh',
        'bash',
        'zsh',
        'fish',
        'python',
        'python3',
        'perl',
        'ruby',
        'node',
        'pwsh',
        'powershell',
        'cmd',
      ];
      // For `env`, the target program is the first arg that isn't VAR=value
      // or a flag. For other launchers, check all args for a shell name.
      if (cmd === 'env') {
        const prog = args.find((a) => !a.includes('=') && !a.startsWith('-'));
        return prog !== undefined && shells.includes(prog);
      }
      return args.some((a) => shells.includes(a));
    },
    reason: 'launcher wrapping a shell/interpreter (bypasses allowlist name-gate)',
  },
];

/**
 * Evaluate the danger level of a (cmd, args) pair.
 *
 * Returns 'safe' if no rule fires, otherwise the highest level among all
 * matching rules. The 'matchedRule' field is the *last* rule that fired
 * (stable, since rules are evaluated in declaration order).
 *
 * Optional `bypass` argument: a set of rule ids that should be SKIPPED
 * even if they would otherwise match. Wired from
 * `config.tools.exec.danger.bypass` (see `ExecDangerConfig` in
 * `@wrongstack/core/src/types/config.ts`). Unknown ids are silently
 * ignored — forward-compat: a rule added in a future version can be
 * referenced before the user upgrades their config schema.
 *
 * This function is the single source of truth for danger classification;
 * it is pure (no side effects) and unit-tested in `danger-detect.test.ts`.
 */
export function detectDanger(
  cmd: string,
  args: readonly string[],
  bypass?: ReadonlySet<string>,
): DangerAssessment {
  const reasons: string[] = [];
  let level: DangerLevel = 'safe';
  let matchedRule: string | undefined;

  for (const rule of RULES) {
    if (bypass?.has(rule.id)) continue;
    if (!rule.test(cmd, args)) continue;
    reasons.push(rule.reason);
    if (matchedRule === undefined || levelRank(rule.level) >= levelRank(level)) {
      matchedRule = rule.id;
    }
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

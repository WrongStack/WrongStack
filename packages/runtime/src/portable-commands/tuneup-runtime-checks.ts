import type { TuneupFinding, TuneupInput } from './tuneup-types.js';

/** A denied command must recur at least this many times to be worth pre-approving. */
const MIN_DENY_COUNT = 2;

/** Session-log bytes above this are worth a prune nudge (~50 MB). */
const LARGE_SESSION_BYTES = 50 * 1024 * 1024;

/**
 * First tokens that make a bash/exec command line safe to auto-approve. Kept
 * deliberately conservative — anything not on this list is left for the user.
 */
const READONLY_VERBS = new Set([
  'ls',
  'cat',
  'pwd',
  'echo',
  'grep',
  'rg',
  'find',
  'head',
  'tail',
  'wc',
  'which',
  'type',
  'tree',
  'stat',
  'du',
  'df',
  'env',
  'printenv',
  'date',
  'whoami',
  'hostname',
  'uname',
  'sort',
  'uniq',
  'cut',
  'awk',
  'sed',
  'diff',
  'realpath',
  'dirname',
  'basename',
]);

/** Shell metacharacters that could turn an otherwise read-only verb destructive. */
const SHELL_WRITE_TOKENS = /[>|;&`$()]|\brm\b|\bmv\b|\bcp\b|--write|--fix|--force|-i\b/;

/** True when `command` is safely read-only by our conservative heuristic. */
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  if (SHELL_WRITE_TOKENS.test(trimmed)) {
    // `git status`/`git log`/`git diff`/`git show` are allowed despite the
    // broad guard, but nothing with redirection or a write subcommand.
    if (!/^git\s+(status|log|diff|show|branch|remote|blame)\b/.test(trimmed)) return false;
    if (/[>|;&`$()]/.test(trimmed)) return false;
  }
  const first = trimmed.split(/\s+/)[0] ?? '';
  if (first === 'git') {
    return /^git\s+(status|log|diff|show|branch|remote|blame)\b/.test(trimmed);
  }
  return READONLY_VERBS.has(first);
}

// ── Item 7: frequently denied read-only commands ─────────────────────────────

export function checkPermissions(input: TuneupInput): TuneupFinding[] {
  const candidates = new Map<string, number>();

  for (const [tool, entry] of Object.entries(input.trust ?? {})) {
    if (tool !== 'bash' && tool !== 'exec') continue;
    for (const pattern of entry.deny ?? []) {
      if (isReadOnlyCommand(pattern)) {
        candidates.set(pattern, Math.max(candidates.get(pattern) ?? 0, MIN_DENY_COUNT));
      }
    }
  }

  for (const { command, count } of input.deniedFromHistory ?? []) {
    if (count >= MIN_DENY_COUNT && isReadOnlyCommand(command)) {
      candidates.set(command, Math.max(candidates.get(command) ?? 0, count));
    }
  }

  if (candidates.size === 0) return [];

  const commandNames = [
    ...new Set([...candidates.keys()].map((c) => c.trim().split(/\s+/)[0] ?? '')),
  ]
    .filter((n) => n.length > 0)
    .sort();

  const sample = [...candidates.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([c, n]) => `  · ${c}${n > MIN_DENY_COUNT ? ` (denied ${n}×)` : ''}`)
    .join('\n');

  return [
    {
      category: 'permissions',
      severity: 'info',
      problem: `${candidates.size} read-only command(s) keep getting denied/prompted.`,
      suggestion: `They look safe to pre-approve:\n${sample}`,
      fix: `add ${commandNames.join(', ')} to tools.exec.allow`,
      action: { kind: 'add-exec-allow', commands: commandNames },
    },
  ];
}

// ── Performance knobs ────────────────────────────────────────────────────────

export function checkPerformance(input: TuneupInput): TuneupFinding[] {
  const { config, env } = input;
  const findings: TuneupFinding[] = [];

  // Fallback recovery: `fallbackAuto` defaults on; only flag an explicit opt-out
  // with no manual chain, which leaves 429s un-recovered.
  if (config.fallbackAuto === false && (config.fallbackModels?.length ?? 0) === 0) {
    findings.push({
      category: 'performance',
      severity: 'warning',
      problem:
        'Automatic fallback is off and no fallback chain is configured — a 429 will just fail.',
      suggestion: 'Re-enable the auto chain so rate-limits recover to another keyed model.',
      fix: 'set fallbackAuto = true',
      action: {
        kind: 'set-config',
        path: ['fallbackAuto'],
        value: true,
        label: 'automatic fallback re-enabled',
      },
    });
  }

  // Adaptive concurrency: safe to enable — it only reacts to 429s.
  if (config.adaptiveConcurrency?.enabled !== true) {
    findings.push({
      category: 'performance',
      severity: 'info',
      problem: 'Adaptive concurrency is off — maxConcurrent will not back off on rate-limits.',
      suggestion: 'Enable it to auto-tune concurrency on 429s and recover on sustained success.',
      fix: 'set adaptiveConcurrency.enabled = true',
      action: {
        kind: 'set-config',
        path: ['adaptiveConcurrency', 'enabled'],
        value: true,
        label: 'adaptive concurrency enabled',
      },
    });
  }

  // Circuit breaker: advisory only — enabling it can block bash on failures.
  if (config.circuitBreaker?.enabled !== true) {
    findings.push({
      category: 'performance',
      severity: 'info',
      problem: 'The process circuit-breaker is off — repeated bash/exec failures are not gated.',
      suggestion: 'Turn it on with `/settings breaker on` for bash-heavy or flaky workflows.',
    });
  }

  // Codebase index: only nag when the user explicitly disabled the default-on run.
  if (config.indexing && config.indexing.onSessionStart === false) {
    findings.push({
      category: 'performance',
      severity: 'info',
      problem:
        'Session-start codebase indexing is disabled — symbol search/navigation is degraded.',
      suggestion: 'Re-enable `indexing.onSessionStart` for faster, index-backed code navigation.',
    });
  }

  // maxConcurrent sanity relative to CPU count.
  const cpu = env?.cpuCount;
  const mc = config.maxConcurrent;
  if (typeof mc === 'number' && mc > 0 && typeof cpu === 'number' && cpu > 0 && mc > cpu * 4) {
    findings.push({
      category: 'performance',
      severity: 'info',
      problem: `maxConcurrent is ${mc} on a ${cpu}-core host — likely oversubscribed.`,
      suggestion: `Consider lowering it toward ${cpu * 2} (or enable adaptive concurrency).`,
    });
  }

  return findings;
}

// ── Reliability / hygiene ────────────────────────────────────────────────────

export function checkReliability(input: TuneupInput): TuneupFinding[] {
  const { config, env } = input;
  const findings: TuneupFinding[] = [];

  if (config.session?.auditLevel === 'minimal') {
    findings.push({
      category: 'reliability',
      severity: 'info',
      problem:
        'Session audit level is "minimal" — tool timing, retries, and errors are not logged.',
      suggestion: 'Use "standard" (the default) if you want richer post-hoc diagnostics.',
    });
  }

  if (env?.vaultHardened === false) {
    findings.push({
      category: 'reliability',
      severity: 'info',
      problem: 'The secret vault key is stored in the clear (no at-rest passphrase).',
      suggestion:
        'Set `WRONGSTACK_VAULT_PASSPHRASE` to wrap the data key (scrypt + AES-256-GCM); existing secrets migrate automatically.',
    });
  }

  if (typeof env?.sessionBytes === 'number' && env.sessionBytes > LARGE_SESSION_BYTES) {
    findings.push({
      category: 'reliability',
      severity: 'info',
      problem: `Session logs for this project are large (${(env.sessionBytes / (1024 * 1024)).toFixed(0)} MB).`,
      suggestion: 'Run `/prune` to trim old sessions and reclaim disk.',
    });
  }

  return findings;
}

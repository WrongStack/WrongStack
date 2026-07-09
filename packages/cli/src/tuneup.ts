/**
 * Tune-up engine — deterministic health, context-cost, and performance checks
 * for a WrongStack session, mapping the "clean up + speed up your setup" idea
 * onto WrongStack's own config knobs and subsystems.
 *
 * Pure module: none of these functions touch the filesystem, the network, or
 * live registries. The `/tuneup` slash command owns all IO (reading config,
 * skills, memory files, the trust file, the update check, disk sizes) and
 * applies the writes; this engine only turns already-loaded data into findings.
 * That keeps it trivially unit-testable, exactly like `config-doctor.ts`.
 *
 * Every finding may carry:
 *   - `action`  — a structured, deterministic fix the command applies on
 *                 `/tuneup fix`. Actions gated by `input.power` are only
 *                 emitted for the explicit `/tuneup fix --power` profile so a
 *                 plain tune-up never silently makes the agent autonomous.
 *   - `handoff` — a line folded into an agent follow-up turn for the fuzzy,
 *                 judgement-heavy items (instruction-file dedup / split).
 */

import type { Config } from '@wrongstack/core';
import type { UpdateInfo } from './update-check.js';

export type TuneupSeverity = 'error' | 'warning' | 'info' | 'ok';

/** Stable check-group ids — one section per group in the rendered report. */
export type TuneupCategory =
  | 'version'
  | 'autonomy'
  | 'skills'
  | 'mcp'
  | 'plugins'
  | 'memory'
  | 'hooks'
  | 'permissions'
  | 'performance'
  | 'reliability'
  | 'config';

/**
 * A structured, deterministic repair the command knows how to apply.
 * `set-config` is the generic one — a dot-path into the global config plus the
 * value to set — so most knobs need no bespoke apply logic.
 */
export type TuneupAction =
  | { kind: 'set-config'; path: string[]; value: unknown; label: string }
  | { kind: 'add-exec-allow'; commands: string[] }
  | { kind: 'normalize-hook-timeout'; event: string; index: number; timeoutMs: number };

export interface TuneupFinding {
  category: TuneupCategory;
  severity: TuneupSeverity;
  /** One-line problem statement. */
  problem: string;
  /** Optional human hint about the recommended action. */
  suggestion?: string | undefined;
  /** Present when a deterministic auto-fix exists; short description shown in the report. */
  fix?: string | undefined;
  /** Machine-readable descriptor the command applies on `/tuneup fix`. */
  action?: TuneupAction | undefined;
  /** A line folded into the agent follow-up turn (fuzzy items with no mechanical fix). */
  handoff?: string | undefined;
}

/** A discovered skill, reduced to what the checks need. */
export interface TuneupSkill {
  name: string;
  source: string;
  /** Body length in chars, when the command could read it (best-effort). */
  bodyChars?: number | undefined;
}

/** Live MCP server status, reduced from `mcpRegistry.describe()`. */
export interface TuneupMcpServer {
  name: string;
  state: string;
  enabled: boolean;
  toolCount: number;
}

/** An instruction/memory file layer to compare + size-check. */
export interface TuneupMemoryFile {
  /** Human label, e.g. "user memory" or "project AGENTS.md". */
  label: string;
  path: string;
  content: string;
  /** True for committed/shared layers (project AGENTS.md, root CLAUDE.md). */
  committed: boolean;
}

/** The persistent permission trust file, `~/.wrongstack/projects/<hash>/trust.json`. */
export type TuneupTrustPolicy = Record<
  string,
  { allow?: string[] | undefined; deny?: string[] | undefined; auto?: boolean | undefined }
>;

/** Ambient facts the command precomputes (host / disk / env) for the checks. */
export interface TuneupEnv {
  /** Logical CPU count, for the maxConcurrent sanity check. */
  cpuCount?: number | undefined;
  /** Number of configured providers, for the fallback-chain check. */
  providerCount?: number | undefined;
  /** Whether the secret vault is passphrase-hardened at rest. */
  vaultHardened?: boolean | undefined;
  /** Total bytes of on-disk session logs for this project (disk-hygiene check). */
  sessionBytes?: number | undefined;
}

export interface TuneupInput {
  config: Config;
  skills: TuneupSkill[];
  /** `config.skills.eagerMaxChars` or its default. */
  eagerMaxChars: number;
  skillMode: 'eager' | 'progressive';
  /** Live MCP status when the host wired `mcpStatus`; undefined → skip live MCP checks. */
  mcp?: TuneupMcpServer[] | undefined;
  /** Instruction-file layers (user memory, project AGENTS.md, root CLAUDE.md/AGENTS.md). */
  memoryFiles: TuneupMemoryFile[];
  /** Self-update info (from `checkForUpdate`), when the version check ran. */
  update?: UpdateInfo | undefined;
  /** Parsed trust file, when present. */
  trust?: TuneupTrustPolicy | undefined;
  /**
   * Denied read-only commands mined from session history (optional richer
   * signal). Each entry is a command line and how many times it was denied.
   */
  deniedFromHistory?: Array<{ command: string; count: number }> | undefined;
  /** Ambient host/disk facts. */
  env?: TuneupEnv | undefined;
  /** Count of `/doctor`-style config issues (from `diagnoseConfig`). */
  configIssues?: number | undefined;
  /**
   * Power profile: `/tuneup fix --power`. Gates the autonomy/yolo/director
   * actions so a plain tune-up never flips them (respects the user-owned
   * autonomy invariant).
   */
  power?: boolean | undefined;
}

export interface TuneupReport {
  findings: TuneupFinding[];
  /** Composed agent follow-up prompt for fuzzy items; empty when none. */
  agentHandoff: string;
}

/** Default eager skill-body budget (mirrors `SkillsConfig.eagerMaxChars`). */
export const DEFAULT_EAGER_MAX_CHARS = 24_000;

/** timeoutMs at/above this is treated as a potentially slow hook. */
const SLOW_HOOK_TIMEOUT_MS = 10_000;
/** A single event with more than this many shell hooks is flagged as heavy. */
const MANY_HOOKS_PER_EVENT = 4;
/** Root instruction files larger than this (chars) are candidates for splitting. */
const LARGE_INSTRUCTION_CHARS = 12_000;
/** …or longer than this many lines. */
const LARGE_INSTRUCTION_LINES = 400;
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

// ── Item 1: unused skills / MCP / plugins ────────────────────────────────────

export function checkSkills(input: TuneupInput): TuneupFinding[] {
  const { skills, skillMode, eagerMaxChars } = input;
  if (skills.length === 0) return [];
  const findings: TuneupFinding[] = [];

  const knownChars = skills.filter((s) => typeof s.bodyChars === 'number');
  const totalChars = knownChars.reduce((n, s) => n + (s.bodyChars ?? 0), 0);
  const approxTokens = Math.round(totalChars / 4);

  if (skillMode === 'eager' && knownChars.length > 0 && totalChars > eagerMaxChars) {
    findings.push({
      category: 'skills',
      severity: 'warning',
      problem: `${skills.length} skills (~${approxTokens.toLocaleString()} tokens of bodies) exceed the eager inject budget (${eagerMaxChars.toLocaleString()} chars).`,
      suggestion:
        'Switch to progressive mode so bodies load on demand, or raise `skills.eagerMaxChars` — every eager skill body is spent on every request.',
      fix: 'set skills.mode = "progressive"',
      action: {
        kind: 'set-config',
        path: ['skills', 'mode'],
        value: 'progressive',
        label: 'skills now load progressively (bodies on demand)',
      },
    });
  }

  const foreign = skills.filter((s) => s.source === 'foreign' || s.source.startsWith('claude-'));
  if (foreign.length > 0 && skillMode === 'eager') {
    findings.push({
      category: 'skills',
      severity: 'info',
      problem: `${foreign.length} of ${skills.length} skills come from foreign coding-agent dirs (.claude / other tools).`,
      suggestion:
        'If you do not use them, set `skills.readClaudeSkills: false` / `skills.foreignSources: false` to stop injecting them into the prompt.',
    });
  }

  return findings;
}

export function checkMcp(input: TuneupInput): TuneupFinding[] {
  const findings: TuneupFinding[] = [];

  const configured = input.config.mcpServers ?? {};
  for (const [name, cfg] of Object.entries(configured)) {
    if (cfg && typeof cfg === 'object' && (cfg as { enabled?: boolean }).enabled === false) {
      findings.push({
        category: 'mcp',
        severity: 'info',
        problem: `MCP server "${name}" is configured but disabled.`,
        suggestion: `Remove it from \`mcpServers\` if you no longer use it (\`/mcp remove ${name}\`).`,
      });
    }
  }

  for (const s of input.mcp ?? []) {
    if (s.state === 'failed') {
      findings.push({
        category: 'mcp',
        severity: 'warning',
        problem: `MCP server "${s.name}" failed to connect (reconnect cycles exhausted).`,
        suggestion: `Fix its command/URL or remove it — it contributes no tools but is retried on boot (\`/mcp restart ${s.name}\` / \`/mcp remove ${s.name}\`).`,
      });
    }
  }

  return findings;
}

export function checkPlugins(input: TuneupInput): TuneupFinding[] {
  const plugins = input.config.plugins ?? [];
  const findings: TuneupFinding[] = [];
  for (const p of plugins) {
    if (typeof p === 'object' && p.enabled === false) {
      findings.push({
        category: 'plugins',
        severity: 'info',
        problem: `Plugin "${p.name}" is listed but disabled.`,
        suggestion:
          'A disabled plugin still sits in your config. Remove the entry if you have no plans to re-enable it.',
      });
    }
  }
  return findings;
}

// ── Item 2 + 3: instruction-file dedup + oversize ────────────────────────────

function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

function isSignificantLine(line: string): boolean {
  const n = normalizeLine(line);
  if (n.length < 24) return false;
  if (/^[#>*\-=_|`]+$/.test(n)) return false; // pure markdown structure
  return true;
}

export function checkMemoryDedup(input: TuneupInput): TuneupFinding[] {
  const files = input.memoryFiles.filter((f) => f.content.trim().length > 0);
  if (files.length < 2) return [];

  const lineToFiles = new Map<string, Set<string>>();
  for (const f of files) {
    const seen = new Set<string>();
    for (const raw of f.content.split(/\r?\n/)) {
      if (!isSignificantLine(raw)) continue;
      const key = normalizeLine(raw);
      if (seen.has(key)) continue;
      seen.add(key);
      const set = lineToFiles.get(key) ?? new Set<string>();
      set.add(f.label);
      lineToFiles.set(key, set);
    }
  }

  const dupes = [...lineToFiles.entries()].filter(([, set]) => set.size >= 2);
  if (dupes.length === 0) return [];

  const sample = dupes
    .slice(0, 3)
    .map(([line]) => `  · ${line.length > 72 ? `${line.slice(0, 69)}…` : line}`)
    .join('\n');

  return [
    {
      category: 'memory',
      severity: 'warning',
      problem: `${dupes.length} instruction line(s) are duplicated across your memory/instruction files.`,
      suggestion:
        'Keep each fact in one layer (committed project AGENTS.md for shared rules, personal memory for personal ones). Duplicates cost prompt tokens on every turn.',
      handoff: `De-duplicate instruction files. These lines appear in more than one of ${files.map((f) => f.label).join(', ')}:\n${sample}\nRemove each duplicate from the more local / less-authoritative layer, keeping the shared/committed copy.`,
    },
  ];
}

export function checkMemorySize(input: TuneupInput): TuneupFinding[] {
  const findings: TuneupFinding[] = [];
  for (const f of input.memoryFiles) {
    const chars = f.content.length;
    const lines = f.content.split(/\r?\n/).length;
    if (chars > LARGE_INSTRUCTION_CHARS || lines > LARGE_INSTRUCTION_LINES) {
      findings.push({
        category: 'memory',
        severity: 'info',
        problem: `${f.label} is large (${chars.toLocaleString()} chars, ${lines} lines) — it is spent on every request.`,
        suggestion:
          'Split rarely-needed detail into a skill (load-on-demand) or a nested per-directory instruction file, keeping the root lean.',
        handoff: `${f.label} (${f.path}) is ${chars} chars / ${lines} lines. Propose how to break it up: move stable, rarely-needed sections into skills or nested instruction files so the always-loaded root stays small. Do not delete anything without confirmation.`,
      });
    }
  }
  return findings;
}

// ── Item 4: slow hooks ───────────────────────────────────────────────────────

export function checkHooks(input: TuneupInput): TuneupFinding[] {
  const hooks = input.config.hooks;
  if (!hooks) return [];
  const findings: TuneupFinding[] = [];

  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list) || list.length === 0) continue;

    if (list.length > MANY_HOOKS_PER_EVENT) {
      findings.push({
        category: 'hooks',
        severity: 'info',
        problem: `${event} runs ${list.length} shell hooks — each blocks the turn until it returns.`,
        suggestion: 'Consolidate or drop hooks you no longer need to keep turns snappy.',
      });
    }

    list.forEach((hook, index) => {
      const timeoutMs = hook.timeoutMs;
      if (typeof timeoutMs === 'number' && timeoutMs >= SLOW_HOOK_TIMEOUT_MS) {
        findings.push({
          category: 'hooks',
          severity: 'warning',
          problem: `${event} hook #${index + 1} allows up to ${(timeoutMs / 1000).toFixed(0)}s (\`${previewCommand(hook.command)}\`).`,
          suggestion:
            'A slow hook stalls every matching tool call. Lower the timeout or disable the hook.',
          fix: `clamp timeout to ${SLOW_HOOK_TIMEOUT_MS / 1000}s`,
          action: { kind: 'normalize-hook-timeout', event, index, timeoutMs: SLOW_HOOK_TIMEOUT_MS },
        });
      }
    });
  }

  return findings;
}

function previewCommand(command: string): string {
  const one = command.replace(/\s+/g, ' ').trim();
  return one.length > 48 ? `${one.slice(0, 45)}…` : one;
}

// ── Item 5: version ──────────────────────────────────────────────────────────

export function checkVersion(input: TuneupInput): TuneupFinding[] {
  const info = input.update;
  if (!info) return [];
  if (info.outdated) {
    return [
      {
        category: 'version',
        severity: 'warning',
        problem: `A newer WrongStack is available: v${info.current} → v${info.latest}.`,
        suggestion: 'Run `wrongstack update` (or your package manager) to upgrade.',
      },
    ];
  }
  if (info.checkFailed) return [];
  return [{ category: 'version', severity: 'ok', problem: `Up to date (v${info.current}).` }];
}

// ── Item 6: auto mode default (power-gated action) ───────────────────────────

export function checkAutonomy(input: TuneupInput): TuneupFinding[] {
  const mode = input.config.autonomy?.defaultMode;
  if (mode === 'auto') {
    return [{ category: 'autonomy', severity: 'ok', problem: 'Auto mode is the startup default.' }];
  }
  const finding: TuneupFinding = {
    category: 'autonomy',
    severity: 'info',
    problem: `Startup autonomy default is "${mode ?? 'off'}", not "auto".`,
    suggestion: input.power
      ? 'Auto mode lets sessions self-drive between turns.'
      : 'Auto mode lets sessions self-drive. Run `/tuneup fix --power` to enable it.',
  };
  // Only the explicit power profile writes autonomy — never a plain tune-up.
  if (input.power) {
    finding.fix = 'set autonomy.defaultMode = "auto"';
    finding.action = {
      kind: 'set-config',
      path: ['autonomy', 'defaultMode'],
      value: 'auto',
      label: 'auto mode is now the startup default',
    };
  }
  return [finding];
}

/** Power-only: yolo + director launch defaults (explicit `--power` opt-in). */
export function checkPowerProfile(input: TuneupInput): TuneupFinding[] {
  if (!input.power) return [];
  const findings: TuneupFinding[] = [];

  if (input.config.yolo !== true) {
    findings.push({
      category: 'autonomy',
      severity: 'info',
      problem: 'YOLO mode (auto-approve tool calls) is off.',
      suggestion: 'Power profile enables it so the agent stops asking to run each tool.',
      fix: 'set yolo = true',
      action: { kind: 'set-config', path: ['yolo'], value: true, label: 'YOLO mode enabled' },
    });
  }

  if (input.config.launch?.director !== true) {
    findings.push({
      category: 'autonomy',
      severity: 'info',
      problem: 'Director mode does not start by default.',
      suggestion: 'Power profile launches with the fleet director + multi-agent orchestration on.',
      fix: 'set launch.director = true',
      action: {
        kind: 'set-config',
        path: ['launch', 'director'],
        value: true,
        label: 'director mode starts on next launch',
      },
    });
  }

  return findings;
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
      problem: 'Session audit level is "minimal" — tool timing, retries, and errors are not logged.',
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

// ── /doctor integration ──────────────────────────────────────────────────────

export function checkConfigDoctor(input: TuneupInput): TuneupFinding[] {
  const n = input.configIssues ?? 0;
  if (n <= 0) return [];
  return [
    {
      category: 'config',
      severity: 'warning',
      problem: `${n} config issue(s) detected in the global config.`,
      suggestion: 'Run `/doctor fix` to repair field types, enums, and shape problems.',
    },
  ];
}

// ── Composition ──────────────────────────────────────────────────────────────

/** Run every check and compose the report + agent hand-off text. */
export function runTuneup(input: TuneupInput): TuneupReport {
  const findings: TuneupFinding[] = [
    ...checkVersion(input),
    ...checkAutonomy(input),
    ...checkPowerProfile(input),
    ...checkSkills(input),
    ...checkMcp(input),
    ...checkPlugins(input),
    ...checkMemoryDedup(input),
    ...checkMemorySize(input),
    ...checkHooks(input),
    ...checkPermissions(input),
    ...checkPerformance(input),
    ...checkReliability(input),
    ...checkConfigDoctor(input),
  ];

  const handoffLines = findings.map((f) => f.handoff).filter((h): h is string => !!h);
  const agentHandoff =
    handoffLines.length === 0
      ? ''
      : `The /tuneup checkup flagged instruction-file issues that need judgement. Address each, asking me before deleting anything:\n\n${handoffLines.map((h, i) => `${i + 1}. ${h}`).join('\n\n')}`;

  return { findings, agentHandoff };
}

/**
 * Build the rich follow-up prompt for `/tuneup deep` — hands the agent the live
 * findings and asks for a project-specific optimization plan (the non-mechanical
 * tier). Kept here so it is unit-testable alongside the checks.
 */
export function buildDeepPrompt(report: TuneupReport): string {
  const lines = report.findings
    .filter((f) => f.severity !== 'ok')
    .map((f) => `- [${f.category}] ${f.problem}`)
    .join('\n');
  return [
    'Act as a WrongStack optimization consultant. Using the tune-up findings below',
    'plus a look at this project (its stack, size, and how it is used), produce a',
    'concise, prioritized optimization plan tailored to THIS project.',
    '',
    'For each recommendation give: the change, why it helps here, and the exact',
    'config knob or command to apply it. Call out anything risky. Do NOT change',
    'any files or config yourself — this is a plan for me to approve.',
    '',
    'Tune-up findings:',
    lines || '- (no mechanical findings — focus on higher-level workflow/model/tooling advice)',
  ].join('\n');
}

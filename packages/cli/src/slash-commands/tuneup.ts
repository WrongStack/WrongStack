import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SlashCommand } from '@wrongstack/core';
import { atomicWrite, color } from '@wrongstack/core';
import { diagnoseConfig } from '../config-doctor.js';
import { appendHistory } from '../config-history.js';
import {
  buildDeepPrompt,
  DEFAULT_EAGER_MAX_CHARS,
  runTuneup,
  type TuneupAction,
  type TuneupCategory,
  type TuneupFinding,
  type TuneupInput,
  type TuneupMemoryFile,
  type TuneupSkill,
  type TuneupTrustPolicy,
} from '../tuneup.js';
import { checkForUpdate } from '../update-check.js';
import { parseSubcommand } from './helpers.js';
import type { SlashCommandContext } from './index.js';

/**
 * `/tuneup` (alias `/checkup`) — broad session health, context-cost, and
 * performance checkup.
 *
 * Where `/doctor` repairs the config JSON, `/tuneup` sweeps the wider setup and
 * suggests the config knobs that make a session faster and more resilient.
 * Report-only by default; `/tuneup fix` applies the safe deterministic subset,
 * `/tuneup fix --power` also enables the autonomy/yolo/director profile (explicit
 * opt-in so a plain tune-up never flips those), and `/tuneup deep` hands the
 * findings to the agent for a project-specific optimization plan.
 */
export function buildTuneupCommand(opts: SlashCommandContext): SlashCommand {
  const help = [
    'Usage:',
    '  /tuneup                Run all health checks (read-only report)',
    '  /tuneup fix            Apply safe deterministic fixes',
    '  /tuneup fix --power    …and enable the autonomy/yolo/director profile',
    '  /tuneup fix --pick     Confirm each fix before applying',
    '  /tuneup deep           Hand the findings to the agent for a tailored plan',
    '',
    'Checks: skill/MCP/plugin context cost, duplicated & oversized instruction',
    'files, slow shell hooks, updates, auto-mode default, denied read-only',
    'commands, performance knobs (fallback, adaptive concurrency, indexing), and',
    'reliability (audit level, vault, disk).',
    '',
    'Fix safety: only deterministic config changes are written; the global config',
    'is backed up first (like /doctor). --power is the ONLY path that touches',
    'autonomy/yolo/director. Instruction-file cleanups are handed to the agent,',
    'never auto-deleted.',
  ].join('\n');

  return {
    name: 'tuneup',
    aliases: ['checkup'],
    category: 'Config',
    description: 'Health + performance checkup; /tuneup fix applies safe fixes.',
    argsHint: '[fix [--power] [--pick] | deep]',
    help,
    async run(args) {
      const parsed = parseArgs(args);
      if (parsed.mode === 'help') return { message: help };
      if (parsed.mode === 'usage') {
        return { message: `${color.amber('Usage:')} /tuneup [fix [--power] [--pick] | deep]` };
      }
      if (!opts.paths) {
        return { message: `${color.red('Error')} config paths not available.` };
      }

      const input = await gatherInput(opts, parsed.power);
      const report = runTuneup(input);

      const lines: string[] = [`${color.bold('WrongStack')} ${color.dim('— Tune-up')}`];
      renderFindings(lines, report.findings);

      // Deep mode: read-only report + hand the findings to the agent.
      if (parsed.mode === 'deep') {
        lines.push('', color.dim('  → asking the agent for a project-specific optimization plan…'));
        return { message: lines.join('\n'), runText: buildDeepPrompt(report) };
      }

      if (parsed.mode === 'report') {
        const fixable = report.findings.filter((f) => f.action).length;
        const handoffs = report.findings.filter((f) => f.handoff).length;
        lines.push('', summaryLine(report.findings, fixable, handoffs, parsed.power));
        return { message: lines.join('\n') };
      }

      // Fix mode: collect actions (optionally confirm each), apply, hand off fuzzy items.
      let actions = report.findings
        .map((f) => f.action)
        .filter((a): a is TuneupAction => !!a);

      if (parsed.pick && opts.confirm) {
        const chosen: TuneupAction[] = [];
        for (const f of report.findings) {
          if (!f.action) continue;
          const ok = await opts.confirm(`Apply: ${f.fix ?? f.problem}?`, true);
          if (ok) chosen.push(f.action);
        }
        actions = chosen;
      }

      const applied = await applyActions(actions, opts);

      lines.push('');
      if (applied.messages.length === 0) {
        lines.push(color.dim('  no deterministic fixes to apply'));
      } else {
        for (const m of applied.messages) lines.push(`  ${color.green('✓')} ${m}`);
        if (applied.changed) {
          lines.push(
            `  ${color.green('✓')} written ${color.dim('(backup: config.json.last + timestamped .bak)')}`,
          );
        }
      }

      const runText = report.agentHandoff || undefined;
      if (runText) {
        lines.push('', color.dim('  → handing instruction-file cleanups to the agent…'));
      }
      return { message: lines.join('\n'), ...(runText ? { runText } : {}) };
    },
  };
}

// ── Argument parsing ─────────────────────────────────────────────────────────

interface ParsedArgs {
  mode: 'report' | 'fix' | 'deep' | 'help' | 'usage';
  power: boolean;
  pick: boolean;
}

function parseArgs(args: string): ParsedArgs {
  const { cmd, rest } = parseSubcommand(args);
  const flags = [cmd, ...rest].filter((t) => t.startsWith('--'));
  const profileIdx = rest.indexOf('--profile');
  const profileVal = profileIdx >= 0 ? rest[profileIdx + 1] : undefined;
  const power = flags.includes('--power') || profileVal === 'power';
  const pick = flags.includes('--pick');

  const sub = cmd.startsWith('--') || cmd === '' ? '' : cmd;
  if (sub === 'help' || sub === '--help') return { mode: 'help', power, pick };
  if (sub === 'deep') return { mode: 'deep', power, pick };
  if (sub === 'fix') return { mode: 'fix', power, pick };
  if (sub === '') return { mode: 'report', power, pick };
  return { mode: 'usage', power, pick };
}

// ── Input gathering (all IO lives here) ──────────────────────────────────────

async function gatherInput(opts: SlashCommandContext, power: boolean): Promise<TuneupInput> {
  const config = opts.configStore.get();
  const skillMode: 'eager' | 'progressive' = config.skills?.mode ?? 'eager';
  const eagerMaxChars = config.skills?.eagerMaxChars ?? DEFAULT_EAGER_MAX_CHARS;

  const [skills, memoryFiles, update, trust, configIssues, sessionBytes] = await Promise.all([
    gatherSkills(opts, skillMode),
    gatherMemoryFiles(opts),
    gatherUpdate(),
    gatherTrust(opts),
    gatherConfigIssues(opts),
    gatherSessionBytes(opts),
  ]);

  return {
    config,
    skills,
    eagerMaxChars,
    skillMode,
    mcp: opts.mcpStatus?.(),
    memoryFiles,
    update,
    trust,
    configIssues,
    power,
    env: {
      cpuCount: os.cpus().length,
      providerCount: Object.keys(config.providers ?? {}).length,
      vaultHardened: !!process.env['WRONGSTACK_VAULT_PASSPHRASE'],
      sessionBytes,
    },
  };
}

async function gatherSkills(
  opts: SlashCommandContext,
  skillMode: 'eager' | 'progressive',
): Promise<TuneupSkill[]> {
  const loader = opts.skillLoader;
  if (!loader) return [];
  let manifests: Awaited<ReturnType<typeof loader.list>>;
  try {
    manifests = await loader.list();
  } catch {
    return [];
  }
  if (skillMode !== 'eager') {
    return manifests.map((m) => ({ name: m.name, source: m.source }));
  }
  return Promise.all(
    manifests.map(async (m) => {
      try {
        const body = await loader.readBody(m.name);
        return { name: m.name, source: m.source, bodyChars: body.length };
      } catch {
        return { name: m.name, source: m.source };
      }
    }),
  );
}

async function gatherMemoryFiles(opts: SlashCommandContext): Promise<TuneupMemoryFile[]> {
  const paths = opts.paths;
  if (!paths) return [];
  const candidates: Array<{ label: string; file: string; committed: boolean }> = [
    { label: 'user memory', file: paths.globalMemory, committed: false },
    { label: 'project AGENTS.md', file: paths.inProjectAgentsFile, committed: true },
    { label: 'root CLAUDE.md', file: path.join(opts.projectRoot, 'CLAUDE.md'), committed: true },
    { label: 'root AGENTS.md', file: path.join(opts.projectRoot, 'AGENTS.md'), committed: true },
  ];
  const out: TuneupMemoryFile[] = [];
  for (const c of candidates) {
    try {
      const content = await fs.readFile(c.file, 'utf8');
      out.push({ label: c.label, path: c.file, content, committed: c.committed });
    } catch {
      // missing layer — skip
    }
  }
  return out;
}

async function gatherUpdate(): Promise<TuneupInput['update']> {
  try {
    return await checkForUpdate();
  } catch {
    return undefined;
  }
}

async function gatherTrust(opts: SlashCommandContext): Promise<TuneupTrustPolicy | undefined> {
  const file = opts.paths?.projectTrust;
  if (!file) return undefined;
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as TuneupTrustPolicy;
  } catch {
    // no trust file yet, or unreadable — no permission findings
  }
  return undefined;
}

/** Count `/doctor`-style config issues so /tuneup can point at /doctor fix. */
async function gatherConfigIssues(opts: SlashCommandContext): Promise<number> {
  const file = opts.paths?.globalConfig;
  if (!file) return 0;
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return diagnoseConfig(parsed).findings.length;
  } catch {
    return 0;
  }
}

/** Best-effort total byte size of this project's session logs. */
async function gatherSessionBytes(opts: SlashCommandContext): Promise<number | undefined> {
  const dir = opts.paths?.projectSessions;
  if (!dir) return undefined;
  try {
    return await dirSize(dir);
  } catch {
    return undefined;
  }
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      total += await dirSize(full);
    } else if (e.isFile()) {
      try {
        total += (await fs.stat(full)).size;
      } catch {
        // race with rotation — ignore
      }
    }
  }
  return total;
}

// ── Fix application (writes to the GLOBAL config only) ────────────────────────

interface ApplyResult {
  messages: string[];
  changed: boolean;
}

async function applyActions(
  actions: TuneupAction[],
  opts: SlashCommandContext,
): Promise<ApplyResult> {
  const messages: string[] = [];
  if (actions.length === 0 || !opts.paths) return { messages, changed: false };

  const file = opts.paths.globalConfig;
  let raw = '{}';
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    // no global config yet — start from an empty object
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {
      messages: [`${color.red('✗')} global config is not valid JSON — run /doctor fix first`],
      changed: false,
    };
  }
  const before = JSON.stringify(parsed);

  // Track live-apply intents so a fix takes effect this session, not just next boot.
  let liveYolo = false;
  let liveAutonomyAuto = false;

  for (const action of actions) {
    if (action.kind === 'set-config') {
      setDeep(parsed, action.path, action.value);
      messages.push(action.label);
      if (action.path.length === 1 && action.path[0] === 'yolo' && action.value === true) {
        liveYolo = true;
      }
      if (
        action.path[0] === 'autonomy' &&
        action.path[1] === 'defaultMode' &&
        action.value === 'auto'
      ) {
        liveAutonomyAuto = true;
      }
    } else if (action.kind === 'add-exec-allow') {
      const tools = asRecord(parsed.tools);
      const exec = asRecord(tools.exec);
      const existing = Array.isArray(exec.allow) ? (exec.allow as unknown[]).map(String) : [];
      const merged = [...new Set([...existing, ...action.commands])].sort();
      if (merged.length !== existing.length) {
        exec.allow = merged;
        tools.exec = exec;
        parsed.tools = tools;
        messages.push(`pre-approved: ${action.commands.join(', ')}`);
      }
    } else if (action.kind === 'normalize-hook-timeout') {
      const clamped = clampHookTimeout(parsed, action);
      if (clamped) {
        messages.push(`clamped ${action.event} hook timeout to ${action.timeoutMs / 1000}s`);
      }
    }
  }

  const changed = JSON.stringify(parsed) !== before;
  if (!changed) return { messages, changed: false };

  try {
    await atomicWrite(`${file}.last`, raw);
    await atomicWrite(`${file}.${Date.now()}.bak`, raw);
  } catch {
    // backup is best-effort
  }
  await atomicWrite(file, JSON.stringify(parsed, null, 2));
  try {
    const homeFn = () => path.dirname(path.dirname(file));
    await appendHistory(JSON.parse(raw), parsed, 'tuneup auto-fix', homeFn);
  } catch {
    // history is best-effort
  }
  opts.configStore.update(parsed as never);

  // Live-apply the power toggles through the existing runtime controllers so
  // they take effect immediately (mirrors how /yolo and /autonomy behave).
  if (liveYolo) opts.onYolo?.(true);
  if (liveAutonomyAuto) opts.onAutonomy?.('auto');

  return { messages, changed: true };
}

/** Set a nested value at `path`, creating intermediate objects as needed. */
function setDeep(root: Record<string, unknown>, keys: string[], value: unknown): void {
  let node = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i] as string;
    node[key] = asRecord(node[key]);
    node = node[key] as Record<string, unknown>;
  }
  const last = keys[keys.length - 1];
  if (last !== undefined) node[last] = value;
}

function clampHookTimeout(
  parsed: Record<string, unknown>,
  action: Extract<TuneupAction, { kind: 'normalize-hook-timeout' }>,
): boolean {
  const hooks = parsed.hooks;
  if (!hooks || typeof hooks !== 'object') return false;
  const list = (hooks as Record<string, unknown>)[action.event];
  if (!Array.isArray(list)) return false;
  const hook = list[action.index];
  if (!hook || typeof hook !== 'object') return false;
  const current = (hook as { timeoutMs?: unknown }).timeoutMs;
  if (typeof current === 'number' && current > action.timeoutMs) {
    (hook as Record<string, unknown>).timeoutMs = action.timeoutMs;
    return true;
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// ── Rendering ────────────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<TuneupCategory, string> = {
  version: 'Version',
  autonomy: 'Autonomy',
  skills: 'Skills',
  mcp: 'MCP servers',
  plugins: 'Plugins',
  memory: 'Instruction files',
  hooks: 'Hooks',
  permissions: 'Permissions',
  performance: 'Performance',
  reliability: 'Reliability',
  config: 'Config',
};

const CATEGORY_ORDER: TuneupCategory[] = [
  'version',
  'autonomy',
  'performance',
  'reliability',
  'config',
  'skills',
  'mcp',
  'plugins',
  'memory',
  'hooks',
  'permissions',
];

function severityIcon(severity: TuneupFinding['severity']): string {
  switch (severity) {
    case 'error':
      return color.red('✗');
    case 'warning':
      return color.amber('!');
    case 'ok':
      return color.green('✓');
    default:
      return color.cyan('·');
  }
}

function renderFindings(lines: string[], findings: TuneupFinding[]): void {
  for (const category of CATEGORY_ORDER) {
    const group = findings.filter((f) => f.category === category);
    if (group.length === 0) continue;
    lines.push('', color.bold(CATEGORY_LABELS[category]));
    for (const f of group) {
      lines.push(`  ${severityIcon(f.severity)} ${f.problem}`);
      if (f.suggestion) {
        for (const s of f.suggestion.split('\n')) lines.push(color.dim(`    ${s}`));
      }
      if (f.fix) lines.push(color.dim(`    → fixable: ${f.fix}`));
    }
  }
}

function summaryLine(
  findings: TuneupFinding[],
  fixable: number,
  handoffs: number,
  power: boolean,
): string {
  const warnings = findings.filter((f) => f.severity === 'warning' || f.severity === 'error').length;
  if (warnings === 0 && fixable === 0 && handoffs === 0) {
    return `${color.green('✓')} everything looks healthy`;
  }
  const parts: string[] = [];
  if (warnings > 0) parts.push(`${warnings} warning(s)`);
  if (fixable > 0) parts.push(`${fixable} auto-fixable`);
  if (handoffs > 0) parts.push(`${handoffs} for the agent`);
  const cmd = power ? '/tuneup fix --power' : '/tuneup fix';
  return `${parts.join(', ')} ${color.dim(`— run ${cmd}`)}`;
}

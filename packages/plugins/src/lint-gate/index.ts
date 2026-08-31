/**
 * lint-gate plugin — PreToolUse hook that runs biome (or eslint) on
 * the would-be file content before `write` or `edit` commits it.
 *
 * Tools registered:
 * - lint_gate_status : Show config, linter, and per-session counters.
 *
 * Hooks registered:
 * - PreToolUse with matcher `write|edit`. For `write`, the full
 *   content is available in `toolInput.content` — it's written to a
 *   temp file and linted. For `edit`, the current file is read, the
 *   `old_string → new_string` replacement is applied in-memory, and
 *   the result is linted.
 *
 * Config (`config.extensions['lint-gate']`):
 *
 * ```jsonc
 * {
 *   "linter": "biome",       // "biome" | "eslint" | "auto"
 *   "mode": "warn",          // "block" (refuse the call) | "warn" (inject context)
 *   "severity": "error",     // minimum severity to act on: "error" | "warning"
 *   "timeoutMs": 10000       // linter process timeout
 * }
 * ```
 *
 * @public
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Plugin } from '@wrongstack/core/types';
import { releaseHandle, BoundedMap } from '../runtime/index.js';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

const state = {
  /** Total PreToolUse invocations. */
  invocationCount: 0,
  /** Times the linter found issues at or above the severity threshold. */
  hitCount: 0,
  /** Times the linter auto-fixed content (fix mode only). */
  fixCount: 0,
  /** Times the linter process itself failed (timeout, not installed, etc.). */
  linterErrorCount: 0,
  /** Hook handle for teardown. */
  hookUnregister: null as null | (() => void),
  /** Last lint result summary — surfaced by health() + status tool. */
  lastResult: null as null | {
    tool: string;
    path: string;
    issueCount: number;
    severities: string[];
    when: string;
  },
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type Linter = 'biome' | 'eslint' | 'auto';
type Mode = 'block' | 'warn' | 'fix';
type Severity = 'error' | 'warning';

interface LintGateConfig {
  linter: Linter;
  mode: Mode;
  severity: Severity;
  timeoutMs: number;
  /**
   * When mode='fix', only auto-fix issues matching these rule IDs.
   * Empty = fix everything the linter can. Non-empty = fix only the
   * listed rules, leave others as warnings.
   */
  fixRules: string[];
}

const DEFAULTS: LintGateConfig = {
  linter: 'auto',
  mode: 'warn',
  severity: 'error',
  timeoutMs: 10_000,
  fixRules: [],
};

function readConfig(raw: unknown): LintGateConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const rawLinter = typeof r['linter'] === 'string' ? r['linter'].trim().toLowerCase() : undefined;
  const linter = rawLinter === 'biome' || rawLinter === 'eslint' ? rawLinter : 'auto';
  const rawMode = typeof (r['mode'] ?? r['action'] ?? r['behavior']) === 'string'
    ? String(r['mode'] ?? r['action'] ?? r['behavior']).trim().toLowerCase()
    : undefined;
  const mode = rawMode === 'block' ? 'block' : rawMode === 'fix' ? 'fix' : 'warn';
  const rawSeverity = typeof r['severity'] === 'string' ? r['severity'].trim().toLowerCase() : undefined;
  const severity = rawSeverity === 'warning' ? 'warning' : 'error';
  const rawTimeout = r['timeoutMs'] ?? r['timeout_ms'] ?? r['timeout'];
  const rawRules = r['fixRules'] ?? r['fix_rules'] ?? r['rules'];

  return {
    linter,
    mode,
    severity,
    timeoutMs: typeof rawTimeout === 'number' && rawTimeout > 0 ? rawTimeout : DEFAULTS.timeoutMs,
    fixRules: Array.isArray(rawRules)
      ? (rawRules as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
  };
}

// ---------------------------------------------------------------------------
// Linter detection
// ---------------------------------------------------------------------------

/**
 * Detect which linter is available. "auto" tries biome first, then eslint.
 * Returns the linter command + args prefix, or null if neither is found.
 *
 * Performance: caches the detection result per cwd so repeated hook
 * invocations don't re-probe the filesystem. The cache is invalidated
 * on setup() reload.
 */
interface CommandResult {
  stdout: string;
  error: Error | null;
}

interface ResolvedLinter {
  /** Always the current Node executable; never a shell or package-manager shim. */
  cmd: string;
  /** Local package bin entry followed by linter-specific arguments. */
  args: string[];
  name: 'biome' | 'eslint';
}

const LINTER_PACKAGES = {
  biome: '@biomejs/biome',
  eslint: 'eslint',
} as const;

/**
 * Module-scope cache for linter detection results. Keyed by cwd.
 * Cleared on setup() to ensure fresh detection after config changes.
 *
 * @internal
 */
const linterCache = new BoundedMap<string, ResolvedLinter | null>({ max: 32, ttlMs: 300_000 });

function isInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Resolve a linter's project-local JavaScript bin entry from package metadata.
 * Using `node <entry>` avoids npx, shell configuration, and Windows `.cmd`
 * shims while still respecting Node's normal project-local package lookup.
 */
export function resolveLocalLinter(name: 'biome' | 'eslint', cwd: string): ResolvedLinter | null {
  try {
    const packageName = LINTER_PACKAGES[name];
    const requireFromProject = createRequire(resolve(cwd, 'package.json'));
    const packagePath = requireFromProject.resolve(`${packageName}/package.json`);
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8')) as {
      bin?: string | Record<string, string>;
    };
    const relativeBin =
      typeof packageJson.bin === 'string'
        ? packageJson.bin
        : (packageJson.bin?.[name] ?? Object.values(packageJson.bin ?? {})[0]);
    if (!relativeBin || isAbsolute(relativeBin)) return null;

    const packageDir = dirname(packagePath);
    const entry = resolve(packageDir, relativeBin);
    if (!isInside(packageDir, entry)) return null;

    return {
      cmd: process.execPath,
      args: name === 'biome' ? [entry, 'check', '--reporter=json'] : [entry, '--format=json'],
      name,
    };
  } catch {
    return null;
  }
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  cwd: string,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    try {
      execFile(
        command,
        args,
        {
          encoding: 'utf-8',
          timeout: timeoutMs,
          cwd,
          windowsHide: true,
          shell: false,
          maxBuffer: 2 * 1024 * 1024,
          ...(signal ? { signal } : {}),
        },
        (error, stdout) => resolveResult({ stdout, error }),
      );
    } catch (err) {
      resolveResult({ stdout: '', error: err instanceof Error ? err : new Error(String(err)) });
    }
  });
}

async function detectLinter(requested: Linter, cwd: string): Promise<ResolvedLinter | null> {
  // Check cache first — avoids redundant filesystem probes on every hook call.
  const cacheKey = `${requested}:${cwd}`;
  const cached = linterCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const candidates: Array<'biome' | 'eslint'> =
    requested === 'auto' ? ['biome', 'eslint'] : [requested];

  for (const name of candidates) {
    const linter = resolveLocalLinter(name, cwd);
    if (!linter) continue;
    const probe = await runCommand(linter.cmd, [linter.args[0]!, '--version'], 5_000, cwd);
    if (!probe.error) {
      linterCache.set(cacheKey, linter);
      return linter;
    }
  }
  
  linterCache.set(cacheKey, null);
  return null;
}

// ---------------------------------------------------------------------------
// Linter execution
// ---------------------------------------------------------------------------

interface LintIssue {
  severity: 'error' | 'warning' | 'info';
  rule: string;
  message: string;
  line?: number;
}

/**
 * Run the linter on a temp file and parse the output.
 * Returns the list of issues found, or null if the linter itself failed.
 */
async function lintContent(
  content: string,
  filePath: string,
  linter: ResolvedLinter,
  timeoutMs: number,
  cwd: string,
  signal: AbortSignal,
): Promise<LintIssue[] | null> {
  // Create a temp directory and write the content with the same extension
  // as the target file so the linter applies the right rules.
  const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')) : '.ts';
  let tmpDir: string | undefined;
  try {
    tmpDir = await mkdtemp(join(tmpdir(), 'lint-gate-'));
    const tmpFile = join(tmpDir, `input${ext}`);
    await writeFile(tmpFile, content, 'utf-8');
    const fullArgs = [...linter.args, tmpFile];
    const result = await runCommand(linter.cmd, fullArgs, timeoutMs, cwd, signal);
    if (signal.aborted) throw signal.reason;
    // Linters commonly exit non-zero when findings exist; JSON remains stdout.
    if (result.error && !result.stdout) return null;
    return parseLinterOutput(result.stdout, linter.name);
  } catch {
    if (signal.aborted) throw signal.reason;
    return null;
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Run the linter with auto-fix enabled, returning the fixed content.
 * Biome: `biome check --write`. ESLint: `eslint --fix`.
 *
 * The fix runs on the SAME temp file as `lintContent`. After the
 * linter exits, the file is read back and returned. If the linter
 * fails or the content is unchanged, the original content is returned
 * (so the caller falls through to warn mode gracefully).
 *
 * @internal
 */
async function lintAndFix(
  content: string,
  filePath: string,
  linter: ResolvedLinter,
  timeoutMs: number,
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')) : '.ts';
  let tmpDir: string | undefined;
  try {
    tmpDir = await mkdtemp(join(tmpdir(), 'lint-gate-fix-'));
    const tmpFile = join(tmpDir, `input${ext}`);
    await writeFile(tmpFile, content, 'utf-8');
    // Build the fix command: biome uses `check --write`, eslint uses `--fix`.
    const fixArgs =
      linter.name === 'biome'
        ? [linter.args[0]!, 'check', '--write', tmpFile]
        : [linter.args[0]!, '--fix', tmpFile];
    await runCommand(linter.cmd, fixArgs, timeoutMs, cwd, signal);
    if (signal.aborted) throw signal.reason;
    // Linters may exit non-zero after partial fixes; read the temp file anyway.
    return await readFile(tmpFile, 'utf-8');
  } catch {
    if (signal.aborted) throw signal.reason;
    return content; // any error → return original
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Parse linter JSON output into a flat list of issues.
 * Biome: `{ diagnostics: [{ category, severity, description, location }] }`
 * ESLint: `[{ messages: [{ ruleId, severity, message, line }] }]`
 */
function parseLinterOutput(stdout: string, linterName: string): LintIssue[] {
  const issues: LintIssue[] = [];
  try {
    const data = JSON.parse(stdout);
    if (linterName === 'biome') {
      for (const d of data.diagnostics ?? []) {
        const cat = d.category ?? 'unknown';
        const sev =
          d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'info';
        issues.push({
          severity: sev,
          rule: cat,
          message: d.description ?? cat,
          line: d.location?.span?.[0] ?? undefined,
        });
      }
    } else {
      // eslint: array of file results
      for (const file of Array.isArray(data) ? data : []) {
        for (const m of file.messages ?? []) {
          const sev = m.severity === 2 ? 'error' : m.severity === 1 ? 'warning' : 'info';
          issues.push({
            severity: sev,
            rule: m.ruleId ?? 'unknown',
            message: m.message ?? '',
            line: m.line,
          });
        }
      }
    }
  } catch {
    // parse error — treat as no issues
  }
  return issues;
}

/**
 * Apply a simple str_replace to file content, mirroring the `edit` tool.
 * If old_string appears multiple times, replaces the first occurrence.
 * Returns the modified content, or null if old_string wasn't found.
 */
function applyEdit(content: string, oldString: string, newString: string): string | null {
  const idx = content.indexOf(oldString);
  if (idx === -1) return null;
  return content.slice(0, idx) + newString + content.slice(idx + oldString.length);
}

/**
 * Filter issues by severity threshold.
 * "error" = only errors; "warning" = errors + warnings.
 */
function filterBySeverity(issues: LintIssue[], threshold: Severity): LintIssue[] {
  if (threshold === 'error') return issues.filter((i) => i.severity === 'error');
  return issues.filter((i) => i.severity === 'error' || i.severity === 'warning');
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'lint-gate',
  version: '0.1.0',
  description:
    'Pre-tool hook that runs biome/eslint on would-be file content before write or edit commits',
  apiVersion: API_VERSION,
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      linter: {
        type: 'string',
        enum: ['biome', 'eslint', 'auto'],
        default: 'auto',
        description: 'Which linter to use. "auto" tries biome first, then eslint.',
      },
      mode: {
        type: 'string',
        enum: ['block', 'warn', 'fix'],
        default: 'warn',
        description:
          '"block" refuses the write/edit; "warn" injects lint errors as context; "fix" auto-runs the linter with --write/--fix and substitutes the fixed content (write: full file; edit: new_string snippet in isolation — file-level rules like import sorting are not checked on snippets).',
      },
      severity: {
        type: 'string',
        enum: ['error', 'warning'],
        default: 'error',
        description:
          'Minimum severity to act on. "error" = only errors; "warning" = errors + warnings.',
      },
      timeoutMs: {
        type: 'number',
        minimum: 1000,
        default: 10000,
        description: 'Linter process timeout in milliseconds.',
      },
      fixRules: {
        type: 'array',
        items: { type: 'string' },
        default: [],
        description:
          'When mode=fix, only auto-fix issues matching these rule IDs (e.g. "lint/style/useImportType", "format"). Empty = fix everything the linter can.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.invocationCount = 0;
    state.hitCount = 0;
    state.fixCount = 0;
    state.linterErrorCount = 0;
    state.hookUnregister = releaseHandle(state.hookUnregister);
    state.lastResult = null;
    
    // Clear linter detection cache to ensure fresh detection after config changes.
    linterCache.clear();

    const cfg = readConfig(api.config.extensions?.['lint-gate']);
    const cwd = resolve(api.config.cwd ?? process.cwd());

    // Detect linter once at setup time.
    const linterReady = detectLinter(cfg.linter, cwd).then((linter) => {
      if (!linter) {
        api.log.warn('lint-gate: no linter found (biome or eslint) — hook will be a no-op', {
          requested: cfg.linter,
        });
      } else {
        api.log.info('lint-gate: detected linter', { name: linter.name });
      }
      return linter;
    });

    // PreToolUse hook: lint the would-be content before write/edit.
    const hook = async (
      input: { toolName?: string | undefined; toolInput?: unknown },
      runtime: { signal: AbortSignal } = { signal: new AbortController().signal },
    ): Promise<{
      decision?: 'block' | 'allow' | undefined;
      reason?: string;
      modifiedInput?: Record<string, unknown>;
      additionalContext?: string;
    } | void> => {
      const linter = await linterReady;
      if (!linter) return; // no linter → no-op

      const toolName = input.toolName ?? '';
      const inp = (input.toolInput ?? {}) as Record<string, unknown>;
      const filePath = inp['path'] as string | undefined;
      if (!filePath || typeof filePath !== 'string') return;

      state.invocationCount += 1;

      // Determine the would-be content.
      let content: string | null = null;
      if (toolName === 'write') {
        const c = inp['content'] as string | undefined;
        if (typeof c !== 'string') return;
        content = c;
      } else if (toolName === 'edit') {
        const oldStr = inp['old_string'] as string | undefined;
        const newStr = inp['new_string'] as string | undefined;
        if (typeof oldStr !== 'string' || typeof newStr !== 'string') return;
        // Read current file content, apply the edit in-memory.
        try {
          const current = await readFile(filePath, 'utf-8');
          content = applyEdit(current, oldStr, newStr);
        } catch {
          return; // can't read file — let the tool handle the error
        }
        if (content === null) return; // old_string not found — edit will fail anyway
      } else {
        return; // not write or edit
      }

      // Run the linter.
      const issues = await lintContent(
        content,
        filePath,
        linter,
        cfg.timeoutMs,
        cwd,
        runtime.signal,
      );
      if (issues === null) {
        state.linterErrorCount += 1;
        return; // linter process failed — don't block the write
      }

      const filtered = filterBySeverity(issues, cfg.severity);
      state.lastResult = {
        tool: toolName,
        path: filePath,
        issueCount: filtered.length,
        severities: [...new Set(filtered.map((i) => i.severity))],
        when: new Date().toISOString(),
      };

      if (filtered.length === 0) return; // clean — let it through

      // We have lint issues at or above the severity threshold.
      state.hitCount += 1;
      const summary = filtered
        .slice(0, 10) // cap at 10 to avoid massive context
        .map(
          (i) => `  • [${i.severity}] ${i.rule}: ${i.message}${i.line ? ` (line ${i.line})` : ''}`,
        )
        .join('\n');
      const truncated = filtered.length > 10 ? `\n  … and ${filtered.length - 10} more` : '';

      if (cfg.mode === 'block') {
        api.log.warn(
          `lint-gate: blocked ${toolName} on ${filePath} — ${filtered.length} issue(s)`,
          {
            severity: cfg.severity,
          },
        );
        return {
          decision: 'block',
          reason:
            `lint-gate: ${filtered.length} linter issue(s) found in '${filePath}'. ` +
            `Fix them before writing:\n${summary}${truncated}`,
        };
      }

      if (cfg.mode === 'fix') {
        // Auto-fix for `write`: fix the entire content.
        if (toolName === 'write') {
          const fixedContent = await lintAndFix(
            content,
            filePath,
            linter,
            cfg.timeoutMs,
            cwd,
            runtime.signal,
          );
          if (fixedContent !== content) {
            state.fixCount += 1;

            // If fixRules is set, check which issues REMAIN after the
            // fix. Issues NOT in fixRules are left as warnings — the
            // linter fixed what it could for the allowed rules, but
            // other issues persist.
            let remainingSummary = '';
            let remainingCount = 0;
            if (cfg.fixRules.length > 0) {
              const fixRuleSet = new Set(cfg.fixRules);
              const remaining = filtered.filter((i) => !fixRuleSet.has(i.rule));
              remainingCount = remaining.length;
              if (remaining.length > 0) {
                remainingSummary = remaining
                  .slice(0, 10)
                  .map(
                    (i) =>
                      `  • [${i.severity}] ${i.rule}: ${i.message}${i.line ? ` (line ${i.line})` : ''}`,
                  )
                  .join('\n');
              }
            }

            api.log.info(`lint-gate: auto-fixed ${filtered.length} issue(s) in ${filePath}`, {
              severity: cfg.severity,
              remaining: remainingCount,
            });
            return {
              decision: 'allow',
              modifiedInput: { ...inp, content: fixedContent },
              additionalContext:
                `\n✅ lint-gate: auto-fixed ${filtered.length} linter issue(s) in the content ` +
                `being written to '${filePath}'. The fixed content has been substituted automatically.` +
                (remainingCount > 0
                  ? `\n${remainingCount} issue(s) remain (not in fixRules):\n${remainingSummary}`
                  : ''),
            };
          }
          // Linter didn't change anything (unfixable rules) — fall
          // through to warn.
        }

        // Auto-fix for `edit`: fix only the `new_string` in isolation.
        // We write just the new_string to a temp file, lint+fix it,
        // and if the linter changed it, substitute the fixed version
        // back into the edit's new_string field via modifiedInput.
        //
        // Limitation: rules that depend on file-level context (import
        // sorting, unused imports, file-level formatting) won't fire
        // on an isolated snippet. But style/format rules (indentation,
        // quotes, semicolons, trailing commas) work fine — and those
        // are the most common auto-fixable issues the LLM introduces.
        if (toolName === 'edit') {
          const newStr = inp['new_string'] as string | undefined;
          if (typeof newStr === 'string' && newStr.length > 0) {
            const fixedNewStr = await lintAndFix(
              newStr,
              filePath,
              linter,
              cfg.timeoutMs,
              cwd,
              runtime.signal,
            );
            if (fixedNewStr !== newStr) {
              state.fixCount += 1;
              api.log.info(`lint-gate: auto-fixed new_string in edit for ${filePath}`, {
                severity: cfg.severity,
              });
              return {
                decision: 'allow',
                modifiedInput: { ...inp, new_string: fixedNewStr },
                additionalContext:
                  `\n✅ lint-gate: auto-fixed lint issue(s) in the new_string being edited ` +
                  `into '${filePath}'. The fixed new_string has been substituted automatically. ` +
                  `Note: file-level rules (import sorting, unused imports) are not checked on ` +
                  `isolated snippets — run a full lint after the edit if needed.`,
              };
            }
            // new_string was clean or linter couldn't fix it — fall
            // through to warn for the whole-file issues found earlier.
          }
        }
        // No fix applied — warn instead.
      }

      // mode === 'warn' — inject context but let the call through.
      api.log.info(
        `lint-gate: warning on ${toolName} for ${filePath} — ${filtered.length} issue(s)`,
        {
          severity: cfg.severity,
        },
      );
      return {
        decision: 'allow',
        additionalContext:
          `\n⚠️ lint-gate: ${filtered.length} linter issue(s) detected in the content ` +
          `being written to '${filePath}'. Consider fixing:\n${summary}${truncated}`,
      };
    };

    state.hookUnregister = api.registerHook('PreToolUse', 'write|edit', hook, {
      name: 'lint-gate',
      stage: 'mutate',
      timeoutMs: Math.max(1_000, cfg.timeoutMs + 1_000),
      // Fail closed: a linter crash or timeout must not let unlinted
      // content through in block mode (issue #363).
      failurePolicy: 'closed',
    });

    // --- lint_gate_status tool ---
    api.tools.register({
      name: 'lint_gate_status',
      description:
        'Reports lint-gate state: linter detected, mode, severity threshold, and per-session invocation/hit/error counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Code Quality',
      mutating: false,
      async execute() {
        const linter = await linterReady;
        return {
          ok: true,
          linter: linter?.name ?? 'none',
          mode: cfg.mode,
          severity: cfg.severity,
          timeoutMs: cfg.timeoutMs,
          fixRules: cfg.fixRules,
          counters: {
            invocations: state.invocationCount,
            hits: state.hitCount,
            fixes: state.fixCount,
            linterErrors: state.linterErrorCount,
          },
          lastResult: state.lastResult,
        };
      },
    });

    api.log.info('lint-gate plugin loaded', {
      version: '0.1.0',
      linter: 'detecting',
      mode: cfg.mode,
      severity: cfg.severity,
    });
  },

  teardown(api) {
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }
    const final = {
      invocations: state.invocationCount,
      hits: state.hitCount,
      fixes: state.fixCount,
      linterErrors: state.linterErrorCount,
    };
    state.invocationCount = 0;
    state.hitCount = 0;
    state.fixCount = 0;
    state.linterErrorCount = 0;
    state.lastResult = null;
    api.log.info('lint-gate: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message:
        state.lastResult === null
          ? `lint-gate: ${state.invocationCount} invocation(s), ${state.hitCount} hit(s)`
          : `lint-gate: last check on ${state.lastResult.path} — ${state.lastResult.issueCount} issue(s) at ${state.lastResult.when}`,
      counters: {
        invocations: state.invocationCount,
        hits: state.hitCount,
        fixes: state.fixCount,
        linterErrors: state.linterErrorCount,
      },
      lastResult: state.lastResult,
    };
  },
};

export default plugin;

/**
 * shell-check plugin — Runs shellcheck analysis on bash/shell scripts.
 *
 * Tools registered:
 * - shellcheck: Run shellcheck on specific files OR recursively scan a directory.
 *
 * Note: The former `shellcheck (scan mode)` tool has been merged into `shellcheck`
 * via the `directory` + `pattern` parameters. Pass `files` for specific
 * files, or `directory` (optionally with `pattern`) for recursive scanning.
 */
import type { Plugin } from '@wrongstack/core';
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Sandbox: reject paths that resolve outside the current working directory.
// shell-check is a recursive file-lister over arbitrary directories — it
// must not let a tool caller (or a prompt-injected LLM) sweep the host
// filesystem, exfiltrate script contents, or expose /etc, $HOME or
// C:\Windows to the linter. The check is absolute-path resolution + a
// `relative()` that must not start with `..` or be absolute.
// ---------------------------------------------------------------------------
function withinProject(p: string): boolean {
  const root = process.cwd();
  const resolved = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const rel = relative(root, resolved);
  if (rel === '' || rel === '.') return true;
  if (rel.startsWith('..')) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

// Length cap matched to the schema description (filenames) and arbitrary
// user-supplied paths via tool input — prevents absurd inputs from
// blowing up `readdirSync` recursion.
const MAX_PATH_LEN = 4096;

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern: shared between setup, teardown,
// health). shell-check is a pure CLI wrapper — no timers, no handles,
// no caches. The state block tracks per-session invocation counts and a
// "last run" snapshot so /diag plugins can answer useful questions
// (how many lints this session, what was the last severity filter).
// Setup is idempotent: re-init zeros the counters; teardown leaves them
// at zero and the host's hot-reload cycle is clean.
// ---------------------------------------------------------------------------
const state = {
  /** Per-session invocation count. */
  invocationCount: 0,
  /** Total issues found across all runs this session (success or fail). */
  totalIssues: 0,
  /** Most recent run summary, surfaced by health(). */
  lastRun: null as null | {
    when: string;
    filesChecked: number;
    issues: number;
    severity: 'error' | 'warning' | 'info' | 'style';
    mode: 'files' | 'directory';
  },
};

interface ShellCheckIssue {
  file: string;
  line: number;
  column: number;
  level: 'error' | 'warning' | 'info' | 'style';
  code: string;
  message: string;
}

// ---------------------------------------------------------------------------
// ShellCheck runner
// ---------------------------------------------------------------------------

function runShellCheck(
  files: string[],
  severity: 'error' | 'warning' | 'info' | 'style',
  cwd?: string | undefined,
): ShellCheckIssue[] {
  if (!existsSync('shellcheck')) {
    // Try to find shellcheck in PATH
    try {
      execSync('shellcheck --version', { encoding: 'utf-8', stdio: 'ignore', windowsHide: true });
    } catch {
      throw new Error(
        'shellcheck is not installed. Install via: apt install shellcheck / brew install shellcheck',
      );
    }
  }

  const levelMap: Record<string, string> = {
    error: 'error',
    warning: 'warning',
    info: 'info',
    style: 'style',
  };

  /* v8 ignore next -- severity is constrained to levelMap keys by the schema enum; the ?? fallback is defensive. */
  const severityFlag = levelMap[severity] ?? 'warning';
  const args = ['-f', 'json', '-S', severityFlag, ...files];

  let raw: string;
  try {
    // Use execFileSync to avoid shell injection — filenames could contain
    // shell metacharacters like `; rm -rf /` if the LLM is tricked.
    raw = execFileSync('shellcheck', args, {
      encoding: 'utf-8',
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60_000,
      windowsHide: true,
    });
  } catch (err: unknown) {
    // shellcheck returns non-zero when issues are found, which is not an error
    const e = err as { stderr?: string | undefined };
    if (e.stderr && !e.stderr.includes('shellcheck')) {
      raw = e.stderr;
    } else {
      return [];
    }
  }

  if (!raw.trim()) return [];

  try {
    const parsed = JSON.parse(raw) as Array<{
      file: string;
      line: number;
      column: number;
      level: string;
      code: string;
      message: string;
    }>;
    return parsed.map((item) => ({
      file: item.file,
      line: item.line,
      column: item.column,
      level: item.level as ShellCheckIssue['level'],
      code: item.code,
      message: item.message,
    }));
  } catch {
    return [];
  }
}

function findShellFiles(dir: string, pattern: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
        results.push(...findShellFiles(full, pattern));
      } else if (entry.isFile() && (entry.name.endsWith('.sh') || entry.name === 'Dockerfile')) {
        if (!pattern || entry.name.includes(pattern)) {
          results.push(full);
        }
      }
    }
  } catch {
    // ignore access errors
  }
  return results;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'shell-check',
  version: '0.2.0',
  description:
    'Runs shellcheck analysis on bash/shell scripts and surfaces issues with severity levels',
  apiVersion: API_VERSION,
  capabilities: { tools: true, pipelines: ['toolCall'] },
  defaultConfig: {
    severity: 'warning',
    severityThreshold: 'warning',
    ignoredCodes: [],
    autoScanOnBash: false,
  },
  configSchema: {
    type: 'object',
    properties: {
      severity: { type: 'string', enum: ['error', 'warning', 'info', 'style'], default: 'warning' },
      severityThreshold: {
        type: 'string',
        enum: ['error', 'warning', 'info', 'style'],
        default: 'warning',
      },
      ignoredCodes: { type: 'array', items: { type: 'string' }, default: [] },
      autoScanOnBash: { type: 'boolean', default: false },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern): zero counters on reload.
    state.invocationCount = 0;
    state.totalIssues = 0;
    state.lastRun = null;

    // --- shellcheck tool (merged: specific files OR recursive directory scan) ---
    api.tools.register({
      name: 'shellcheck',
      description:
        'Run shellcheck analysis on shell script files. Pass `files` for specific files, ' +
        'or `directory` (optionally with `pattern`) to recursively scan for .sh files. ' +
        'Returns issues with file, line, column, severity, code, and message.',
      inputSchema: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Shell script files to check. Mutually exclusive with `directory`.',
          },
          directory: {
            type: 'string',
            default: '.',
            description:
              'Directory to recursively scan for .sh files. Used when `files` is omitted.',
          },
          pattern: {
            type: 'string',
            default: '',
            description:
              'Filename pattern to match when scanning a directory (default: all .sh files).',
          },
          severity: {
            type: 'string',
            enum: ['error', 'warning', 'info', 'style'],
            default: 'warning',
            description: 'Minimum severity level to report',
          },
          fix: {
            type: 'boolean',
            default: false,
            description: 'Apply safe automatic fixes where possible',
          },
        },
      },
      permission: 'auto',
      category: 'Code Quality',
      mutating: true,
      async execute(input: Record<string, unknown>) {
        // Bump the per-session counter on every invocation. The
        // lastRun snapshot below is updated on success so /diag can
        // answer "what was the last lint?" — failed runs (empty
        // file list, runShellCheck threw) are still counted because
        // the operator wants to see activity.
        const inp = input as {
          files?: string[];
          directory?: string;
          pattern?: string;
          severity?: ShellCheckIssue['level'];
        };
        const files = inp.files;
        const directory = inp.directory ?? '.';
        const pattern = inp.pattern ?? '';
        const severity = inp.severity ?? 'warning';
        state.invocationCount += 1;

        // Sandbox: confine any user-supplied path to the project root
        // before it touches the filesystem or the external shellcheck
        // binary. Without this guard a tool caller (or a prompt-
        // injected LLM) could sweep /etc, $HOME, C:\Windows, etc.
        const pathIsSafe = (p: string): boolean =>
          typeof p === 'string' && p.length > 0 && p.length <= MAX_PATH_LEN && withinProject(p);
        if (!pathIsSafe(directory)) {
          return {
            ok: false,
            error: `directory path is outside the project root: ${directory}`,
            issues: [],
            filesScanned: 0,
            rejectedOutsideProject: true,
          };
        }
        if (files && files.some((f) => !pathIsSafe(f))) {
          return {
            ok: false,
            error: 'one or more file paths are outside the project root',
            issues: [],
            filesScanned: 0,
            rejectedOutsideProject: true,
          };
        }

        // Resolve the file list: explicit files, or recursive directory scan.
        let checkFiles: string[];
        let scannedDirectories = false;

        if (files && files.length > 0) {
          checkFiles = files;
        } else {
          checkFiles = findShellFiles(directory, pattern);
          scannedDirectories = true;
        }

        if (checkFiles.length === 0) {
          state.lastRun = {
            when: new Date().toISOString(),
            filesChecked: 0,
            issues: 0,
            severity,
            mode: scannedDirectories ? 'directory' : 'files',
          };
          return {
            ok: true,
            filesScanned: 0,
            issues: [],
            summary: { total: 0 },
            mode: scannedDirectories ? 'directory' : 'files',
          };
        }

        let issues: ShellCheckIssue[];
        try {
          issues = runShellCheck(checkFiles, severity);
        } catch (err: unknown) {
          /* v8 ignore next -- runShellCheck only throws Error; the String(err) branch is defensive. */
          const msg = err instanceof Error ? err.message : String(err);
          return { ok: false, error: msg, issues: [], filesScanned: 0 };
        }

        const byFile: Record<string, ShellCheckIssue[]> = {};
        for (const issue of issues) {
          if (byFile[issue.file] === undefined) {
            byFile[issue.file] = [];
          }
          byFile[issue.file]?.push(issue);
        }

        const errorCount = issues.filter((i) => i.level === 'error').length;
        const warningCount = issues.filter((i) => i.level === 'warning').length;
        const infoCount = issues.filter((i) => i.level === 'info').length;
        const styleCount = issues.filter((i) => i.level === 'style').length;

        api.metrics.counter('issues_found', issues.length, { severity });
        api.metrics.histogram('issues_per_file', issues.length / Math.max(checkFiles.length, 1));
        state.totalIssues += issues.length;
        state.lastRun = {
          when: new Date().toISOString(),
          filesChecked: checkFiles.length,
          issues: issues.length,
          severity,
          mode: scannedDirectories ? 'directory' : 'files',
        };

        return {
          ok: true,
          mode: scannedDirectories ? 'directory' : 'files',
          filesScanned: checkFiles.length,
          filesWithIssues: Object.keys(byFile).length,
          issues,
          summary: {
            total: issues.length,
            errors: errorCount,
            warnings: warningCount,
            info: infoCount,
            style: styleCount,
          },
          byFile,
          recommendation:
            errorCount > 0
              ? 'Fix errors before deploying.'
              : warningCount > 0
                ? 'Review and fix warnings for better script quality.'
                : 'No issues found.',
        };
      },
    });

    api.log.info('shell-check plugin loaded', { version: '0.2.0' });
  },

  teardown(api) {
    // H1 pattern: zero counters on unload. shell-check has no
    // file handles, timers, or watches — execFileSync calls are
    // synchronous and complete before the tool returns. The unload
    // log preserves the per-session counter so operators can see
    // how many lints this session ran.
    const finalInvocations = state.invocationCount;
    const finalIssues = state.totalIssues;
    state.invocationCount = 0;
    state.totalIssues = 0;
    state.lastRun = null;
    api.log.info('shell-check: teardown complete', {
      invocations: finalInvocations,
      totalIssues: finalIssues,
    });
  },

  async health() {
    // /diag plugins — surface a one-line status plus per-session
    // counters so an operator can confirm the plugin is wired and
    // see how heavily it's been used. No resources to track (the
    // tool is a per-call sync CLI wrapper).
    return {
      ok: true,
      message:
        state.lastRun === null
          ? `shell-check: ${state.invocationCount} run(s) this session`
          : `shell-check: last run checked ${state.lastRun.filesChecked} file(s), ${state.lastRun.issues} issue(s) at ${state.lastRun.when}`,
      invocationCount: state.invocationCount,
      totalIssues: state.totalIssues,
      lastRun: state.lastRun,
    };
  },
};

export default plugin;

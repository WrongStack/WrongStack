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
import type { Plugin } from '@wrongstack/core/types';
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
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
  if (typeof p !== 'string' || p.length === 0 || p.length > MAX_PATH_LEN) return false;
  // Leading dash first. `resolve(root, '-x')` lands INSIDE the root, so the
  // containment test below returns true for `-x` / `-P` — and these strings go
  // straight into shellcheck's argv, where they are options, not paths.
  // `files: ['-x', '-P', '/', 'build.sh']` made shellcheck follow `source`
  // directives out of the project and report host files back into context:
  // exactly the sweep this module's header says it prevents. The shared
  // `sanitizeRunnerPath` in ../runtime/index.ts rejects this; the local copy
  // never did.
  if (p.startsWith('-')) return false;
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
// blowing up the recursive directory walk.
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

async function runShellCheck(
  files: string[],
  severity: 'error' | 'warning' | 'info' | 'style',
  cwd?: string | undefined,
): Promise<ShellCheckIssue[]> {
  // Probe: verify shellcheck is installed. Uses async execFile to keep the
  // event loop free — the prior sync version blocked on every tool invocation.
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      execFile(
        'shellcheck',
        ['--version'],
        { encoding: 'utf-8', windowsHide: true },
        (err) => {
          if (err) rejectPromise(err);
          else resolvePromise();
        },
      );
    });
  } catch {
    throw new Error(
      'shellcheck is not installed. Install via: apt install shellcheck / brew install shellcheck',
    );
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
    // Use async execFile to keep the event loop free — the previous sync
    // version blocked the event loop for up to 60s. Promise-wrapped to
    // preserve the same error semantics as the sync version.
    raw = await new Promise<string>((resolvePromise, rejectPromise) => {
      execFile(
        'shellcheck',
        args,
        {
          encoding: 'utf-8',
          cwd,
          windowsHide: true,
          timeout: 60_000,
          maxBuffer: 16 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          if (err) {
            const e = err as NodeJS.ErrnoException & {
              stdout?: string | Buffer;
              stderr?: string | Buffer;
            };
            // ShellCheck exits non-zero when it finds issues. Depending on
            // the Node version/wrapper, its JSON can be delivered through
            // the callback's stdout/stderr or copied onto the Error object.
            const diagnostic =
              stdout ||
              e.stdout?.toString() ||
              stderr ||
              e.stderr?.toString() ||
              '';
            if (diagnostic.trim()) {
              resolvePromise(diagnostic);
              return;
            }
            // shellcheck exited non-zero with no diagnostic stderr → not
            // a runtime error, just no JSON to parse. Reject so the
            // outer try/catch returns [].
            rejectPromise(err);
            return;
          }
          resolvePromise(stdout);
        },
      );
    });
  } catch {
    // shellcheck returns non-zero when issues are found, which is not an error
    return [];
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

async function findShellFiles(dir: string, pattern: string): Promise<string[]> {
  const results: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results; // ignore access errors
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
      results.push(...(await findShellFiles(full, pattern)));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.sh') ||
        entry.name.endsWith('.bash') ||
        entry.name.endsWith('.zsh') ||
        entry.name === 'Dockerfile' ||
        entry.name === '.bashrc' ||
        entry.name === '.zshrc')
    ) {
      if (!pattern || entry.name.includes(pattern)) {
        results.push(full);
      }
    }
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
            description:
              'Shell script files to check — a single path string or an array of paths. ' +
              'Mutually exclusive with `directory`. Aliases: `file`, `filePath`, `TargetFile`, ' +
              '`targetFile`, `path`.',
            // execute() normalizes the string form and the alias keys, but
            // schema-validating hosts check this BEFORE execute — declare them.
            anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }],
          },
          file: { type: 'string', description: 'Alias for `files` (single path).' },
          filePath: { type: 'string', description: 'Alias for `files` (single path).' },
          TargetFile: { type: 'string', description: 'Alias for `files` (single path).' },
          targetFile: { type: 'string', description: 'Alias for `files` (single path).' },
          path: { type: 'string', description: 'Alias for `files` (single path).' },
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
          files?: string[] | string;
          directory?: string;
          pattern?: string;
          severity?: ShellCheckIssue['level'];
        };
        let files: string[] | undefined;
        const rawFiles =
          inp.files ??
          (input as Record<string, unknown>)['file'] ??
          (input as Record<string, unknown>)['filePath'] ??
          (input as Record<string, unknown>)['file_path'] ??
          (input as Record<string, unknown>)['TargetFile'] ??
          (input as Record<string, unknown>)['targetFile'] ??
          (input as Record<string, unknown>)['path'];
        if (rawFiles !== undefined) {
          if (typeof rawFiles === 'string' && rawFiles.trim().length > 0) {
            files = [rawFiles.trim()];
          } else if (Array.isArray(rawFiles)) {
            files = rawFiles.filter((f): f is string => typeof f === 'string' && f.trim().length > 0);
          }
        }
        const rawDirectory =
          inp.directory ??
          (input as Record<string, unknown>)['dir'] ??
          (input as Record<string, unknown>)['SearchDirectory'];
        const directory =
          typeof rawDirectory === 'string' && rawDirectory.length > 0 ? rawDirectory : '.';
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
        if (files?.some((f) => !pathIsSafe(f))) {
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
          checkFiles = await findShellFiles(directory, pattern);
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
          issues = await runShellCheck(checkFiles, severity);
        } catch (err: unknown) {
          /* v8 ignore next -- runShellCheck only throws Error; the String(err) branch is defensive. */
          const msg = err instanceof Error ? err.message : String(err);
          return {
            ok: false,
            error: msg,
            issues: [],
            filesScanned: 0,
            mode: scannedDirectories ? 'directory' : 'files',
          };
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
    // file handles, timers, or watches — async `execFile` calls
    // complete before the tool returns. The unload
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

/**
 * dead-code-detector plugin — lightweight regex-based scan for exported
 * identifiers that appear unused anywhere in the project.
 *
 * The plugin registers one tool:
 *  - `dead_code_scan` — scan a path for suspicious exported symbols.
 *
 * And one hook:
 *  - `PostToolUse` matcher `write|edit` — auto-scan changed source files and
 *    inject a short warning when newly exported symbols look unused.
 *
 * No external AST parser is used; all detection is regex-based and
 * deterministic. Expect false positives on re-exports, public API surface,
 * and test-only exports.
 *
 * Config (`config.extensions['dead-code-detector']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "extensions": [".ts", ".tsx", ".js", ".jsx"],
 *   "defaultDepth": 3,
 *   "excludeDirs": ["node_modules", "dist", ".git", "coverage"]
 * }
 * ```
 *
 * @public
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import type { Plugin } from '@wrongstack/core/types';
import { withinProject } from '../runtime/index.js';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface SuspiciousSymbol {
  identifier: string;
  file: string;
  line: number;
  exportType: string;
}

interface DeadCodeDetectorState {
  scanCount: number;
  hitCount: number;
  missCount: number;
  hookInvocationCount: number;
  warningCount: number;
  errorCount: number;
  hookUnregister: null | (() => void);
}

const state: DeadCodeDetectorState = {
  scanCount: 0,
  hitCount: 0,
  missCount: 0,
  hookInvocationCount: 0,
  warningCount: 0,
  errorCount: 0,
  hookUnregister: null,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface DeadCodeDetectorConfig {
  enabled: boolean;
  extensions: string[];
  defaultDepth: number;
  maxDepth: number;
  excludeDirs: string[];
}

const DEFAULTS: DeadCodeDetectorConfig = {
  enabled: false,
  extensions: ['.ts', '.tsx', '.js', '.jsx'],
  defaultDepth: 3,
  maxDepth: 10,
  excludeDirs: ['node_modules', 'dist', '.git', 'coverage'],
};

function readConfig(raw: unknown): DeadCodeDetectorConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: r['enabled'] === true,
    extensions: Array.isArray(r['extensions'])
      ? (r['extensions'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : DEFAULTS.extensions,
    defaultDepth:
      typeof r['defaultDepth'] === 'number' &&
      r['defaultDepth'] >= 0 &&
      r['defaultDepth'] <= DEFAULTS.maxDepth
        ? r['defaultDepth']
        : DEFAULTS.defaultDepth,
    maxDepth: DEFAULTS.maxDepth,
    excludeDirs: Array.isArray(r['excludeDirs'])
      ? (r['excludeDirs'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : DEFAULTS.excludeDirs,
  };
}

// ---------------------------------------------------------------------------
// File gathering
// ---------------------------------------------------------------------------

interface ScannedFile {
  path: string;
  exports: SuspiciousSymbol[];
}

/**
 * Gather files recursively with deterministic ordering.
 *
 * Performance: uses Set for O(1) exclude lookup instead of Array.includes() O(n).
 * Determinism: sorts directory entries before traversal so scan results are
 * reproducible across platforms and file systems.
 */
async function gatherFiles(
  root: string,
  depth: number,
  cfg: DeadCodeDetectorConfig,
): Promise<string[]> {
  const files: string[] = [];
  const excludeSet = new Set(cfg.excludeDirs); // O(1) lookup

  async function walk(dir: string, remaining: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Sort entries for deterministic traversal order across platforms.
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (remaining > 0 && !excludeSet.has(entry.name)) {
          await walk(join(dir, entry.name), remaining - 1);
        }
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (cfg.extensions.includes(ext)) {
          files.push(join(dir, entry.name));
        }
      }
    }
  }

  await walk(resolve(root), depth);
  return files;
}

// ---------------------------------------------------------------------------
// Lightweight parsing
// ---------------------------------------------------------------------------

function stripNoise(content: string): string {
  // Remove single-line comments.
  let stripped = content.replace(/\/\/.*$/gm, ' ');
  // Remove multi-line comments.
  stripped = stripped.replace(/\/\*[\s\S]*?\*\//g, ' ');
  // Remove string literals (basic coverage for '...', "...", `...`).
  stripped = stripped.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, ' ');
  return stripped;
}

function lineNumber(content: string, index: number): number {
  return content.slice(0, index).split(/\r?\n/).length;
}

const DECLARATION_EXPORT_RE =
  /export\s+(?:async\s+|abstract\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;

const NAMED_EXPORT_RE = /export\s*\{([^}]+)\}/g;

function extractExports(content: string, filePath: string): SuspiciousSymbol[] {
  const exports: SuspiciousSymbol[] = [];

  DECLARATION_EXPORT_RE.lastIndex = 0;
  for (const match of content.matchAll(DECLARATION_EXPORT_RE)) {
    exports.push({
      identifier: match[1]!,
      file: filePath,
      line: lineNumber(content, match.index),
      exportType: 'declaration',
    });
  }

  NAMED_EXPORT_RE.lastIndex = 0;
  for (const match of content.matchAll(NAMED_EXPORT_RE)) {
    const line = lineNumber(content, match.index);
    const names = match[1]!
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const name of names) {
      // Handle `foo as bar` — the externally visible name is the alias.
      const parts = name.split(/\s+as\s+/);
      const exportedName = parts.length > 1 ? parts[parts.length - 1]!.trim() : name;
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exportedName)) {
        exports.push({
          identifier: exportedName,
          file: filePath,
          line,
          exportType: 'named',
        });
      }
    }
  }

  return exports;
}

/**
 * Find unused symbols across all scanned files.
 *
 * Performance: source text is never retained after a file is parsed. A second
 * streaming pass counts only identifiers that are exported somewhere in the
 * scan, reducing the old O(exports × files × source length) regex work to two
 * linear file reads while avoiding simultaneous `content` + `stripped` copies.
 *
 * Determinism: returns findings in sorted order (by file path, then line)
 * so scan results are reproducible across runs.
 */
async function findUnusedSymbols(files: ScannedFile[]): Promise<SuspiciousSymbol[]> {
  const suspicious: SuspiciousSymbol[] = [];
  const exportedNames = new Set(files.flatMap((file) => file.exports.map((exp) => exp.identifier)));
  const filesContainingIdentifier = new Map<string, number>();
  const identifierPattern = /[A-Za-z_$][A-Za-z0-9_$]*/g;

  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file.path, 'utf-8');
    } catch {
      continue;
    }
    const seenInFile = new Set<string>();
    for (const match of stripNoise(content).matchAll(identifierPattern)) {
      const identifier = match[0];
      if (exportedNames.has(identifier)) seenInFile.add(identifier);
    }
    for (const identifier of seenInFile) {
      filesContainingIdentifier.set(
        identifier,
        (filesContainingIdentifier.get(identifier) ?? 0) + 1,
      );
    }
  }

  for (const file of files) {
    for (const exp of file.exports) {
      if ((filesContainingIdentifier.get(exp.identifier) ?? 0) <= 1) suspicious.push(exp);
    }
  }

  // Sort findings for deterministic output: by file path, then line number.
  suspicious.sort((a, b) => {
    const fileCompare = a.file.localeCompare(b.file);
    if (fileCompare !== 0) return fileCompare;
    return a.line - b.line;
  });

  return suspicious;
}

interface ScanResult {
  findings: SuspiciousSymbol[];
  scannedFiles: number;
}

async function scan(root: string, depth: number, cfg: DeadCodeDetectorConfig): Promise<ScanResult> {
  const filePaths = await gatherFiles(root, depth, cfg);
  const files: ScannedFile[] = [];
  for (const p of filePaths) {
    try {
      const content = await readFile(p, 'utf-8');
      files.push({ path: p, exports: extractExports(content, p) });
    } catch {
      // Skip unreadable files.
    }
  }
  return { findings: await findUnusedSymbols(files), scannedFiles: files.length };
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

// withinProject() imported from ../runtime/index.js

async function resolveScanRoot(rawPath: string): Promise<string> {
  const resolved = resolve(process.cwd(), rawPath);
  try {
    const stats = await stat(resolved);
    if (!stats.isDirectory()) {
      return resolve(resolved, '..');
    }
  } catch {
    // fall through
  }
  return resolved;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function relativePath(p: string): string {
  return toPosix(relative(process.cwd(), p));
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'dead-code-detector',
  version: '0.1.0',
  description:
    'Lightweight regex-based scan for exported identifiers that appear unused anywhere in the project',
  apiVersion: API_VERSION,
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        default: false,
        description: 'Master switch.',
      },
      extensions: {
        type: 'array',
        items: { type: 'string' },
        default: ['.ts', '.tsx', '.js', '.jsx'],
        description: 'File extensions to scan.',
      },
      defaultDepth: {
        type: 'number',
        minimum: 0,
        maximum: 10,
        default: 3,
        description: 'Default recursion depth for scans.',
      },
      excludeDirs: {
        type: 'array',
        items: { type: 'string' },
        default: ['node_modules', 'dist', '.git', 'coverage'],
        description: 'Directory names to skip while scanning.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 audit pattern).
    state.scanCount = 0;
    state.hitCount = 0;
    state.missCount = 0;
    state.hookInvocationCount = 0;
    state.warningCount = 0;
    state.errorCount = 0;
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }

    const cfg = readConfig(api.config.extensions?.['dead-code-detector']);

    const hook = async (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
      toolResult?: { content: string; isError: boolean } | undefined;
    }): Promise<{ decision?: 'block'; reason?: string; additionalContext?: string } | void> => {
      if (!cfg.enabled) return;

      // Skip if the mutating tool itself errored.
      if (input.toolResult?.isError) return;

      const inp = (input.toolInput ?? {}) as Record<string, unknown>;
      const rawSource =
        inp['path'] ??
        inp['TargetFile'] ??
        inp['filePath'] ??
        inp['targetFile'] ??
        inp['file_path'] ??
        inp['file'];
      const sourcePath = typeof rawSource === 'string' ? rawSource : undefined;
      if (!sourcePath || typeof sourcePath !== 'string') return;
      if (!withinProject(sourcePath)) return;

      const ext = sourcePath.includes('.')
        ? sourcePath.slice(sourcePath.lastIndexOf('.')).toLowerCase()
        : '';
      if (!cfg.extensions.includes(ext)) return;

      state.hookInvocationCount += 1;

      // Scan from project root using defaultDepth so usages across other
      // directories are accurately captured, preventing false-positive dead-code warnings.
      let result: ScanResult;
      try {
        result = await scan(process.cwd(), cfg.defaultDepth, cfg);
      } catch {
        state.errorCount += 1;
        return;
      }

      const changedFile = resolve(process.cwd(), sourcePath);
      const relevant = result.findings.filter((f) => resolve(f.file) === changedFile);

      if (relevant.length === 0) {
        state.missCount += 1;
        return;
      }

      state.hitCount += 1;
      state.warningCount += relevant.length;
      const list = relevant
        .map((f) => `  - ${f.identifier} (${f.exportType}) at ${relativePath(f.file)}:${f.line}`)
        .join('\n');
      const message =
        `\n⚠️ dead-code-detector: ${relevant.length} exported symbol(s) in ${sourcePath} look unused:\n` +
        `${list}\n` +
        `Consider removing the export if it is not part of the public API.`;
      return { additionalContext: message };
    };

    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook, {
      background: true,
    });

    // --- dead_code_scan tool ---
    api.tools.register({
      name: 'dead_code_scan',
      description:
        'Scan TypeScript/JavaScript source files for exported symbols that appear unused anywhere in the project.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            default: '.',
            description: 'Directory or file path to scan.',
          },
          depth: {
            type: 'number',
            default: 3,
            minimum: 0,
            maximum: 10,
            description: 'Maximum recursion depth.',
          },
        },
      },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute(input: { path?: string; depth?: number }) {
        if (!cfg.enabled) return { ok: false, error: 'dead-code-detector is disabled' };

        const raw = (input ?? {}) as Record<string, unknown>;
        const rawPath =
          (typeof input.path === 'string' && input.path.trim().length > 0
            ? input.path.trim()
            : undefined) ??
          (typeof raw['directory'] === 'string' ? raw['directory'] : undefined) ??
          (typeof raw['dir'] === 'string' ? raw['dir'] : undefined) ??
          (typeof raw['SearchDirectory'] === 'string' ? raw['SearchDirectory'] : undefined) ??
          (typeof raw['filePath'] === 'string' ? raw['filePath'] : undefined) ??
          (typeof raw['TargetFile'] === 'string' ? raw['TargetFile'] : undefined) ??
          (typeof raw['targetFile'] === 'string' ? raw['targetFile'] : undefined) ??
          (typeof raw['file_path'] === 'string' ? raw['file_path'] : undefined) ??
          (typeof raw['file'] === 'string' ? raw['file'] : undefined) ??
          '.';
        const rawDepth = typeof input.depth === 'number' ? input.depth : cfg.defaultDepth;
        const depth = Math.max(0, Math.min(Math.floor(rawDepth), cfg.maxDepth));

        if (!withinProject(rawPath)) {
          return { ok: false, error: 'scan path is outside the project root' };
        }

        state.scanCount += 1;

        const scanRoot = await resolveScanRoot(rawPath);
        let result: ScanResult;
        try {
          result = await scan(scanRoot, depth, cfg);
        } catch (err) {
          state.errorCount += 1;
          return { ok: false, error: String(err) };
        }

        return {
          ok: true,
          scanRoot: relativePath(scanRoot),
          depth,
          scannedFiles: result.scannedFiles,
          findings: result.findings.map((f) => ({
            identifier: f.identifier,
            file: relativePath(f.file),
            line: f.line,
            exportType: f.exportType,
          })),
        };
      },
    });

    api.log.info('dead-code-detector plugin loaded', {
      version: '0.1.0',
      extensions: cfg.extensions,
      defaultDepth: cfg.defaultDepth,
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
      scans: state.scanCount,
      hits: state.hitCount,
      misses: state.missCount,
      hookInvocations: state.hookInvocationCount,
      warnings: state.warningCount,
      errors: state.errorCount,
    };
    state.scanCount = 0;
    state.hitCount = 0;
    state.missCount = 0;
    state.hookInvocationCount = 0;
    state.warningCount = 0;
    state.errorCount = 0;
    api.log.info('dead-code-detector: teardown complete', { final });
  },

  async health() {
    return {
      ok: state.errorCount === 0,
      message: state.errorCount
        ? `dead-code-detector: ${state.errorCount} error(s)`
        : `dead-code-detector: ${state.scanCount} scan(s), ${state.hitCount} finding(s), ${state.warningCount} warning(s)`,
      counters: {
        scans: state.scanCount,
        hits: state.hitCount,
        misses: state.missCount,
        hookInvocations: state.hookInvocationCount,
        warnings: state.warningCount,
        errors: state.errorCount,
      },
    };
  },
};

export default plugin;

/**
 * duplicate-code-detector plugin — finds duplicated code blocks across source
 * files using normalized-line fingerprinting.
 *
 * Tools registered:
 * - detect_duplicate_code : Scan a path for duplicated blocks.
 * - duplicate_code_status : Report config + counters.
 *
 * Hooks registered:
 * - PostToolUse with matcher `write|edit` to source files, warning when the
 *   changed file introduces blocks that duplicate existing code elsewhere.
 *
 * Config (`config.extensions['duplicate-code-detector']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "minLines": 5,
 *   "threshold": 0.8,
 *   "extensions": [".ts", ".tsx", ".js", ".jsx"],
 *   "excludeDirs": ["node_modules", "dist", ".git", "coverage"],
 *   "maxFindings": 20
 * }
 * ```
 *
 * @public
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import type { Plugin } from '@wrongstack/core';
import { withinProject } from '../runtime/index.js';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface DuplicateLocation {
  file: string;
  startLine: number;
  endLine: number;
  snippet: string;
}

interface DuplicateFinding {
  fingerprint: string;
  lineCount: number;
  locations: DuplicateLocation[];
}

interface DuplicateCodeDetectorState {
  scanCount: number;
  findingCount: number;
  hookInvocationCount: number;
  warningCount: number;
  errorCount: number;
  hookUnregister: null | (() => void);
  lastHookWarning: Map<string, number>;
}

const state: DuplicateCodeDetectorState = {
  scanCount: 0,
  findingCount: 0,
  hookInvocationCount: 0,
  warningCount: 0,
  errorCount: 0,
  hookUnregister: null,
  lastHookWarning: new Map(),
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface DuplicateCodeDetectorConfig {
  enabled: boolean;
  minLines: number;
  threshold: number;
  extensions: string[];
  excludeDirs: string[];
  maxFindings: number;
}

const DEFAULTS: DuplicateCodeDetectorConfig = {
  enabled: false,
  minLines: 8,
  threshold: 0.8,
  extensions: ['.ts', '.tsx', '.js', '.jsx'],
  excludeDirs: ['node_modules', 'dist', '.git', 'coverage'],
  maxFindings: 5,
};

function readConfig(raw: unknown): DuplicateCodeDetectorConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: r['enabled'] === true,
    minLines:
      typeof r['minLines'] === 'number' && r['minLines'] >= 2 && r['minLines'] <= 100
        ? r['minLines']
        : DEFAULTS.minLines,
    threshold:
      typeof r['threshold'] === 'number' && r['threshold'] > 0 && r['threshold'] <= 1
        ? r['threshold']
        : DEFAULTS.threshold,
    extensions: Array.isArray(r['extensions'])
      ? (r['extensions'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : DEFAULTS.extensions,
    excludeDirs: Array.isArray(r['excludeDirs'])
      ? (r['excludeDirs'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : DEFAULTS.excludeDirs,
    maxFindings:
      typeof r['maxFindings'] === 'number' && r['maxFindings'] >= 1 && r['maxFindings'] <= 500
        ? r['maxFindings']
        : DEFAULTS.maxFindings,
  };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

// withinProject() imported from ../runtime/index.js

function matchesExtension(p: string, exts: string[]): boolean {
  const ext = extname(p).toLowerCase();
  return exts.includes(ext);
}

function collectSourceFiles(root: string, cfg: DuplicateCodeDetectorConfig): string[] {
  const files: string[] = [];
  if (!existsSync(root)) return files;
  const s = statSync(root);
  if (s.isFile()) {
    if (matchesExtension(root, cfg.extensions)) files.push(root);
    return files;
  }
  if (!s.isDirectory()) return files;

  function walk(dir: string) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = resolve(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!cfg.excludeDirs.includes(entry)) walk(full);
      } else if (st.isFile() && matchesExtension(full, cfg.extensions)) {
        files.push(full);
      }
    }
  }

  walk(root);
  return files;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function relativePath(p: string): string {
  return toPosix(relative(process.cwd(), p));
}

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

function removeInlineComments(line: string): string {
  return line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//, '');
}

function normalizeLine(line: string): string {
  let normalized = line.trim().toLowerCase();
  normalized = removeInlineComments(normalized);
  normalized = normalized.replace(/\s+/g, ' ').trim();
  return normalized;
}

function buildFingerprint(lines: string[]): string {
  return lines.map(normalizeLine).filter((l) => l.length > 0).join('\n');
}

interface CodeWindow {
  file: string;
  startLine: number;
  endLine: number;
  snippet: string;
  fingerprint: string;
}

function extractWindows(filePath: string, content: string, minLines: number): CodeWindow[] {
  const rawLines = content.split(/\r?\n/);
  const windows: CodeWindow[] = [];
  for (let i = 0; i <= rawLines.length - minLines; i++) {
    const slice = rawLines.slice(i, i + minLines);
    const fingerprint = buildFingerprint(slice);
    if (fingerprint.length === 0) continue;
    const snippet = slice.join('\n');
    windows.push({
      file: filePath,
      startLine: i + 1,
      endLine: i + minLines,
      snippet,
      fingerprint,
    });
  }
  return windows;
}

function findDuplicates(files: Map<string, string>, minLines: number, maxFindings: number): DuplicateFinding[] {
  const byFingerprint = new Map<string, CodeWindow[]>();
  for (const [filePath, content] of files.entries()) {
    const windows = extractWindows(filePath, content, minLines);
    for (const w of windows) {
      const list = byFingerprint.get(w.fingerprint) ?? [];
      list.push(w);
      byFingerprint.set(w.fingerprint, list);
    }
  }

  const findings: DuplicateFinding[] = [];
  for (const [fingerprint, windows] of byFingerprint.entries()) {
    if (windows.length < 2) continue;
    const locations = windows.map((w) => ({
      file: relativePath(w.file),
      startLine: w.startLine,
      endLine: w.endLine,
      snippet: w.snippet,
    }));
    findings.push({ fingerprint, lineCount: fingerprint.split('\n').length, locations });
    if (findings.length >= maxFindings) break;
  }

  return findings;
}

function scanPath(rawPath: string, cfg: DuplicateCodeDetectorConfig): { findings: DuplicateFinding[]; scannedFiles: number } {
  const root = process.cwd();
  const resolved = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
  const filePaths = collectSourceFiles(resolved, cfg);
  const files = new Map<string, string>();
  for (const p of filePaths) {
    try {
      files.set(p, readFileSync(p, 'utf-8'));
    } catch {
      // skip unreadable files
    }
  }
  return { findings: findDuplicates(files, cfg.minLines, cfg.maxFindings), scannedFiles: files.size };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'duplicate-code-detector',
  version: '0.1.0',
  description: 'Finds duplicated code blocks across source files using normalized-line fingerprinting',
  apiVersion: API_VERSION,
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: false, description: 'Master switch.' },
      minLines: {
        type: 'number',
        minimum: 2,
        maximum: 100,
        default: 8,
        description: 'Minimum number of consecutive lines to form a block.',
      },
      threshold: {
        type: 'number',
        minimum: 0.01,
        maximum: 1,
        default: 0.8,
        description: 'Similarity threshold (currently exact-match only).',
      },
      extensions: {
        type: 'array',
        items: { type: 'string' },
        default: ['.ts', '.tsx', '.js', '.jsx'],
        description: 'File extensions to scan.',
      },
      excludeDirs: {
        type: 'array',
        items: { type: 'string' },
        default: ['node_modules', 'dist', '.git', 'coverage'],
        description: 'Directory names to skip while scanning.',
      },
      maxFindings: {
        type: 'number',
        minimum: 1,
        maximum: 500,
        default: 20,
        description: 'Maximum duplicate groups reported per scan.',
      },
    },
  },

  setup(api) {
    state.scanCount = 0;
    state.findingCount = 0;
    state.hookInvocationCount = 0;
    state.warningCount = 0;
    state.errorCount = 0;
    state.lastHookWarning.clear();
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }

    const cfg = readConfig(api.config.extensions?.['duplicate-code-detector']);

    const hook = (
      input: {
        toolName?: string | undefined;
        toolInput?: unknown;
        toolResult?: { content: string; isError: boolean } | undefined;
      },
    ): { decision?: 'block'; reason?: string; additionalContext?: string; contextAs?: 'inline' | 'separate' } | void => {
      if (!cfg.enabled) return;
      if (input.toolResult?.isError) return;

      const inp = (input.toolInput ?? {}) as Record<string, unknown>;
      const sourcePath = inp['path'] as string | undefined;
      if (!sourcePath || typeof sourcePath !== 'string') return;
      if (!withinProject(sourcePath)) return;

      const ext = sourcePath.includes('.')
        ? sourcePath.slice(sourcePath.lastIndexOf('.')).toLowerCase()
        : '';
      if (!cfg.extensions.includes(ext)) return;

      state.hookInvocationCount += 1;

      // Throttle repeated warnings for the same file within one minute.
      // Bulk tools like `replace` can touch many files in quick succession;
      // we still report the total count, but we don't repeat the same message
      // for the same file on every edit.
      const now = Date.now();
      const lastWarning = state.lastHookWarning.get(sourcePath);
      if (lastWarning !== undefined && now - lastWarning < 60_000) return;

      const changedFile = resolve(process.cwd(), sourcePath);
      let content: string;
      try {
        content = readFileSync(changedFile, 'utf-8');
      } catch {
        state.errorCount += 1;
        return;
      }

      const changedWindows = extractWindows(changedFile, content, cfg.minLines);
      if (changedWindows.length === 0) return;

      const projectRoot = resolve(process.cwd());
      let otherFiles: Map<string, string>;
      try {
        const filePaths = collectSourceFiles(projectRoot, cfg).filter((p) => p !== changedFile);
        otherFiles = new Map<string, string>();
        for (const p of filePaths) {
          try {
            otherFiles.set(p, readFileSync(p, 'utf-8'));
          } catch {
            // skip unreadable
          }
        }
      } catch {
        state.errorCount += 1;
        return;
      }

      const existingWindows: CodeWindow[] = [];
      for (const [p, c] of otherFiles.entries()) {
        existingWindows.push(...extractWindows(p, c, cfg.minLines));
      }

      const hits: CodeWindow[] = [];
      for (const cw of changedWindows) {
        for (const ew of existingWindows) {
          if (cw.fingerprint === ew.fingerprint) {
            hits.push(ew);
            break;
          }
        }
      }

      if (hits.length === 0) return;

      state.warningCount += hits.length;
      state.lastHookWarning.set(sourcePath, now);
      return {
        additionalContext:
          `⚠️ duplicate-code-detector: ${sourcePath} contains ${hits.length} block(s) already present elsewhere. ` +
          `Run detect_duplicate_code for details.`,
        contextAs: 'separate',
      };
    };

    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook, { background: true });

    // --- detect_duplicate_code tool ---
    api.tools.register({
      name: 'detect_duplicate_code',
      description:
        'Scan source files for duplicated code blocks. Uses normalized-line fingerprinting to find identical multi-line blocks across files.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', default: '.', description: 'Directory or file path to scan.' },
        },
      },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute(input: { path?: string }) {
        if (!cfg.enabled) return { ok: false, error: 'duplicate-code-detector is disabled' };

        const rawPath = typeof input.path === 'string' ? input.path : '.';
        if (!withinProject(rawPath)) {
          return { ok: false, error: 'scan path is outside the project root' };
        }

        state.scanCount += 1;
        let result: { findings: DuplicateFinding[]; scannedFiles: number };
        try {
          result = scanPath(rawPath, cfg);
        } catch (err) {
          state.errorCount += 1;
          return { ok: false, error: String(err) };
        }

        state.findingCount += result.findings.length;
        return {
          ok: true,
          path: relativePath(resolve(process.cwd(), rawPath)),
          scannedFiles: result.scannedFiles,
          minLines: cfg.minLines,
          findings: result.findings,
        };
      },
    });

    // --- duplicate_code_status tool ---
    api.tools.register({
      name: 'duplicate_code_status',
      description: 'Reports duplicate-code-detector state: config + counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          minLines: cfg.minLines,
          threshold: cfg.threshold,
          extensions: cfg.extensions,
          excludeDirs: cfg.excludeDirs,
          maxFindings: cfg.maxFindings,
          counters: {
            scans: state.scanCount,
            findings: state.findingCount,
            hookInvocations: state.hookInvocationCount,
            warnings: state.warningCount,
            errors: state.errorCount,
          },
        };
      },
    });

    api.log.info('duplicate-code-detector plugin loaded', {
      version: '0.1.0',
      minLines: cfg.minLines,
      extensions: cfg.extensions,
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
      findings: state.findingCount,
      hookInvocations: state.hookInvocationCount,
      warnings: state.warningCount,
      errors: state.errorCount,
    };
    state.scanCount = 0;
    state.findingCount = 0;
    state.hookInvocationCount = 0;
    state.warningCount = 0;
    state.errorCount = 0;
    state.lastHookWarning.clear();
    api.log.info('duplicate-code-detector: teardown complete', { final });
  },

  async health() {
    return {
      ok: state.errorCount === 0,
      message: state.errorCount
        ? `duplicate-code-detector: ${state.errorCount} error(s)`
        : `duplicate-code-detector: ${state.scanCount} scan(s), ${state.findingCount} duplicate group(s)`,
      counters: {
        scans: state.scanCount,
        findings: state.findingCount,
        hookInvocations: state.hookInvocationCount,
        warnings: state.warningCount,
        errors: state.errorCount,
      },
    };
  },
};

export default plugin;

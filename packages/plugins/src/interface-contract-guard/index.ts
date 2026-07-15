/**
 * interface-contract-guard plugin — checks TypeScript interface declarations
 * for apparent implementers, warning when an interface looks unimplemented.
 *
 * Tools registered:
 * - check_interface_contracts : Scan TypeScript files for unimplemented interfaces.
 * - interface_contract_status : Report config + counters.
 *
 * Hooks registered:
 * - PostToolUse with matcher `write|edit` to .ts/.tsx files, warning when the
 *   changed file contains interface declarations because implementers may need
 *   updating.
 *
 * Config (`config.extensions['interface-contract-guard']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "extensions": [".ts", ".tsx"],
 *   "maxFindings": 50
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

export interface InterfaceContractFinding {
  interfaceName: string;
  file: string;
  line: number;
  message: string;
}

interface InterfaceContractGuardState {
  scanCount: number;
  findingCount: number;
  hookInvocationCount: number;
  warningCount: number;
  errorCount: number;
  hookUnregister: null | (() => void);
}

const state: InterfaceContractGuardState = {
  scanCount: 0,
  findingCount: 0,
  hookInvocationCount: 0,
  warningCount: 0,
  errorCount: 0,
  hookUnregister: null,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface InterfaceContractGuardConfig {
  enabled: boolean;
  extensions: string[];
  maxFindings: number;
}

const DEFAULTS: InterfaceContractGuardConfig = {
  enabled: false,
  extensions: ['.ts', '.tsx'],
  maxFindings: 50,
};

function readConfig(raw: unknown): InterfaceContractGuardConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: r['enabled'] !== false,
    extensions: Array.isArray(r['extensions'])
      ? (r['extensions'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : DEFAULTS.extensions,
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

function normalizeExtensions(exts: string[]): string[] {
  return exts.map((e) => (e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`));
}

function matchesExtension(p: string, exts: string[]): boolean {
  return exts.includes(extname(p).toLowerCase());
}

function collectSourceFiles(root: string, exts: string[]): string[] {
  const files: string[] = [];
  if (!existsSync(root)) return files;
  const s = statSync(root);
  if (s.isFile()) {
    if (matchesExtension(root, exts)) files.push(root);
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
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git' || entry === 'coverage') continue;
      const full = resolve(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile() && matchesExtension(full, exts)) {
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
// Contract detection
// ---------------------------------------------------------------------------

const INTERFACE_RE = /(?:export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;

function extractInterfaceNames(content: string): Array<{ name: string; line: number }> {
  const names: Array<{ name: string; line: number }> = [];
  INTERFACE_RE.lastIndex = 0;
  for (const m of content.matchAll(INTERFACE_RE)) {
    names.push({ name: m[1]!, line: content.slice(0, m.index).split(/\r?\n/).length });
  }
  return names;
}

function hasImplementer(name: string, contents: string[]): boolean {
  const implRe = new RegExp(`(?:implements|satisfies|\\bas)\\s+${name}\\b`, 'g');
  for (const content of contents) {
    if (implRe.test(content)) return true;
  }
  return false;
}

function scanPath(rawPath: string, cfg: InterfaceContractGuardConfig): {
  findings: InterfaceContractFinding[];
  scannedFiles: number;
} {
  const root = process.cwd();
  const resolved = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
  const exts = normalizeExtensions(cfg.extensions);
  const files = collectSourceFiles(resolved, exts);
  const contents: { path: string; content: string }[] = [];
  for (const p of files) {
    try {
      contents.push({ path: p, content: readFileSync(p, 'utf-8') });
    } catch {
      // skip unreadable
    }
  }

  const allContentStrings = contents.map((c) => c.content);
  const findings: InterfaceContractFinding[] = [];
  for (const { path, content } of contents) {
    for (const { name, line } of extractInterfaceNames(content)) {
      if (!hasImplementer(name, allContentStrings)) {
        findings.push({
          interfaceName: name,
          file: relativePath(path),
          line,
          message: `interface "${name}" is declared but has no visible implementer`,
        });
        if (findings.length >= cfg.maxFindings) break;
      }
    }
    if (findings.length >= cfg.maxFindings) break;
  }

  return { findings, scannedFiles: contents.length };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'interface-contract-guard',
  version: '0.1.0',
  description: 'Checks TypeScript interfaces for visible implementers and warns about contract drift',
  apiVersion: API_VERSION,
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: true, description: 'Master switch.' },
      extensions: {
        type: 'array',
        items: { type: 'string' },
        default: ['.ts', '.tsx'],
        description: 'File extensions to scan.',
      },
      maxFindings: {
        type: 'number',
        minimum: 1,
        maximum: 500,
        default: 50,
        description: 'Maximum findings reported per scan.',
      },
    },
  },

  setup(api) {
    state.scanCount = 0;
    state.findingCount = 0;
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

    const cfg = readConfig(api.config.extensions?.['interface-contract-guard']);

    const hook = (
      input: {
        toolName?: string | undefined;
        toolInput?: unknown;
        toolResult?: { content: string; isError: boolean } | undefined;
      },
    ): { decision?: 'block'; reason?: string; additionalContext?: string } | void => {
      if (!cfg.enabled) return;
      if (input.toolResult?.isError) return;

      const inp = (input.toolInput ?? {}) as Record<string, unknown>;
      const sourcePath = inp['path'] as string | undefined;
      if (!sourcePath || typeof sourcePath !== 'string') return;
      if (!withinProject(sourcePath)) return;

      const exts = normalizeExtensions(cfg.extensions);
      if (!matchesExtension(sourcePath, exts)) return;

      state.hookInvocationCount += 1;

      const resolved = resolve(process.cwd(), sourcePath);
      let content: string;
      try {
        content = readFileSync(resolved, 'utf-8');
      } catch {
        state.errorCount += 1;
        return;
      }

      const interfaces = extractInterfaceNames(content);
      if (interfaces.length === 0) return;

      state.warningCount += 1;
      const names = interfaces.map((i) => i.name).join(', ');
      return {
        additionalContext:
          `\n🛡️ interface-contract-guard: ${sourcePath} declares interface(s): ${names}.\n` +
          `If you changed member shapes, search the project for implementers/\`satisfies\`/` +
          `\`as\` usages and update them accordingly.`,
      };
    };

    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook, { background: true });

    // --- check_interface_contracts tool ---
    api.tools.register({
      name: 'check_interface_contracts',
      description:
        'Scan TypeScript files for interface declarations that have no visible implementer (implements / as / satisfies).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', default: '.', description: 'File or directory path to scan.' },
        },
      },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute(input: { path?: string }) {
        if (!cfg.enabled) return { ok: false, error: 'interface-contract-guard is disabled' };

        const rawPath = typeof input.path === 'string' ? input.path : '.';
        if (!withinProject(rawPath)) {
          return { ok: false, error: 'path is outside the project root' };
        }

        state.scanCount += 1;
        let result: { findings: InterfaceContractFinding[]; scannedFiles: number };
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
          findings: result.findings,
        };
      },
    });

    // --- interface_contract_status tool ---
    api.tools.register({
      name: 'interface_contract_status',
      description: 'Reports interface-contract-guard state: config + counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          extensions: cfg.extensions,
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

    api.log.info('interface-contract-guard plugin loaded', {
      version: '0.1.0',
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
    api.log.info('interface-contract-guard: teardown complete', { final });
  },

  async health() {
    return {
      ok: state.errorCount === 0,
      message: state.errorCount
        ? `interface-contract-guard: ${state.errorCount} error(s)`
        : `interface-contract-guard: ${state.scanCount} scan(s), ${state.findingCount} finding(s)`,
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

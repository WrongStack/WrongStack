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

import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Plugin } from '@wrongstack/core/types';
import { collectSourceFilesAsync, matchesExtension, withinProject } from '../runtime/index.js';

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
  /**
   * Upper bound on files read per scan. Without a cap, a scan of a large
   * monorepo read every matching file and held them all in memory at once.
   */
  maxFiles: number;
}

const DEFAULTS: InterfaceContractGuardConfig = {
  enabled: false,
  extensions: ['.ts', '.tsx'],
  maxFindings: 50,
  maxFiles: 2_000,
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
    maxFiles:
      typeof r['maxFiles'] === 'number' && r['maxFiles'] >= 1 && r['maxFiles'] <= 50_000
        ? Math.floor(r['maxFiles'])
        : DEFAULTS.maxFiles,
  };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

// withinProject() imported from ../runtime/index.js

function normalizeExtensions(exts: string[]): string[] {
  return exts.map((e) => (e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`));
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
  // Line numbers are derived from a single forward scan. The previous
  // spelling did `content.slice(0, m.index).split(/\r?\n/).length` per
  // match, allocating a copy of everything before each hit — quadratic in
  // file size once a file declares more than a handful of interfaces.
  let searchedUpTo = 0;
  let line = 1;
  for (const m of content.matchAll(INTERFACE_RE)) {
    const index = m.index ?? 0;
    for (let i = searchedUpTo; i < index; i++) {
      if (content.charCodeAt(i) === 10 /* \n */) line += 1;
    }
    searchedUpTo = index;
    names.push({ name: m[1]!, line });
  }
  return names;
}

/**
 * Every type name that something in the scanned set implements, satisfies,
 * or asserts to.
 *
 * Built once, in a single pass over the corpus. The previous approach ran
 * a freshly-compiled regex across every file's full text for *every*
 * interface name — O(interfaces x files x file size), which on a monorepo
 * with a few hundred interfaces meant re-reading the entire corpus a few
 * hundred times. Membership is now an O(1) set lookup.
 */
const IMPLEMENTS_EXTENDS_RE = /(?:\bimplements\b|\bextends\b)\s+([^{;=]+)/g;
const SATISFIES_AS_RE = /(?:\bsatisfies\b|\bas\b)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
const IDENTIFIER_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

function collectImplementedNames(content: string, into: Set<string>): void {
  for (const m of content.matchAll(IMPLEMENTS_EXTENDS_RE)) {
    const clause = m[1];
    if (clause) {
      for (const id of clause.matchAll(IDENTIFIER_RE)) {
        if (id[0]) into.add(id[0]);
      }
    }
  }
  for (const m of content.matchAll(SATISFIES_AS_RE)) {
    const name = m[1];
    if (name) into.add(name);
  }
}

async function scanPath(
  rawPath: string,
  cfg: InterfaceContractGuardConfig,
): Promise<{
  findings: InterfaceContractFinding[];
  scannedFiles: number;
  /** True when `maxFiles` cut the corpus short — the scan is partial. */
  truncated: boolean;
}> {
  const root = process.cwd();
  const resolved = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
  const exts = normalizeExtensions(cfg.extensions);
  const allFiles = await collectSourceFilesAsync(resolved, { extensions: exts });
  // Cap the corpus. Without one, a scan of a large monorepo held every
  // matching file's full text in memory simultaneously.
  const files = allFiles.slice(0, cfg.maxFiles);

  // Two passes, each streaming: the first records what is implemented, the
  // second records where interfaces are declared. Only the (small) name
  // sets are retained between them, not the file contents.
  const implemented = new Set<string>();
  const declarations: Array<{ name: string; line: number; file: string }> = [];
  let scannedFiles = 0;
  for (const p of files) {
    let content: string;
    try {
      content = await readFile(p, 'utf-8');
    } catch {
      continue; // skip unreadable
    }
    scannedFiles += 1;
    collectImplementedNames(content, implemented);
    for (const { name, line } of extractInterfaceNames(content)) {
      declarations.push({ name, line, file: p });
    }
  }

  const findings: InterfaceContractFinding[] = [];
  for (const { name, line, file } of declarations) {
    if (implemented.has(name)) continue;
    findings.push({
      interfaceName: name,
      file: relativePath(file),
      line,
      message: `interface "${name}" is declared but has no visible implementer`,
    });
    if (findings.length >= cfg.maxFindings) break;
  }

  return { findings, scannedFiles, truncated: allFiles.length > files.length };
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
      maxFiles: {
        type: 'number',
        minimum: 1,
        maximum: 50000,
        default: 2000,
        description: 'Upper bound on files read per scan.',
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

    const hook = async (
      input: {
        toolName?: string | undefined;
        toolInput?: unknown;
        toolResult?: { content: string; isError: boolean } | undefined;
      },
    ): Promise<{ decision?: 'block'; reason?: string; additionalContext?: string } | void> => {
      if (!cfg.enabled) return;
      if (input.toolResult?.isError) return;

      const inp = (input.toolInput ?? {}) as Record<string, unknown>;
      const rawPath =
        inp['path'] ??
        inp['TargetFile'] ??
        inp['filePath'] ??
        inp['targetFile'] ??
        inp['file_path'] ??
        inp['file'];
      const sourcePath = typeof rawPath === 'string' && rawPath.trim() ? rawPath.trim() : undefined;
      if (!sourcePath || typeof sourcePath !== 'string') return;
      if (!withinProject(sourcePath)) return;

      const exts = normalizeExtensions(cfg.extensions);
      if (!matchesExtension(sourcePath, exts)) return;

      state.hookInvocationCount += 1;

      const resolved = resolve(process.cwd(), sourcePath);
      let content: string;
      try {
        content = await readFile(resolved, 'utf-8');
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

        const raw = (input ?? {}) as Record<string, unknown>;
        const rawPath =
          (typeof input.path === 'string' && input.path.trim().length > 0 ? input.path.trim() : undefined) ??
          (typeof raw['directory'] === 'string' ? raw['directory'] : undefined) ??
          (typeof raw['dir'] === 'string' ? raw['dir'] : undefined) ??
          (typeof raw['SearchDirectory'] === 'string' ? raw['SearchDirectory'] : undefined) ??
          (typeof raw['TargetFile'] === 'string' ? raw['TargetFile'] : undefined) ??
          (typeof raw['filePath'] === 'string' ? raw['filePath'] : undefined) ??
          (typeof raw['targetFile'] === 'string' ? raw['targetFile'] : undefined) ??
          (typeof raw['file'] === 'string' ? raw['file'] : undefined) ??
          '.';
        if (!withinProject(rawPath)) {
          return { ok: false, error: 'path is outside the project root' };
        }

        state.scanCount += 1;
        let result: Awaited<ReturnType<typeof scanPath>>;
        try {
          result = await scanPath(rawPath, cfg);
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
          // Say so when the corpus was cut short. A partial scan that
          // reports "no findings" is not the same as a clean result, and
          // the caller has no other way to tell the difference.
          truncated: result.truncated,
          ...(result.truncated
            ? {
                note:
                  `Scan stopped at the maxFiles limit (${cfg.maxFiles}); results are partial. ` +
                  'Raise `maxFiles` or scan a narrower path for full coverage.',
              }
            : {}),
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

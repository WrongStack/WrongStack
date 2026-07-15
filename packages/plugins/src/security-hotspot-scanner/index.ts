/**
 * security-hotspot-scanner plugin — scans source code for common security
 * anti-patterns and reports them via tools + a PostToolUse hook.
 *
 * Tools registered:
 * - security_hotspot_scan   : scan a file or directory for security hotspots
 * - security_hotspot_status : config + per-session counters
 *
 * Hooks registered:
 * - PostToolUse with matcher `write|edit` to warn about newly introduced hotspots.
 *
 * Config (`config.extensions['security-hotspot-scanner']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "severity": "warn",          // "warn" | "block"
 *   "maxFindings": 10,
 *   "scanOnChange": [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py"]
 * }
 * ```
 *
 * @public
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Plugin } from '@wrongstack/core';
import { withinProject } from '../runtime/index.js';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface Hotspot {
  type: string;
  severity: 'high' | 'medium' | 'low';
  line: number;
  snippet: string;
}

interface SecurityHotspotState {
  scanCount: number;
  fileScanCount: number;
  findingCount: number;
  hookInvocationCount: number;
  skippedCount: number;
  blockedCount: number;
  lastResult: {
    path: string;
    findings: number;
    durationMs: number;
    when: string;
  } | null;
  knownHotspots: Set<string>;
  hookUnregister: null | (() => void);
}

const state: SecurityHotspotState = {
  scanCount: 0,
  fileScanCount: 0,
  findingCount: 0,
  hookInvocationCount: 0,
  skippedCount: 0,
  blockedCount: 0,
  lastResult: null,
  knownHotspots: new Set(),
  hookUnregister: null,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface SecurityHotspotConfig {
  enabled: boolean;
  severity: 'warn' | 'block';
  maxFindings: number;
  scanOnChange: string[];
}

const DEFAULTS: SecurityHotspotConfig = {
  enabled: false,
  severity: 'warn',
  maxFindings: 10,
  scanOnChange: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.java', '.go', '.rb', '.php'],
};

function readConfig(raw: unknown): SecurityHotspotConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: r['enabled'] === true,
    severity: r['severity'] === 'block' ? 'block' : DEFAULTS.severity,
    maxFindings:
      typeof r['maxFindings'] === 'number' && r['maxFindings'] >= 1 && r['maxFindings'] <= 100
        ? r['maxFindings']
        : DEFAULTS.maxFindings,
    scanOnChange: Array.isArray(r['scanOnChange'])
      ? (r['scanOnChange'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : DEFAULTS.scanOnChange,
  };
}

// ---------------------------------------------------------------------------
// Detection patterns
// ---------------------------------------------------------------------------

const PATTERNS: { type: string; severity: 'high' | 'medium' | 'low'; regex: RegExp }[] = [
  { type: 'eval_call', severity: 'high', regex: /\beval\s*\(/i },
  { type: 'function_constructor', severity: 'high', regex: /\bnew\s+Function\s*\(|\bFunction\s*\(/i },
  {
    type: 'unsafe_html',
    severity: 'high',
    regex: /\binnerHTML\s*=|dangerouslySetInnerHTML/i,
  },
  {
    type: 'sql_concatenation',
    severity: 'high',
    regex: /\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b[^;]{0,120}(\+|\$\{|\.concat\s*\()/i,
  },
  {
    type: 'hardcoded_http',
    severity: 'medium',
    regex: /http:\/\/[a-zA-Z0-9][^\s'")\\]*/i,
  },
  {
    type: 'console_log_credentials',
    severity: 'medium',
    regex: /\bconsole\.log\s*\([^)]{0,120}(?:password|token|secret|key|credential|apikey|auth)/i,
  },
  {
    type: 'exec_variable_command',
    severity: 'high',
    regex: /\bexec\s*\(\s*(?:`[^`]*\$\{[^}]*\}[^`]*`|[a-zA-Z_$][\w$]*)/i,
  },
];

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

function scanSource(content: string, maxFindings: number): Hotspot[] {
  const findings: Hotspot[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    for (const pattern of PATTERNS) {
      const match = pattern.regex.exec(line);
      if (match) {
        findings.push({
          type: pattern.type,
          severity: pattern.severity,
          line: i + 1,
          snippet: line.trim().slice(0, 160),
        });
        if (findings.length >= maxFindings) return findings;
      }
    }
  }
  return findings;
}

function isSourceFile(filePath: string, extensions: string[]): boolean {
  const lower = filePath.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

// withinProject() imported from ../runtime/index.js

interface ScanResult {
  path: string;
  scanned: boolean;
  findings: Hotspot[];
  filesScanned: number;
  error?: string;
  durationMs: number;
}

function scanPath(inputPath: string, cfg: SecurityHotspotConfig): ScanResult {
  const start = Date.now();
  const root = process.cwd();
  const resolved = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath);

  if (!withinProject(inputPath)) {
    return {
      path: inputPath,
      scanned: false,
      findings: [],
      filesScanned: 0,
      error: 'path is outside the project directory',
      durationMs: Date.now() - start,
    };
  }

  let filesScanned = 0;
  const allFindings: Hotspot[] = [];
  const maxPerFile = Math.max(1, Math.floor(cfg.maxFindings / 2));

  const scanFile = (filePath: string) => {
    if (!isSourceFile(filePath, cfg.scanOnChange)) return;
    try {
      const content = readFileSync(filePath, 'utf-8');
      filesScanned += 1;
      const findings = scanSource(content, maxPerFile);
      for (const f of findings) {
        allFindings.push({ ...f, snippet: `${relative(root, filePath)}:${f.line}: ${f.snippet}` });
        if (allFindings.length >= cfg.maxFindings) return;
      }
    } catch {
      // best-effort: unreadable files are skipped
    }
  };

  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (allFindings.length >= cfg.maxFindings) return;
      const full = resolve(dir, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          // Skip hidden directories and common dependency folders.
          if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist' || entry === 'coverage') {
            continue;
          }
          walk(full);
        } else if (st.isFile()) {
          scanFile(full);
        }
      } catch {
        // best-effort
      }
    }
  };

  try {
    const st = statSync(resolved);
    if (st.isDirectory()) {
      walk(resolved);
    } else if (st.isFile()) {
      scanFile(resolved);
    } else {
      return {
        path: inputPath,
        scanned: false,
        findings: [],
        filesScanned: 0,
        error: 'path is not a file or directory',
        durationMs: Date.now() - start,
      };
    }
  } catch {
    return {
      path: inputPath,
      scanned: false,
      findings: [],
      filesScanned: 0,
      error: 'path does not exist or cannot be read',
      durationMs: Date.now() - start,
    };
  }

  return {
    path: inputPath,
    scanned: true,
    findings: allFindings,
    filesScanned,
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'security-hotspot-scanner',
  version: '0.1.0',
  description:
    'Scans source code for security anti-patterns and warns after writes/edits that introduce new hotspots',
  apiVersion: API_VERSION,
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: false, description: 'Master switch.' },
      severity: {
        type: 'string',
        enum: ['warn', 'block'],
        default: 'warn',
        description: 'warn = inject hotspots as additionalContext; block = refuse the mutating tool.',
      },
      maxFindings: {
        type: 'number',
        minimum: 1,
        maximum: 100,
        default: 10,
        description: 'Maximum hotspots reported per scan.',
      },
      scanOnChange: {
        type: 'array',
        items: { type: 'string' },
        default: DEFAULTS.scanOnChange,
        description: 'Only scan files with one of these extensions.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.scanCount = 0;
    state.fileScanCount = 0;
    state.findingCount = 0;
    state.hookInvocationCount = 0;
    state.skippedCount = 0;
    state.blockedCount = 0;
    state.lastResult = null;
    state.knownHotspots.clear();
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }

    const cfg = readConfig(api.config.extensions?.['security-hotspot-scanner']);

    const hook = (
      input: {
        toolName?: string | undefined;
        toolInput?: unknown;
        toolResult?: { content: string; isError: boolean } | undefined;
      },
    ): { decision?: 'block'; reason?: string; additionalContext?: string } | void => {
      if (!cfg.enabled) return;

      // Skip if the write/edit itself errored.
      if (input.toolResult?.isError) return;

      const inp = (input.toolInput ?? {}) as Record<string, unknown>;
      const sourcePath = inp['path'] as string | undefined;
      if (!sourcePath || typeof sourcePath !== 'string') return;
      if (!withinProject(sourcePath)) return;

      const ext = sourcePath.includes('.')
        ? sourcePath.slice(sourcePath.lastIndexOf('.')).toLowerCase()
        : '';
      if (!cfg.scanOnChange.includes(ext)) {
        state.skippedCount += 1;
        return;
      }

      state.hookInvocationCount += 1;
      const result = scanPath(sourcePath, cfg);
      state.scanCount += 1;
      state.fileScanCount += result.filesScanned;

      if (!result.scanned) {
        return;
      }

      // Only report hotspots we have not already seen.
      const newFindings = result.findings.filter((f) => {
        const key = `${result.path}:${f.type}:${f.line}`;
        if (state.knownHotspots.has(key)) return false;
        state.knownHotspots.add(key);
        return true;
      });

      if (newFindings.length === 0) return;

      state.findingCount += newFindings.length;
      state.lastResult = {
        path: result.path,
        findings: newFindings.length,
        durationMs: result.durationMs,
        when: new Date().toISOString(),
      };

      const lines = newFindings.map(
        (f) => `  [${f.severity.toUpperCase()}] ${f.type} at line ${f.line}: ${f.snippet}`,
      );
      const message =
        `\n🛡️ security-hotspot-scanner: ${newFindings.length} new security hotspot(s) introduced by editing ${sourcePath}.` +
        `\n${lines.join('\n')}` +
        (result.findings.length >= cfg.maxFindings
          ? `\n  … and possibly more (showing first ${cfg.maxFindings})`
          : '') +
        `\nReview or remove the risky pattern(s).`;

      if (cfg.severity === 'block') {
        state.blockedCount += 1;
        return {
          decision: 'block' as const,
          reason: message,
        };
      }

      return { additionalContext: message };
    };

    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook, { background: true });

    // --- security_hotspot_scan tool ---
    api.tools.register({
      name: 'security_hotspot_scan',
      description:
        'Scan a file or directory for security anti-patterns (eval, Function constructor, innerHTML, SQL concatenation, http URLs, credential logging, variable exec commands).',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File or directory path to scan (relative or absolute, must be inside the project).',
          },
        },
        required: ['path'],
      },
      permission: 'auto',
      category: 'Security',
      mutating: false,
      async execute(input: { path: string }) {
        if (!cfg.enabled) return { ok: false, error: 'security-hotspot-scanner is disabled' };
        const result = scanPath(input.path, cfg);
        state.scanCount += 1;
        state.fileScanCount += result.filesScanned;
        state.findingCount += result.findings.length;
        if (!result.scanned) {
          return { ok: false, error: result.error, path: input.path };
        }
        state.lastResult = {
          path: result.path,
          findings: result.findings.length,
          durationMs: result.durationMs,
          when: new Date().toISOString(),
        };
        return {
          ok: true,
          path: input.path,
          filesScanned: result.filesScanned,
          findings: result.findings,
          findingCount: result.findings.length,
          durationMs: result.durationMs,
        };
      },
    });

    // --- security_hotspot_status tool ---
    api.tools.register({
      name: 'security_hotspot_status',
      description:
        'Reports security-hotspot-scanner state: severity, extensions, pattern types, and per-session counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Security',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          severity: cfg.severity,
          maxFindings: cfg.maxFindings,
          scanOnChange: cfg.scanOnChange,
          patternTypes: PATTERNS.map((p) => p.type),
          counters: {
            scans: state.scanCount,
            filesScanned: state.fileScanCount,
            findings: state.findingCount,
            hookInvocations: state.hookInvocationCount,
            skipped: state.skippedCount,
            blocked: state.blockedCount,
          },
          lastResult: state.lastResult,
        };
      },
    });

    api.log.info('security-hotspot-scanner plugin loaded', {
      version: '0.1.0',
      severity: cfg.severity,
      maxFindings: cfg.maxFindings,
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
      filesScanned: state.fileScanCount,
      findings: state.findingCount,
      hookInvocations: state.hookInvocationCount,
      skipped: state.skippedCount,
      blocked: state.blockedCount,
    };
    state.scanCount = 0;
    state.fileScanCount = 0;
    state.findingCount = 0;
    state.hookInvocationCount = 0;
    state.skippedCount = 0;
    state.blockedCount = 0;
    state.lastResult = null;
    state.knownHotspots.clear();
    api.log.info('security-hotspot-scanner: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message: state.lastResult
        ? `security-hotspot-scanner: ${state.scanCount} scan(s), last scan found ${state.lastResult.findings} hotspot(s)`
        : `security-hotspot-scanner: ${state.scanCount} scan(s), ${state.findingCount} finding(s)`,
      counters: {
        scans: state.scanCount,
        filesScanned: state.fileScanCount,
        findings: state.findingCount,
        hookInvocations: state.hookInvocationCount,
        skipped: state.skippedCount,
        blocked: state.blockedCount,
      },
      lastResult: state.lastResult,
    };
  },
};

export default plugin;

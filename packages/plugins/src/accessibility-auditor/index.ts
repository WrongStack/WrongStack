/**
 * accessibility-auditor plugin — audits UI files for common accessibility
 * issues using fast regex-based heuristics.
 *
 * Tools registered:
 * - a11y_audit : Scan a file or directory for a11y issues.
 * - a11y_status : Show config + per-session counters.
 *
 * Hooks registered:
 * - PostToolUse with matcher `write|edit` to UI files, injecting a short
 *   additionalContext summary of any new accessibility issues.
 *
 * Config (`config.extensions['accessibility-auditor']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "includeExtensions": [".tsx", ".jsx", ".html", ".vue"],
 *   "maxFindings": 50,
 *   "severity": "warn",         // "warn" | "block"
 *   "onWriteEdit": true
 * }
 * ```
 *
 * @public
 */

import { type Plugin, ToolValidationError } from '@wrongstack/contracts/types';
import { matchesExtension, releaseHandle, withinProject } from '../runtime/index.js';
import { auditPath, formatSummary, truncationWarning } from './a11y-audit.js';
import { assertPathExists, DEFAULTS, normalizeExtensions, readConfig } from './a11y-config.js';

export type { A11yFinding, A11yRule } from './a11y-heuristics.js';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface AccessibilityAuditorState {
  auditCount: number;
  fileCount: number;
  findingCount: number;
  hookInvocationCount: number;
  lastResult: {
    path: string;
    fileCount: number;
    findingCount: number;
    when: string;
  } | null;
  hookUnregister: null | (() => void);
}

const state: AccessibilityAuditorState = {
  auditCount: 0,
  fileCount: 0,
  findingCount: 0,
  hookInvocationCount: 0,
  lastResult: null,
  hookUnregister: null,
};

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'accessibility-auditor',
  version: '0.1.0',
  description:
    'Audits .tsx/.jsx/.html/.vue files for common accessibility issues and reports findings after writes/edits',
  apiVersion: API_VERSION,
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        default: true,
        description: 'Master switch.',
      },
      includeExtensions: {
        type: 'array',
        items: { type: 'string' },
        default: ['.tsx', '.jsx', '.html', '.vue'],
        description: 'File extensions to audit.',
      },
      maxFindings: {
        type: 'number',
        minimum: 1,
        maximum: 500,
        default: 50,
        description: 'Maximum findings returned per audit.',
      },
      severity: {
        type: 'string',
        enum: ['warn', 'block'],
        default: 'warn',
        description:
          'warn = inject findings as additionalContext; block = refuse the mutating tool when issues appear.',
      },
      onWriteEdit: {
        type: 'boolean',
        default: true,
        description: 'Run audit after write|edit to UI files.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 audit pattern).
    state.auditCount = 0;
    state.fileCount = 0;
    state.findingCount = 0;
    state.hookInvocationCount = 0;
    state.lastResult = null;
    state.hookUnregister = releaseHandle(state.hookUnregister);

    const cfg = readConfig(api.config.extensions?.['accessibility-auditor']);

    const hook = async (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
      toolResult?: { content: string; isError: boolean } | undefined;
    }): Promise<{ decision?: 'block'; reason?: string; additionalContext?: string } | void> => {
      if (!cfg.enabled || !cfg.onWriteEdit) return;
      if (input.toolResult?.isError) return;

      const inp = (input.toolInput ?? {}) as Record<string, unknown>;
      const rawPath =
        inp['path'] ??
        inp['TargetFile'] ??
        inp['filePath'] ??
        inp['targetFile'] ??
        inp['file_path'] ??
        inp['file'];
      const sourcePath = typeof rawPath === 'string' ? rawPath : undefined;
      if (!sourcePath) return;
      if (!withinProject(sourcePath)) return;

      const exts = normalizeExtensions(cfg.includeExtensions);
      if (!matchesExtension(sourcePath, exts)) return;

      state.hookInvocationCount += 1;
      const result = await auditPath(sourcePath, cfg);
      state.auditCount += 1;
      state.fileCount += result.fileCount;
      state.findingCount += result.findings.length;
      state.lastResult = {
        path: result.path,
        fileCount: result.fileCount,
        findingCount: result.findings.length,
        when: new Date().toISOString(),
      };

      if (result.findings.length === 0 && !result.truncated) return;

      const summary = formatSummary(result);
      if (cfg.severity === 'block' && result.findings.length > 0) {
        return { decision: 'block' as const, reason: summary };
      }
      return { additionalContext: summary };
    };

    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook, {
      background: true,
    });

    // --- a11y_audit tool ---
    api.tools.register({
      name: 'a11y_audit',
      description:
        'Audit a file or directory for accessibility issues. Scans .tsx/.jsx/.html/.vue files for missing alt text, missing labels, low-contrast placeholders, missing button text, and duplicate ids.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File or directory path to audit (relative to project root).',
          },
        },
        required: ['path'],
      },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute(input: { path: string }) {
        if (!cfg.enabled) throw new Error('accessibility-auditor is disabled');
        const raw = input as Record<string, unknown>;
        const rawPath =
          (typeof input.path === 'string' && input.path.trim().length > 0
            ? input.path.trim()
            : undefined) ??
          (typeof raw['directory'] === 'string' ? raw['directory'] : undefined) ??
          (typeof raw['dir'] === 'string' ? raw['dir'] : undefined) ??
          (typeof raw['SearchDirectory'] === 'string' ? raw['SearchDirectory'] : undefined) ??
          (typeof raw['TargetFile'] === 'string' ? raw['TargetFile'] : undefined) ??
          (typeof raw['filePath'] === 'string' ? raw['filePath'] : undefined) ??
          (typeof raw['file_path'] === 'string' ? raw['file_path'] : undefined) ??
          (typeof raw['targetFile'] === 'string' ? raw['targetFile'] : undefined) ??
          (typeof raw['file'] === 'string' ? raw['file'] : undefined) ??
          '.';
        if (!withinProject(rawPath)) {
          throw new ToolValidationError({
            message: 'path must be inside the project',
            field: 'path',
          });
        }
        // A missing path would otherwise walk nothing and read as a clean audit.
        await assertPathExists(rawPath);

        state.auditCount += 1;
        const result = await auditPath(rawPath, cfg);
        state.fileCount += result.fileCount;
        state.findingCount += result.findings.length;
        state.lastResult = {
          path: result.path,
          fileCount: result.fileCount,
          findingCount: result.findings.length,
          when: new Date().toISOString(),
        };

        const warning = truncationWarning(result);
        return {
          ok: true,
          path: result.path,
          fileCount: result.fileCount,
          scannedFiles: result.scannedFiles,
          // Say so when the cap stopped the walk early: a partial scan
          // that reports few findings must not read as a clean result.
          truncated: result.truncated,
          findingCount: result.findings.length,
          findings: result.findings,
          ...(warning ? { additionalContext: `⚠️ ${warning}`, warning } : {}),
        };
      },
    });

    // --- a11y_status tool ---
    api.tools.register({
      name: 'a11y_status',
      description:
        'Reports accessibility-auditor state: config, per-session counters, and the most recent scan result.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          includeExtensions: cfg.includeExtensions,
          maxFindings: cfg.maxFindings,
          severity: cfg.severity,
          onWriteEdit: cfg.onWriteEdit,
          counters: {
            audits: state.auditCount,
            files: state.fileCount,
            findings: state.findingCount,
            hookInvocations: state.hookInvocationCount,
          },
          lastResult: state.lastResult,
        };
      },
    });

    api.log.info('accessibility-auditor plugin loaded', {
      version: '0.1.0',
      includeExtensions: cfg.includeExtensions,
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
      audits: state.auditCount,
      files: state.fileCount,
      findings: state.findingCount,
      hookInvocations: state.hookInvocationCount,
    };
    state.auditCount = 0;
    state.fileCount = 0;
    state.findingCount = 0;
    state.hookInvocationCount = 0;
    state.lastResult = null;
    api.log.info('accessibility-auditor: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message: state.lastResult
        ? `accessibility-auditor: ${state.auditCount} audit(s), last scan ${state.lastResult.path} had ${state.lastResult.findingCount} finding(s)`
        : `accessibility-auditor: ${state.auditCount} audit(s), ${state.findingCount} finding(s)`,
      counters: {
        audits: state.auditCount,
        files: state.fileCount,
        findings: state.findingCount,
        hookInvocations: state.hookInvocationCount,
      },
      lastResult: state.lastResult,
    };
  },
};

export default plugin;

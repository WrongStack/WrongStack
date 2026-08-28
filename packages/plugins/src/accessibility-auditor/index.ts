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

import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Plugin } from '@wrongstack/core/types';
import { releaseHandle, collectSourceFilesAsync, matchesExtension, withinProject } from '../runtime/index.js';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

export type A11yRule =
  | 'missing-alt'
  | 'missing-input-label'
  | 'low-contrast-placeholder'
  | 'missing-button-text'
  | 'duplicate-id';

export interface A11yFinding {
  file: string;
  line: number;
  rule: A11yRule;
  severity: 'error' | 'warning';
  message: string;
  /**
   * Optional scan limitation. Cross-file labels (e.g. `<Label>` in a
   * sibling component) are invisible to this single-file regex walk.
   */
  note?: string;
}

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
// Config
// ---------------------------------------------------------------------------

interface AccessibilityAuditorConfig {
  enabled: boolean;
  includeExtensions: string[];
  maxFindings: number;
  severity: 'warn' | 'block';
  onWriteEdit: boolean;
}

const DEFAULTS: AccessibilityAuditorConfig = {
  enabled: false,
  includeExtensions: ['.tsx', '.jsx', '.html', '.vue'],
  maxFindings: 50,
  severity: 'warn',
  onWriteEdit: true,
};

function readConfig(raw: unknown): AccessibilityAuditorConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: r['enabled'] !== false,
    includeExtensions: Array.isArray(r['includeExtensions'])
      ? (r['includeExtensions'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : DEFAULTS.includeExtensions,
    maxFindings:
      typeof r['maxFindings'] === 'number' && r['maxFindings'] >= 1 && r['maxFindings'] <= 500
        ? r['maxFindings']
        : DEFAULTS.maxFindings,
    severity: r['severity'] === 'block' ? 'block' : DEFAULTS.severity,
    onWriteEdit: r['onWriteEdit'] !== false,
  };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

// withinProject() imported from ../runtime/index.js

function normalizeExtensions(exts: string[]): string[] {
  return exts.map((e) => (e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`));
}

// ---------------------------------------------------------------------------
// Audit heuristics
// ---------------------------------------------------------------------------

const TAG_IMG = /<img\b[^>]*>/gi;
const TAG_INPUT = /<input\b[^>]*\/?>/gi;
const TAG_BUTTON = /<button\b[^>]*>([\s\S]*?)<\/button>/gi;
const INPUT_BUTTON = /<input\b[^>]*\btype\s*=\s*["'](submit|button|reset)["'][^>]*\/?>/gi;
const ATTR_ID = /\bid\s*=\s*["']([^"']+)["']/gi;
const ATTR_ALT = /\balt\s*=/i;
const ATTR_ARIA_LABEL = /\b(?:aria-label|aria-labelledby)\s*=/i;
const ATTR_ARIA_DESCRIBEDBY = /\baria-describedby\s*=/i;
const ATTR_TITLE = /\btitle\s*=/i;
const ATTR_PLACEHOLDER = /\bplaceholder\s*=/i;
const ATTR_VALUE = /\bvalue\s*=/i;
const ATTR_ROLE_DECORATIVE = /\brole\s*=\s*["'](?:presentation|none)["']/i;
const SINGLE_FILE_LABEL_NOTE =
  'Single-file heuristic: a label declared in a sibling component file is not visible to this scan.';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasMeaningfulAlt(tag: string): boolean {
  const m = ATTR_ALT.exec(tag);
  ATTR_ALT.lastIndex = 0;
  if (!m) return false;
  const valMatch = tag.match(/\balt\s*=\s*["']?([^"'\s>]*)["']?/i);
  const alt = valMatch ? valMatch[1]!.trim() : '';
  if (alt.length > 0) return true;
  // Decorative images: empty alt plus an explicit role hint is enough.
  return ATTR_ROLE_DECORATIVE.test(tag);
}

function hasFieldsetLegendLabel(tag: string, content: string): boolean {
  const labelledBy = tag.match(/\baria-labelledby\s*=\s*["']([^"']+)["']/i);
  if (labelledBy?.[1]) {
    for (const id of labelledBy[1].split(/\s+/).filter(Boolean)) {
      const idRe = new RegExp(`\\bid\\s*=\\s*["']${escapeRegExp(id)}["']`, 'i');
      if (idRe.test(content)) return true;
    }
  }
  const typeMatch = tag.match(/\btype\s*=\s*["']?([^"'\s>]*)["']?/i);
  const type = typeMatch ? typeMatch[1]!.toLowerCase() : 'text';
  if (type === 'checkbox' || type === 'radio') {
    return /<fieldset\b[\s\S]*?<legend\b[\s\S]*?<\/legend>[\s\S]*?<input\b[\s\S]*?<\/fieldset>/i.test(
      content,
    );
  }
  return false;
}

async function auditFile(filePath: string, projectRoot: string): Promise<A11yFinding[]> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  const findings: A11yFinding[] = [];
  const lines = content.split(/\r?\n/);
  const idsByValue = new Map<string, number[]>();

  function add(
    line: number,
    rule: A11yRule,
    severity: 'error' | 'warning',
    message: string,
    note?: string,
  ) {
    findings.push({
      file: relative(projectRoot, filePath),
      line,
      rule,
      severity,
      message,
      ...(note ? { note } : {}),
    });
  }

  // First pass: collect ids and per-line tags.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;

    // Duplicate ids.
    for (const idMatch of line.matchAll(ATTR_ID)) {
      const id = idMatch[1]!;
      const list = idsByValue.get(id) ?? [];
      list.push(lineNo);
      idsByValue.set(id, list);
    }
    ATTR_ID.lastIndex = 0;

    // Missing alt on images.
    for (const imgMatch of line.matchAll(TAG_IMG)) {
      const tag = imgMatch[0]!;
      if (!hasMeaningfulAlt(tag)) {
        add(lineNo, 'missing-alt', 'error', '<img> is missing meaningful alt text');
      }
    }
    TAG_IMG.lastIndex = 0;

    // Inputs.
    for (const inputMatch of line.matchAll(TAG_INPUT)) {
      const tag = inputMatch[0]!;
      const typeMatch = tag.match(/\btype\s*=\s*["']?([^"'\s>]*)["']?/i);
      const type = typeMatch ? typeMatch[1]!.toLowerCase() : 'text';
      // Hidden/submit/button/reset inputs are not text-field a11y concerns;
      // input[type=submit|button|reset] is handled separately below.
      if (type === 'hidden' || type === 'button' || type === 'submit' || type === 'reset' || type === 'image') {
        continue;
      }

      const hasAriaLabel = ATTR_ARIA_LABEL.test(tag);
      const hasDescribedBy = ATTR_ARIA_DESCRIBEDBY.test(tag);
      const hasTitle = ATTR_TITLE.test(tag);
      const idMatchLocal = tag.match(/\bid\s*=\s*["']([^"']+)["']/i);
      const id = idMatchLocal ? idMatchLocal[1] : null;

      let hasLabelFor = false;
      if (id) {
        const labelForRe = new RegExp(
          `<label\\b[^>]*\\bfor\\s*=\\s*["']${escapeRegExp(id)}["']`,
          'i',
        );
        hasLabelFor = labelForRe.test(content);
      }
      const wrappedInLabel = /<label\b[\s\S]*?<input\b[\s\S]*?<\/label>/i.test(content);
      const hasLegend = hasFieldsetLegendLabel(tag, content);
      const hasPrimaryLabel = hasAriaLabel || hasTitle || hasLabelFor || wrappedInLabel || hasLegend;

      // aria-describedby is supplementary, not a primary name.
      if (!hasPrimaryLabel && hasDescribedBy) {
        add(
          lineNo,
          'low-contrast-placeholder',
          'warning',
          `<input type="${type}"> uses aria-describedby as a description (supplementary, not a primary label)`,
        );
      } else if (!hasPrimaryLabel) {
        add(
          lineNo,
          'missing-input-label',
          'error',
          `<input type="${type}"> is missing an associated label`,
          SINGLE_FILE_LABEL_NOTE,
        );
      }

      // Placeholder used as a label proxy is a common low-contrast / usability issue.
      if (ATTR_PLACEHOLDER.test(tag)) {
        add(lineNo, 'low-contrast-placeholder', 'warning', '<input> uses placeholder text (often low contrast and disappears on input)');
      }
    }
    TAG_INPUT.lastIndex = 0;

    // Buttons.
    for (const buttonMatch of line.matchAll(TAG_BUTTON)) {
      const tag = buttonMatch[0]!;
      const inner = buttonMatch[1] ?? '';
      const hasText = inner.replace(/\s+/g, '').length > 0;
      const hasAriaLabel = ATTR_ARIA_LABEL.test(tag);
      const hasTitle = ATTR_TITLE.test(tag);
      if (!hasText && !hasAriaLabel && !hasTitle) {
        add(lineNo, 'missing-button-text', 'error', '<button> has no visible text or accessible label');
      }
    }
    TAG_BUTTON.lastIndex = 0;

    // input[type=submit|button|reset] without value.
    for (const inputButtonMatch of line.matchAll(INPUT_BUTTON)) {
      const tag = inputButtonMatch[0]!;
      if (!ATTR_VALUE.test(tag) && !ATTR_ARIA_LABEL.test(tag) && !ATTR_TITLE.test(tag)) {
        add(lineNo, 'missing-button-text', 'error', `<input type="${inputButtonMatch[1]}"> is missing value/aria-label/title`);
      }
    }
    INPUT_BUTTON.lastIndex = 0;
  }

  // Duplicate ids across the file.
  for (const [id, lineNos] of idsByValue.entries()) {
    if (lineNos.length > 1) {
      for (const lineNo of lineNos) {
        add(lineNo, 'duplicate-id', 'error', `Duplicate id "${id}"`);
      }
    }
  }

  return findings;
}

async function auditPath(
  rawPath: string,
  cfg: AccessibilityAuditorConfig,
): Promise<{
  path: string;
  findings: A11yFinding[];
  fileCount: number;
  /** Files actually opened. Lower than `fileCount` when the cap was hit. */
  scannedFiles: number;
  /** True when `maxFindings` stopped the walk before every file was read. */
  truncated: boolean;
}> {
  const root = process.cwd();
  const resolved = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
  const exts = normalizeExtensions(cfg.includeExtensions);
  const files = await collectSourceFilesAsync(resolved, { extensions: exts });
  const findings: A11yFinding[] = [];
  let scannedFiles = 0;
  let truncated = false;
  for (const file of files) {
    const fileFindings = await auditFile(file, root);
    scannedFiles += 1;
    findings.push(...fileFindings);
    if (findings.length >= cfg.maxFindings) {
      // Only a real truncation if files remain unexamined.
      truncated = scannedFiles < files.length;
      break;
    }
  }
  return {
    path: relative(root, resolved),
    findings: findings.slice(0, cfg.maxFindings),
    fileCount: files.length,
    scannedFiles,
    truncated,
  };
}

function truncationWarning(result: {
  fileCount: number;
  scannedFiles?: number;
  truncated?: boolean;
}): string {
  if (!result.truncated) return '';
  const unexamined = Math.max(0, result.fileCount - (result.scannedFiles ?? result.fileCount));
  return `partial scan — ${unexamined} files not examined`;
}

function formatSummary(result: {
  path: string;
  findings: A11yFinding[];
  fileCount: number;
  scannedFiles?: number;
  truncated?: boolean;
}): string {
  const trunc = truncationWarning(result);
  if (result.findings.length === 0) {
    const clean = `\n✅ accessibility-auditor: no issues found in ${result.path} (${result.fileCount} file${result.fileCount === 1 ? '' : 's'}).`;
    return trunc ? `${clean}\n⚠️ ${trunc}` : clean;
  }
  const lines = result.findings.map((f) => `  - ${f.file}:${f.line} — ${f.message} (${f.rule})`);
  return (
    `\n⚠️ accessibility-auditor: ${result.findings.length} issue(s) in ${result.path} (${result.fileCount} file${result.fileCount === 1 ? '' : 's'}):\n` +
    lines.join('\n') +
    '\nConsider adding missing labels/alt text or resolving duplicate ids.' +
    (trunc ? `\n⚠️ ${trunc}` : '')
  );
}

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

    const hook = async (
      input: {
        toolName?: string | undefined;
        toolInput?: unknown;
        toolResult?: { content: string; isError: boolean } | undefined;
      },
    ): Promise<{ decision?: 'block'; reason?: string; additionalContext?: string } | void> => {
      if (!cfg.enabled || !cfg.onWriteEdit) return;
      if (input.toolResult?.isError) return;

      const inp = (input.toolInput ?? {}) as Record<string, unknown>;
      const rawPath = inp['path'] ?? inp['filePath'] ?? inp['file_path'];
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

    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook, { background: true });

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
        if (!cfg.enabled) return { ok: false, error: 'accessibility-auditor is disabled' };
        const rawPath = input.path;
        if (!rawPath || typeof rawPath !== 'string') {
          return { ok: false, error: 'path is required' };
        }
        if (!withinProject(rawPath)) {
          return { ok: false, error: 'path must be inside the project' };
        }

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
          ...(warning
            ? { additionalContext: `⚠️ ${warning}`, warning }
            : {}),
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

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

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Plugin } from '@wrongstack/core';
import { withinProject } from '../runtime/index.js';

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

function matchesExtension(p: string, exts: string[]): boolean {
  const dot = p.lastIndexOf('.');
  if (dot === -1) return false;
  return exts.includes(p.slice(dot).toLowerCase());
}

function collectUiFiles(root: string, exts: string[]): string[] {
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
const ATTR_TITLE = /\btitle\s*=/i;
const ATTR_PLACEHOLDER = /\bplaceholder\s*=/i;
const ATTR_VALUE = /\bvalue\s*=/i;
function hasMeaningfulAlt(tag: string): boolean {
  const m = ATTR_ALT.exec(tag);
  ATTR_ALT.lastIndex = 0;
  if (!m) return false;
  // alt="" is valid for decorative images, but this heuristic treats it as
  // a warning so the author confirms intent.
  const valMatch = tag.match(/\balt\s*=\s*["']?([^"'\s>]*)["']?/i);
  return valMatch ? valMatch[1]!.trim().length > 0 : false;
}

function auditFile(filePath: string, projectRoot: string): A11yFinding[] {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const findings: A11yFinding[] = [];
  const lines = content.split(/\r?\n/);
  const idsByValue = new Map<string, number[]>();

  function add(line: number, rule: A11yRule, severity: 'error' | 'warning', message: string) {
    findings.push({
      file: relative(projectRoot, filePath),
      line,
      rule,
      severity,
      message,
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
      const hasTitle = ATTR_TITLE.test(tag);
      const idMatchLocal = tag.match(/\bid\s*=\s*["']([^"']+)["']/i);
      const id = idMatchLocal ? idMatchLocal[1] : null;

      let hasLabelFor = false;
      if (id) {
        const labelForRe = new RegExp(`<label\\b[^>]*\\bfor\\s*=\\s*["']${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i');
        hasLabelFor = labelForRe.test(content);
      }
      const wrappedInLabel = /<label\b[\s\S]*?<input\b[\s\S]*?<\/label>/i.test(content);

      if (!hasAriaLabel && !hasTitle && !hasLabelFor && !wrappedInLabel) {
        add(lineNo, 'missing-input-label', 'error', `<input type="${type}"> is missing an associated label`);
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

function auditPath(rawPath: string, cfg: AccessibilityAuditorConfig): { path: string; findings: A11yFinding[]; fileCount: number } {
  const root = process.cwd();
  const resolved = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
  const exts = normalizeExtensions(cfg.includeExtensions);
  const files = collectUiFiles(resolved, exts);
  const findings: A11yFinding[] = [];
  for (const file of files) {
    const fileFindings = auditFile(file, root);
    findings.push(...fileFindings);
    if (findings.length >= cfg.maxFindings) break;
  }
  return {
    path: relative(root, resolved),
    findings: findings.slice(0, cfg.maxFindings),
    fileCount: files.length,
  };
}

function formatSummary(result: { path: string; findings: A11yFinding[]; fileCount: number }): string {
  if (result.findings.length === 0) {
    return `\n✅ accessibility-auditor: no issues found in ${result.path} (${result.fileCount} file${result.fileCount === 1 ? '' : 's'}).`;
  }
  const lines = result.findings.map((f) => `  - ${f.file}:${f.line} — ${f.message} (${f.rule})`);
  return (
    `\n⚠️ accessibility-auditor: ${result.findings.length} issue(s) in ${result.path} (${result.fileCount} file${result.fileCount === 1 ? '' : 's'}):\n` +
    lines.join('\n') +
    '\nConsider adding missing labels/alt text or resolving duplicate ids.'
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
    state.hookUnregister = null;

    const cfg = readConfig(api.config.extensions?.['accessibility-auditor']);

    const hook = (
      input: {
        toolName?: string | undefined;
        toolInput?: unknown;
        toolResult?: { content: string; isError: boolean } | undefined;
      },
    ): { decision?: 'block'; reason?: string; additionalContext?: string } | void => {
      if (!cfg.enabled || !cfg.onWriteEdit) return;
      if (input.toolResult?.isError) return;

      const inp = (input.toolInput ?? {}) as Record<string, unknown>;
      const sourcePath = inp['path'] as string | undefined;
      if (!sourcePath || typeof sourcePath !== 'string') return;
      if (!withinProject(sourcePath)) return;

      const exts = normalizeExtensions(cfg.includeExtensions);
      if (!matchesExtension(sourcePath, exts)) return;

      state.hookInvocationCount += 1;
      const result = auditPath(sourcePath, cfg);
      state.auditCount += 1;
      state.fileCount += result.fileCount;
      state.findingCount += result.findings.length;
      state.lastResult = {
        path: result.path,
        fileCount: result.fileCount,
        findingCount: result.findings.length,
        when: new Date().toISOString(),
      };

      if (result.findings.length === 0) return;

      const summary = formatSummary(result);
      if (cfg.severity === 'block') {
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
        const result = auditPath(rawPath, cfg);
        state.fileCount += result.fileCount;
        state.findingCount += result.findings.length;
        state.lastResult = {
          path: result.path,
          fileCount: result.fileCount,
          findingCount: result.findings.length,
          when: new Date().toISOString(),
        };

        return {
          ok: true,
          path: result.path,
          fileCount: result.fileCount,
          findingCount: result.findings.length,
          findings: result.findings,
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

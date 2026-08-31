/**
 * schema-evolution-guard plugin — guards database/API schema changes.
 *
 * Registers a `PostToolUse` hook on `write|edit` that scans files matching
 * schema-related patterns for destructive changes:
 *
 *   - DROP TABLE / DROP COLUMN (Prisma migrations, raw SQL)
 *   - NOT NULL added without a default (SQL)
 *   - Required field without a default (Prisma, TypeScript schema files)
 *   - Required field added to an OpenAPI schema (YAML/JSON)
 *
 * When a destructive pattern is found the plugin either injects an
 * `additionalContext` warning or blocks the tool, depending on `failSeverity`.
 *
 * Tools registered:
 *   - schema_evolution_status : counters + config snapshot.
 *
 * Config (`config.extensions['schema-evolution-guard']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "failSeverity": "warn", // "warn" | "block"
 *   "maxFindings": 5,
 *   "filePatterns": [
 *     "*.prisma",
 *     "*migration*.sql",
 *     "*openapi*.yaml",
 *     "*openapi*.json",
 *     "*schema*.ts"
 *   ]
 * }
 * ```
 *
 * @public
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Plugin } from '@wrongstack/core/types';
import { withinProject } from '../runtime/index.js';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

type FileKind = 'sql' | 'prisma' | 'openapi' | 'typescript-schema';

interface SchemaEvolutionState {
  invocationCount: number;
  scannedCount: number;
  skippedCount: number;
  hitCount: number;
  warningCount: number;
  blockedCount: number;
  lastFinding: string | null;
  hookUnregister: null | (() => void);
}

const state: SchemaEvolutionState = {
  invocationCount: 0,
  scannedCount: 0,
  skippedCount: 0,
  hitCount: 0,
  warningCount: 0,
  blockedCount: 0,
  lastFinding: null,
  hookUnregister: null,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface SchemaEvolutionConfig {
  enabled: boolean;
  failSeverity: 'warn' | 'block';
  maxFindings: number;
  filePatterns: string[];
}

const DEFAULT_FILE_PATTERNS = [
  '*.prisma',
  '*migration*.sql',
  '*openapi*.yaml',
  '*openapi*.json',
  '*schema*.ts',
];

const DEFAULTS: SchemaEvolutionConfig = {
  enabled: true,
  failSeverity: 'warn',
  maxFindings: 5,
  filePatterns: [...DEFAULT_FILE_PATTERNS],
};

function readConfig(raw: unknown): SchemaEvolutionConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const rawSev = typeof (r['failSeverity'] ?? r['fail_severity'] ?? r['severity'] ?? r['mode']) === 'string'
    ? String(r['failSeverity'] ?? r['fail_severity'] ?? r['severity'] ?? r['mode']).trim().toLowerCase()
    : undefined;
  const rawMax = r['maxFindings'] ?? r['max_findings'] ?? r['limit'];
  const rawPatterns = r['filePatterns'] ?? r['file_patterns'] ?? r['patterns'];
  return {
    enabled: r['enabled'] !== false,
    failSeverity: rawSev === 'block' ? 'block' : DEFAULTS.failSeverity,
    maxFindings:
      typeof rawMax === 'number' &&
      Number.isFinite(rawMax) &&
      rawMax >= 1 &&
      rawMax <= 50
        ? Math.floor(rawMax)
        : DEFAULTS.maxFindings,
    filePatterns: Array.isArray(rawPatterns)
      ? (rawPatterns as unknown[]).filter((x): x is string => typeof x === 'string')
      : DEFAULTS.filePatterns,
  };
}

// ---------------------------------------------------------------------------
// File matching
// ---------------------------------------------------------------------------

function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function matchesAnyPattern(fileName: string, patterns: string[]): boolean {
  return patterns.some((p) => patternToRegExp(p).test(fileName));
}

function fileKind(fileName: string): FileKind | null {
  const n = fileName.toLowerCase();
  if (n.endsWith('.prisma')) return 'prisma';
  if (n.endsWith('.sql')) return 'sql';
  if (n.endsWith('.yaml') || n.endsWith('.yml') || n.endsWith('.json')) return 'openapi';
  if (n.endsWith('.ts')) return 'typescript-schema';
  return null;
}

// withinProject() imported from ../runtime/index.js

// ---------------------------------------------------------------------------
// Destructive-pattern detection
// ---------------------------------------------------------------------------

function findIssues(content: string, kind: FileKind, maxFindings: number): string[] {
  const findings: string[] = [];
  const lines = content.split(/\r?\n/);
  let inOpenApiRequiredList = false;

  for (let i = 0; i < lines.length && findings.length < maxFindings; i++) {
    const line = lines[i]!;
    const lineNumber = i + 1;

    switch (kind) {
      case 'sql': {
        if (/DROP\s+TABLE\b/i.test(line)) {
          findings.push(`DROP TABLE at line ${lineNumber}`);
          continue;
        }
        if (/DROP\s+COLUMN\b/i.test(line)) {
          findings.push(`DROP COLUMN at line ${lineNumber}`);
          continue;
        }
        if (/\bNOT\s+NULL\b/i.test(line) && !/DEFAULT\b/i.test(line) && !/DROP\b/i.test(line)) {
          findings.push(`NOT NULL added without default at line ${lineNumber}`);
        }
        break;
      }

      case 'prisma': {
        const match = line.match(/^\s+([A-Za-z_]\w*)\s+([A-Za-z_]\w+)(\?)?(\s+@.*)?$/);
        const attrs = match?.[4] ?? '';
        // Exempt by attribute NAME (the token before any parenthesized
        // arguments), never by substring: `attrs.includes('@id')` also
        // matched `@idempotencyKey`-style attributes and silently waived
        // genuinely required fields.
        const isExempt = attrs.split(/\s+/).some((t) => {
          const name = t.replace(/\(.*$/, '');
          return (
            name === '@default' ||
            name === '@id' ||
            name === '@updatedAt' ||
            name === '@relation' ||
            name === '@ignore'
          );
        });
        if (match && !match[3] && !isExempt) {
          findings.push(
            `required field without default at line ${lineNumber}: ${match[1]} (${match[2]})`,
          );
        }
        break;
      }

      case 'openapi': {
        const requiredMatch = line.match(/\b["']?required["']?\s*:\s*(.*)/i);
        if (requiredMatch) {
          const rest = (requiredMatch[1] ?? '').trim();
          if (rest.startsWith('[')) {
            const close = rest.indexOf(']');
            const inner = close >= 0 ? rest.slice(1, close) : rest.slice(1);
            const items = inner
              .split(',')
              .map((s) => s.trim().replace(/^["']|["']$/g, ''))
              .filter(Boolean);
            for (const item of items) {
              if (findings.length >= maxFindings) break;
              findings.push(
                `required field added to OpenAPI schema at line ${lineNumber}: ${item}`,
              );
            }
            inOpenApiRequiredList = false;
          } else if (rest === '') {
            inOpenApiRequiredList = true;
          } else {
            inOpenApiRequiredList = false;
          }
          continue;
        }

        if (inOpenApiRequiredList) {
          const listMatch = line.match(/^\s*-\s*(\w+)/);
          if (listMatch) {
            findings.push(
              `required field added to OpenAPI schema at line ${lineNumber}: ${listMatch[1]}`,
            );
            continue;
          }
          if (line.trim() !== '' && !/^\s*#/.test(line)) {
            inOpenApiRequiredList = false;
          }
        }
        break;
      }

      case 'typescript-schema': {
        const match = line.match(/^\s*(\w+)(\?)?\s*:\s*([^=;\n]+?);?$/);
        if (match && !match[2] && !match[3]?.includes('=')) {
          findings.push(`required field without default at line ${lineNumber}: ${match[1]}`);
        }
        break;
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'schema-evolution-guard',
  version: '0.1.0',
  description:
    'PostToolUse hook that guards database/API schema changes by detecting destructive patterns in schema files',
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
      failSeverity: {
        type: 'string',
        enum: ['warn', 'block'],
        default: 'warn',
        description: 'warn = inject additionalContext; block = refuse the mutating tool.',
      },
      maxFindings: {
        type: 'number',
        minimum: 1,
        maximum: 50,
        default: 5,
        description: 'Maximum destructive findings reported per file.',
      },
      filePatterns: {
        type: 'array',
        items: { type: 'string' },
        default: DEFAULT_FILE_PATTERNS,
        description: 'Basename patterns that trigger the scan.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.invocationCount = 0;
    state.scannedCount = 0;
    state.skippedCount = 0;
    state.hitCount = 0;
    state.warningCount = 0;
    state.blockedCount = 0;
    state.lastFinding = null;
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }

    const cfg = readConfig(api.config.extensions?.['schema-evolution-guard']);

    const hook = (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
      toolResult?: { content: string; isError: boolean } | undefined;
    }): { decision?: 'block'; reason?: string; additionalContext?: string } | void => {
      if (!cfg.enabled) return;

      // Skip if the write/edit itself errored.
      if (input.toolResult?.isError) return;

      const toolInput = (input.toolInput ?? {}) as Record<string, unknown>;
      const rawPath =
        toolInput['path'] ??
        toolInput['filePath'] ??
        toolInput['file_path'] ??
        toolInput['TargetFile'] ??
        toolInput['targetFile'] ??
        toolInput['file'];
      const filePath = typeof rawPath === 'string' && rawPath.trim() ? rawPath.trim() : undefined;
      if (!filePath) return;

      state.invocationCount += 1;

      const fileName = basename(filePath);
      if (!matchesAnyPattern(fileName, cfg.filePatterns)) {
        state.skippedCount += 1;
        return;
      }

      const kind = fileKind(fileName);
      if (!kind) {
        state.skippedCount += 1;
        return;
      }

      let content: string | undefined;
      if (typeof toolInput['content'] === 'string') {
        content = toolInput['content'];
      } else if (typeof toolInput['CodeContent'] === 'string') {
        content = toolInput['CodeContent'];
      } else if (typeof toolInput['code'] === 'string') {
        content = toolInput['code'];
      } else if (typeof toolInput['text'] === 'string') {
        content = toolInput['text'];
      } else if (typeof toolInput['contents'] === 'string') {
        content = toolInput['contents'];
      } else if (typeof toolInput['body'] === 'string') {
        content = toolInput['body'];
      } else if (typeof toolInput['new_string'] === 'string') {
        content = toolInput['new_string'];
      } else if (typeof toolInput['ReplacementContent'] === 'string') {
        content = toolInput['ReplacementContent'];
      } else if (typeof toolInput['newContent'] === 'string') {
        content = toolInput['newContent'];
      } else if (withinProject(filePath)) {
        try {
          content = readFileSync(filePath, 'utf-8');
        } catch {
          content = undefined;
        }
      }

      if (content === undefined) {
        state.skippedCount += 1;
        return;
      }

      state.scannedCount += 1;
      const findings = findIssues(content, kind, cfg.maxFindings);
      if (findings.length === 0) return;

      state.hitCount += 1;
      state.lastFinding = findings[0] ?? null;

      const header = `\n⚠️ schema-evolution-guard: destructive schema pattern(s) detected in ${filePath}`;
      const body = findings.map((f) => `  - ${f}`).join('\n');
      const suffix =
        cfg.failSeverity === 'block'
          ? '\nThis change is blocked. Add a safe migration path (e.g. default value, multi-step alter) and retry.'
          : '\nReview the change before proceeding; consider a safer migration path.';
      const message = `${header}\n${body}${suffix}`;

      if (cfg.failSeverity === 'block') {
        state.blockedCount += 1;
        return { decision: 'block' as const, reason: message };
      }

      state.warningCount += 1;
      return { additionalContext: message };
    };

    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook, {
      background: true,
    });

    // --- schema_evolution_status tool ---
    api.tools.register({
      name: 'schema_evolution_status',
      description:
        'Reports schema-evolution-guard state: config, file patterns, and per-session counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          failSeverity: cfg.failSeverity,
          maxFindings: cfg.maxFindings,
          filePatterns: cfg.filePatterns,
          counters: {
            invocations: state.invocationCount,
            scanned: state.scannedCount,
            skipped: state.skippedCount,
            hits: state.hitCount,
            warnings: state.warningCount,
            blocked: state.blockedCount,
          },
          lastFinding: state.lastFinding,
        };
      },
    });

    api.log.info('schema-evolution-guard plugin loaded', {
      version: '0.1.0',
      failSeverity: cfg.failSeverity,
      filePatterns: cfg.filePatterns,
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
      invocations: state.invocationCount,
      scanned: state.scannedCount,
      skipped: state.skippedCount,
      hits: state.hitCount,
      warnings: state.warningCount,
      blocked: state.blockedCount,
    };
    state.invocationCount = 0;
    state.scannedCount = 0;
    state.skippedCount = 0;
    state.hitCount = 0;
    state.warningCount = 0;
    state.blockedCount = 0;
    state.lastFinding = null;
    api.log.info('schema-evolution-guard: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message: `schema-evolution-guard: ${state.scannedCount} scan(s), ${state.hitCount} hit(s), ${state.blockedCount} blocked`,
      counters: {
        invocations: state.invocationCount,
        scanned: state.scannedCount,
        skipped: state.skippedCount,
        hits: state.hitCount,
        warnings: state.warningCount,
        blocked: state.blockedCount,
      },
      lastFinding: state.lastFinding,
    };
  },
};

export default plugin;

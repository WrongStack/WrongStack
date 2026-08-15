/**
 * license-audit-gate plugin — audits dependency licenses at install time.
 *
 * After every `bash` or `exec` tool call that looks like a package-manager
 * install/add command (`npm i`, `pnpm add`, `yarn add`, `bun add`), the
 * plugin reads `node_modules/<package>/package.json` for each newly added
 * dependency, extracts its license field(s), and checks them against an
 * allowlist. If any package's license is not on the allowlist, the hook
 * either blocks the install (default) or injects a warning note.
 *
 * Tools registered:
 * - license_audit_status : Show config + per-session counters.
 *
 * Hooks registered:
 * - PostToolUse with matcher `bash|exec`.
 *
 * Config (`config.extensions['license-audit-gate']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "allowedLicenses": ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "Unlicense"],
 *   "block": true
 * }
 * ```
 *
 * @public
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from '@wrongstack/core/types';
import { parseInstallCommands } from '../dep-guard/index.js';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface LicenseAuditState {
  invocations: number;
  installsSeen: number;
  packagesAudited: number;
  allowedCount: number;
  deniedCount: number;
  blockedCount: number;
  errorCount: number;
  lastResult: {
    passed: boolean;
    denied: string[];
    when: string;
  } | null;
  hookUnregister: null | (() => void);
}

const state: LicenseAuditState = {
  invocations: 0,
  installsSeen: 0,
  packagesAudited: 0,
  allowedCount: 0,
  deniedCount: 0,
  blockedCount: 0,
  errorCount: 0,
  lastResult: null,
  hookUnregister: null,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface LicenseAuditConfig {
  enabled: boolean;
  allowedLicenses: string[];
  block: boolean;
}

const DEFAULTS: LicenseAuditConfig = {
  enabled: true,
  allowedLicenses: ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'Unlicense'],
  block: true,
};

function normalizeStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === 'string' && s.length > 0).map((s) => s.trim());
}

function readConfig(raw: unknown): LicenseAuditConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const allowed = normalizeStrings(r['allowedLicenses']);
  return {
    enabled: r['enabled'] !== false,
    allowedLicenses: allowed.length > 0 ? allowed : [...DEFAULTS.allowedLicenses],
    block: r['block'] !== false,
  };
}

// ---------------------------------------------------------------------------
// License extraction
// ---------------------------------------------------------------------------

function extractLicenseStrings(pkg: unknown): string[] {
  if (!pkg || typeof pkg !== 'object') return [];
  const p = pkg as Record<string, unknown>;
  const out: string[] = [];

  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) {
      out.push(v.trim());
    } else if (v && typeof v === 'object' && typeof (v as Record<string, unknown>).type === 'string') {
      const t = (v as Record<string, unknown>).type as string;
      if (t.trim()) out.push(t.trim());
    }
  };

  push(p['license']);
  if (Array.isArray(p['licenses'])) {
    for (const entry of p['licenses']) push(entry);
  }

  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Install-command parsing
// ---------------------------------------------------------------------------

export function parsePackageNames(command: string): string[] {
  return [
    ...new Set(parseInstallCommands(command).flatMap((entry) => entry.packages.map((pkg) => pkg.name))),
  ];
}

// ---------------------------------------------------------------------------
// Package audit
// ---------------------------------------------------------------------------

interface PackageAuditResult {
  name: string;
  licenses: string[];
  allowed: boolean;
}

function auditPackages(names: string[], allowedLicenses: string[]): {
  ok: boolean;
  results: PackageAuditResult[];
  errors: string[];
} {
  const results: PackageAuditResult[] = [];
  const errors: string[] = [];
  const normalizedAllowed = new Set(allowedLicenses.map((l) => l.toLowerCase()));

  for (const name of names) {
    let licenses: string[] = [];
    try {
      const pkgPath = resolve('node_modules', name, 'package.json');
      const raw = JSON.parse(readFileSync(pkgPath, 'utf-8')) as unknown;
      licenses = extractLicenseStrings(raw);
    } catch {
      errors.push(name);
    }

    const allowed = licenses.length > 0 && licenses.every((l) => normalizedAllowed.has(l.toLowerCase()));
    results.push({ name, licenses, allowed });
  }

  const ok = errors.length === 0 && results.every((r) => r.allowed);
  return { ok, results, errors };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'license-audit-gate',
  version: '0.1.0',
  description:
    'PostToolUse hook that audits dependency licenses after package-manager install/add commands and blocks disallowed licenses',
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
      allowedLicenses: {
        type: 'array',
        items: { type: 'string' },
        default: DEFAULTS.allowedLicenses,
        description: 'List of allowed SPDX/license identifiers.',
      },
      block: {
        type: 'boolean',
        default: true,
        description: 'true = block the install when a disallowed license is found; false = inject a warning note.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.invocations = 0;
    state.installsSeen = 0;
    state.packagesAudited = 0;
    state.allowedCount = 0;
    state.deniedCount = 0;
    state.blockedCount = 0;
    state.errorCount = 0;
    state.lastResult = null;
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }

    const cfg = readConfig(api.config.extensions?.['license-audit-gate']);

    const hook = (
      input: {
        toolName?: string | undefined;
        toolInput?: unknown;
        toolResult?: { content: string; isError: boolean } | undefined;
      },
    ): { decision?: 'block'; reason?: string; additionalContext?: string } | void => {
      if (!cfg.enabled) return;
      // Skip if the install command itself errored.
      if (input.toolResult?.isError) return;

      const ti = (input.toolInput ?? {}) as Record<string, unknown>;
      const command = typeof ti['command'] === 'string' ? ti['command'] : '';
      if (!command) return;

      state.invocations += 1;
      const names = parsePackageNames(command);
      if (names.length === 0) return;

      state.installsSeen += 1;
      const audit = auditPackages(names, cfg.allowedLicenses);
      state.packagesAudited += names.length;

      const denied = audit.results.filter((r) => !r.allowed).map((r) => r.name);
      state.allowedCount += audit.results.filter((r) => r.allowed).length;
      state.deniedCount += denied.length;
      state.errorCount += audit.errors.length;

      state.lastResult = {
        passed: audit.ok,
        denied,
        when: new Date().toISOString(),
      };

      if (audit.ok) return;

      const lines = audit.results.map((r) => {
        const licenseText = r.licenses.length > 0 ? r.licenses.join(', ') : 'no license found';
        if (r.allowed) return `  ✅ ${r.name}: ${licenseText}`;
        return `  ❌ ${r.name}: ${licenseText} (not in allowlist)`;
      });
      if (audit.errors.length > 0) {
        lines.push(`  ⚠️ could not read package.json for: ${audit.errors.join(', ')}`);
      }
      const message =
        `license-audit-gate: dependency license check failed for newly added packages.\n` +
        `Allowed licenses: ${cfg.allowedLicenses.join(', ')}\n` +
        lines.join('\n');

      if (cfg.block) {
        state.blockedCount += 1;
        return {
          decision: 'block' as const,
          reason: message,
          additionalContext: message,
        };
      }

      return { additionalContext: message };
    };

    state.hookUnregister = api.registerHook('PostToolUse', 'bash|exec', hook as never);

    // --- license_audit_status tool ---
    api.tools.register({
      name: 'license_audit_status',
      description:
        'Reports license-audit-gate state: allowlist, block mode, and per-session audit counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          allowedLicenses: cfg.allowedLicenses,
          block: cfg.block,
          counters: {
            invocations: state.invocations,
            installsSeen: state.installsSeen,
            packagesAudited: state.packagesAudited,
            allowed: state.allowedCount,
            denied: state.deniedCount,
            blocked: state.blockedCount,
            errors: state.errorCount,
          },
          lastResult: state.lastResult,
        };
      },
    });

    api.log.info('license-audit-gate plugin loaded', {
      version: '0.1.0',
      allowedLicensesCount: cfg.allowedLicenses.length,
      block: cfg.block,
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
      invocations: state.invocations,
      installsSeen: state.installsSeen,
      packagesAudited: state.packagesAudited,
      allowed: state.allowedCount,
      denied: state.deniedCount,
      blocked: state.blockedCount,
      errors: state.errorCount,
    };
    state.invocations = 0;
    state.installsSeen = 0;
    state.packagesAudited = 0;
    state.allowedCount = 0;
    state.deniedCount = 0;
    state.blockedCount = 0;
    state.errorCount = 0;
    state.lastResult = null;
    api.log.info('license-audit-gate: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message: state.lastResult
        ? `license-audit-gate: ${state.installsSeen} install command(s) seen, ${state.deniedCount} denied, ${state.blockedCount} blocked`
        : `license-audit-gate: ${state.invocations} invocation(s), ${state.packagesAudited} package(s) audited`,
      counters: {
        invocations: state.invocations,
        installsSeen: state.installsSeen,
        packagesAudited: state.packagesAudited,
        allowed: state.allowedCount,
        denied: state.deniedCount,
        blocked: state.blockedCount,
        errors: state.errorCount,
      },
      lastResult: state.lastResult,
    };
  },
};

export default plugin;

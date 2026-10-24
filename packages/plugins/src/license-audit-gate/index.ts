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
import { dirname, join, resolve } from 'node:path';
import type { Plugin } from '@wrongstack/contracts/types';
import { shellCommandLinesFromInput } from '@wrongstack/core/security';
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
  allowedLicenses: [
    'MIT',
    'Apache-2.0',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'ISC',
    '0BSD',
    'Unlicense',
  ],
  block: true,
};

function normalizeStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === 'string' && s.length > 0).map((s) => s.trim());
}

function readConfig(raw: unknown): LicenseAuditConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const rawLicenses = r['allowedLicenses'] ?? r['allowed_licenses'] ?? r['licenses'];
  const allowed = normalizeStrings(rawLicenses);
  const rawBlock = r['block'] ?? r['fail_on_violation'] ?? r['failOnViolation'];
  return {
    enabled: r['enabled'] !== false,
    allowedLicenses: allowed.length > 0 ? allowed : [...DEFAULTS.allowedLicenses],
    block: rawBlock !== false,
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
    } else if (
      v &&
      typeof v === 'object' &&
      typeof (v as Record<string, unknown>).type === 'string'
    ) {
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
    ...new Set(
      parseInstallCommands(command).flatMap((entry) => entry.packages.map((pkg) => pkg.name)),
    ),
  ];
}

/** Managers whose installs materialize as `node_modules/<name>/package.json`.
 *  `parseInstallCommands` (shared with dep-guard) also recognizes pip/uv/cargo,
 *  but those packages never live under node_modules, so the node_modules-based
 *  license audit cannot apply to them — feeding them through would fail every
 *  read and block every legitimate non-node install. */
const AUDITABLE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/** JS-manager options whose value is the directory the install runs in. */
const INSTALL_DIR_OPTIONS = new Set(['--prefix', '-C', '--dir', '--cwd']);

function unquote(token: string): string {
  return token.replace(/^(['"])(.*)\1$/, '$2');
}

function installDirOption(segment: string): string | undefined {
  const tokens = segment.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? '';
    if (INSTALL_DIR_OPTIONS.has(token) && tokens[i + 1]) return unquote(tokens[i + 1] ?? '');
    const eq = /^(--prefix|--dir|--cwd)=(.+)$/.exec(token);
    if (eq?.[2]) return unquote(eq[2]);
  }
  return undefined;
}

interface AuditTarget {
  name: string;
  /** Directory the install ran in; the package resolves from here. */
  dir: string;
}

/**
 * Every auditable install in `command`, with the directory it installed into.
 * `parseInstallCommands` keeps the package names but not the target, so the
 * audit read `./node_modules/<name>` for `cd pkg && npm i x`, `--prefix pkg`,
 * `pnpm -C pkg add x` and `yarn --cwd pkg add x` alike — a disallowed package
 * installed into a sub-package passed whenever the root held an allowed copy.
 * A `cd` lasts until the end of its `( … )` subshell.
 */
function auditTargets(command: string, cwd: string): AuditTarget[] {
  const targets = new Map<string, AuditTarget>();
  const scopes: string[] = [];
  let dir = cwd;
  for (const raw of command.split(/&&|\|\||[;|\n\r]/)) {
    let segment = raw.trim();
    while (/^[({]/.test(segment)) {
      if (segment.startsWith('(')) scopes.push(dir);
      segment = segment.slice(1).trim();
    }
    let closes = 0;
    while (/[)}]$/.test(segment)) {
      if (segment.endsWith(')')) closes++;
      segment = segment.slice(0, -1).trim();
    }
    const cd = /^(?:cd|pushd)\s+(?:--\s+)?(\S+)$/.exec(segment);
    if (cd?.[1]) {
      dir = resolve(dir, unquote(cd[1]));
    } else {
      for (const entry of parseInstallCommands(segment)) {
        if (!AUDITABLE_MANAGERS.has(entry.manager)) continue;
        const option = installDirOption(segment);
        const at = option ? resolve(dir, option) : dir;
        for (const pkg of entry.packages)
          targets.set(`${pkg.name}\0${at}`, { name: pkg.name, dir: at });
      }
    }
    for (; closes > 0; closes--) dir = scopes.pop() ?? dir;
  }
  return [...targets.values()];
}

/** `<name>/package.json` as Node resolves it from `dir`: nearest `node_modules` up the tree. */
function readInstalledManifest(name: string, dir: string): unknown {
  let current = dir;
  for (;;) {
    try {
      return JSON.parse(
        readFileSync(join(current, 'node_modules', name, 'package.json'), 'utf-8'),
      ) as unknown;
    } catch (err) {
      const parent = dirname(current);
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || parent === current) throw err;
      current = parent;
    }
  }
}

// ---------------------------------------------------------------------------
// Package audit
// ---------------------------------------------------------------------------

interface PackageAuditResult {
  name: string;
  licenses: string[];
  allowed: boolean;
}

/** Split on TOP-LEVEL OR/AND separators only. Parentheses create
 *  sub-expressions, so `(A OR B) AND C` must never be flattened into
 *  `A OR B AND C` — the old paren-stripping regex did exactly that and
 *  turned the allow-gate into a bypass (a single allow-listed OR branch
 *  short-circuited the required AND clause). */
function splitTopLevel(expr: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      const match = separator.exec(expr.slice(i));
      if (match && match.index === 0) {
        parts.push(expr.slice(start, i).trim());
        i += match[0].length - 1;
        start = i + 1;
      }
    }
  }
  parts.push(expr.slice(start).trim());
  return parts;
}

function isLicenseAllowed(licenseStr: string, normalizedAllowed: Set<string>): boolean {
  let expr = licenseStr.trim();
  if (!expr) return false;
  if (normalizedAllowed.has(expr.toLowerCase())) return true;

  // Unwrap parentheses that wrap the ENTIRE expression: `(A)` -> `A`.
  while (expr.startsWith('(')) {
    let depth = 0;
    let close = -1;
    for (let i = 0; i < expr.length; i++) {
      if (expr[i] === '(') depth++;
      else if (expr[i] === ')') {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close !== expr.length - 1) break;
    expr = expr.slice(1, -1).trim();
  }

  const orParts = splitTopLevel(expr, /\s+OR\s+/i);
  if (orParts.length > 1) {
    return orParts.some((p) => isLicenseAllowed(p, normalizedAllowed));
  }
  const andParts = splitTopLevel(expr, /\s+AND\s+/i);
  if (andParts.length > 1) {
    return andParts.every((p) => isLicenseAllowed(p, normalizedAllowed));
  }

  return normalizedAllowed.has(expr.toLowerCase());
}

function auditPackages(
  targets: AuditTarget[],
  allowedLicenses: string[],
): {
  ok: boolean;
  results: PackageAuditResult[];
  errors: string[];
} {
  const results: PackageAuditResult[] = [];
  const errors: string[] = [];
  const normalizedAllowed = new Set(allowedLicenses.map((l) => l.toLowerCase()));

  for (const { name, dir } of targets) {
    let licenses: string[] = [];
    try {
      licenses = extractLicenseStrings(readInstalledManifest(name, dir));
    } catch {
      errors.push(name);
    }

    const allowed =
      licenses.length > 0 && licenses.every((l) => isLicenseAllowed(l, normalizedAllowed));
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
        description:
          'true = block the install when a disallowed license is found; false = inject a warning note.',
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

    const hook = (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
      toolResult?: { content: string; isError: boolean } | undefined;
    }): { decision?: 'block'; reason?: string; additionalContext?: string } | void => {
      if (!cfg.enabled) return;
      // Skip if the install command itself errored.
      if (input.toolResult?.isError) return;

      const ti = (input.toolInput ?? {}) as Record<string, unknown>;
      const { lines: cmdLines } = shellCommandLinesFromInput(ti);
      for (const key of ['CommandLine', 'input']) {
        const legacy = ti[key];
        if (typeof legacy === 'string' && legacy) cmdLines.push(legacy);
      }
      const command = cmdLines.join('\n');
      if (!command) return;

      state.invocations += 1;
      const baseCwd =
        typeof ti['cwd'] === 'string' && ti['cwd'].trim()
          ? resolve(process.cwd(), ti['cwd'].trim())
          : process.cwd();
      const targets = auditTargets(command, baseCwd);
      if (targets.length === 0) return;

      state.installsSeen += 1;
      const audit = auditPackages(targets, cfg.allowedLicenses);
      state.packagesAudited += targets.length;

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

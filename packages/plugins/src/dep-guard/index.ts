/**
 * dep-guard plugin — supervises dependency-install commands.
 *
 * Supply-chain safety at the point of no return: a `PreToolUse` hook
 * on `bash|exec` parses package-manager install commands
 * (`npm i`, `pnpm add`, `yarn add`, `bun add`, `pip install`,
 * `cargo add`) and extracts the package names being added:
 *
 *  - packages on the `deny` list        → blocked (or warned in
 *    warn mode) with the configured reason
 *  - typosquat lookalikes of `popular`  → warned ("did you mean
 *    react? you typed raect") via Levenshtein distance 1
 *  - unpinned installs (no version)     → optional warning when
 *    `warnOnUnpinned` is set
 *  - the public registry (`registryCheck`) → a name the registry does not
 *    know is flagged as possibly hallucinated; a package first published
 *    under `minPackageAgeDays` ago is refused in block mode (the
 *    slopsquatting shape: a hallucinated name someone registered); a
 *    version OSV.dev lists advisories for is flagged. A registry that does
 *    not answer never blocks — the install runs and the note says unchecked.
 *  - every install                      → a compact context note so
 *    the model consciously confirms new dependencies
 *  - after a commit (`lockfileSync`)    → a note when it changed a
 *    manifest's dependencies but not the tracked lockfile pinning them
 *    (see lockfile-sync.ts)
 *
 * Non-install commands pass through untouched.
 *
 * Config (`config.extensions['dep-guard']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "mode": "block",           // "block" | "warn" (deny-list handling)
 *   "deny": [],                 // exact names or prefix globs ("left-pad", "@evil/*")
 *   "allow": [],                // exemptions from deny
 *   "warnOnUnpinned": false,    // warn when no version is specified
 *   "typosquatCheck": true,     // warn on 1-edit lookalikes of popular packages
 *   "registryCheck": true,      // ask npm / PyPI / crates.io and OSV.dev
 *   "minPackageAgeDays": 7,     // refuse packages younger than this (block mode)
 *   "vulnerabilityCheck": true, // OSV.dev advisories for the version installed
 *   "registryTimeoutMs": 3000,  // per install command, all packages together
 *   "lockfileSync": true        // note a commit that leaves its lockfile behind
 * }
 * ```
 *
 * Toggle off with `{ "name": "dep-guard", "enabled": false }` in
 * `config.plugins`, or `"enabled": false` in the options above.
 *
 * @public
 */

import type { HookInvocationContext, Plugin } from '@wrongstack/contracts/types';
import { shellCommandLinesFromInput } from '@wrongstack/core/security';
import { parseInstallCommands } from './install-commands.js';
import { registerLockfileSync } from './lockfile-sync.js';
import { type Ecosystem, ecosystemOf, type RegistryFinding, registryVerdict } from './registry.js';

export type { ParsedInstall } from './install-commands.js';
export { isTreeInstallCommand, parseInstallCommands } from './install-commands.js';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface DepGuardState {
  invocations: number;
  installsSeen: number;
  blocks: number;
  warns: number;
  /** Times the LLM successfully confirmed a typosquat candidate. */
  llmConfirmCount: number;
  /** Times the LLM confirmation call failed or was skipped. */
  llmConfirmErrors: number;
  lastBlock: { pkg: string; command: string; when: string } | null;
  /** Registry answers, keyed `ecosystem:name@version` — each asked once per process. */
  registryCache: Map<string, RegistryFinding[]>;
  hookUnregister: null | (() => void);
  lockfileUnregister: null | (() => void);
}

const state: DepGuardState = {
  invocations: 0,
  installsSeen: 0,
  blocks: 0,
  warns: 0,
  llmConfirmCount: 0,
  llmConfirmErrors: 0,
  lastBlock: null,
  registryCache: new Map(),
  hookUnregister: null,
  lockfileUnregister: null,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface DepGuardConfig {
  enabled: boolean;
  mode: 'block' | 'warn';
  deny: string[];
  allow: string[];
  warnOnUnpinned: boolean;
  typosquatCheck: boolean;
  /**
   * When true (default OFF), the plugin asks the host Council
   * (`api.llm.council`) to confirm whether a flagged typosquat candidate
   * is actually a real (but obscure) package or genuinely a typo. Hosts
   * without Council support fall back to a One Shot LLM request.
   * The LLM's verdict is appended to the warn context, never used
   * to upgrade a warn into a block. Off by default because LLM
   * calls aren't free and the Levenshtein-1 heuristic is already a
   * strong signal.
   */
  confirmTyposquatsWithLlm: boolean;
  registryCheck: boolean;
  minPackageAgeDays: number;
  vulnerabilityCheck: boolean;
  registryTimeoutMs: number;
  lockfileSync: boolean;
}

const DEFAULTS: DepGuardConfig = {
  enabled: true,
  mode: 'block',
  deny: [],
  allow: [],
  warnOnUnpinned: false,
  typosquatCheck: true,
  confirmTyposquatsWithLlm: false,
  registryCheck: true,
  minPackageAgeDays: 7,
  vulnerabilityCheck: true,
  registryTimeoutMs: 3000,
  lockfileSync: true,
};

/** RAM guard for remembered registry answers; the oldest go first. */
const MAX_REGISTRY_CACHE = 500;

function readConfig(raw: unknown): DepGuardConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length > 0) : [];
  return {
    enabled: r['enabled'] !== false,
    mode: r['mode'] === 'warn' ? 'warn' : 'block',
    deny: strings(r['deny']),
    allow: strings(r['allow']),
    warnOnUnpinned: r['warnOnUnpinned'] === true,
    typosquatCheck: r['typosquatCheck'] !== false,
    confirmTyposquatsWithLlm: r['confirmTyposquatsWithLlm'] === true,
    registryCheck: r['registryCheck'] !== false,
    minPackageAgeDays: nonNegative(r['minPackageAgeDays'], DEFAULTS.minPackageAgeDays),
    vulnerabilityCheck: r['vulnerabilityCheck'] !== false,
    registryTimeoutMs: nonNegative(r['registryTimeoutMs'], DEFAULTS.registryTimeoutMs) || 1,
    lockfileSync: r['lockfileSync'] !== false,
  };
}

function nonNegative(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

// ---------------------------------------------------------------------------
// Deny matching + typosquat detection
// ---------------------------------------------------------------------------

function matchesPattern(name: string, pattern: string): boolean {
  if (pattern.endsWith('*'))
    return name.toLowerCase().startsWith(pattern.slice(0, -1).toLowerCase());
  return name.toLowerCase() === pattern.toLowerCase();
}

/**
 * Well-known packages used as typosquat anchors, PER ECOSYSTEM. One flat list
 * compared npm installs against PyPI/crates names: `npm i request` (a real npm
 * package) was flagged as a typosquat of the pip package `requests`.
 */
const POPULAR_PACKAGES: Record<Ecosystem, readonly string[]> = {
  npm: [
    'react',
    'react-dom',
    'express',
    'lodash',
    'axios',
    'typescript',
    'vite',
    'vitest',
    'next',
    'vue',
    'svelte',
    'zod',
    'prettier',
    'eslint',
    'jest',
    'webpack',
    'commander',
    'chalk',
    'dotenv',
  ],
  PyPI: ['requests', 'numpy', 'pandas', 'flask', 'django'],
  'crates.io': ['serde', 'tokio'],
};

/**
 * Established packages that sit one edit from an anchor on purpose
 * (`preact`/`react`, `vuex`/`vue`). Warning on them sends the model to second-
 * guess a correct dependency.
 */
const KNOWN_DISTINCT = new Set(['preact', 'vuex', 'nuxt']);

/**
 * Optimal-string-alignment distance (Levenshtein + adjacent
 * transposition). Transpositions count as ONE edit because they are
 * the classic typosquat vector: `lodahs` → `lodash`, `raect` → `react`.
 * Package names are short, so the full matrix is cheap.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => {
    const row = new Array<number>(b.length + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= b.length; j++) (d[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const row = d[i] as number[];
      const prevRow = d[i - 1] as number[];
      row[j] = Math.min(
        (prevRow[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (prevRow[j - 1] as number) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        row[j] = Math.min(row[j] as number, ((d[i - 2] as number[])[j - 2] as number) + 1);
      }
    }
  }
  return (d[a.length] as number[])[b.length] as number;
}

export function typosquatOf(name: string, ecosystem: Ecosystem | null = 'npm'): string | null {
  const lower = name.toLowerCase().replace(/^@[^/]+\//, '');
  if (KNOWN_DISTINCT.has(lower)) return null;
  const anchors = ecosystem ? POPULAR_PACKAGES[ecosystem] : Object.values(POPULAR_PACKAGES).flat();
  if (anchors.includes(lower)) return null;
  for (const popular of anchors) {
    if (editDistance(lower, popular) === 1) return popular;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

function releaseLockfileSync(): void {
  try {
    state.lockfileUnregister?.();
  } catch {
    // best-effort
  }
  state.lockfileUnregister = null;
}

const plugin: Plugin = {
  name: 'dep-guard',
  version: '0.1.0',
  description:
    'Supervises dependency installs: blocks deny-listed and just-published packages, flags typosquat lookalikes, unknown names and vulnerable versions',
  apiVersion: '^0.1.10',
  capabilities: { tools: true, hooks: true, llm: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: true, description: 'Master switch.' },
      mode: {
        type: 'string',
        enum: ['block', 'warn'],
        default: 'block',
        description: 'How deny-list hits are handled.',
      },
      deny: {
        type: 'array',
        items: { type: 'string' },
        default: [],
        description:
          'Package names (exact) or prefix globs ("@evil/*") that must not be installed.',
      },
      allow: {
        type: 'array',
        items: { type: 'string' },
        default: [],
        description: 'Exemptions that override deny.',
      },
      warnOnUnpinned: {
        type: 'boolean',
        default: false,
        description: 'Warn when a package is installed without an explicit version.',
      },
      typosquatCheck: {
        type: 'boolean',
        default: true,
        description: 'Warn when a package name is one edit away from a well-known package.',
      },
      confirmTyposquatsWithLlm: {
        type: 'boolean',
        default: false,
        description:
          'Ask the risk-review Council to assess a flagged typosquat, with One Shot fallback. Appended to the warn context, never escalates to a block. Off by default.',
      },
      registryCheck: {
        type: 'boolean',
        default: true,
        description:
          'Ask the public registry (npm, PyPI, crates.io) about each package before install: flag unknown names, refuse just-published ones in block mode. Fails open.',
      },
      minPackageAgeDays: {
        type: 'number',
        default: 7,
        description:
          'A package first published fewer days ago is refused (block mode) or flagged (warn mode).',
      },
      vulnerabilityCheck: {
        type: 'boolean',
        default: true,
        description: 'Ask OSV.dev whether the version to be installed has known advisories.',
      },
      registryTimeoutMs: {
        type: 'number',
        default: 3000,
        description:
          'Time budget for all registry lookups of one command; past it the install runs unchecked.',
      },
      lockfileSync: {
        type: 'boolean',
        default: true,
        description:
          "After a commit, note it when it changed a manifest's dependencies but not the tracked lockfile.",
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.invocations = 0;
    state.installsSeen = 0;
    state.blocks = 0;
    state.warns = 0;
    state.llmConfirmCount = 0;
    state.llmConfirmErrors = 0;
    state.lastBlock = null;
    state.registryCache.clear();
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }

    releaseLockfileSync();

    const cfg = readConfig(api.config.extensions?.['dep-guard']);

    const hook = async (
      input: { toolName?: string | undefined; toolInput?: unknown },
      hookContext?: HookInvocationContext,
    ) => {
      if (!cfg.enabled) return;
      state.invocations += 1;
      const ti = (input.toolInput ?? {}) as Record<string, unknown>;
      // Every command line the call can run: `bash`'s string, `exec`'s
      // command + args, and the workflow plugins' `{ program, args }` objects
      // (top-level or nested). Reading only a top-level string missed the last
      // two, so `exec npm install x` and `workspace_recipe_run` installs were
      // never seen (WS-2026-09-26-03).
      const { lines, truncated } = shellCommandLinesFromInput(ti);
      for (const key of ['CommandLine', 'input']) {
        const legacy = ti[key];
        if (typeof legacy === 'string' && legacy) lines.push(legacy);
      }
      const command = lines.join('\n');
      // A walk that hit its scan bounds may be hiding an install in the
      // unread region — the padding vector classifyShellSurfaceInput closes
      // by reading truncation as the worst kind. A truncated call is never
      // certified clean, whatever the visible lines show.
      if (truncated) {
        if (cfg.mode === 'block') {
          state.blocks += 1;
          state.lastBlock = {
            pkg: '<unknown: scan truncated>',
            command: command.slice(0, 200) || '<no visible command>',
            when: new Date().toISOString(),
          };
          api.metrics.counter('blocks');
          return {
            decision: 'block' as const,
            reason:
              'dep-guard: the command scan hit its depth/size bounds before reading the whole tool input — refusing to evaluate installs from an incomplete scan. Shrink or flatten the tool input and retry.',
          };
        }
        state.warns += 1;
        api.metrics.counter('warns');
        return {
          decision: 'allow' as const,
          additionalContext:
            'dep-guard: the command scan was TRUNCATED — part of this call was not scanned and may contain additional installs. Do not add dependencies from it without explicit user approval.',
        };
      }
      if (!command) return;

      const installs = parseInstallCommands(command);
      const packages = installs.flatMap((i) =>
        i.packages.map((p) => ({ ...p, ecosystem: ecosystemOf(i.manager) })),
      );
      if (packages.length === 0) return;
      state.installsSeen += 1;
      api.metrics.counter('installs_seen');

      const notes: string[] = [];
      for (const pkg of packages) {
        const allowed = cfg.allow.some((p) => matchesPattern(pkg.name, p));
        const denied = !allowed && cfg.deny.some((p) => matchesPattern(pkg.name, p));
        if (denied) {
          if (cfg.mode === 'block') {
            state.blocks += 1;
            state.lastBlock = {
              pkg: pkg.name,
              command: command.slice(0, 200),
              when: new Date().toISOString(),
            };
            api.metrics.counter('blocks');
            return {
              decision: 'block' as const,
              reason:
                `dep-guard: package "${pkg.name}" is on the deny list (config.extensions["dep-guard"].deny) — install refused. ` +
                'Ask the user before adding this dependency, or add an `allow` entry.',
            };
          }
          notes.push(
            `"${pkg.name}" is DENY-LISTED — do not add it without explicit user approval.`,
          );
        }
        if (cfg.typosquatCheck) {
          const lookalike = typosquatOf(pkg.name, pkg.ecosystem);
          if (lookalike) {
            const baseNote = `"${pkg.name}" is one edit away from the well-known package "${lookalike}" — possible typosquat. Verify the name before installing.`;
            if (cfg.confirmTyposquatsWithLlm && api.llm) {
              try {
                const reviewSignal = hookContext?.signal
                  ? AbortSignal.any([hookContext.signal, AbortSignal.timeout(3000)])
                  : AbortSignal.timeout(3000);
                const question = `Classify whether npm package "${pkg.name}" is likely a typo or typosquat of "${lookalike}".`;
                const council = api.llm.council
                  ? await api.llm.council(question, {
                      signal: reviewSignal,
                      timeoutMs: 3000,
                      context:
                        'The only supplied evidence is that the names have edit distance 1. Do not invent registry, download, ownership, or provenance facts.',
                      profile: 'risk-review',
                      options: [
                        { id: 'typo', label: 'Likely typo or typosquat' },
                        { id: 'real', label: 'Likely distinct real package' },
                        { id: 'uncertain', label: 'Insufficient evidence' },
                      ],
                    })
                  : null;
                const councilVerdict =
                  council?.status === 'decided' && council.optionId
                    ? `${council.optionId.toUpperCase()}: ${council.reason ?? council.answer ?? 'no rationale'}`
                    : null;
                const t = councilVerdict
                  ? councilVerdict
                  : (
                      await api.llm.complete(
                        `${question} Reply with ONE sentence starting with "TYPO:", "REAL:", or "UNCERTAIN:".`,
                        {
                          system:
                            'You are a supply-chain security assistant. Use only supplied evidence and preserve uncertainty.',
                          role: 'security-reviewer',
                          timeoutMs: 3000,
                          signal: reviewSignal,
                        },
                      )
                    ).text.trim();
                reviewSignal.throwIfAborted();
                if (t) {
                  state.llmConfirmCount += 1;
                  api.metrics.counter('llm_confirm');
                  notes.push(`${baseNote} LLM verdict: ${t.slice(0, 300)}`);
                } else {
                  notes.push(baseNote);
                }
              } catch {
                state.llmConfirmErrors += 1;
                notes.push(baseNote);
              }
            } else {
              notes.push(baseNote);
            }
          }
        }
        if (cfg.warnOnUnpinned && pkg.version === null) {
          notes.push(`"${pkg.name}" has no pinned version — consider "${pkg.name}@<version>".`);
        }
      }

      if (cfg.registryCheck) {
        const verdict = await registryVerdict(
          installs,
          {
            isAllowed: (name) => cfg.allow.some((p) => matchesPattern(name, p)),
            minPackageAgeDays: cfg.minPackageAgeDays,
            vulnerabilityCheck: cfg.vulnerabilityCheck,
            registryTimeoutMs: cfg.registryTimeoutMs,
            cache: state.registryCache,
            maxCacheEntries: MAX_REGISTRY_CACHE,
          },
          hookContext?.signal,
        );
        if (verdict.block && cfg.mode === 'block') {
          state.blocks += 1;
          state.lastBlock = {
            pkg: verdict.block.name,
            command: command.slice(0, 200),
            when: new Date().toISOString(),
          };
          api.metrics.counter('blocks');
          return { decision: 'block' as const, reason: verdict.block.reason };
        }
        if (verdict.block) notes.push(verdict.block.reason);
        notes.push(...verdict.notes);
      }

      if (notes.length > 0) {
        state.warns += 1;
        api.metrics.counter('warns');
        return {
          decision: 'allow' as const,
          additionalContext: `dep-guard:\n${notes.map((n) => `  - ${n}`).join('\n')}`,
        };
      }
      // Plain new-dependency note: keep it lightweight, one line.
      return {
        decision: 'allow' as const,
        additionalContext: `dep-guard: this command adds ${packages.length} dependenc${packages.length === 1 ? 'y' : 'ies'}: ${packages.map((p) => p.name).join(', ')}. Confirm each is intentional.`,
      };
    };

    state.hookUnregister = api.registerHook('PreToolUse', '*', hook as never, {
      name: 'dep-guard',
      stage: 'validate',
      failurePolicy: 'closed',
      policy: true,
    });
    if (cfg.enabled && cfg.lockfileSync) state.lockfileUnregister = registerLockfileSync(api);

    // ── dep_guard_status tool ─────────────────────────────────────────
    api.tools.register({
      name: 'dep_guard_status',
      description:
        'Reports dep-guard state: deny/allow lists, mode, and counters (installs seen, blocks, warns).',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          mode: cfg.mode,
          deny: cfg.deny,
          allow: cfg.allow,
          warnOnUnpinned: cfg.warnOnUnpinned,
          typosquatCheck: cfg.typosquatCheck,
          registryCheck: cfg.registryCheck,
          minPackageAgeDays: cfg.minPackageAgeDays,
          vulnerabilityCheck: cfg.vulnerabilityCheck,
          counters: {
            invocations: state.invocations,
            installsSeen: state.installsSeen,
            llmConfirmCount: state.llmConfirmCount,
            llmConfirmErrors: state.llmConfirmErrors,
            blocks: state.blocks,
            warns: state.warns,
          },
          lastBlock: state.lastBlock,
        };
      },
    });

    api.log.info('dep-guard plugin loaded', {
      version: '0.1.0',
      enabled: cfg.enabled,
      mode: cfg.mode,
      denyCount: cfg.deny.length,
    });
  },

  teardown(api) {
    releaseLockfileSync();
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
      llmConfirmCount: state.llmConfirmCount,
      llmConfirmErrors: state.llmConfirmErrors,
      blocks: state.blocks,
      warns: state.warns,
    };
    state.invocations = 0;
    state.installsSeen = 0;
    state.blocks = 0;
    state.warns = 0;
    state.llmConfirmCount = 0;
    state.llmConfirmErrors = 0;
    state.lastBlock = null;
    api.log.info('dep-guard: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message:
        state.lastBlock === null
          ? `dep-guard: ${state.installsSeen} install command(s) seen, ${state.blocks} block(s), ${state.warns} warn(s)`
          : `dep-guard: last block on "${state.lastBlock.pkg}" at ${state.lastBlock.when}`,
      counters: {
        invocations: state.invocations,
        installsSeen: state.installsSeen,
        llmConfirmCount: state.llmConfirmCount,
        llmConfirmErrors: state.llmConfirmErrors,
        blocks: state.blocks,
        warns: state.warns,
      },
    };
  },
};

export default plugin;

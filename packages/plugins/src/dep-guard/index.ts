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
 *  - every install                      → a compact context note so
 *    the model consciously confirms new dependencies
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
 *   "typosquatCheck": true      // warn on 1-edit lookalikes of popular packages
 * }
 * ```
 *
 * Toggle off with `{ "name": "dep-guard", "enabled": false }` in
 * `config.plugins`, or `"enabled": false` in the options above.
 *
 * @public
 */
import type { Plugin } from '@wrongstack/core/types';

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
  hookUnregister: null | (() => void);
}

const state: DepGuardState = {
  invocations: 0,
  installsSeen: 0,
  blocks: 0,
  warns: 0,
  llmConfirmCount: 0,
  llmConfirmErrors: 0,
  lastBlock: null,
  hookUnregister: null,
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
}

const DEFAULTS: DepGuardConfig = {
  enabled: true,
  mode: 'block',
  deny: [],
  allow: [],
  warnOnUnpinned: false,
  typosquatCheck: true,
  confirmTyposquatsWithLlm: false,
};

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
  };
}

// ---------------------------------------------------------------------------
// Install-command parsing
// ---------------------------------------------------------------------------

export interface ParsedInstall {
  manager: string;
  packages: Array<{ name: string; version: string | null }>;
}

const INSTALL_RE =
  /(?:^|[;&|]\s*)(npm|pnpm|yarn|bun)\s+(?:install|i|add)\s+([^;&|]+)|(?:^|[;&|]\s*)(pip3?|uv)\s+(?:pip\s+)?install\s+([^;&|]+)|(?:^|[;&|]\s*)(uv)\s+add\s+([^;&|]+)|(?:^|[;&|]\s*)(cargo)\s+add\s+([^;&|]+)/gi;

/**
 * Parse a shell command for dependency installs. Returns one entry
 * per install segment found (compound commands can contain several).
 * Bare `npm install` (restore from lockfile, no packages) yields an
 * empty package list and is NOT treated as adding dependencies.
 */
export function parseInstallCommands(command: string): ParsedInstall[] {
  const out: ParsedInstall[] = [];
  INSTALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null = INSTALL_RE.exec(command);
  while (m !== null) {
    const manager = (m[1] ?? m[3] ?? m[5] ?? m[7] ?? '').toLowerCase();
    const argString = m[2] ?? m[4] ?? m[6] ?? m[8] ?? '';
    const packages: ParsedInstall['packages'] = [];
    for (const token of argString.split(/\s+/)) {
      if (!token || token.startsWith('-')) continue;
      // Skip local paths / URLs / archives.
      if (/^(\.|\/|file:|git\+|https?:)/i.test(token) || token.endsWith('.tgz')) continue;
      const cleaned = token.replace(/^['"]|['"]$/g, '');
      if (!cleaned) continue;
      // npm-style version suffix: name@ver (careful with @scope/name@ver);
      // pip-style: name==ver / name>=ver.
      let name = cleaned;
      let version: string | null = null;
      const pipMatch =
        /^([A-Za-z0-9_.-]+(?:\[[^\]]+\])?)\s*(==|>=|<=|~=|!=|>|<)\s*(.+)$/.exec(cleaned);
      if (pipMatch?.[1]) {
        name = pipMatch[1];
        const op = pipMatch[2] ?? '';
        const ver = (pipMatch[3] ?? '').trim();
        // `==` is the historical pip pin spelling; keep the bare version.
        // Range operators stay attached so `>=1.0` is distinguishable from `1.0`.
        version = op === '==' || op === '' ? ver || null : `${op}${ver}`;
      } else {
        const at = cleaned.lastIndexOf('@');
        if (at > 0) {
          name = cleaned.slice(0, at);
          version = cleaned.slice(at + 1) || null;
        }
      }
      if (name) packages.push({ name, version });
    }
    out.push({ manager, packages });
    m = INSTALL_RE.exec(command);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deny matching + typosquat detection
// ---------------------------------------------------------------------------

function matchesPattern(name: string, pattern: string): boolean {
  if (pattern.endsWith('*'))
    return name.toLowerCase().startsWith(pattern.slice(0, -1).toLowerCase());
  return name.toLowerCase() === pattern.toLowerCase();
}

/** Well-known packages used as typosquat anchors. */
const POPULAR_PACKAGES = [
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
  'requests',
  'numpy',
  'pandas',
  'flask',
  'django',
  'serde',
  'tokio',
];

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

export function typosquatOf(name: string): string | null {
  const lower = name.toLowerCase().replace(/^@[^/]+\//, '');
  if (POPULAR_PACKAGES.includes(lower)) return null;
  for (const popular of POPULAR_PACKAGES) {
    if (editDistance(lower, popular) === 1) return popular;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'dep-guard',
  version: '0.1.0',
  description:
    'Supervises dependency installs: blocks deny-listed packages, flags typosquat lookalikes, and optionally warns on unpinned versions',
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
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }

    const cfg = readConfig(api.config.extensions?.['dep-guard']);

    const hook = async (input: { toolName?: string | undefined; toolInput?: unknown }) => {
      if (!cfg.enabled) return;
      state.invocations += 1;
      const ti = (input.toolInput ?? {}) as Record<string, unknown>;
      const rawCmd =
        ti['command'] ??
        ti['CommandLine'] ??
        ti['cmd'] ??
        ti['script'] ??
        ti['input'];
      const command = typeof rawCmd === 'string' ? rawCmd : '';
      if (!command) return;

      const installs = parseInstallCommands(command);
      const packages = installs.flatMap((i) => i.packages);
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
          const lookalike = typosquatOf(pkg.name);
          if (lookalike) {
            const baseNote = `"${pkg.name}" is one edit away from the well-known package "${lookalike}" — possible typosquat. Verify the name before installing.`;
            if (cfg.confirmTyposquatsWithLlm && api.llm) {
              try {
                const question = `Classify whether npm package "${pkg.name}" is likely a typo or typosquat of "${lookalike}".`;
                const council = api.llm.council
                  ? await api.llm.council(question, {
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
                          maxTokens: 100,
                        },
                      )
                    ).text.trim();
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

    state.hookUnregister = api.registerHook('PreToolUse', 'bash|exec', hook as never, {
      name: 'dep-guard',
      stage: 'validate',
      failurePolicy: 'closed',
      policy: true,
    });

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

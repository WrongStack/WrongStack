import * as fs from 'node:fs/promises';
import { decryptConfigSecrets } from '../security/config-secrets.js';
import { type Config, type ConfigLoader, type SyncConfig } from '../types/config.js';
import {
  DEFAULT_CONTEXT_WINDOW_MODE_ID,
  isContextWindowModeId,
  listContextWindowModes,
} from '../types/context-window.js';
import { ConfigError, ERROR_CODES } from '../types/errors.js';
import { atomicWrite, withFileLock } from '../utils/atomic-write.js';
import { backupConfigFile } from '../utils/config-backup.js';
import { type DeepMergeOptions, deepMerge as deepMergeCore } from '../utils/deep-merge.js';
import { toErrorMessage } from '../utils/error.js';
import { safeParse } from '../utils/safe-json.js';
import { safeProfileName } from '../utils/wstack-paths.js';
import { isBootstrapOnly } from './config-loader/bootstrap.js';
import {
  fillMissingDefaults,
  isPlainRecord,
} from './config-loader/default-repair.js';
import { CONFIG_BEHAVIOR_DEFAULTS } from './config-loader/defaults.js';
import { storageErrorString } from './config-loader/diagnostics.js';
import {
  ENV_MAP,
  envBoolOptional,
  type PartialConfig,
} from './config-loader/env-overrides.js';
import {
  migrateLegacySuperMemoryKey,
  removeLegacySageEngine,
} from './config-loader/legacy-sage-migration.js';
import { samePath } from './config-loader/path-identity.js';
import type {
  ConfigLoaderOptions,
  ConfigSource,
  MemoizedConfigSource,
} from './config-loader/types.js';
import type { EventBus } from '../kernel/events.js';
import type { Logger } from '../types/logger.js';
import type { SecretVault } from '../types/secret-vault.js';
import type { WstackPaths } from '../utils/wstack-paths.js';

export {
  fillMissingDefaults,
  repairConfigDefaults,
  type ConfigDefaultRepair,
  type ConfigDefaultRepairReport,
} from './config-loader/default-repair.js';
export { CONFIG_BEHAVIOR_DEFAULTS } from './config-loader/defaults.js';
export type {
  ConfigLoaderOptions,
  ConfigSource,
  MemoizedConfigSource,
} from './config-loader/types.js';

const IN_PROJECT_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'version',
  'model',
  'cwd',
  'context',
  'tools',
  'features',
  'Sage',
  'skills',
  'autonomy',
  'indexing',
  'session',
  'log',
  'launch',
  'nextPrediction',
  'hints',
  'debugStream',
  'configScope',
  'maxConcurrent',
  'uiLocale',
  'fallbackModels',
  'fallbackProfiles',
  'favoriteModels',
  'favoriteModelsOnly',
  'modelAvailabilitySchedule',
  'fallbackAuto',
  'models',
  'modelMatrix',
  'circuitBreaker',
  'adaptiveConcurrency',
  'modelRuntime',
]);

/**
 * Top-level config keys that exist on `Config` but MUST NEVER be settable
 * from a repo-committed `<project>/.wrongstack/config.json`. Each entry pairs
 * the field name with the specific way a malicious repo would abuse it. This
 * list is documentation + exhaustiveness checking; the runtime enforcement
 * is the *allow-list* above (anything not in the allow-list is stripped).
 *
 *   - `provider`     — set provider id to a custom / evil implementation →
 *                      intercepts every prompt and response.
 *   - `activeProfile` — only the trusted root bootstrap may select a profile;
 *                       accepting it here makes later writes target a profile
 *                       whose settings were never loaded.
 *   - `apiKey`       — overrides the user's API key with attacker-controlled
 *                      value, exfiltrating prompts to the attacker.
 *   - `baseUrl`      — redirects the provider endpoint so the user's real
 *                      decrypted API key is sent to the attacker's server.
 *   - `providers`    — per-provider `apiKey`/`baseUrl`/`oauthConfig` map,
 *                      same endpoint-redirect + secret-exfiltration vector.
 *   - `mcpServers`   — arbitrary `command` + `args` + `env` spawned at boot.
 *   - `hooks`        — shell command arrays attached to lifecycle events.
 *   - `plugins`      — npm package names dynamically loaded into the agent
 *                      process at boot.
 *   - `pluginManager` — controls which plugin boot states the LLM may mutate;
 *                       a repository must not weaken or replace this user policy.
 *   - `sync`         — carries `githubToken` (credential) and the repo
 *                      the user's sync push targets.
 *   - `yolo`         — flips off every permission confirmation prompt so a
 *                      malicious agent turn can run `bash` / `write` /
 *                      `install` without user approval.
 *   - `extensions`   — per-plugin namespaced config; the LSP plugin's
 *                      `servers[].command` is spawned on autoStart, and
 *                      arbitrary plugin configs can carry their own
 *                      credential / command fields → RCE / secret exposure.
 *   - `hq`           — carries `token` (HQ client credential) and `url`
 *                      (HQ endpoint, similar to `baseUrl`).
 *   - `git`          — carries `identity` (commit author/committer env
 *                      injection); a malicious repo could spoof who appears
 *                      to have authored the user's commits.
 */
const KNOWN_DENIED_IN_PROJECT: ReadonlyArray<{ key: string; reason: string }> = [
  {
    key: 'activeProfile',
    reason: 'Only the trusted root bootstrap may select the active profile.',
  },
  { key: 'provider', reason: 'Provider id override; can intercept prompts/responses.' },
  { key: 'apiKey', reason: 'Overrides user API key; exfiltrates prompts.' },
  { key: 'baseUrl', reason: 'Redirects provider endpoint; leaks real API key.' },
  { key: 'providers', reason: 'Per-provider apiKey/baseUrl/oauthConfig; same redirect/exfil.' },
  { key: 'mcpServers', reason: 'Arbitrary command/args/env spawned at boot (RCE).' },
  { key: 'hooks', reason: 'Shell command arrays on lifecycle events (RCE).' },
  { key: 'plugins', reason: 'Dynamic npm package load at boot (RCE).' },
  {
    key: 'pluginManager',
    reason: 'Controls which plugin boot states the LLM may mutate; user-owned trust policy.',
  },
  { key: 'sync', reason: 'Carries githubToken credential and target repo.' },
  { key: 'yolo', reason: 'Disables all permission confirmation prompts.' },
  { key: 'extensions', reason: 'Per-plugin config can carry command/credential fields.' },
  { key: 'hq', reason: 'Carries HQ client token credential and endpoint URL.' },
  { key: 'acp', reason: 'Per-agent ACP command/args/env override → arbitrary command exec (RCE).' },
  {
    key: 'fleet',
    reason:
      'Fleet supervision knobs: a repo-committed config could enable autonomous subagent spawning/steering/termination and mailbox traffic on the victim machine.',
  },
  {
    key: 'brain',
    reason:
      'Brain decision-layer knobs: a repo-committed config could raise the autonomy risk ceiling, switch the Brain to headless (removing the human tier), or reroute Brain decisions to an attacker-chosen provider/model.',
  },
  {
    key: 'git',
    reason:
      "Carries git.identity (GIT_AUTHOR_*/GIT_COMMITTER_* injection): a repo-committed config could spoof the author identity written into the victim's commit history (impersonation).",
  },
];

/**
 * Every top-level key that exists on the `Config` interface. This is the
 * *ground truth* used by `assertInProjectAllowListComplete()` to detect when
 * a new field has been added to `Config` without a corresponding decision
 * about whether it is safe for an attacker-controllable source to set it.
 *
 * Each entry must appear in EXACTLY ONE of:
 *   - `IN_PROJECT_ALLOWED_KEYS`   — explicitly safe for in-project config
 *   - `KNOWN_DENIED_IN_PROJECT`   — explicitly documented as unsafe
 *
 * The drift-check function below throws at runtime / test time when this
 * invariant is violated, so a forgotten update fails loudly instead of
 * silently widening the attack surface.
 */
const KNOWN_CONFIG_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'version',
  'activeProfile',
  'provider',
  'model',
  'apiKey',
  'baseUrl',
  'maxConcurrent',
  'uiLocale',
  'providers',
  'models',
  'modelMatrix',
  'context',
  'tools',
  'mcpServers',
  'fallbackModels',
  'fallbackProfiles',
  'favoriteModels',
  'favoriteModelsOnly',
  'modelAvailabilitySchedule',
  'fallbackAuto',
  'hooks',
  'plugins',
  'pluginManager',
  'log',
  'features',
  'Sage',
  'skills',
  'yolo',
  'nextPrediction',
  'cwd',
  'autonomy',
  'hints',
  'debugStream',
  'configScope',
  'indexing',
  'circuitBreaker',
  'adaptiveConcurrency',
  'launch',
  'session',
  'modelRuntime',
  'hq',
  'sync',
  'extensions',
  'acp',
  'fleet',
  'brain',
  'git',
]);

/**
 * Assert that the allow-list and deny-list together cover every top-level
 * field of `Config`. Throws on drift so the failure is loud at test time and
 * at first boot, not a silent widening of the attack surface. Exported so
 * tests (and any consumer building tooling on top of this) can call it
 * explicitly; `stripUnsafeInProjectFields()` also calls it lazily on its
 * first invocation so the guarantee is structural, not test-only.
 *
 * The check is two-sided:
 *   1. Every key in `KNOWN_CONFIG_TOP_LEVEL_KEYS` is either allowed or
 *      explicitly documented as denied (catches: "added a new field but
 *      forgot to decide").
 *   2. Every entry in `KNOWN_DENIED_IN_PROJECT` actually exists on Config
 *      (catches: "left a stale denied-field entry behind after a rename").
 *   3. The two lists are disjoint (catches: "put the same field in both
 *      lists; allow-list silently wins and the deny docs lie").
 */
export function assertInProjectAllowListComplete(): void {
  const missingFromBoth: string[] = [];
  for (const key of KNOWN_CONFIG_TOP_LEVEL_KEYS) {
    if (IN_PROJECT_ALLOWED_KEYS.has(key)) continue;
    const denied = KNOWN_DENIED_IN_PROJECT.find((d) => d.key === key);
    if (!denied) missingFromBoth.push(key);
  }
  const staleDenials = KNOWN_DENIED_IN_PROJECT.filter(
    (d) => !KNOWN_CONFIG_TOP_LEVEL_KEYS.has(d.key),
  ).map((d) => d.key);
  const duplicate = KNOWN_DENIED_IN_PROJECT.filter((d) => IN_PROJECT_ALLOWED_KEYS.has(d.key)).map(
    (d) => d.key,
  );

  const problems: string[] = [];
  if (missingFromBoth.length > 0) {
    problems.push(
      `new Config field(s) not classified as allowed or denied for in-project config: ` +
        missingFromBoth.join(', ') +
        '. Add each to IN_PROJECT_ALLOWED_KEYS (if safe) or KNOWN_DENIED_IN_PROJECT (with a reason).',
    );
  }
  if (staleDenials.length > 0) {
    problems.push(
      `KNOWN_DENIED_IN_PROJECT references keys that no longer exist on Config: ` +
        staleDenials.join(', ') +
        '. Remove them or restore the field on Config.',
    );
  }
  if (duplicate.length > 0) {
    problems.push(
      `field(s) appear in BOTH IN_PROJECT_ALLOWED_KEYS and KNOWN_DENIED_IN_PROJECT: ` +
        duplicate.join(', ') +
        '. The allow-list wins at runtime; remove from one of the two.',
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `stripUnsafeInProjectFields drift check failed:\n  - ${problems.join('\n  - ')}`,
    );
  }
}

let driftChecked = false;

/**
 * Remove forbidden top-level keys from a repo-committed in-project config
 * before it is merged. Returns a new object; the original is not mutated.
 * Emits a warning (and a `config.read` failure-style event) naming the
 * stripped keys so the behavior is observable rather than silent.
 *
 * On first invocation, runs `assertInProjectAllowListComplete()` to verify
 * the allow-list + deny-list together still cover every top-level field of
 * `Config`. The check is idempotent and the result is memoized so the cost
 * is paid at most once per process. The assertion throws on drift, which
 * surfaces the issue at boot in production and at first test invocation in
 * CI — both observable, never silent.
 */
export function stripUnsafeInProjectFields(
  inProject: PartialConfig,
  sourcePath: string,
  warn: (msg: string) => void = (msg) => console.warn(msg),
): PartialConfig {
  if (!driftChecked) {
    assertInProjectAllowListComplete();
    driftChecked = true;
  }
  const stripped: string[] = [];
  const out: PartialConfig = {};
  for (const [k, v] of Object.entries(inProject)) {
    if (IN_PROJECT_ALLOWED_KEYS.has(k)) {
      (out as Record<string, unknown>)[k] = v;
      continue;
    }
    stripped.push(k);
  }

  // Nested strip: `tools` is allow-listed (it carries benign limits), but
  // `tools.exec.allow` EXPANDS what the agent may execute — never honor that
  // from an attacker-controllable repo config. Remove it while preserving
  // `tools.exec.deny` (removing commands only narrows, so it is always safe).
  //
  // `tools.exec.danger.bypass` is the same threat model: a bypass list
  // weakens the heuristic danger gate on a per-rule basis. A malicious
  // repo that auto-loaded its own bypass rules could silently disarm
  // safety checks for anyone who clones it. Same strip semantics.
  //
  // Clone the affected objects so the caller's input is not mutated.
  const outTools = (out as Record<string, unknown>)['tools'];
  if (outTools && typeof outTools === 'object') {
    const execCfg = (outTools as Record<string, unknown>)['exec'];
    if (execCfg && typeof execCfg === 'object') {
      const hasAllow = 'allow' in (execCfg as Record<string, unknown>);
      const hasDanger = 'danger' in (execCfg as Record<string, unknown>);
      if (hasAllow || hasDanger) {
        const clonedExec: Record<string, unknown> = { ...(execCfg as Record<string, unknown>) };
        if (hasAllow) {
          delete clonedExec['allow'];
          stripped.push('tools.exec.allow');
        }
        if (hasDanger) {
          // Strip the whole `danger` object — `ExecDangerConfig` only
          // has `bypass` today, and bypass is the unsafe field, so
          // stripping the parent is equivalent and forward-compat with
          // any future fields added under `danger` that we don't yet
          // know about. Better to be conservative: anything new under
          // `danger` from a repo config is rejected until it gets an
          // explicit allow decision.
          delete clonedExec['danger'];
          stripped.push('tools.exec.danger');
        }
        (out as Record<string, unknown>)['tools'] = {
          ...(outTools as Record<string, unknown>),
          exec: clonedExec,
        };
      }
    }
  }

  // Nested strip: `skills` is allow-listed (benign prefs), but `skills.extraDirs`
  // points the loader at ARBITRARY directories to scan and inject into the
  // prompt — never honor that from an attacker-controllable repo config
  // (prompt-injection / read-into-prompt vector). `readClaudeSkills` and `mode`
  // are safe prefs and survive. `skills.registryUrl` is also stripped: it points
  // the skill-search HTTP client at an arbitrary URL whose parsed response flows
  // into the prompt (SSRF + prompt-injection vector). Safe prefs
  // (`readClaudeSkills`, `mode`, `eagerMaxChars`) survive.
  const outSkills = (out as Record<string, unknown>)['skills'];
  if (outSkills && typeof outSkills === 'object') {
    const skillsRec = outSkills as Record<string, unknown>;
    const needsClone = 'extraDirs' in skillsRec || 'registryUrl' in skillsRec;
    if (needsClone) {
      const clonedSkills = { ...skillsRec };
      if ('extraDirs' in clonedSkills) {
        delete clonedSkills['extraDirs'];
        stripped.push('skills.extraDirs');
      }
      if ('registryUrl' in clonedSkills) {
        delete clonedSkills['registryUrl'];
        stripped.push('skills.registryUrl');
      }
      (out as Record<string, unknown>)['skills'] = clonedSkills;
    }
  }

  // `Sage` is benign except for `storage.directory`: that value is a
  // filesystem write destination and accepts absolute paths in trusted user
  // config. A repo-committed config must not redirect memory logs outside the
  // project, so only the destination override is stripped.
  const outSage = (out as Record<string, unknown>)['Sage'];
  if (outSage && typeof outSage === 'object') {
    const storage = (outSage as Record<string, unknown>)['storage'];
    if (
      storage &&
      typeof storage === 'object' &&
      'directory' in (storage as Record<string, unknown>)
    ) {
      const clonedStorage = { ...(storage as Record<string, unknown>) };
      delete clonedStorage['directory'];
      (out as Record<string, unknown>)['Sage'] = {
        ...(outSage as Record<string, unknown>),
        storage: clonedStorage,
      };
      stripped.push('Sage.storage.directory');
    }
  }

  if (stripped.length > 0) {
    warn(
      JSON.stringify({
        level: 'warn',
        event: 'config.in_project_unsafe_fields_ignored',
        path: sourcePath,
        ignoredKeys: stripped,
        message:
          `Ignored ${stripped.length} field(s) from the repo-committed config ` +
          `"${sourcePath}": ${stripped.join(', ')}. ` +
          `Only a small allow-list of benign preferences (model, context, tools limits, ` +
          `features, …) may be set by <project>/.wrongstack/config.json. ` +
          `Everything else must live in your active profile config.`,
        timestamp: new Date().toISOString(),
      }),
    );
  }
  return out;
}

/**
 * Config-layer deep merge — delegates to the shared utility with
 * `arrayMode: 'concat-primitives'` and optional debug logging for
 * non-primitive array replacements.
 */
function deepMerge<T, TPatch extends object>(base: T, patch: TPatch): T {
  const opts: DeepMergeOptions = { arrayMode: 'concat-primitives' };
  if (envBoolOptional(process.env.WRONGSTACK_DEBUG_CONFIG)) {
    opts.onNonPrimitiveArrayReplace = (key, existingLen, patchLen) => {
      console.warn(
        `[config] Non-primitive array for "${key}" replaced (global + local config merge). ` +
          `Global entries: ${existingLen}, local entries: ${patchLen}.`,
      );
    };
  }
  return deepMergeCore(
    base as Record<string, unknown>,
    patch as Record<string, unknown>,
    opts,
  ) as T;
}

export class DefaultConfigLoader implements ConfigLoader {
  private readonly paths: WstackPaths;
  private readonly strict: boolean;
  private readonly vault: SecretVault | undefined;
  private readonly extraSources: ConfigSource[];
  private readonly events: EventBus | undefined;
  private readonly traceId: string | undefined;
  private readonly logger: Logger | undefined;
  private readonly jsonCache = new Map<string, MemoizedConfigSource>();

  constructor(opts: ConfigLoaderOptions) {
    this.paths = opts.paths;
    this.strict = opts.strict ?? false;
    this.vault = opts.vault;
    this.extraSources = opts.sources ?? [];
    this.events = opts.events;
    this.traceId = opts.traceId;
    this.logger = opts.logger;
  }

  /**
   * Emit a structured warning. Uses the configured Logger when available;
   * falls back to console.warn(JSON) so warnings are never silently dropped
   * during early boot (before a Logger is constructed).
   */
  private logWarn(msg: string, ctx?: Record<string, unknown>): void {
    if (this.logger) {
      this.logger.warn(msg, ctx);
    } else {
      console.warn(JSON.stringify({ ...ctx, message: msg, timestamp: new Date().toISOString() }));
    }
  }

  async load(
    opts: {
      cliFlags?: Partial<Config> | undefined;
      cwd?: string | undefined;
      skipIdentityValidation?: boolean;
    } = {},
  ): Promise<Config> {
    let cfg: PartialConfig = { ...CONFIG_BEHAVIOR_DEFAULTS } as PartialConfig;

    // Materialize behavior/settings defaults into the active profile before
    // env vars or CLI flags are applied. The root config remains bootstrap-only.
    await this.ensureGlobalDefaults();

    // Layer 2, 3 (profile), 4 & 4b: global bootstrap + profile + project-local +
    // in-project config. The global bootstrap (~/.wrongstack/config.json) is now
    // a thin file containing just version and activeProfile. User settings live in the
    // active profile's config: ~/.wrongstack/profiles/<name>/config.json.
    //
    // inProjectConfig (<project>/.wrongstack/config.json) merges AFTER
    // projectLocalConfig so it takes priority (user-intended > auto-cached).
    //
    // When the project root *is* the user's home (e.g. launching from `~`),
    // `<projectRoot>/.wrongstack/config.json` resolves to the very same file as
    // the trusted global bootstrap. Reading it again as the untrusted in-project
    // layer would strip `provider`/`apiKey`/… from the user's *own* file and
    // emit a spurious `config.in_project_unsafe_fields_ignored` warning — even
    // though the trusted global layer already merged those fields. Skip the
    // in-project read entirely on collision so trust isn't applied to a file
    // the user fully controls.
    const inProjectCollides =
      samePath(this.paths.inProjectConfig, this.paths.globalConfig) ||
      samePath(this.paths.inProjectConfig, this.paths.projectLocalConfig);
    const [bootstrap, local, inProject] = await Promise.all([
      this.readJson(this.paths.globalConfig),
      this.readJson(this.paths.projectLocalConfig),
      inProjectCollides
        ? Promise.resolve({} as PartialConfig)
        : this.readJson(this.paths.inProjectConfig),
    ]);
    // The root config is bootstrap metadata, never a settings layer. Even if
    // another process accidentally writes settings into it, only these two
    // keys may affect the runtime. Legacy settings are migrated separately,
    // and only while the selected profile file does not yet exist.
    const bootstrapMetadata = {
      ...(typeof (bootstrap as { version?: unknown }).version === 'number'
        ? { version: (bootstrap as { version: number }).version }
        : {}),
      ...(typeof (bootstrap as { activeProfile?: unknown }).activeProfile === 'string'
        ? { activeProfile: safeProfileName((bootstrap as { activeProfile: string }).activeProfile) }
        : {}),
    } as PartialConfig;
    cfg = deepMerge(cfg, bootstrapMetadata);

    // Layer 2b: active profile config.
    // Extract the active profile name from the bootstrap config (default: 'default').
    const profileName = safeProfileName(
      (bootstrap as { activeProfile?: string | undefined }).activeProfile,
    );
    const profileCfg = await this.readJson(this.paths.profileConfig(profileName));
    if (Object.keys(profileCfg).length > 0) {
      // Bootstrap metadata is authoritative only in the root config. Ignore
      // stale copies in profile files so a profile cannot select another profile.
      const profileSettings = { ...profileCfg } as Record<string, unknown>;
      delete profileSettings['version'];
      delete profileSettings['activeProfile'];
      cfg = deepMerge(cfg, profileSettings as PartialConfig);
    }

    // Bootstrap metadata is authoritative only in the root config. A stale
    // project-private override must not make later persistence target a
    // different profile than the one whose settings were loaded above.
    const localSettings = { ...local } as Record<string, unknown>;
    delete localSettings['version'];
    delete localSettings['activeProfile'];
    cfg = deepMerge(cfg, localSettings as PartialConfig);

    // The in-project config is repo-committed and therefore attacker-
    // controllable. Strip credential/endpoint/code-execution fields before
    // merging so a malicious repo cannot redirect the provider endpoint
    // (API-key exfiltration) or auto-run an MCP server / hook (RCE) on launch.
    cfg = deepMerge(
      cfg,
      stripUnsafeInProjectFields(
        inProject,
        this.paths.inProjectConfig,
        this.logger ? (msg: string) => this.logger!.warn(msg) : undefined,
      ),
    );

    // Layer 4: env vars
    for (const [key, fn] of Object.entries(ENV_MAP)) {
      const v = process.env[key];
      if (v) fn(cfg, v);
    }

    // Layer 5: extra sources — sorted by priority (lowest first).
    // When priorities tie, sort by name for deterministic order.
    const sorted = [...this.extraSources].sort((a, b) => {
      const pd = (a.priority ?? 50) - (b.priority ?? 50);
      if (pd !== 0) return pd;
      return a.name.localeCompare(b.name);
    });
    for (const src of sorted) {
      try {
        const patch = await src.read();
        if (patch && Object.keys(patch).length > 0) {
          cfg = deepMerge(cfg, patch);
        }
      } catch (err) {
        // Best-effort: skip failing sources so one bad source doesn't block boot.
        this.logWarn('Config source load failed', {
          event: 'config.source_load_failed',
          source: src.name,
          message: toErrorMessage(err),
        });
      }
    }

    // Layer 6: CLI flags
    if (opts.cliFlags) {
      cfg = deepMerge(cfg, opts.cliFlags);
    }

    // Decrypt apiKey-like fields if a vault is configured.
    if (this.vault) {
      cfg = decryptConfigSecrets(cfg, this.vault);
    }

    // Multi-key resolution: when a provider has `apiKeys[]` configured,
    // mirror the active entry into `apiKey` so downstream construction
    // code (provider registry, wire adapters) needs no changes. Honors
    // `activeKey` (by label), else falls back to the first entry. A
    // pre-existing `apiKey` set by env/CLI flags wins so an explicit
    // override still beats the saved list.
    if (cfg.providers) {
      for (const pcfg of Object.values(cfg.providers)) {
        if (!pcfg || typeof pcfg !== 'object') continue;
        const rawKeys = (pcfg as { apiKeys?: unknown | undefined }).apiKeys;
        if (!Array.isArray(rawKeys) || rawKeys.length === 0) continue;
        // Each apiKeys entry came from arbitrary JSON. Filter to entries
        // that actually have a string apiKey + label so a malformed array
        // (null entry, missing field) doesn't crash the .find / chosen.apiKey
        // path below.
        const keys = rawKeys.filter(
          (k): k is { label: string; apiKey: string } =>
            !!k &&
            typeof k === 'object' &&
            typeof (k as { label?: unknown | undefined }).label === 'string' &&
            typeof (k as { apiKey?: unknown | undefined }).apiKey === 'string',
        );
        if (keys.length === 0) continue;
        const existing = (pcfg as { apiKey?: string | undefined }).apiKey;
        if (existing && existing.length > 0) continue;
        const activeLabel = (pcfg as { activeKey?: string | undefined }).activeKey;
        const chosen = activeLabel
          ? (keys.find((k) => k.label === activeLabel) ?? keys[0])
          : keys[0];
        if (chosen?.apiKey) {
          (pcfg as { apiKey?: string | undefined }).apiKey = chosen.apiKey;
        }
      }
    }

    // `Sage.storage.engine` used to select JSONL. SQLite is now the
    // sole backend, so ignore the retired key from every config layer.
    removeLegacySageEngine(cfg as Record<string, unknown>);
    this.validateBehavior(cfg);
    if (this.strict && !opts.skipIdentityValidation) {
      this.validateIdentity(cfg);
    }
    // In strict mode, validateIdentity has confirmed provider/model are set;
    // it's safe to assert the full Config contract. In non-strict mode the
    // caller (e.g. early-boot wizard) accepts a Partial and constructs the
    // provider later, so we deliberately return without the cast.
    return Object.freeze(cfg) as Config;
  }

  /** Check whether a config object contains only the two bootstrap keys. */
  private static isBootstrapOnly(config: Record<string, unknown>): boolean {
    return isBootstrapOnly(config);
  }

  private async ensureGlobalDefaults(): Promise<void> {
    const fp = this.paths.globalConfig;
    const t0 = Date.now();
    try {
      await withFileLock(fp, async () => {
        let parsed: Record<string, unknown>;
        let fileExisted = true;
        try {
          const raw = await fs.readFile(fp, 'utf8');
          const result = safeParse<unknown>(raw);
          if (!result.ok || !isPlainRecord(result.value)) {
            return;
          }
          parsed = result.value;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            this.events?.emit('storage.error', {
              sessionId: '~config~',
              store: 'config',
              filePath: fp,
              operation: 'ensure_defaults',
              outcome: 'failure',
              error: storageErrorString(err),
              recoverable: false,
              durationMs: Date.now() - t0,
              ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
            });
            this.logWarn('Config defaults read failed', {
              event: 'config.defaults_read_failed',
              path: fp,
              message: toErrorMessage(err),
            });
            return;
          }
          fileExisted = false;
          parsed = {};
        }

        // Do not silently normalize an explicit unsupported bootstrap schema.
        // Leave it intact so load() can surface the version error to the user.
        if (parsed['version'] !== undefined && parsed['version'] !== 1) return;

        const rawProfileName = (parsed as { activeProfile?: string | undefined }).activeProfile;
        const profileName = safeProfileName(rawProfileName);
        const profileFp = this.paths.profileConfig(profileName);

        // Run before trimming so a genuinely legacy flat config can be moved
        // into a missing profile. Once a profile file exists, root-level
        // settings are ignored rather than merged into the active profile.
        await this.ensureProfileConfig(profileFp, parsed, fileExisted);

        // Bootstrap config now only stores version + activeProfile.
        // Full behavior defaults go into the profile config instead.
        const bootstrap: Record<string, unknown> = {
          version: 1,
          activeProfile: profileName,
        };

        let needsBootstrapWrite = false;
        // If version is missing or wrong, write the bootstrap.
        if ((parsed as { version?: number | undefined }).version !== 1) {
          needsBootstrapWrite = true;
        }
        // If activeProfile is missing from the existing parsed config, flag it.
        if (parsed.activeProfile === undefined || parsed.activeProfile !== profileName) {
          needsBootstrapWrite = true;
        }
        // If the bootstrap has extra keys beyond version+activeProfile, trim it.
        if (!DefaultConfigLoader.isBootstrapOnly(parsed)) {
          needsBootstrapWrite = true;
        }

        if (needsBootstrapWrite) {
          // Back up the current root config before overwriting
          await backupConfigFile(fp, this.paths);
          await atomicWrite(fp, JSON.stringify(bootstrap, null, 2), { mode: 0o600 });
          this.events?.emit('storage.write', {
            sessionId: '~config~',
            store: 'config',
            filePath: fp,
            operation: 'ensure_defaults',
            outcome: 'success',
            durationMs: Date.now() - t0,
            ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
          });
        }
      });
    } catch (err) {
      this.events?.emit('storage.error', {
        sessionId: '~config~',
        store: 'config',
        filePath: fp,
        operation: 'ensure_defaults',
        outcome: 'failure',
        error: storageErrorString(err),
        recoverable: false,
        durationMs: Date.now() - t0,
        ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      });
      this.logWarn('Config defaults write failed', {
        event: 'config.defaults_write_failed',
        path: fp,
        message: toErrorMessage(err),
      });
    }
  }

  /**
   * Ensure a profile config file exists at the given path.
   * On first boot: migrate content from the old flat global config, or seed
   * with behavior defaults. Subsequent boots: fill any missing keys from
   * CONFIG_BEHAVIOR_DEFAULTS (keeping user settings intact).
   *
   * Once a profile file exists, settings found in the root bootstrap are
   * ignored. This prevents stale or accidentally-written root values from
   * becoming a hidden settings source alongside profiles.
   */
  private async ensureProfileConfig(
    profileFp: string,
    oldGlobalParsed: Record<string, unknown>,
    oldFileExisted: boolean,
  ): Promise<void> {
    const t0 = Date.now();

    // No nested file lock: the profile write is idempotent (same content from
    // all writers) and atomicWrite handles concurrent writes atomically on
    // every platform.  Using withFileLock here caused a second lock acquisition
    // inside the outer ensureGlobalDefaults() lock — under high concurrency
    // (50+ peers) the nested lock could time out, silently aborting the
    // migration and leaving the bootstrap overstuffed forever.
    let parsed: Record<string, unknown>;
    let existed = true;
    try {
      const raw = await fs.readFile(profileFp, 'utf8');
      const result = safeParse<unknown>(raw);
      if (!result.ok || !isPlainRecord(result.value)) {
        this.logWarn('Profile config parse failed — falling back to defaults', {
          event: 'config.profile_parse_failed',
          path: profileFp,
        });
        parsed = {};
      } else {
        parsed = result.value;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logWarn('Profile config read failed', {
          event: 'config.profile_read_failed',
          path: profileFp,
          message: toErrorMessage(err),
        });
        return;
      }
      existed = false;
      parsed = {};
    }

    const removedLegacyEngine = removeLegacySageEngine(parsed);

    // Migration from old flat config to profile: If the old global config
    // existed and had any setting at all (can be just `version` + one user
    // setting like `mcpServers`), promote them into the new profile config.
    //
    let seed: Record<string, unknown>;
    if (!existed && oldFileExisted && Object.keys(oldGlobalParsed).length >= 1) {
      // Copy old global content into the profile, excluding bootstrap-only fields.
      seed = { ...oldGlobalParsed };
      delete seed['activeProfile'];
      removeLegacySageEngine(seed);
      // Fill in any missing behavior defaults.
      const filled = fillMissingDefaults(seed, CONFIG_BEHAVIOR_DEFAULTS as Record<string, unknown>);
      seed = filled.value;
    } else {
      // Normal boot: fill missing defaults on existing (or empty) profile.
      const filled = fillMissingDefaults(
        parsed,
        CONFIG_BEHAVIOR_DEFAULTS as Record<string, unknown>,
      );
      if (!filled.changed && !removedLegacyEngine) return; // Nothing to write
      seed = filled.value;
    }

    await backupConfigFile(profileFp, this.paths);
    await atomicWrite(profileFp, JSON.stringify(seed, null, 2), { mode: 0o600 });
    this.events?.emit('storage.write', {
      sessionId: '~config~',
      store: 'config',
      filePath: profileFp,
      operation: 'ensure_profile_defaults',
      outcome: 'success',
      durationMs: Date.now() - t0,
      ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
    });
  }

  /**
   * Persist sync config to the active profile's sync.json, with the token encrypted
   * by the vault (if provided). The file is isolated from the main config
   * hierarchy to prevent accidental commits.
   */
  async persistSyncConfig(cfg: SyncConfig): Promise<void> {
    let toWrite = { ...cfg };
    if (this.vault && toWrite.githubToken && !toWrite.githubToken.startsWith('enc:')) {
      // Re-encrypt if plaintext (e.g. came from in-memory configStore update
      // rather than direct /sync enable call). Idempotent for already-encrypted.
      toWrite = { ...toWrite, githubToken: this.vault.encrypt(toWrite.githubToken) };
    }
    const fp = this.paths.syncConfig;
    const t0 = Date.now();
    try {
      await atomicWrite(fp, JSON.stringify(toWrite, null, 2), { mode: 0o600 });
      this.events?.emit('storage.write', {
        sessionId: '~config~',
        store: 'config',
        filePath: fp,
        operation: 'persist_sync',
        outcome: 'success',
        durationMs: Date.now() - t0,
        ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      });
    } catch (err) {
      this.events?.emit('storage.error', {
        sessionId: '~config~',
        store: 'config',
        filePath: fp,
        operation: 'persist_sync',
        outcome: 'failure',
        error: storageErrorString(err),
        recoverable: false,
        durationMs: Date.now() - t0,
        ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      });
      throw err;
    }
  }

  /**
   * Read the active profile's sync.json (encrypted GitHub token storage) and decrypt
   * the token if a vault is available. Returns null if the file doesn't exist.
   * This is separate from main config loading because sync.json is intentionally
   * isolated — it should never be part of project-local or env-driven config.
   */
  async loadSyncConfig(): Promise<SyncConfig | null> {
    const fp = this.paths.syncConfig;
    const t0 = Date.now();
    try {
      const raw = await fs.readFile(fp, 'utf8');
      const parsed = safeParse<SyncConfig>(raw);
      if (!parsed.ok || !parsed.value) {
        this.events?.emit('storage.read', {
          sessionId: '~config~',
          store: 'config',
          filePath: fp,
          operation: 'load_sync',
          outcome: 'failure',
          durationMs: Date.now() - t0,
          error: 'parse error or empty file',
          ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
        });
        return null;
      }

      // Decrypt the token if vault is available (field name matches secret pattern)
      if (this.vault) {
        const decrypted = decryptConfigSecrets({ sync: parsed.value } as PartialConfig, this.vault);
        const result = (decrypted as { sync: SyncConfig }).sync ?? null;
        this.events?.emit('storage.read', {
          sessionId: '~config~',
          store: 'config',
          filePath: fp,
          operation: 'load_sync',
          outcome: 'success',
          durationMs: Date.now() - t0,
          ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
        });
        return result;
      }
      this.events?.emit('storage.read', {
        sessionId: '~config~',
        store: 'config',
        filePath: fp,
        operation: 'load_sync',
        outcome: 'success',
        durationMs: Date.now() - t0,
        ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      });
      return parsed.value;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // Non-ENOENT failures (EACCES, ENOSPC, etc.) — emit storage.read failure, then return null
      this.events?.emit('storage.read', {
        sessionId: '~config~',
        store: 'config',
        filePath: fp,
        operation: 'load_sync',
        outcome: 'failure',
        durationMs: Date.now() - t0,
        error: storageErrorString(err),
        ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      });
      this.logWarn('Config sync load failed', {
        event: 'config.sync_load_failed',
        message: toErrorMessage(err),
      });
      return null;
    }
  }

  private async readJson(file: string): Promise<PartialConfig> {
    const t0 = Date.now();
    let mtimeMs: number | null = null;
    try {
      const stat = await fs.stat(file);
      mtimeMs = stat.mtimeMs;
      const cached = this.jsonCache.get(file);
      if (cached && cached.mtimeMs === mtimeMs) {
        return structuredClone(cached.value);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.jsonCache.set(file, { mtimeMs: null, value: {} });
        return {};
      }
      this.events?.emit('storage.read', {
        sessionId: '~config~',
        store: 'config',
        filePath: file,
        operation: 'read_json',
        outcome: 'failure',
        durationMs: Date.now() - t0,
        error: storageErrorString(err),
        ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      });
      this.logWarn('Config read failed (stat)', {
        event: 'config.read_failed',
        path: file,
        message: toErrorMessage(err),
      });
      return {};
    }

    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.events?.emit('storage.read', {
          sessionId: '~config~',
          store: 'config',
          filePath: file,
          operation: 'read_json',
          outcome: 'failure',
          durationMs: Date.now() - t0,
          error: storageErrorString(err),
          ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
        });
        this.logWarn('Config read failed (read)', {
          event: 'config.read_failed',
          path: file,
          message: toErrorMessage(err),
        });
      }
      this.jsonCache.set(file, { mtimeMs: null, value: {} });
      return {};
    }
    const parsed = safeParse<PartialConfig>(raw);
    if (!parsed.ok || !parsed.value) {
      this.events?.emit('storage.read', {
        sessionId: '~config~',
        store: 'config',
        filePath: file,
        operation: 'read_json',
        outcome: 'failure',
        durationMs: Date.now() - t0,
        error: 'parse error or empty file',
        ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      });
      this.logWarn('Config parse failed — falling back to defaults', {
        event: 'config.parse_failed',
        path: file,
      });
      return {};
    }
    // Migrate the pre-SAGE `superMemory` key per SOURCE, before the layered
    // merge: after merging, `Sage` always exists (behavior defaults), so a
    // post-merge migration could only ever see defaults win and would drop the
    // user's legacy settings.
    migrateLegacySuperMemoryKey(parsed.value as Record<string, unknown>);
    this.jsonCache.set(file, { mtimeMs, value: structuredClone(parsed.value) });
    return parsed.value;
  }

  private validateBehavior(cfg: PartialConfig): void {
    /* v8 ignore start -- defensive: config defaults always seed version:1 before validation */
    if (cfg.version === undefined)
      throw new ConfigError({
        message: 'Config: missing version field',
        code: ERROR_CODES.CONFIG_INVALID,
        context: { field: 'version' },
      });
    /* v8 ignore stop */
    if (cfg.version !== 1)
      throw new ConfigError({
        message: `Config: unsupported version ${cfg.version}`,
        code: ERROR_CODES.CONFIG_INVALID,
        context: { field: 'version', actual: cfg.version },
      });
    const c = cfg.context;
    if (!c)
      throw new ConfigError({
        message: 'Config: missing context section',
        code: ERROR_CODES.CONFIG_INVALID,
        context: { field: 'context' },
      });
    // A user-edited config.json can land strings here ("0.6") and slip past
    // truthiness checks; the `>=` comparison then coerces silently and the
    // threshold ordering check passes for nonsense values. Validate types
    // explicitly so misconfigs surface here, not as confusing failures deep
    // in the auto-compaction logic.
    const fields: Array<keyof typeof c> = ['warnThreshold', 'softThreshold', 'hardThreshold'];
    for (const f of fields) {
      const v = c[f];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new ConfigError({
          message: `Config: context.${String(f)} must be a finite number (got ${typeof v})`,
          code: ERROR_CODES.CONFIG_INVALID,
          context: { field: `context.${String(f)}`, actualType: typeof v },
        });
      }
    }
    if (c.warnThreshold >= c.softThreshold || c.softThreshold >= c.hardThreshold) {
      throw new ConfigError({
        message: 'Config: context thresholds must satisfy warn < soft < hard',
        code: ERROR_CODES.CONFIG_INVALID,
        context: { warn: c.warnThreshold, soft: c.softThreshold, hard: c.hardThreshold },
      });
    }
    if (c.mode !== undefined && !isContextWindowModeId(c.mode)) {
      // An unknown mode (typo or value from an older/renamed scheme) should not
      // brick the CLI — unlike the numeric thresholds above there is a safe
      // default. Warn and fall back rather than throwing.
      const known = listContextWindowModes()
        .map((m) => m.id)
        .join(', ');
      this.logWarn(
        `Ignoring unknown context.mode "${c.mode}" — falling back to "${DEFAULT_CONTEXT_WINDOW_MODE_ID}"`,
        { event: 'config.unknown_context_mode', mode: c.mode, known },
      );
      c.mode = DEFAULT_CONTEXT_WINDOW_MODE_ID;
    }
  }

  private validateIdentity(cfg: PartialConfig): void {
    if (!cfg.provider) {
      throw new ConfigError({
        message: 'Config: no provider configured. Run `wstack init` or set WRONGSTACK_PROVIDER.',
        code: ERROR_CODES.CONFIG_INVALID,
        context: { field: 'provider' },
      });
    }
    if (!cfg.model) {
      throw new ConfigError({
        message: 'Config: no model configured. Run `wstack init` or set WRONGSTACK_MODEL.',
        code: ERROR_CODES.CONFIG_INVALID,
        context: { field: 'model' },
      });
    }
  }
}

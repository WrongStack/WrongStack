import type { Config } from '../../types/config.js';

/**
 * Partial config shape shared with the config loader. Must stay assignment-
 * compatible with the loader's `PartialConfig` so the `stripUnsafeInProjectFields`
 * call site (which passes a `PartialConfig`) type-checks under `strict: true`.
 * `Partial<Config>` has no index signature, so a plain `Record<string, unknown>`
 * parameter type would reject that argument.
 */
type PartialConfig = Partial<Config> & {
  providers?: Record<
    string,
    { apiKey?: string | undefined; baseUrl?: string | undefined; type?: string | undefined }
  >;
  /** Fields that came from environment variables — must not be persisted. */
  _envSource?: Set<string> | undefined;
};

/**
 * Top-level config keys a REPO-COMMITTED `<project>/.wrongstack/config.json`
 * (the `inProjectConfig` layer) IS permitted to set. The in-project config
 * is attacker-controllable (it ships inside a cloned/pulled repository), so
 * every other field is denied by default. Anything not in this list is
 * stripped by `stripUnsafeInProjectFields()` before the merge.
 *
 * Why an allow-list and not a deny-list? A deny-list of N known-bad keys is
 * structurally incomplete: any new field added to `Config` without a matching
 * edit to the deny list silently becomes attacker-controllable, and the next
 * field that carries an executable string or a credential immediately turns
 * `<project>/.wrongstack/config.json` into an RCE / secret-exfiltration
 * vector the moment someone clones a malicious repo. An allow-list inverts
 * that — new fields are denied by default and must be explicitly added, so a
 * forgotten update is a safe default instead of an unsafe one.
 *
 * Each entry below is a benign user-preference that a project author may
 * legitimately want to pin for everyone who works in the repo:
 *
 *   - `version`            — schema marker required for any config merge.
 *   - `model`              — model id (also settable via env / CLI).
 *   - `cwd`                — working-directory hint (UX, not a permission).
 *   - `context`            — compaction thresholds, mode, preserveK.
 *   - `tools`              — iteration / timeouts / restrictToProjectRoot.
 *   - `features`           — feature toggles (display-only side effects).
 *   - `autonomy`           — autoProceedDelayMs, thinkingWord.
 *   - `indexing`           — onSessionStart / onEdit / debounceMs.
 *   - `session`            — audit level + sampling.
 *   - `log`                — log level.
 *   - `launch`             — saved launch prefs.
 *   - `nextPrediction`     — toggle `/next` after-turn suggestions.
 *   - `hints`              — toggle startup hints.
 *   - `debugStream`        — verbose SSE dump (noisy, not security-sensitive).
 *   - `configScope`        — where settings persist.
 *   - `maxConcurrent`      — fleet concurrency limit.
 *   - `fallbackModels`     — model references tried on 429/5xx.
 *   - `fallbackProfiles`   — named fallback chains.
 *   - `favoriteModels`     — model references preferred for display/routing.
 *   - `favoriteModelsOnly` — restrict auto-derived chains to favorite models.
 *   - `fallbackAuto`       — derived-fallback toggle.
 *   - `models`             — custom model definitions (data, not code).
 *   - `modelMatrix`        — per-task model matrix.
 *   - `circuitBreaker`     — process circuit-breaker config (process gating).
 *   - `adaptiveConcurrency` — adaptive concurrency controller.
 *   - `modelRuntime`       — runtime reasoning/cache/parameters.
 *   - `Sage`        — benign local memory storage/injection/hygiene knobs.
 *
 * Fields deliberately NOT in the allow-list (and therefore always stripped
 * from `<project>/.wrongstack/config.json`) — see `KNOWN_DENIED_IN_PROJECT`
 * below for the reason each is unsafe.
 */
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

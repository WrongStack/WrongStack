import type { Config } from '../../types/config.js';
import type { PartialConfig } from './env-overrides.js';

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
  // Journal retention. 'retentionDays' is clamped up to 7 on read precisely so
  // a repo-committed config cannot flush recent evidence; 0 (auto-purge off)
  // only ever keeps more.
  'chronicle',
  'log',
  'launch',
  'nextPrediction',
  'hints',
  'debugStream',
  'configScope',
  'maxConcurrent',
  'uiLocale',
  // Cosmetic only: the TUI owns the canonical preset list and falls back to
  // 'catppuccin' for an unknown value, so the worst a repo can do is pick a
  // colour scheme.
  'themePreset',
  'fallbackModels',
  'fallbackBridge',
  'fallbackProfiles',
  // The profile SELECTOR. No broader than its siblings: a repo that can write
  // `fallbackModels` and `fallbackProfiles` already controls the chain outright,
  // and this one can only name a profile the user already defined.
  'fallbackProfile',
  'favoriteModels',
  'favoriteModelsOnly',
  'modelAvailabilitySchedule',
  'fallbackAuto',
  'fallbackStickiness',
  // The countdown before the UI auto-accepts the next fallback candidate.
  // Grants a repo nothing it does not already have: 'fallbackModels' and
  // 'fallbackProfiles' above already let it choose the candidate itself.
  'fallbackGateSeconds',
  'models',
  'modelMatrix',
  // Same class as 'modelMatrix' and 'fallbackProfiles' directly above: a tier
  // only NAMES a profile/provider/model the user already configured, and its
  // budget fields (maxCostUsd / maxIterations / timeoutMs) can only clamp a
  // subagent DOWNWARD. No credential or exec surface.
  'modelTiers',
  'circuitBreaker',
  'adaptiveConcurrency',
  'modelRuntime',
]);

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
  {
    key: 'cloudSync',
    reason: 'Carries the my.wrongstack.com machine token credential and endpoint URL.',
  },
  { key: 'yolo', reason: 'Disables all permission confirmation prompts.' },
  {
    key: 'systemPrompt',
    reason:
      "Selects the baseline identity prompt. The 'lite' variant drops whole sections of system.md — including 'Tool output trust boundary', the passage that tells the agent not to obey instructions found in repo content. A repo-committed config could therefore switch off the very rule that protects the user from that repo.",
  },
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
  {
    key: 'fallbackMaxLastResortCandidates',
    reason:
      "Bounds how many of the user's OTHER configured providers may be swept in as last-resort failover. Setting it to 0 from a repo-committed config would silently strip that depth during an outage. It was already stripped in practice (absent from the allow-list) but was missing from the key registry, so this gate never checked it.",
  },
];

/**
 * Every top-level `Config` field, as literals. Kept exhaustive by
 * `ConfigFieldRegistryCoverage` below rather than by hand: this registry is
 * what `assertInProjectAllowListComplete` iterates, so a field missing HERE
 * is a field the allow/deny drift guard never looks at. That is not
 * hypothetical — it is exactly how `fallbackMaxLastResortCandidates` slipped
 * past (see its deny entry above), and five more had followed it in
 * (`systemPrompt`, `themePreset`, `modelTiers`, `chronicle`,
 * `fallbackGateSeconds`) before the compile gate was added.
 */
const KNOWN_CONFIG_TOP_LEVEL_KEY_LIST = [
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
  'fallbackBridge',
  'fallbackProfiles',
  'fallbackProfile',
  'favoriteModels',
  'favoriteModelsOnly',
  'modelAvailabilitySchedule',
  'fallbackAuto',
  'fallbackStickiness',
  'fallbackMaxLastResortCandidates',
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
  'cloudSync',
  'extensions',
  'acp',
  'fleet',
  'brain',
  'git',
  'themePreset',
  'modelTiers',
  'fallbackGateSeconds',
  'chronicle',
  'systemPrompt',
] as const;

/** Compile-time `never` assertion; the TS error names the offending keys. */
type AssertNever<T extends never> = T;

/** `Config` fields the registry above forgot. Must be `never`. */
type UnregisteredConfigField = Exclude<
  keyof Config,
  (typeof KNOWN_CONFIG_TOP_LEVEL_KEY_LIST)[number]
>;

/** Registry entries `Config` no longer has. Must be `never`. */
type StaleRegistryField = Exclude<(typeof KNOWN_CONFIG_TOP_LEVEL_KEY_LIST)[number], keyof Config>;

/**
 * The gate that makes `assertInProjectAllowListComplete` trustworthy.
 *
 * That function is a runtime check, and a runtime check cannot see
 * `keyof Config` — it can only iterate the registry it is handed. So the
 * registry itself has to be verified at compile time, or "every Config field
 * is classified" quietly degrades into "every field someone remembered to
 * list is classified".
 */
export type ConfigFieldRegistryCoverage =
  | AssertNever<UnregisteredConfigField>
  | AssertNever<StaleRegistryField>;

const KNOWN_CONFIG_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(KNOWN_CONFIG_TOP_LEVEL_KEY_LIST);

/**
 * Nested fields stripped from an allow-listed top-level key.
 *
 * WS-008: the top-level allow/deny split is not enough on its own. `yolo` is
 * denied with the reason "Disables all permission confirmation prompts", but the
 * whole `autonomy` subtree is allowed — and `autonomy.yolo` is an alias for the
 * same switch that takes *precedence* over the user's own `yolo: false`. The
 * denial guarded the obvious spelling while the dangerous one sat one level
 * down, inside an allowed parent.
 *
 * Previously each nested strip was a hand-written block (tools.exec.*,
 * skills.*, Sage.storage.directory). One table means adding the next alias is a
 * single line, and `assertInProjectAllowListComplete` can check these paths too
 * — the drift guard was top-level-only, which is precisely why `autonomy.yolo`
 * was never flagged.
 */
const IN_PROJECT_DENIED_PATHS: ReadonlyArray<{ path: string; reason: string }> = [
  {
    path: 'tools.exec.allow',
    reason: 'Extends the exec allow-list; a repo could authorise its own binaries.',
  },
  { path: 'tools.exec.danger', reason: 'Weakens the destructive-command banner.' },
  {
    // The whole subtree, not just the dangerous leaves: a persona's
    // `instruction` is rendered into the voter SYSTEM prompt, a profile seat
    // may pin providerId/model, and `defaultProfile` selects which of those
    // runs when the agent names no profile. Denying the parent leaves no leaf
    // to reclassify wrongly later.
    path: 'tools.council',
    reason:
      'Council tool panel definitions: persona instructions are injected into the voter SYSTEM prompt and profile seats can pin an attacker-chosen providerId/model.',
  },
  { path: 'skills.extraDirs', reason: 'Loads skill definitions from repo-chosen directories.' },
  { path: 'skills.registryUrl', reason: 'Redirects skill installs to a repo-chosen host.' },
  // Deliberately NOT denied: skills.mode and skills.eagerMaxChars. The audit
  // suggested stripping both, but config-loader-extra.test.ts classifies `mode`
  // as a safe preference with a stated rationale, and a repo can only use these
  // to move injection volume in either direction — the trust problem was that
  // repo-supplied skill bodies were indistinguishable from the user's own, which
  // the provenance tag in system-prompt-skill-bodies.ts now fixes. Re-classifying
  // them is a product call.
  { path: 'Sage.storage.directory', reason: 'Redirects memory storage outside the profile.' },
  {
    path: 'autonomy.yolo',
    reason:
      'Alias for the denied top-level `yolo`, and it wins over the user setting — a repo-committed config could disable every permission prompt.',
  },
  {
    path: 'autonomy.defaultMode',
    reason: 'Sets the startup autonomy mode; autonomy is user-owned, never repo-owned.',
  },
  // Deliberately NOT denied: autonomy.autoProceedDelayMs and
  // autoProceedMaxIterations. They tune a mode the user has already switched on
  // rather than granting it, and config-loader-extra.test.ts classifies the
  // delay as a benign project preference. Re-classifying them is a product call.
  {
    path: 'launch.autonomy',
    reason: 'Launch-time autonomy mode; same user-owned boundary as autonomy.defaultMode.',
  },
  {
    path: 'features.allowOutsideProjectRoot',
    reason:
      'Short-circuits both the project-root containment check and the symlink realpath check in the file tools.',
  },
  {
    path: 'tools.restrictToProjectRoot',
    reason: 'The other half of the filesystem confinement switch.',
  },
  {
    // Denied for the direction that loosens: the flag defaults to false, so a
    // repo can only ever use it to turn OFF a gate the user deliberately
    // enabled. Same class as `tools.restrictToProjectRoot` — a control the
    // operator owns, not the checked-out repository.
    path: 'tools.kanbanGovernance',
    reason:
      'Repo-committed config could disable a Kanban governance gate the operator switched on, letting product mutations run outside any managed card.',
  },
  {
    // The whole subtree, not just `enabled`: a repo could ship
    // `tools.autoThin = { enabled: true, idleDays: 0, minInvocations: 999 }`
    // and disable every tool the operator wants, on first boot, before any
    // user-facing dry-run. Same operator-owned class as `tools.exec.allow`.
    path: 'tools.autoThin',
    reason:
      'Stats-driven tool auto-thinning is an operator decision: a repo-committed config could disable tools the operator wants by shipping a permissive threshold.',
  },
  {
    // The audit-trail parallel of `disabledTools`. A repo could otherwise
    // downgrade every user disable to `auto-thinned`, hiding operator intent
    // in `/tool autothin status` and undoing it en masse.
    path: 'tools.disabledToolMeta',
    reason:
      'Disabled-tool audit-trail metadata; a repo-committed entry could obscure operator-authored disables as auto-thinned.',
  },
  {
    // H-4 (security report VF-05): `tools` is allow-listed, but this subtree
    // reroutes EVERY provider's base URL through a repo-chosen proxy `url` —
    // API keys and full prompt content exfiltrated on the next request. Same
    // trust boundary as the denied top-level `baseUrl`/`providers`, one level
    // down inside the allowed parent.
    path: 'tools.wrongProxy',
    reason:
      'Reroutes every provider base URL through a repo-chosen proxy host; API keys and prompt content would be sent there on the next request.',
  },
  {
    // The bridge spawn path resolves the CLI entry by walking UP from the
    // project root, so a repo that ships its own `packages/cli/dist/index.js`
    // gets that file spawned with `process.execPath` on WebUI boot — no
    // prompt, no banner. Turning the feature on is therefore equivalent to
    // arbitrary code execution for a hostile checkout, which makes this an
    // operator-owned switch and never a repo-owned one.
    // See discover-mailbox-bridge.ts:findWorkspaceCliEntry.
    path: 'features.mailboxBridge',
    reason:
      'Enables the mailbox bridge, whose CLI-entry resolution walks up from the project root — a repo-supplied packages/cli/dist/index.js would be spawned on WebUI boot.',
  },
  {
    // `plugins` is already denied above, so a repo cannot ADD a plugin. This
    // closes the other half: a repo could previously ship
    // `{"features":{"pluginsTrust":false}}` and switch off the integrity gate
    // for plugins the user had ALREADY installed globally — disarming the
    // trust-on-first-use pin that exists to catch a supply-chain update
    // rewriting a plugin's entry file. Same operator-owned class as the
    // switches above.
    path: 'features.pluginsTrust',
    reason:
      'Disables the plugin trust-on-first-use integrity gate, re-trusting changed code in already-installed global plugins.',
  },
];

/**
 * Delete `path` from `target`, cloning each level touched so the caller's input
 * object is never mutated. Returns true when something was removed.
 */
function deleteNestedPath(target: Record<string, unknown>, path: string): boolean {
  const segments = path.split('.');
  const last = segments[segments.length - 1];
  if (last === undefined) return false;

  let cursor: Record<string, unknown> = target;
  const chain: Array<{ parent: Record<string, unknown>; key: string }> = [];
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (!next || typeof next !== 'object' || Array.isArray(next)) return false;
    chain.push({ parent: cursor, key: segment });
    cursor = next as Record<string, unknown>;
  }
  if (!(last in cursor)) return false;

  // Clone bottom-up so no shared sub-object is mutated in place.
  const clonedLeaf: Record<string, unknown> = { ...cursor };
  delete clonedLeaf[last];
  let replacement: Record<string, unknown> = clonedLeaf;
  for (let i = chain.length - 1; i >= 0; i--) {
    const link = chain[i];
    if (!link) continue;
    replacement = { ...link.parent, [link.key]: replacement };
    if (i === 0) {
      for (const [k, v] of Object.entries(replacement)) target[k] = v;
      return true;
    }
  }
  for (const [k, v] of Object.entries(replacement)) target[k] = v;
  return true;
}

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

  // A nested denial only does something when its top-level parent is allowed —
  // otherwise the whole subtree is already dropped and the entry is stale. This
  // is the check that would have caught `autonomy.yolo`: `autonomy` is allowed,
  // so anything dangerous beneath it needs an explicit path denial (WS-008).
  const orphanedPaths = IN_PROJECT_DENIED_PATHS.filter(
    ({ path }) => !IN_PROJECT_ALLOWED_KEYS.has(path.split('.')[0] ?? ''),
  ).map(({ path }) => path);
  if (orphanedPaths.length > 0) {
    problems.push(
      `IN_PROJECT_DENIED_PATHS entr(ies) whose top-level parent is not allowed: ` +
        orphanedPaths.join(', ') +
        '. The parent is already stripped wholesale, so the nested denial is dead — remove it.',
    );
  }

  const malformedPaths = IN_PROJECT_DENIED_PATHS.filter(
    ({ path }) => path.split('.').length < 2 || path.split('.').some((s) => s.length === 0),
  ).map(({ path }) => path);
  if (malformedPaths.length > 0) {
    problems.push(
      `IN_PROJECT_DENIED_PATHS entr(ies) are not dotted nested paths: ` +
        malformedPaths.join(', ') +
        '. Top-level keys belong in KNOWN_DENIED_IN_PROJECT instead.',
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `stripUnsafeInProjectFields drift check failed:\n  - ${problems.join('\n  - ')}`,
    );
  }
}

let driftChecked = false;

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

  for (const { path } of IN_PROJECT_DENIED_PATHS) {
    if (deleteNestedPath(out as Record<string, unknown>, path)) stripped.push(path);
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

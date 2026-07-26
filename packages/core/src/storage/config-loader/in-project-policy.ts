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

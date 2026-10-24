import { readFile } from 'node:fs/promises';
import type { Config, ConfigStore } from '@wrongstack/contracts/types/config/root';
import type { SecretVault } from '@wrongstack/contracts/types/secret-vault';
import { encryptConfigSecrets } from '../security/config-secrets.js';
import { atomicWrite, withFileLock } from '../utils/index.js';
import { isLoopbackHost } from '../utils/ip-guard.js';
import { TYPESAFE_JUDGMENT_FEATURES } from './judgments.js';
import { jevFeatureReadiness } from './readiness.js';
import { resolveTypeSafeAccount, resolveTypeSafeRoute } from './resolve.js';
import { isTypeSafeRoute, TYPESAFE_ROUTES } from './route.js';

export const JEV_FEATURES = [
  ...TYPESAFE_JUDGMENT_FEATURES,
  'skillSuggestion',
  'fleetDispatch',
] as const;
export type JevFeature = (typeof JEV_FEATURES)[number];
export interface JevSettingsPatch {
  enabled?: boolean;
  route?: 'typesafe' | 'openrouter' | 'custom';
  apiKey?: string | null;
  endpoint?: string | null;
  model?: string | null;
  requestTimeoutMs?: number;
  logContent?: boolean;
  contextStrategy?: 'hybrid' | 'intelligent' | 'selective';
  recallTurnContext?: boolean;
  features?: Partial<Record<JevFeature, boolean>>;
}

export function validateJevSettingsPatch(value: unknown): JevSettingsPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a Jev settings object');
  const patch = value as Record<string, unknown>;
  for (const [key, val] of Object.entries(patch)) {
    if (key === 'enabled') {
      if (typeof val !== 'boolean') throw new Error('Invalid Jev enabled setting');
    } else if (key === 'route') {
      if (!isTypeSafeRoute(val)) throw new Error('Invalid Jev route');
    } else if (['apiKey', 'endpoint', 'model'].includes(key)) {
      if (val !== null && (typeof val !== 'string' || !val.trim() || val.length > 4096))
        throw new Error(`Invalid Jev ${key}`);
    } else if (key === 'requestTimeoutMs') {
      if (typeof val !== 'number' || !Number.isInteger(val) || val < 100 || val > 120000)
        throw new Error('Timeout must be 100–120000 ms');
    } else if (key === 'logContent') {
      if (typeof val !== 'boolean') throw new Error('Invalid Jev log content setting');
    } else if (key === 'recallTurnContext') {
      if (typeof val !== 'boolean') throw new Error('Invalid recall turn context setting');
    } else if (key === 'contextStrategy') {
      if (!['hybrid', 'intelligent', 'selective'].includes(val as string))
        throw new Error('Invalid compaction strategy');
    } else if (key === 'features') {
      if (!val || typeof val !== 'object' || Array.isArray(val))
        throw new Error('Invalid Jev features');
      for (const [feature, enabled] of Object.entries(val)) {
        if (!(JEV_FEATURES as readonly string[]).includes(feature) || typeof enabled !== 'boolean')
          throw new Error('Invalid Jev feature');
      }
    } else throw new Error('Unknown Jev setting');
  }
  if (typeof patch['endpoint'] === 'string') {
    let url: URL;
    try {
      url = new URL(patch['endpoint']);
    } catch {
      throw new Error('Invalid endpoint URL');
    }
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new Error('Endpoint must be HTTP(S), without credentials, query or fragment');
    // Cleartext is allowed only to this machine. The endpoint is where the
    // stored Jev API key and every judgment payload (which carries application
    // state) are sent, and `apply()` below clears the key only when the ROUTE
    // changes — so setting just `endpoint` on an already-custom route retargets
    // the existing credential. Over `http:` to a remote host that is a
    // plaintext credential and state disclosure to anything on the path.
    if (url.protocol === 'http:' && !isLoopbackHost(url.hostname))
      throw new Error('A non-loopback endpoint must use https://');
  }
  return patch as JevSettingsPatch;
}

function apply(config: Partial<Config>, patch: JevSettingsPatch): Partial<Config> {
  const typesafe = { ...config.typesafe };
  if (patch.route && patch.route !== resolveTypeSafeRoute(config, {})) {
    delete typesafe.apiKey;
    delete typesafe.endpoint;
    delete typesafe.model;
  }
  for (const key of [
    'enabled',
    'route',
    'apiKey',
    'endpoint',
    'model',
    'requestTimeoutMs',
    'logContent',
  ] as const) {
    if (!(key in patch)) continue;
    const val = patch[key];
    if (val === null) delete typesafe[key];
    else Object.assign(typesafe, { [key]: val });
  }
  const next: Partial<Config> = { typesafe };
  if (patch.recallTurnContext !== undefined)
    next.Sage = {
      ...config.Sage,
      inject: { ...config.Sage?.inject, turnContext: patch.recallTurnContext },
    };
  if (patch.contextStrategy)
    next.context = { ...config.context, strategy: patch.contextStrategy } as Config['context'];
  if (patch.features) {
    typesafe.judgments = { ...typesafe.judgments };
    for (const feature of TYPESAFE_JUDGMENT_FEATURES) {
      if (patch.features[feature] !== undefined)
        typesafe.judgments[feature] = patch.features[feature];
    }
    if (patch.features.skillSuggestion !== undefined)
      next.skills = {
        ...config.skills,
        suggest: { ...config.skills?.suggest, enabled: patch.features.skillSuggestion },
      };
    if (patch.features.fleetDispatch !== undefined)
      next.fleet = {
        ...config.fleet,
        dispatch: { ...config.fleet?.dispatch, typesafeClassifier: patch.features.fleetDispatch },
      };
  }
  if (patch.enabled !== false && typesafe.route === 'custom' && !typesafe.endpoint)
    throw new Error('Custom route requires an endpoint');
  return next;
}

export function jevSettingsSnapshot(config: Readonly<Config>) {
  const account = resolveTypeSafeAccount({ config });
  const route = resolveTypeSafeRoute(config, process.env);
  const spec = route === 'custom' ? undefined : TYPESAFE_ROUTES[route];
  let endpoint = '';
  try {
    const url = new URL(config.typesafe?.endpoint ?? spec?.url ?? '');
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    endpoint = url.href;
  } catch {
    /* Invalid legacy endpoints are not echoed to clients. */
  }
  const features = Object.fromEntries(
    JEV_FEATURES.map((key) => [
      key,
      key === 'skillSuggestion'
        ? config.skills?.suggest?.enabled === true
        : key === 'fleetDispatch'
          ? config.fleet?.dispatch?.typesafeClassifier === true
          : config.typesafe?.judgments?.[key] !== false,
    ]),
  ) as Record<JevFeature, boolean>;
  return {
    enabled: config.typesafe?.enabled === true,
    status: account.status,
    reason:
      account.status === 'ready'
        ? account.rest?.isResting()
          ? account.rest.reason()
          : undefined
        : account.reason,
    route,
    model: config.typesafe?.model ?? spec?.model ?? '',
    endpoint,
    requestTimeoutMs: config.typesafe?.requestTimeoutMs ?? 4000,
    keySource: config.typesafe?.apiKey?.trim()
      ? 'config'
      : process.env[spec?.env ?? TYPESAFE_ROUTES.typesafe.env]?.trim()
        ? 'env'
        : 'none',
    features,
    logContent: config.typesafe?.logContent === true,
    recallTurnContext: config.Sage?.inject?.turnContext === true,
    readiness: jevFeatureReadiness(config, features, account.status === 'ready'),
    contextStrategy:
      config.context?.strategy ?? (config.context?.llmSelector ? 'selective' : 'hybrid'),
  };
}

/** Patch disk under its shared lock, preserve unrelated fields and ciphertext, then publish live. */
export async function saveJevSettings(
  store: ConfigStore,
  file: string,
  vault: SecretVault | undefined,
  value: unknown,
): Promise<void> {
  const patch = validateJevSettingsPatch(value);
  if (patch.apiKey && !vault) throw new Error('Secret vault unavailable');
  // Validate before opening the write transaction.
  apply(store.get(), patch);
  await withFileLock(file, async () => {
    let raw: Partial<Config>;
    try {
      const text = await readFile(file, 'utf8');
      // A UTF-8 BOM (PowerShell 5.1 writes one) is dropped, as the config loader does.
      raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('Cannot read profile configuration');
      raw = {};
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('Invalid profile configuration');
    const next = apply(raw, patch);
    const safe = vault ? encryptConfigSecrets(next, vault) : next;
    await atomicWrite(file, JSON.stringify({ ...raw, ...safe }, null, 2), { mode: 0o600 });
    store.update(apply(store.get(), patch));
  });
}

export async function testJevConnection(config: Readonly<Config>): Promise<string> {
  const account = resolveTypeSafeAccount({ config, restGate: null });
  if (account.status !== 'ready') throw new Error(account.reason);
  const result = await account.client.systemOne(
    {
      activityFeature: 'connectionTest',
      activityPurpose: 'self-test',
      state: { value: 2 },
      questions: { check: { type: 'noul', instructions: 'Is value equal to 2?' } },
    },
    AbortSignal.timeout(10000),
  );
  if (result.answers['check']?.type !== 'noul')
    throw new Error('Jev returned no valid test answer');
  return `Connected · ${result.model ?? account.model} · ${result.usage.inputTokens} input tokens`;
}

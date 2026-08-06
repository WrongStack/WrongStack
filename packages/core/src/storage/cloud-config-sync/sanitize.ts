/**
 * Contract-aware partitioning and sanitization for my.wrongstack.com config sync.
 *
 * The portal's namespace registry owns a fixed set of `config.json` top-level keys and
 * validates each payload against a strict, recursively-specified schema (server repo:
 * `docs/CLIENT_SYNC_CONTRACT.md`). This module is the client half of that contract:
 *
 * - `buildNamespacePayloads` projects the local config onto the contract field tree, so a
 *   payload can never carry a field the server does not know (which would 422) — and, more
 *   importantly, can never carry credential material: secret-bearing paths simply are not
 *   in the tree.
 * - `applyNamespacePayload` merges a pulled server payload back at contract-field
 *   granularity, so locally-kept fields the contract does not own (e.g. `tools.exec`,
 *   `mcpServers.*.env`, every `providers.*.apiKey`) are never clobbered by a pull.
 *
 * Stripping is therefore structural (projection), with `stripSecretMaterial` as a final
 * defense-in-depth pass mirroring the server's own scan.
 */

/** `true` = the whole value is contract-owned; an object = recurse per key; `'*'` = record wildcard. */
export type ContractNode = true | { [key: string]: ContractNode };

const SAGE_TREE: ContractNode = {
  enabled: true,
  storage: { projectLocal: true, directory: true },
  inject: {
    turnContext: true,
    toolResults: true,
    taskAware: true,
    maxHintsPerTool: true,
    maxCharsPerTool: true,
    minScore: true,
    repeatCooldownMs: true,
    maxTurnMemories: true,
    maxCharsPerTurn: true,
    minImportance: true,
    relationFloor: true,
  },
  hygiene: {
    autoAfterSession: true,
    autoOnFileChange: true,
    retentionDays: true,
    archiveLowConfidenceAfterDays: true,
  },
  embeddings: { enabled: true },
};

const CORE_RUNTIME_TREE: ContractNode = {
  maxConcurrent: true,
  context: {
    mode: true,
    autoCompact: true,
    strategy: true,
    warnThreshold: true,
    softThreshold: true,
    hardThreshold: true,
    preserveK: true,
    eliseThreshold: true,
    targetLoad: true,
  },
  tools: {
    defaultExecutionStrategy: true,
    maxIterations: true,
    iterationTimeoutMs: true,
    sessionTimeoutMs: true,
    perIterationOutputCapBytes: true,
    autoExtendLimit: true,
    restrictToProjectRoot: true,
    descriptionMode: true,
    disabledTools: true,
    maxToolTimeoutMs: true,
    loopDetection: {
      mode: true,
      steerThreshold: true,
      cutThreshold: true,
      windowSize: true,
      callRepeatThreshold: true,
    },
  },
  log: { level: true, format: true },
  features: {
    mcp: true,
    plugins: true,
    memory: true,
    modelsRegistry: true,
    skills: true,
    prompts: true,
    tokenSavingMode: true,
    allowOutsideProjectRoot: true,
    developerMode: true,
  },
  session: { auditLevel: true, sampling: { toolProgress: { sampleRate: true } } },
  indexing: { onSessionStart: true, onEdit: true, watchExternal: true, debounceMs: true },
  circuitBreaker: { enabled: true, autoKillResetMs: true },
  modelRuntime: {
    reasoning: { mode: true, effort: true, preserve: true },
    cache: { ttl: true },
  },
  systemPrompt: { variant: true },
  skills: { readClaudeSkills: true },
  Sage: SAGE_TREE,
  fallbackAuto: true,
  yolo: true,
  nextPrediction: true,
  hints: true,
  debugStream: true,
};

const UI_PREFERENCES_TREE: ContractNode = {
  autonomy: {
    defaultMode: true,
    autoProceedDelayMs: true,
    autoProceedMaxIterations: true,
    autonomyNextPrompt: true,
    terminalTitleAnimation: true,
    yolo: true,
    streamFleet: true,
    chime: true,
    confirmExit: true,
    mouseMode: true,
    enhance: true,
    enhanceDelayMs: true,
    enhanceCountdownMs: true,
    enhanceLanguage: true,
    statuslineMode: true,
    thinkingWord: true,
    midRunSendPicker: true,
    animationStyle: true,
    fleetChatVerbosity: true,
    refinerFallbackProfile: true,
    refinerProvider: true,
    refinerModel: true,
    showModelReasoning: true,
    shellBangWarningDontShowAgain: true,
    showAgentSwarmPanel: true,
    showSageMemoryInject: true,
    readAdvancedMode: true,
    panelPositions: true,
  },
  launch: { mode: true, autonomy: true },
  uiLocale: true,
};

const MODELS_ROUTING_TREE: ContractNode = {
  provider: true,
  model: true,
  favoriteModels: true,
  favoriteModelsOnly: true,
  fallbackModels: true,
  fallbackProfiles: true,
  modelMatrix: { '*': { fallbackProfile: true } },
  brain: {
    mode: true,
    maxAutoRisk: true,
    models: true,
    strategy: true,
    decisionTimeoutMs: true,
    humanTimeoutMs: true,
    council: {
      enabled: true,
      minRisk: true,
      voters: true,
    },
    ledger: { enabled: true, autoDenyAfterFailures: true },
    trace: { enabled: true },
  },
};

/** Provider definitions minus every piece of key material — the point of the namespace. */
const PROVIDERS_CATALOG_TREE: ContractNode = {
  providers: {
    '*': {
      type: true,
      family: true,
      baseUrl: true,
      envVars: true,
      models: true,
      activeKey: true,
    },
  },
};

/** `env`/`headers` carry VALUES and are deliberately absent; `envVars` carries names only. */
const MCP_SERVERS_TREE: ContractNode = {
  mcpServers: {
    '*': {
      name: true,
      transport: true,
      command: true,
      args: true,
      url: true,
      description: true,
      permission: true,
      enabled: true,
      lazy: true,
      envVars: true,
    },
  },
};

const EXTENSIONS_PLUGINS_TREE: ContractNode = {
  plugins: true,
  extensions: true,
};

/** Namespace → the contract tree over the `config.json` top-level keys it owns. */
export const CLOUD_SYNC_CONTRACT: Readonly<Record<string, ContractNode>> = {
  'core.runtime': CORE_RUNTIME_TREE,
  'ui.preferences': UI_PREFERENCES_TREE,
  'models.routing': MODELS_ROUTING_TREE,
  'providers.catalog': PROVIDERS_CATALOG_TREE,
  'mcp.servers': MCP_SERVERS_TREE,
  'extensions.plugins': EXTENSIONS_PLUGINS_TREE,
};

export const CLOUD_SYNC_NAMESPACES = Object.keys(CLOUD_SYNC_CONTRACT);

/** Server-side schema versions, sent in every push envelope. */
export const NAMESPACE_SCHEMA_VERSIONS: Readonly<Record<string, number>> = {
  'core.runtime': 1,
  'ui.preferences': 1,
  'models.routing': 1,
  'providers.catalog': 1,
  'mcp.servers': 2,
  'extensions.plugins': 1,
};

/**
 * Top-level keys that must never leave the machine, per the contract. Everything not in a
 * contract tree stays local implicitly; this list exists for documentation and tests.
 */
export const LOCAL_ONLY_TOP_LEVEL = [
  'version',
  'configScope',
  'hq',
  'cloudSync',
  'sync',
  'models',
  'apiKey',
  'baseUrl',
] as const;

const ENCRYPTED_VALUE = /enc:v\d+:/;
/** Mirrors the server's key scan; anchored so `tokenSavingMode` survives. */
const SECRET_KEY =
  /^(api[-_]?key|apikeys|.*token|secret.*|.*secret|password|passwd|credential.*|private[-_]?key|authorization)$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Defense-in-depth sweep run over every outgoing payload after projection: drops any
 * secret-named key and any string value that is (or contains) an encrypted blob. Returns
 * `undefined` when nothing survives.
 */
export function stripSecretMaterial(value: unknown): unknown {
  if (typeof value === 'string') {
    return ENCRYPTED_VALUE.test(value) ? undefined : value;
  }
  if (Array.isArray(value)) {
    const cleaned = value.map((entry) => stripSecretMaterial(entry));
    return cleaned.filter((entry) => entry !== undefined);
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) continue;
      const cleaned = stripSecretMaterial(child);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }
  return value;
}

/** Projects `value` onto `tree`: only contract-owned fields survive. */
function project(value: unknown, tree: ContractNode): unknown {
  if (tree === true) return value;
  if (!isPlainObject(value)) return undefined;

  const wildcard = tree['*'];
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const node = Object.hasOwn(tree, key) && key !== '*' ? tree[key] : wildcard;
    if (node === undefined) continue;
    const projected = project(child, node);
    if (projected !== undefined) out[key] = projected;
  }
  return out;
}

/**
 * Builds the per-namespace payloads to push. Sections absent locally are omitted (every
 * top-level contract key is optional server-side); a namespace with nothing to say is
 * omitted entirely.
 */
export function buildNamespacePayloads(
  config: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const payloads: Record<string, Record<string, unknown>> = {};
  for (const [namespace, tree] of Object.entries(CLOUD_SYNC_CONTRACT)) {
    if (tree === true) continue;
    const payload: Record<string, unknown> = {};
    for (const [key, node] of Object.entries(tree)) {
      if (!(key in config) || config[key] === undefined) continue;
      const projected = project(config[key], node);
      if (projected === undefined) continue;
      const cleaned = stripSecretMaterial(projected);
      if (cleaned === undefined) continue;
      if (isPlainObject(cleaned) && Object.keys(cleaned).length === 0 && node !== true) continue;
      payload[key] = cleaned;
    }
    if (Object.keys(payload).length > 0) payloads[namespace] = payload;
  }
  return payloads;
}

/**
 * A pulled payload never contains secret material (the server rejects it), but the local
 * value it replaces may — e.g. `extensions.telegram.botToken` lives inside the
 * contract-owned `extensions` subtree. When a leaf replaces an object wholesale, local
 * secret-named keys and encrypted values absent from the incoming object are carried
 * over so a pull can never destroy a locally-stored credential.
 */
function reinjectLocalSecrets(local: unknown, incoming: unknown): unknown {
  if (!isPlainObject(local) || !isPlainObject(incoming)) return incoming;
  const out: Record<string, unknown> = { ...incoming };
  for (const [key, value] of Object.entries(local)) {
    const secretish =
      SECRET_KEY.test(key) || (typeof value === 'string' && ENCRYPTED_VALUE.test(value));
    if (secretish && !(key in incoming)) {
      out[key] = value;
      continue;
    }
    if (isPlainObject(value) && isPlainObject(incoming[key])) {
      out[key] = reinjectLocalSecrets(value, incoming[key]);
    }
  }
  return out;
}

/** Writes `incoming` into `local` at contract granularity; non-contract keys survive. */
function mergeAtContract(local: unknown, incoming: unknown, tree: ContractNode): unknown {
  if (tree === true) return reinjectLocalSecrets(local, incoming);
  if (!isPlainObject(incoming)) return local;
  const base: Record<string, unknown> = isPlainObject(local) ? { ...local } : {};

  const wildcard = tree['*'];
  for (const [key, child] of Object.entries(incoming)) {
    const node = Object.hasOwn(tree, key) && key !== '*' ? tree[key] : wildcard;
    if (node === undefined) continue;
    base[key] = mergeAtContract(base[key], child, node);
  }
  return base;
}

/**
 * Applies a pulled namespace snapshot to the local config object, returning a new object.
 *
 * Only keys present in the payload are touched (an omitted optional section means "the
 * server doesn't know", never "deleted"), and inside each section only contract-owned
 * paths are replaced — `providers.*.apiKey`, `mcpServers.*.env`, `tools.exec`, and any
 * field newer than the contract stay exactly as they are locally.
 */
export function applyNamespacePayload(
  config: Record<string, unknown>,
  namespace: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const tree = CLOUD_SYNC_CONTRACT[namespace];
  if (!tree || tree === true) return config;

  const next = { ...config };
  for (const [key, incoming] of Object.entries(payload)) {
    const node = Object.hasOwn(tree, key) ? tree[key] : undefined;
    if (node === undefined) continue;
    next[key] = mergeAtContract(next[key], incoming, node);
  }
  return next;
}

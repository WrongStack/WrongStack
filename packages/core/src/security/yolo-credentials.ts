/**
 * Environment variables that hold a credential for some OTHER service.
 *
 * Not a general "looks like a secret" list — `MYLLM_API_KEY` must stay usable,
 * because naming the env var that supplies a provider's key is the entire point
 * of `provider_manage`. These are the well-known names where attaching them to
 * a NEW provider means pointing an existing credential at a new destination.
 */
export const WELL_KNOWN_CREDENTIAL_ENV_VARS: ReadonlySet<string> = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'COHERE_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'OPENROUTER_API_KEY',
  'REQUESTY_API_KEY',
  'PERPLEXITY_API_KEY',
  'TOGETHER_API_KEY',
  'FIREWORKS_API_KEY',
  'HUGGINGFACE_API_KEY',
  'HF_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AZURE_CLIENT_SECRET',
  'GITLAB_TOKEN',
  'SLACK_TOKEN',
  'STRIPE_SECRET_KEY',
  'TELEGRAM_BOT_TOKEN',
  'WRONGSTACK_VAULT_PASSPHRASE',
]);

/**
 * Input keys whose value NAMES environment variables — an array of names, a
 * single name string, or an object whose keys are the names (MCP-server
 * `env` maps). Matched case-insensitively with underscores ignored, so
 * `envVars` / `env_vars` / `ENVVARS` all hit.
 */
export const ENV_NAME_CARRIER_KEYS = new Set(['envvars', 'env', 'environment']);

/** Bounds for the recursive carrier scan — tool inputs are untrusted. */
export const MAX_CREDENTIAL_SCAN_DEPTH = 6;

export const MAX_CREDENTIAL_SCAN_NODES = 500;

/**
 * True when a tool call would bind a well-known third-party credential to a
 * provider endpoint.
 *
 * `provider_manage` lets the model create a provider, choose its `baseUrl`
 * (no metadata-host gate) and name the environment variables its key is read
 * from. Nothing claims `ANTHROPIC_API_KEY` on a stock install, so
 * `rejectBorrowedEnvVars` — which only rejects names another provider already
 * lists — let it through. Combined with the sibling `fallback_chain_manage` /
 * `leader_model_set` tools in the same bundle, that is a complete "send my
 * real key to a host I chose" primitive, reachable by prompt injection.
 *
 * VULN-006 item 3: the scan is NOT limited to the top-level `envVars` key.
 * Config-sync and mass-assignment payloads carry credential carriers nested
 * one or more levels down, under alias keys (`env`, `env_vars`,
 * `environment`), as MCP-style env MAPS (the keys are the names), or as
 * single strings. The scan walks the whole input — depth- and node-bounded —
 * and flags a well-known name in any of those shapes.
 *
 * The tool stays usable: this only forces the decision back to the human
 * rather than letting YOLO auto-approve it.
 */
export function attachesWellKnownCredential(input: unknown): boolean {
  return inputNamesAWellKnownCredential(input, 0, { nodes: 0 });
}

export function inputNamesAWellKnownCredential(
  node: unknown,
  depth: number,
  budget: { nodes: number },
): boolean {
  if (!node || typeof node !== 'object') return false;
  if (depth > MAX_CREDENTIAL_SCAN_DEPTH || ++budget.nodes > MAX_CREDENTIAL_SCAN_NODES) {
    // Fail closed (chimera review): a payload that exhausts the traversal
    // bounds cannot be proven clean, so treat it as risky — the callers turn
    // `true` into human approval instead of a silent YOLO auto-approve. A
    // crafted payload can weaponize the bounds ONLY into a spurious prompt,
    // never into a missed carrier.
    return true;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (isEnvCarrierKey(key) && namesAWellKnownCredential(value)) return true;
    if (value && typeof value === 'object') {
      if (inputNamesAWellKnownCredential(value, depth + 1, budget)) return true;
    }
  }
  return false;
}

export function isEnvCarrierKey(key: string): boolean {
  return ENV_NAME_CARRIER_KEYS.has(key.toLowerCase().replace(/_/g, ''));
}

export function namesAWellKnownCredential(value: unknown): boolean {
  if (typeof value === 'string') {
    return WELL_KNOWN_CREDENTIAL_ENV_VARS.has(value.toUpperCase());
  }
  if (Array.isArray(value)) {
    return value.some(
      (name) => typeof name === 'string' && WELL_KNOWN_CREDENTIAL_ENV_VARS.has(name.toUpperCase()),
    );
  }
  if (value && typeof value === 'object') {
    // MCP-server style env maps: the KEYS are the variable names.
    return Object.keys(value as Record<string, unknown>).some((name) =>
      WELL_KNOWN_CREDENTIAL_ENV_VARS.has(name.toUpperCase()),
    );
  }
  return false;
}

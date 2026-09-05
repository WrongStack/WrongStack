/**
 * Offline **floor** for the ChatGPT "Sign in with ChatGPT" (`openai-codex`)
 * models, mirroring what the official Codex CLI / ChatGPT model picker shows.
 *
 * Source-of-truth precedence (live path wins):
 *  1. The curated overlay `packages/cli/data/providers.json` — provider
 *     `openai-codex` — which is **synced from raw GitHub** + cached + bundled
 *     offline by `DefaultModelsRegistry` (overlayUrl/overlayFile). Editing that
 *     JSON and pushing updates every client without a code release; this is the
 *     authoritative list whenever the registry overlay is wired (the CLI path).
 *  2. This hardcoded table — the last-resort floor used where no overlay is
 *     available (a standalone registry without the bundled file) and by the CLI
 *     auth-menu login flow, which needs a synchronous id list.
 *
 * Keep this in lockstep with the `openai-codex` block in `providers.json`; the
 * drift-guard test `packages/cli/tests/codex-catalog-overlay-sync.test.ts`
 * asserts they agree.
 *
 * Layer note: this lives in `core` (not the CLI auth-menu) so the model-list
 * resolver can read it without `core` depending on `cli`. The CLI's
 * `FALLBACK_CODEX_MODELS` is derived from this list.
 */

export interface CodexModelMeta {
  /** The wire id sent to the backend and stored in config (e.g. `gpt-6-astra`). */
  id: string;
  /** Human-readable display name shown in pickers. */
  name: string;
  /** One-line capability blurb, matching the official Codex picker copy. */
  description: string;
  /** The recommended / latest model — tagged "(current)" in the official UI. */
  current?: boolean;
}

/**
 * Current ChatGPT sign-in models, newest first. The first entry is the
 * recommended default (`current`). Order is significant: callers that need a
 * default model id use `CODEX_MODELS[0]`.
 */
export const CODEX_MODELS: ReadonlyArray<CodexModelMeta> = [
  {
    id: 'gpt-6-astra',
    name: 'GPT-6 Astra',
    description: 'Most capable model for complex work across code, apps, and research.',
    current: true,
  },
  {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    description: 'Latest frontier agentic coding model.',
  },
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    description: 'Frontier model for complex coding, research, and real-world work.',
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    description: 'Balanced agentic coding model for everyday work.',
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    description: 'Fast and affordable agentic coding model.',
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 Mini',
    description: 'Small, fast, and cost-efficient model for simpler coding tasks.',
  },
  {
    id: 'gpt-5.3-codex-spark',
    name: 'GPT-5.3 Codex Spark',
    description: 'Ultra-fast coding model.',
  },
];

const BY_ID: ReadonlyMap<string, CodexModelMeta> = new Map(CODEX_MODELS.map((m) => [m.id, m]));

/** Look up the canonical metadata for a Codex model id, or `undefined`. */
export function codexModelMeta(id: string): CodexModelMeta | undefined {
  return BY_ID.get(id);
}

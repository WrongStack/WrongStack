/**
 * The built-in "setup mode" provider — the one provider that is always
 * available, needs no credential, and never touches the network.
 *
 * WHY IT EXISTS. On a machine with no API key, no OAuth session and no local
 * gateway, every entry in the provider picker is unusable: picking one and
 * launching lands the user in a session whose first request fails. Before this
 * provider existed the launch path had no non-failing option at all, so a
 * first-time user could not reach the TUI to run `/auth` — the one command
 * that would fix the situation. This provider closes that loop: it is a real,
 * constructible `Provider` that boots the whole app (TUI, tools, session
 * store, slash commands) and answers every request with the same short
 * onboarding message.
 *
 * It is deliberately NOT a mock/echo transport for testing. It answers one
 * question ("how do I connect a real model?") and nothing else, so a user who
 * lands here by accident is never confused about whether it is working.
 *
 * LIFECYCLE. `wrongstack-setup` is never written into `config.providers` — only
 * the top-level `provider`/`model` pointers reference it. That is what makes
 * the cleanup automatic: `clearStaleProviderDefaults` (called from every
 * `mutateConfigProviders` write, i.e. from every auth flow) drops top-level
 * pointers whose provider has no saved entry, so the first real credential the
 * user adds silently retires setup mode. See `provider-config-utils.ts`.
 */
import type { ProviderFactory } from '@wrongstack/core/registry';
import type {
  Capabilities,
  Provider,
  ProviderConfig,
  Request,
  ResolvedProvider,
  Response,
  StreamEvent,
} from '@wrongstack/core/types';

/** Registry key, config `provider` value, and picker id for setup mode. */
export const SETUP_PROVIDER_ID = 'wrongstack-setup';

/** The single model setup mode offers. Named for what it means, not what it does. */
export const SETUP_MODEL_ID = 'no-api-key';

/** Display name used by the picker and the launch banner. */
export const SETUP_PROVIDER_NAME = 'Setup mode — no API key yet';

/** Is this the built-in setup provider? Accepts undefined for call-site ergonomics. */
export function isSetupProvider(providerId: string | undefined): boolean {
  return providerId === SETUP_PROVIDER_ID;
}

/**
 * Capabilities are a plausible mid-range profile rather than zeros. A
 * `maxContext` of 0 would make every context-fullness computation divide by
 * zero, and `tools: false` would strip the tool surface from the very session
 * the user is meant to explore before connecting a model.
 */
const SETUP_CAPABILITIES: Capabilities = {
  tools: true,
  parallelTools: false,
  vision: false,
  streaming: true,
  promptCache: false,
  systemPrompt: true,
  jsonMode: false,
  reasoning: false,
  maxContext: 200_000,
  maxOutput: 4096,
  cacheControl: 'none',
  topK: false,
  frequencyPenalty: false,
  presencePenalty: false,
  seed: false,
  structuredOutput: false,
  logprobs: false,
  audio: false,
  multipleCompletions: false,
};

const SETUP_REPLY = [
  'WrongStack is running in **setup mode** — no model is connected yet, so this',
  'reply is generated locally and nothing was sent to a provider.',
  '',
  'To connect a real model, run one of these:',
  '',
  '  /auth login    Sign in with a subscription (ChatGPT, Claude, GitHub Copilot)',
  '  /auth          Add an API key (Anthropic, OpenAI, Google, OpenRouter, …)',
  '',
  'From a shell you can use `wstack auth` for the same menu.',
  '',
  'Everything else in this session is real: tools, file edits, the session',
  'store and slash commands all work. Only the model reply is a placeholder.',
  '',
  'Setup mode retires itself — the moment you save a credential, WrongStack',
  'drops it and asks you to pick a real provider on the next launch.',
].join('\n');

/** Split the canned reply into deltas so the UI streams it like a real answer. */
function replyChunks(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += 64) chunks.push(text.slice(i, i + 64));
  return chunks;
}

class SetupProvider implements Provider {
  readonly id: string;
  readonly capabilities: Capabilities = SETUP_CAPABILITIES;

  constructor(id: string = SETUP_PROVIDER_ID) {
    this.id = id;
  }

  async *stream(req: Request, opts: { signal: AbortSignal }): AsyncIterable<StreamEvent> {
    const model = req.model || SETUP_MODEL_ID;
    yield { type: 'message_start', model };
    yield { type: 'content_block_start', kind: 'text' };
    for (const text of replyChunks(SETUP_REPLY)) {
      // Honour cancellation the same way a real transport does: stop emitting
      // and close the block cleanly rather than leaving the stream dangling.
      if (opts.signal.aborted) break;
      yield { type: 'text_delta', text };
    }
    yield { type: 'content_block_stop', index: 0 };
    yield {
      type: 'message_stop',
      stopReason: 'end_turn',
      usage: { input: 0, output: 0 },
    };
  }

  async complete(req: Request, _opts: { signal: AbortSignal }): Promise<Response> {
    return {
      content: [{ type: 'text', text: SETUP_REPLY }],
      stopReason: 'end_turn',
      usage: { input: 0, output: 0 },
      model: req.model || SETUP_MODEL_ID,
    };
  }
}

/**
 * Factory for the setup provider. Registered unconditionally at boot — it is
 * inert unless `config.provider` actually names it, and registering it always
 * means the fallback ladder can reach it as a last resort instead of dying.
 */
export function createSetupProviderFactory(): ProviderFactory {
  return {
    type: SETUP_PROVIDER_ID,
    // Routing metadata only; SetupProvider does no wire conversion at all.
    family: 'openai-compatible',
    create: (cfg: ProviderConfig) => new SetupProvider(cfg.type || SETUP_PROVIDER_ID),
  };
}

/**
 * The catalog shape of setup mode. Synthesized rather than published through
 * models.dev so it can never appear for a user who already has a credential —
 * every call site decides for itself whether to offer it.
 */
export function setupProviderResolved(): ResolvedProvider {
  return {
    id: SETUP_PROVIDER_ID,
    name: SETUP_PROVIDER_NAME,
    family: 'openai-compatible',
    apiBase: undefined,
    envVars: [],
    models: [
      {
        id: SETUP_MODEL_ID,
        name: 'No API key (local placeholder)',
        tool_call: true,
        limit: { context: 200_000, output: 4096 },
      },
    ],
    npm: undefined,
  };
}

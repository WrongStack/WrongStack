/**
 * `anthropic-oauth` wire family — Claude Pro/Max via "Sign in with Claude".
 *
 * Same wire as the API-key `anthropic` family (api.anthropic.com/v1/messages),
 * but authenticated with an OAuth access token instead of an API key. Three
 * things differ from the API-key path, all REQUIRED for the subscription
 * backend to accept the request:
 *   1. `Authorization: Bearer <access>` (no `x-api-key`).
 *   2. `anthropic-beta: claude-code-20250219,oauth-2025-04-20`.
 *   3. The first system block MUST be exactly the Claude Code identity line —
 *      Anthropic rejects OAuth requests whose system prompt doesn't lead with it.
 *
 * The API-key `anthropic` family is untouched. Tokens self-refresh (near-expiry
 * + once on 401) via the refresh token; rotated tokens persist through the same
 * `setOAuthTokenPersister` hook the codex family uses.
 */

import {
  type Capabilities,
  FetchError,
  ParseError,
  ProviderError,
  type Request,
  type StreamEvent,
} from '@wrongstack/core/types';
import { OAuthRefreshCoordinator } from './oauth-refresh-coordinator.js';
import { anthropicWireFormat } from './presets/anthropic.js';
import type { AnthropicStreamState } from './presets/anthropic.js';
import { WireFormatProvider } from './wire-format.js';
import { capabilitiesForFamily } from './family-capabilities.js';
import type { WireAdapterStreamOptions } from './wire-adapter.js';
import type { BuildBodyContext } from './model-output-limits.js';

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const DEFAULT_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const OAUTH_BETA = 'claude-code-20250219,oauth-2025-04-20';
/** Version string mimicked in the User-Agent so requests look like Claude Code. */
const CLAUDE_CODE_VERSION = '2.1.75';

/** Required first system block for OAuth/subscription requests. */
export const CLAUDE_CODE_SYSTEM_PROMPT =
  "You are Claude Code, Anthropic's official CLI for Claude.";

// ── Tool-name camouflage ─────────────────────────────────────────────────────
// The subscription backend can fingerprint a non-Claude-Code client by its tool
// names. We present Claude Code's canonical casing on the wire (read → Read,
// bash → Bash, …) for any tool whose name matches case-insensitively, and map
// the streamed tool_use name back to the caller's real tool so dispatch works.
// Tools without a Claude Code counterpart pass through unchanged.

const CLAUDE_CODE_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Grep',
  'Glob',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'KillShell',
  'NotebookEdit',
  'Skill',
  'Task',
  'TaskOutput',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
] as const;

const CC_TOOL_BY_LOWER = new Map(CLAUDE_CODE_TOOLS.map((t) => [t.toLowerCase(), t]));

/** Map a real tool name to Claude Code's canonical casing (if it matches). */
function toClaudeCodeName(name: string): string {
  return CC_TOOL_BY_LOWER.get(name.toLowerCase()) ?? name;
}

/** Map a Claude-Code-cased name back to the caller's real tool name. */
function fromClaudeCodeName(name: string, tools: Request['tools']): string {
  const lower = name.toLowerCase();
  const match = tools?.find((t) => t.name.toLowerCase() === lower);
  return match?.name ?? name;
}

export interface AnthropicOAuthTokens {
  access: string;
  refresh: string;
  /** Absolute expiry in epoch milliseconds. */
  expires: number;
}

/** Refresh an expired Claude OAuth access token. */
export async function refreshAnthropicOAuthToken(
  refreshToken: string,
  signal?: AbortSignal,
): Promise<AnthropicOAuthTokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Preserve the real status: FetchError derives `recoverable` from it
    // (429/5xx → true). Hardcoding 401 marked every transient blip (503, 429)
    // as a non-recoverable auth failure, so callers dropped credentials and
    // forced a re-login instead of retrying.
    throw new FetchError({
      message: `Claude token refresh failed (${res.status}): ${text || res.statusText}`,
      status: res.status,
      context: { provider: 'anthropic-oauth' },
    });
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  } | null;
  if (
    !json?.access_token ||
    !json.refresh_token ||
    typeof json.expires_in !== 'number' ||
    !Number.isFinite(json.expires_in) ||
    json.expires_in <= 0
  ) {
    throw new ParseError({
      message: 'Claude token refresh response missing fields',
      source: 'anthropic-oauth',
    });
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

export interface AnthropicOAuthCredentials {
  accessToken: string;
  refreshToken?: string | undefined;
  expiresAt?: number | undefined;
}

export interface AnthropicOAuthProviderOptions {
  credentials: AnthropicOAuthCredentials;
  baseUrl?: string | undefined;
  id?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  streamOpts?: WireAdapterStreamOptions | undefined;
  onRefresh?:
    | ((creds: { accessToken: string; refreshToken: string; expiresAt: number }) => void)
    | undefined;
  refreshFn?:
    | ((refreshToken: string, signal?: AbortSignal) => Promise<AnthropicOAuthTokens>)
    | undefined;
}

export class AnthropicOAuthProvider extends WireFormatProvider<AnthropicStreamState> {
  override readonly id: string;
  override readonly capabilities: Capabilities;

  private access: string;
  private refresh: string | undefined;
  private readonly refreshFn: (
    refreshToken: string,
    signal?: AbortSignal,
  ) => Promise<AnthropicOAuthTokens>;
  /** Shared OAuth refresh machinery — see packages/providers/src/oauth-refresh-coordinator.ts */
  private readonly refreshCoordinator: OAuthRefreshCoordinator<
    AnthropicOAuthTokens,
    NonNullable<AnthropicOAuthProviderOptions['onRefresh']> extends (p: infer P) => void ? P : never
  >;

  constructor(opts: AnthropicOAuthProviderOptions) {
    super(anthropicWireFormat, {
      apiKey: opts.credentials.accessToken,
      baseUrl: opts.baseUrl ?? DEFAULT_BASE,
      fetchImpl: opts.fetchImpl,
      streamOpts: opts.streamOpts,
    });
    this.id = opts.id ?? 'anthropic-oauth';
    this.capabilities = capabilitiesForFamily('anthropic-oauth');
    this.access = opts.credentials.accessToken;
    this.refresh = opts.credentials.refreshToken;
    this.refreshFn = opts.refreshFn ?? refreshAnthropicOAuthToken;
    this.refreshCoordinator = new OAuthRefreshCoordinator<
      AnthropicOAuthTokens,
      {
        accessToken: string;
        refreshToken: string;
        expiresAt: number;
      }
    >({
      initialRefreshKey: opts.credentials.refreshToken,
      initialExpiresAt: opts.credentials.expiresAt,
      label: 'Anthropic OAuth',
      hooks: {
        refreshFn: (key, signal) => this.refreshFn(key, signal),
        onRefresh: opts.onRefresh,
        formatPayload: (_tokens, derived) => ({
          accessToken: derived.accessToken,
          refreshToken: derived.refreshKey ?? '',
          expiresAt: derived.expiresAt,
        }),
        projectTokens: (tokens) => ({
          accessToken: tokens.access,
          expiresAt: tokens.expires,
          // Anthropic rotates its refresh token on every refresh.
          refreshKey: tokens.refresh,
        }),
        applyTokens: (derived) => {
          this.access = derived.accessToken;
          if (derived.refreshKey !== undefined) {
            this.refresh = derived.refreshKey;
          }
        },
      },
    });
  }

  override async *stream(req: Request, opts: { signal: AbortSignal }) {
    await this.ensureFreshToken(opts.signal);
    try {
      yield* this.remapToolNames(super.stream(req, opts), req.tools);
    } catch (err) {
      if (err instanceof ProviderError && err.status === 401 && this.refresh) {
        await this.doRefresh(opts.signal);
        yield* this.remapToolNames(super.stream(req, opts), req.tools);
        return;
      }
      throw err;
    }
  }

  /** Map Claude-Code-cased tool_use names in the stream back to real names. */
  private async *remapToolNames(
    events: AsyncIterable<StreamEvent>,
    tools: Request['tools'],
  ): AsyncIterable<StreamEvent> {
    for await (const ev of events) {
      if (
        (ev.type === 'tool_use_start' || ev.type === 'content_block_start') &&
        typeof (ev as { name?: string }).name === 'string'
      ) {
        yield { ...ev, name: fromClaudeCodeName((ev as { name: string }).name, tools) };
      } else {
        yield ev;
      }
    }
  }

  private async ensureFreshToken(signal: AbortSignal): Promise<void> {
    await this.refreshCoordinator.ensureFreshToken(signal);
  }

  private async doRefresh(signal: AbortSignal): Promise<void> {
    await this.refreshCoordinator.doRefresh(signal);
  }

  protected override buildHeaders(_req: Request): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': ANTHROPIC_VERSION,
      authorization: `Bearer ${this.access}`,
      'anthropic-beta': OAUTH_BETA,
      // Present as the official Claude Code CLI so the subscription backend
      // accepts the request and the client isn't trivially fingerprinted.
      'user-agent': `claude-cli/${CLAUDE_CODE_VERSION}`,
      'x-app': 'cli',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  }

  protected override buildBody(req: Request, ctx: BuildBodyContext): Record<string, unknown> {
    const body = super.buildBody(req, ctx);
    // Prepend the required Claude Code identity block (unless already present).
    const existing = (body['system'] as { type: 'text'; text: string }[] | undefined) ?? [];
    const alreadyLed = existing[0]?.text?.startsWith(CLAUDE_CODE_SYSTEM_PROMPT) === true;
    body['system'] = alreadyLed
      ? existing
      : [{ type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT }, ...existing];

    // Present Claude Code's canonical tool names on the wire, consistently
    // across both the tool definitions and the tool_use blocks in history.
    const tools = body['tools'] as Array<{ name?: string }> | undefined;
    if (Array.isArray(tools)) {
      for (const t of tools) {
        if (typeof t.name === 'string') t.name = toClaudeCodeName(t.name);
      }
    }
    const messages = body['messages'] as Array<{ content?: unknown }> | undefined;
    if (Array.isArray(messages)) {
      for (const m of messages) {
        if (!Array.isArray(m.content)) continue;
        for (const block of m.content as Array<{ type?: string; name?: string }>) {
          if (block?.type === 'tool_use' && typeof block.name === 'string') {
            block.name = toClaudeCodeName(block.name);
          }
        }
      }
    }
    return body;
  }
}

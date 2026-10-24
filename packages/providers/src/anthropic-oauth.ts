/**
 * `anthropic-oauth` — the retired "Sign in with Claude" (Pro/Max) family.
 *
 * The only way this login ever worked was by passing WrongStack off as Claude
 * Code: Claude Code's own OAuth client id, its User-Agent and beta header, a
 * forced "You are Claude Code" system block and Claude-Code-cased tool names.
 * Anthropic publishes no OAuth client for third-party apps, so there is no
 * honest version of this wire, and it was removed.
 *
 * The family itself stays registered so a saved `anthropic-oauth` entry still
 * loads (config, pickers, colors, limits) instead of breaking boot. Every
 * request fails fast with an `auth` ProviderError that says what to use
 * instead; nothing is sent over the network and the stored tokens are never
 * read or refreshed. `auth` is non-retryable, so a configured fallback takes
 * over immediately.
 */

import {
  type Capabilities,
  type Provider,
  ProviderError,
  type Request,
  type Response,
  type StreamEvent,
} from '@wrongstack/contracts/types';
import { capabilitiesForFamily } from './family-capabilities.js';

/** Kept within `ProviderError.describe()`'s 240-char detail so it is never cut. */
export const ANTHROPIC_OAUTH_RETIRED_MESSAGE =
  'Claude sign-in (anthropic-oauth) was removed: it only worked by posing as Claude Code. ' +
  'Add an Anthropic API key with `wstack auth anthropic` (Max/Team: link a Console org in ' +
  'claude.ai Billing for monthly credits) and remove this one.';

/** A saved `anthropic-oauth` entry: constructible, but every request is refused. */
export class RetiredAnthropicOAuthProvider implements Provider {
  readonly id: string;
  readonly capabilities: Capabilities = capabilitiesForFamily('anthropic-oauth');

  constructor(id = 'anthropic-oauth') {
    this.id = id;
  }

  private retired(): ProviderError {
    return new ProviderError(ANTHROPIC_OAUTH_RETIRED_MESSAGE, 401, false, this.id, {
      kind: 'auth',
      body: { message: ANTHROPIC_OAUTH_RETIRED_MESSAGE },
    });
  }

  stream(_req: Request, _opts: { signal: AbortSignal }): AsyncIterable<StreamEvent> {
    const error = this.retired();
    return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }) };
  }

  complete(_req: Request, _opts: { signal: AbortSignal }): Promise<Response> {
    return Promise.reject(this.retired());
  }
}

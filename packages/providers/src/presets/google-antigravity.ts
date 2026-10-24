/**
 * Antigravity wire format — the Gemini preset, re-pointed at Cloud Code.
 *
 * Everything about interpreting Gemini's messages, tool calls, thought
 * signatures and usage is already correct in `googleWireFormat` and is reused
 * verbatim. This module changes only what the Cloud Code envelope changes:
 * where the request goes, how it is authenticated, and the one extra layer
 * around each response chunk.
 *
 * The request envelope itself is NOT built here. It needs the account's Cloud
 * Code project id, which is instance state discovered at sign-in, and a preset
 * is a pure function of `(req, ctx)` — so `AntigravityProvider.buildBody`
 * wraps what this preset's `buildBody` (i.e. Gemini's) produces.
 *
 * @module presets/google-antigravity
 */

import type { StreamEvent } from '@wrongstack/contracts/types';
import { recordProviderQuota } from '@wrongstack/core/quota';
import { capabilitiesForFamily } from '../family-capabilities.js';
import {
  ANTIGRAVITY_DEFAULT_HOST,
  ANTIGRAVITY_STREAM_PATH,
  antigravityUserAgent,
  readAntigravityCredits,
  unwrapAntigravityPayload,
} from '../google-antigravity-protocol.js';
import { defineWireFormat } from '../wire-format.js';
import { type GoogleStreamState, googleWireFormat } from './google.js';

/** Provider id an Antigravity login is stored under. */
export const ANTIGRAVITY_PROVIDER_ID = 'google-antigravity';

export const antigravityWireFormat = defineWireFormat<GoogleStreamState>({
  ...googleWireFormat,
  id: ANTIGRAVITY_PROVIDER_ID,
  family: 'google-antigravity',
  capabilities: capabilitiesForFamily('google-antigravity'),
  defaultBaseUrl: ANTIGRAVITY_DEFAULT_HOST,
  // A verb path, not a model path: the target model rides in the envelope
  // instead of the URL. Always the streaming endpoint — the non-streaming
  // `generateContent` sibling is not used by the official clients and is not
  // exercised by anyone, so it is not a fallback we can rely on.
  buildUrl: (base) => `${base.replace(/\/+$/, '')}${ANTIGRAVITY_STREAM_PATH}`,
  // Bearer, not `x-goog-api-key`: this is an OAuth subscription, not an API
  // key. The user agent is part of the identity Google checks.
  buildHeaders: (accessToken) => ({
    'user-agent': antigravityUserAgent(),
    authorization: `Bearer ${accessToken}`,
  }),
  parseStreamEvent: (msg, state): StreamEvent[] => {
    if (!msg.data || msg.data === '[DONE]') return [];
    // Credits are Cloud Code's, not Gemini's: they sit beside `response` and
    // would be dropped by the unwrap. Reading them here means a pay-as-you-go
    // balance reaches the quota surfaces without a second request.
    const credits = readAntigravityCredits(msg.data);
    if (credits && state.providerId) {
      recordProviderQuota(state.providerId, [
        {
          providerId: state.providerId,
          meterId: 'credits',
          windows: [],
          credits: {
            hasCredits: credits.some((c) => Number(c.creditAmount) > 0),
            unlimited: false,
            balance: credits.map((c) => `${c.creditType}: ${c.creditAmount}`).join(', '),
          },
          capturedAt: Date.now(),
        },
      ]);
    }
    return googleWireFormat.parseStreamEvent(
      { ...msg, data: unwrapAntigravityPayload(msg.data) },
      state,
    );
  },
});

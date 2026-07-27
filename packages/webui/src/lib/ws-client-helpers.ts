/**
 * Pure payload builders for the `provider.*` client messages.
 * Extracted so the test suite can verify the wire shape without
 * spinning up a WebSocket connection.
 *
 * The naming mirrors the `*.clear_models` ↔ `*.undo_clear` pair:
 *   - `buildClearModelsMessage(providerId)` → `provider.clear_models`
 *   - `buildUndoClearMessage(providerId, previousModels)` →
 *     `provider.undo_clear`
 *   - `buildProviderUpdateMessage(payload)` → `provider.update`
 *
 * The builders are the single source of truth for the message
 * shape — both the `WSClient` methods and the test suite
 * consume the same function, so an accidental shape drift is
 * caught at type-check + unit-test time.
 */
import type { ProviderCustomModelWire } from '../types/client-message.js';
import type { WSClientMessage } from '../types';

/**
 * Build the `provider.clear_models` message that removes the
 * saved `models` allowlist for `providerId`. The picked id
 * becomes `undefined` on the next `providers.saved` broadcast.
 */
export function buildClearModelsMessage(providerId: string): WSClientMessage {
  return { type: 'provider.clear_models', payload: { providerId } };
}

/**
 * Build the `provider.undo_clear` message that restores the
 * `models` allowlist from `previousModels`. Pairs with
 * `buildClearModelsMessage` — the WebUI's "Undo" toast calls
 * this to reapply the list the user just removed.
 *
 * Defensive-copies the input list so a caller who mutates their
 * array after the call doesn't leak into the saved state.
 */
export function buildUndoClearMessage(
  providerId: string,
  previousModels: string[],
): WSClientMessage {
  return {
    type: 'provider.undo_clear',
    payload: { providerId, previousModels: [...previousModels] },
  };
}

/**
 * Build a `provider.update` message. Thin pass-through that
 * exists so the test suite can verify the wire shape without
 * importing the full `WSClient` class.
 */
export function buildProviderUpdateMessage(payload: {
  id: string;
  family?: string | undefined;
  baseUrl?: string | undefined;
  envVars?: string[] | undefined;
  models?: string[] | undefined;
  customModels?: Record<string, ProviderCustomModelWire> | undefined;
}): WSClientMessage {
  return { type: 'provider.update', payload };
}

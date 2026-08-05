import type { EventBus } from '@wrongstack/core/kernel';
import type { WSClientMessage } from './types.js';
import { validateModelFallbackChoicePayload } from './ws-payload-validation.js';

/**
 * Bridge a `model.fallback_choice` client message to the
 * `provider.fallback_choice` EventBus emission consumed by the fallback gate
 * (`packages/cli/src/wiring/fallback-gate.ts`). Shared by the standalone route
 * table (`routes.ts`) and the embedded message router so wire validation and
 * the event contract live in exactly one place.
 *
 * Returns `true` when the payload was valid and forwarded, `false` when the
 * payload failed validation (the caller may send an error frame).
 */
export function emitFallbackChoice(
  events: EventBus | undefined,
  msg: WSClientMessage,
): { ok: true } | { ok: false; message: string } {
  const parsed = validateModelFallbackChoicePayload(msg.payload);
  if (!parsed.ok) return parsed;
  events?.emit('provider.fallback_choice', {
    requestId: parsed.value.requestId,
    ...(parsed.value.providerId ? { providerId: parsed.value.providerId } : {}),
    ...(parsed.value.model ? { model: parsed.value.model } : {}),
    ...(parsed.value.autoSwitch ? { autoSwitch: true } : {}),
  });
  return { ok: true };
}

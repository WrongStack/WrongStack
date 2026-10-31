import { toast } from '@/components/Toaster';
import { chatFor } from '@/lib/ws-client-utils';
import type { WSServerMessage } from '@/types';
import { toastIfForeground } from './delegation-handlers.js';

/**
 * `model.tier_proposed` — in `propose` mode the leader asked for another model tier and the
 * model was NOT changed. The conversation shows the proposal; the model picker applies it.
 */
export function handleModelTierProposed(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  const payload = (msg.payload ?? {}) as {
    toTier?: string | undefined;
    target?: { provider?: string; model?: string } | undefined;
    reason?: string | undefined;
  };
  const target = [payload.target?.provider, payload.target?.model].filter(Boolean).join('/');
  if (!payload.toTier || !target) return;
  chat.addMessage({
    role: 'assistant',
    content:
      `WrongStack proposes the \`${payload.toTier}\` tier: \`${target}\`. The model was not ` +
      `changed; choose it in the model picker to accept.${payload.reason ? ` ${payload.reason}` : ''}`,
  });
  toastIfForeground(chat, () => toast.info(`Proposed tier: ${payload.toTier}`));
}

import type { Message } from '../types/messages.js';
import type { SecretScrubber } from '../types/secret-scrubber.js';
import type { SessionEvent } from '../types/session.js';

export function scrubSessionWriterEvent(
  event: SessionEvent,
  secretScrubber?: SecretScrubber | undefined,
): SessionEvent {
  const persistMessage = (message: Message): Message => {
    const { _estTokens: _ignored, ...persisted } = message;
    return {
      ...persisted,
      content:
        typeof persisted.content === 'string'
          ? (secretScrubber?.scrub(persisted.content) ?? persisted.content)
          : (secretScrubber?.scrubObject(persisted.content) ?? persisted.content),
    };
  };
  if (event.type === 'context_snapshot' || event.type === 'messages_replaced') {
    return { ...event, messages: event.messages.map(persistMessage) };
  }
  if (event.type === 'message_appended' || event.type === 'message_updated') {
    return { ...event, message: persistMessage(event.message) };
  }
  if (!secretScrubber) return event;
  if (event.type === 'user_input') {
    return {
      ...event,
      content:
        typeof event.content === 'string'
          ? secretScrubber.scrub(event.content)
          : secretScrubber.scrubObject(event.content),
    };
  }
  if (event.type === 'llm_response') {
    return { ...event, content: secretScrubber.scrubObject(event.content) };
  }
  return event;
}

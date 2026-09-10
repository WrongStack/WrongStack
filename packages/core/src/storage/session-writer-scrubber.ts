import type { Message } from '../types/messages.js';
import type { SecretScrubber } from '../types/secret-scrubber.js';
import type { FileSnapshot, SessionEvent } from '../types/session.js';

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
  if (event.type === 'tool_use') {
    return { ...event, input: secretScrubber.scrubObject(event.input) };
  }
  if (event.type === 'tool_call_start') {
    return { ...event, input: secretScrubber.scrubObject(event.input) };
  }
  if (event.type === 'tool_result') {
    return {
      ...event,
      content:
        typeof event.content === 'string'
          ? secretScrubber.scrub(event.content)
          : secretScrubber.scrubObject(event.content),
    };
  }
  if (event.type === 'file_snapshot') {
    return {
      ...event,
      files: event.files.map((f: FileSnapshot) => ({
        ...f,
        before: f.before !== null ? secretScrubber.scrub(f.before) : null,
        after: f.after !== null ? secretScrubber.scrub(f.after) : null,
      })),
    };
  }
  if (event.type === 'side_effect') {
    return secretScrubber.scrubObject(event);
  }
  // `error` had no case at all, so it fell through to the unscrubbed return
  // below — while every neighbouring event type was handled. Its `message` is
  // raw provider error text, which is one of the two places a credential most
  // reliably comes back at you (a gateway echoing an `Authorization` header, a
  // connection string with an inline password). The session journal is durable
  // and replayed, so an unscrubbed value here persists indefinitely and is read
  // back into later context.
  if (event.type === 'error') {
    return { ...event, message: secretScrubber.scrub(event.message) };
  }
  // Same class, same omission: both carry a raw thrown-error string
  // (`agent_error.error` is the director's `errorString`). `session-scrub-parity`
  // enumerates the union so the next variant with a free-text error field
  // cannot be added without a decision here.
  if (event.type === 'task_failed' || event.type === 'agent_error') {
    return { ...event, error: secretScrubber.scrub(event.error) };
  }
  // `errorBody` on these two is documented as scrubbed at the emit site, but
  // `description` is a free-text string whose construction I could not trace to
  // a closed set of categories. Scrubbing it is a no-op on text that holds no
  // secret, so the cheap defensive pass is preferable to an assumption — this
  // is the journal, where a wrong assumption persists.
  if (event.type === 'provider_error' || event.type === 'provider_retry') {
    return { ...event, description: secretScrubber.scrub(event.description) };
  }
  return event;
}

import type { Message } from '@wrongstack/contracts/types/messages';
import type { SecretScrubber } from '@wrongstack/contracts/types/secret-scrubber';
import type { FileSnapshot, SessionEvent } from '@wrongstack/contracts/types/session';

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
  // Sandbox audit records are appended with `detail: entry.detail`
  // (Record<string, unknown>) by sandbox/audit.ts and DELIBERATELY ignore
  // `session.auditLevel`, so they are always persisted. `detail` carries
  // host/policy strings — including the raw approver error string
  // (`decidedBy`) — the same class as `side_effect.input` above.
  if (event.type === 'sandbox_audit') {
    return { ...event, detail: secretScrubber.scrubObject(event.detail) };
  }
  // Sampled streaming tool output (auditLevel 'full'). `event.text` is the
  // mid-stream form of `tool_result.content`, which IS scrubbed above, and
  // `event.data` is an arbitrary record. Both reached the durable journal
  // verbatim, because this variant is not named `*_error`, so the parity
  // guard's name-pattern ratchet never demanded a case here.
  if (event.type === 'tool_progress') {
    return {
      ...event,
      event: {
        ...event.event,
        ...(typeof event.event.text === 'string'
          ? { text: secretScrubber.scrub(event.event.text) }
          : {}),
        ...(event.event.data !== undefined
          ? { data: secretScrubber.scrubObject(event.event.data) }
          : {}),
      },
    };
  }
  // The compaction digest is a lossless copy of the collapsed turns' TEXT
  // (`buildLosslessDigest` joins `[role]: text` lines verbatim), built from the
  // in-memory conversation before the write boundary ever sees it. The same
  // text IS scrubbed when it rides `message_appended` / `context_snapshot`, so
  // persisting the digest raw leaks exactly what those cases remove.
  if (event.type === 'compaction') {
    return typeof event.digest === 'string'
      ? { ...event, digest: secretScrubber.scrub(event.digest) }
      : event;
  }
  // The checkpoint preview is `inputPayload.text.slice(0, 80)` — the head of
  // the user's own turn, written on EVERY host's user turn (agent-loop.ts) and
  // always persisted (Core Reconstruct set). The same text IS scrubbed when it
  // rides `user_input` / `message_appended`.
  if (event.type === 'checkpoint') {
    return { ...event, promptPreview: secretScrubber.scrub(event.promptPreview) };
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
  if (event.type === 'task_failed') {
    return {
      ...event,
      title: secretScrubber.scrub(event.title),
      error: secretScrubber.scrub(event.error),
    };
  }
  if (event.type === 'agent_error') {
    return { ...event, error: secretScrubber.scrub(event.error) };
  }
  // Task-family titles are model-authored task specs and outcomes
  // (`title: task.description` in director-task-registry.ts), the same
  // category as `llm_response` content, which IS scrubbed above.
  if (event.type === 'task_created' || event.type === 'task_completed') {
    return { ...event, title: secretScrubber.scrub(event.title) };
  }
  // Delegation records: `task` is the instruction handed to a subagent — the
  // text that becomes that subagent's user input, which IS scrubbed in its own
  // journal — and `summary` is the one-liner the surfaces render. Both are
  // model-authored, the same category as `llm_response` content.
  if (event.type === 'delegate_started') {
    return { ...event, task: secretScrubber.scrub(event.task) };
  }
  if (event.type === 'delegate_completed') {
    return {
      ...event,
      task: secretScrubber.scrub(event.task),
      summary: secretScrubber.scrub(event.summary),
    };
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

import type { EventBus } from '@wrongstack/contracts/kernel';
import type {
  ContextSnapshot,
  SessionLoadProgress,
  TokenCounter,
} from '@wrongstack/contracts/types';
import type { Agent } from '@wrongstack/core/agent';
import type { TuiRuntimeState } from './tui-runtime-state.js';

export interface SessionResumeContext {
  state: TuiRuntimeState;
  agent: Agent;
  tokenCounter: TokenCounter;
  switchProviderAndModel:
    | ((providerId: string, modelId: string) => string | null | void | Promise<unknown>)
    | undefined;
  /** App EventBus — forwarded to the re-pointed todos checkpoint for storage.* events. */
  events?: EventBus | undefined;
  /**
   * Byte-level parse progress sink for large journals. When provided, the
   * store's JSONL loader throttles it to ~4 updates/sec so the TUI picker
   * hint can stream load progress instead of a static line.
   */
  onLoadProgress?: ((progress: SessionLoadProgress) => void) | undefined;
  /**
   * Why a resume returned `null`.
   *
   * `resumeSession` deliberately keeps returning `null` on failure — every
   * rollback test pins that contract, and a throw escaping mid-rollback would
   * be worse than a clean `null`. But `null` alone reaches the user as a bare
   * "Failed to resume session <id>." with no reason, on every surface, which
   * makes a broken resume undiagnosable. This sink carries the reason (and the
   * STAGE it died at) out to the caller, which turns it into the message the
   * user actually reads.
   */
  onFailure?: ((failure: SessionResumeFailure) => void) | undefined;
  /**
   * Live stage reporter.
   *
   * The same `stage` string the failure sink reports, but emitted as each step
   * BEGINS rather than only when one fails. The TUI turns it into the rolling
   * "what is happening right now" rows of the resume block — without it the
   * only honest thing that surface could show during a multi-second journal
   * parse was a spinner.
   */
  onStage?: ((stage: string) => void) | undefined;
}

/** The stage a failed resume died at, plus the underlying error text. */
export interface SessionResumeFailure {
  /** Machine-readable step name, e.g. `resolve_id`, `open_writer`, `hydrate`. */
  stage: string;
  /** Error text from the failing step — never empty. */
  message: string;
}

export interface SessionResumeResult {
  entries: unknown[];
  nextId: number;
  sessionId: string;
  /**
   * Whether the agent is now WRITING to this session.
   *
   * `false` means the transcript is on screen but ownership was never taken:
   * the session stays read-only and the next prompt continues the session the
   * user was already in. Showing the transcript anyway is deliberate — the
   * expensive, safe half of a resume (read the journal, render the timeline)
   * has no reason to be discarded because the risky half (claim the journal
   * for writing) failed.
   */
  attached: boolean;
  /**
   * Non-fatal problems the user should see, e.g. a sidecar that could not be
   * re-pointed or a provider that is no longer configured. These used to abort
   * the whole resume and roll back a transcript that had already loaded.
   */
  warnings: string[];
  /**
   * Optional context-window snapshot for the resumed session. `tokens` is a
   * flat `number` — the prompt size of the session's LAST request, read from
   * its journal by `projectLastRequestTokens`. The TUI consumer
   * (`packages/tui/src/reducers/composer.ts:561-577`) reads it as a flat
   * number and gates on `snap.tokens > 0`, so a session that never reached the
   * model reports 0 and simply leaves the chip alone.
   */
  contextSnapshot?: ContextSnapshot | undefined;
  /**
   * Text of the LAST assistant message in the resumed transcript.
   *
   * The caller parses `<nextsteps>` out of it. Deterministic by construction —
   * the TUI's per-entry parser fires on whichever assistant entry happens to
   * mount last during a replay, which is not necessarily the final turn, so a
   * resume needs the authoritative one from the transcript itself.
   */
  lastAssistantText?: string | undefined;
}

/** Flatten a message's content to plain text (string form or text blocks). */
export function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      block && typeof block === 'object' && 'text' in block && typeof block.text === 'string'
        ? block.text
        : '',
    )
    .filter(Boolean)
    .join('\n');
}

/** Text of the final assistant turn, or undefined when the session has none. */
export function lastAssistantTextOf(
  messages: readonly { role: string; content: unknown }[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    const text = messageText(message.content).trim();
    if (text) return text;
  }
  return undefined;
}

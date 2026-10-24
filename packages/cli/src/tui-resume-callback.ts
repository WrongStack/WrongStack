import type { SessionLoadProgress } from '@wrongstack/contracts/types';

import { hasOpenTodos } from '@wrongstack/core/utils';

import { parseNextSteps } from '@wrongstack/tools/next-steps';

import { resumeSession } from './boot/tui-session-resume.js';

import { setAutoSuggestions } from './services/suggestion-store.js';

export function createTuiResumeCallback({
  state,
  agent,
  tokenCounter,
  switchProviderAndModel,
  events,
}: {
  state: import('./boot/tui-runtime-state.js').TuiRuntimeState;
  agent: import('@wrongstack/core/agent').Agent;
  tokenCounter: import('@wrongstack/contracts/types').TokenCounter;
  switchProviderAndModel: (
    providerId: string,
    modelId: string,
  ) => string | Promise<string | null> | null;
  events: import('@wrongstack/contracts/kernel').EventBus;
}) {
  return async (
    sessionId: string,
    onLoadProgress?: (progress: SessionLoadProgress) => void,
    // Live stage names for the TUI's resume block. Purely a display
    // channel: it never changes what the resume does.
    onStage?: (stage: string) => void,
  ) => {
    // `resumeSession` returns `null` only when the JOURNAL could not be
    // read — every other failure now comes back as a read-only result
    // carrying the reason in `warnings`, because a transcript that
    // loaded is worth showing even when ownership was not taken. When
    // it does return null the reason went to stderr, which the TUI
    // owns, so the user would otherwise see a bare "Failed to resume
    // session <id>.". Capture the reason and REJECT with it instead:
    // both TUI resume surfaces render `.catch` text into the chat.
    let failure: import('./boot/tui-session-resume.js').SessionResumeFailure | undefined;
    const result = await resumeSession(
      {
        state,
        agent,
        tokenCounter,
        switchProviderAndModel,
        events,
        onLoadProgress,
        onStage,
        onFailure: (info) => {
          failure = info;
        },
      },
      sessionId,
    );
    if (!result) {
      throw new Error(
        failure
          ? `${failure.message} (at ${failure.stage})`
          : `Session "${sessionId}" could not be resumed.`,
      );
    }
    // ── Next steps of the RESUMED session ────────────────────────
    // A session that ended on a `<nextsteps>` block must come back
    // with those steps offered, not executed: the user picks one (or
    // types something else) and nothing runs until they do.
    //
    // Deliberately NOT `parseSuggestionsFromOutput`: that helper arms
    // `auto="true"` items as a side effect, which is precisely the
    // "it resumed and then just carried on by itself" behaviour. A
    // resume clears the auto store instead — including any items left
    // over from the session being left, which would otherwise fire the
    // moment the post-resume hold is released.
    setAutoSuggestions([]);
    // Open todos keep their precedence over suggestions, exactly as in
    // the live turn: the board is the continuation authority, and
    // offering `/next 1` beside it would let an arbitrary prompt
    // displace the next todo.
    const resumedNextSteps =
      result.attached && !hasOpenTodos(agent.ctx.todos) && result.lastAssistantText
        ? parseNextSteps(result.lastAssistantText).texts
        : [];
    return { ...result, nextSteps: resumedNextSteps };
  };
}

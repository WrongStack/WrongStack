import type { ContextSnapshot, SessionLoadProgress } from '@wrongstack/contracts/types';
import type { ResumeSessionEntry } from './app-reducer.js';
import type { HistoryEntry } from './history-entry.js';
export interface TuiSessionProps {
  /**
   * Called when the user selects a session in the /resume picker. The host
   * loads the session JSONL, replays history entries, rebuilds the agent
   * context, and returns the hydrated history entries + nextId for display.
   * Returns null when resume fails (session not found, corrupt JSONL, etc.).
   *
   * The returned entries replace the TUI's current entries in a single
   * `replaceHistory` dispatch, so the user sees the prior conversation
   * exactly as it appeared during live interaction.
   */
  onResumeSession?:
    | ((
        sessionId: string,
        onLoadProgress?: (progress: SessionLoadProgress) => void,
        /**
         * Live stage names as each step of the resume begins (`resolve_id`,
         * `open_journal`, `swap_writer`, …). Drives the rolling rows of the
         * resume loading block, so the screen reports what is actually
         * happening instead of a spinner over an unexplained multi-second wait.
         */
        onStage?: (stage: string) => void,
      ) => Promise<{
        entries: HistoryEntry[];
        nextId: number;
        sessionId: string;
        /**
         * Optional context-window snapshot computed from the resumed
         * session's tokenCounter after accounting the persisted usage.
         * When present, the reducer writes `tokens` to `state.leader.ctxTokens`,
         * `maxContext` to `state.leader.ctxMaxTokens`, and bumps
         * `state.contextChipVersion` so the chip refreshes immediately. When
         * absent, the chip stays at its previous value until the next ctx.pct
         * event lands.
         */
        contextSnapshot?: ContextSnapshot | undefined;
        /**
         * `false` when the transcript loaded but the session was NOT claimed
         * for writing — another process owns it, or the claim lapsed. The
         * conversation is still shown (read-only); the agent keeps writing to
         * the session it was already in. Treated as present-but-true by hosts
         * that predate the field.
         */
        attached?: boolean | undefined;
        /**
         * Non-fatal problems to print alongside the replayed transcript
         * (sidecars that did not re-point, a provider that is gone). These no
         * longer abort a resume, so they have to be visible somewhere.
         */
        warnings?: string[] | undefined;
        /**
         * `<nextsteps>` parsed from the resumed session's final assistant turn.
         *
         * OFFERED, never executed: the resume lists them and stops. Empty when
         * the session did not end on a next-steps block, when it has open todos
         * (the board keeps precedence), or when the transcript is read-only.
         */
        nextSteps?: string[] | undefined;
      } | null>)
    | undefined;

  /**
   * List recent session summaries for the /resume picker. The host reads
   * from the session store and returns ResumeSessionEntry-shaped data.
   * Used both by the /resume slash command (to populate the picker) and
   * optionally by the startup rehydration path.
   */
  listSessions?: ((limit?: number) => Promise<ResumeSessionEntry[]>) | undefined;
  /**
   * Branch a session at a checkpoint (the conversation before that prompt)
   * into a new session, leaving the original as it is. Returns the new id;
   * the TUI then resumes it. The working tree is shared, not copied.
   */
  forkSession?:
    | ((sessionId: string, checkpointPromptIndex: number) => Promise<{ id: string }>)
    | undefined;

  /**
   * Goal text passed from `--goal "..."` on the command line. When set,
   * the App mounts, renders the banner, then automatically dispatches
   * a synthetic `/goal <text>` so the user lands in goal mode without
   * having to type the slash command. Mutually advisory with `initialSteer`
   * — `initialGoal` wins if both are present.
   */
  initialGoal?: string | undefined;
  /**
   * Initial user message passed from `--ask "..."` on the command line.
   * Submitted verbatim as the first turn (no preamble) so users can
   * launch the TUI and pre-populate one turn from a shell alias / script.
   */
  initialAsk?: string | undefined;
  /** Directory for session JSONL files. Passed to App for /rewind. */
  sessionsDir?: string | undefined;
}

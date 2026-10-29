/**
 * Code Assist — the shared contract for the "Ask AI" panel mounted on the
 * File Manager and Code Atlas screens.
 *
 * A run is deliberately EPHEMERAL: it is answered by a throwaway isolated
 * agent on the server (see the `makeLightSubagentFactory` pattern) rather than
 * by a `session.new` session. That distinction is the whole point of this
 * module — `session.new` re-points the runtime's foreground session and
 * persists a row the user then has to clean up, neither of which a small
 * side-panel analysis should ever do.
 *
 * The preset vocabulary lives here (not in either surface) so the WebUI's
 * button labels and the server's prompt templates cannot drift apart.
 */

/**
 * Predefined analyses offered by the panel.
 *
 * - `overview`     — what this code does and how it fits the surrounding system
 * - `explain`      — line-level walkthrough of the focused symbol
 * - `quality`      — code-quality and maintainability assessment
 * - `bugs`         — hunt for real defects, not style nits
 * - `security`     — injection / unsafe-deserialization / secret exposure
 * - `tests`        — what is covered, what is missing, what to add
 * - `impact`       — blast radius of a change to this symbol
 * - `fix`          — implement the improvement (the only mutating preset)
 * - `custom`       — free-form question from the panel's input box
 */
export type CodeAssistPreset =
  | 'overview'
  | 'explain'
  | 'quality'
  | 'bugs'
  | 'security'
  | 'tests'
  | 'impact'
  | 'fix'
  | 'custom';

/** Presets that are allowed to write to the working tree. */
export type CodeAssistMutatingPreset = 'fix';

/**
 * Read-only presets run with `fs.read` only. `fix` additionally receives
 * `fs.write`; `custom` follows the panel's explicit allow-edits toggle, so a
 * free-form question cannot silently escalate into a mutating run.
 */
export function codeAssistAllowsEdits(preset: CodeAssistPreset, allowEdits: boolean): boolean {
  if (preset === 'fix') return true;
  if (preset === 'custom') return allowEdits === true;
  return false;
}

/** The target an analysis is anchored to, as sent by the panel. */
export interface CodeAssistTarget {
  /** Project-relative POSIX path. */
  filePath: string;
  /** Symbol (function / class / method) name inside `filePath`, when known. */
  symbol?: string | undefined;
  /** Line the user was viewing, when known. */
  line?: number | undefined;
}

/** `code.assist.run` payload. */
export interface CodeAssistRunRequest extends CodeAssistTarget {
  requestId: string;
  preset: CodeAssistPreset;
  question?: string | undefined;
  allowEdits?: boolean | undefined;
}

/** `code.assist.started` payload — the server accepted the run. */
export interface CodeAssistStarted {
  requestId: string;
  preset: CodeAssistPreset;
  filePath: string;
  symbol?: string | undefined;
}

/** `code.assist.delta` payload — one streamed chunk of assistant text. */
export interface CodeAssistDelta {
  requestId: string;
  text: string;
}

/** `code.assist.result` payload — the terminal frame for a run. */
export interface CodeAssistResult {
  requestId: string;
  status: 'done' | 'error' | 'aborted';
  /** Final assistant text. Absent on `error`. */
  text?: string | undefined;
  /** Human-readable failure reason. Present on `error`. */
  error?: string | undefined;
  /**
   * True when the run was allowed to write. The panel uses this to warn that
   * a "fix" run touched the working tree.
   */
  appliedEdits?: boolean | undefined;
  /**
   * Editing runs only: each file a `write`/`edit` tool targeted, with its text before the run's
   * first write to it (null = it did not exist). Read as each tool started.
   */
  edits?: Array<{ path: string; before: string | null }> | undefined;
  /** Editing runs only: tools or files whose changes were not captured (shell, patch, limits). */
  uncaptured?: string[] | undefined;
}

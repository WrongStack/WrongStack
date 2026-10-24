/**
 * Side-effect risk classification for structured audit recording (P2 #5).
 *
 * @see {@link import('../core/context.js').Context.recordSideEffect}
 */

/**
 * The kind of risk a tool side-effect poses. Used by /diag and session
 * replay to filter and group side effects.
 */
export type SideEffectRisk = 'fs.write' | 'shell' | 'package' | 'network' | 'config';

/**
 * A structured record of a non-filesystem side effect produced by a tool.
 * Appended to the session JSONL as a `side_effect` event for audit and
 * observability.
 */
export interface SideEffect {
  /** Session-unique tool call ID (from the tool_use block). */
  toolUseId: string;
  /** Tool name: 'bash' | 'install' | 'fetch' | ... */
  toolName: string;
  /** ISO timestamp. */
  ts: string;
  /** The input the tool received (command, url, packages). */
  input: Record<string, unknown>;
  /**
   * Optional outcome summary — NOT the full output (that's already in the
   * tool_result block). A short string like "exit 0", "installed 42 packages",
   * "HTTP 200 (12KB)", or "timed out".
   */
  outcome?: string | undefined;
  /** Risk classification for filtering in /diag. */
  risk: SideEffectRisk;
}

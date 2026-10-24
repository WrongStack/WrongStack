/**
 * A permission rule the user set for one session with `/permissions allow` or
 * `/permissions deny`. It lives in that session's journal and is never written
 * to the trust file or any config.
 */
export interface SessionPermissionOverride {
  effect: 'allow' | 'deny';
  /** A tool name, or a glob over tool names (`mcp__github__*`). */
  tool: string;
  /**
   * A glob over the call's subject (the command line, the path, …), matched
   * the way trust-file patterns are. Absent means any input.
   */
  pattern?: string | undefined;
}

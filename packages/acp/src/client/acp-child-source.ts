/**
 * The child session an ACP request came from. A leaf module: permission.ts and
 * acp-session-types.ts both name it, and acp-session-types.ts already imports
 * permission.ts, so neither of them can own it without a type cycle.
 */
export interface AcpChildSource {
  id: string;
  title: string | null;
}

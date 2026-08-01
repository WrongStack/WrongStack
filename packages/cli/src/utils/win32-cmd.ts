/**
 * Re-export of the canonical Windows `.cmd`/`.bat` shim builder.
 *
 * This file previously held its own copy, byte-identical to the one in
 * `@wrongstack/acp`, while `@wrongstack/mcp` used a weaker quoting helper that
 * left metacharacter-bearing arguments unquoted under `shell: true`. Keeping one
 * implementation in core removes the divergence risk (WS-004 / CMDI-005).
 */
export {
  buildWin32CmdShimInvocation,
  type Win32CmdShimInvocation,
} from '@wrongstack/core/utils';

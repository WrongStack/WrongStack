/**
 * Tool allowlist policy for the SAGE MCP server.
 *
 * Mirrors `packages/cli/src/mcp-serve.ts:217-236` (selectExposedTools).
 *
 * Tool permission model:
 *   - Sage tools use `permission: 'confirm'` for any write/delete/update/
 *     recover/backfill/verify/hygiene operation
 *     (`packages/sage/src/tools/memory-tools.ts`), reserving
 *     `permission: 'auto'` for read-only tools.
 *   - `wstack mcp serve` (`packages/cli/src/mcp-serve.ts:217-236`)
 *     decides auto-approval by routing through a host `PermissionPolicy`
 *     (`AutoApprovePermissionPolicy` defaults to read-only).
 *
 * SAGE MCP chooses a simpler axis: MCP has no UI confirm flow, so a write
 * tool surfaced over MCP cannot be approved inline — the MCP client (e.g.
 * Claude Desktop) is expected to surface its own confirm UX before
 * forwarding the call. Default policy is therefore "read-only", exposing
 * only `permission: 'auto'` AND `riskTier === 'safe'` tools. Pass
 * `--writable` to additionally expose `permission === 'confirm'` tools
 * whose `riskTier !== 'destructive'`. The MCP client owns the user-facing
 * confirmation gesture in that case.
 *
 * The tool's own `Tool.validate(input)` (see
 * `packages/sage/src/tools/memory-tools.ts:276-283` and `:332-340`) remains
 * the source of truth for per-call safety checks such as `force: true` on
 * `memory_delete`. Policy only controls visibility.
 */
import type { Tool } from '@wrongstack/core/types';

export interface SageMcpPolicyOptions {
  writable?: boolean;
}

export interface SageMcpAllowedTool {
  name: string;
  tool: Tool;
}

export function selectAllowedTools(
  tools: Tool[],
  opts: SageMcpPolicyOptions = {},
): SageMcpAllowedTool[] {
  const allowed: SageMcpAllowedTool[] = [];
  for (const tool of tools) {
    if (tool.permission === 'deny') continue;
    if (tool.riskTier === 'destructive') continue;
    if (tool.permission === 'auto') {
      if (tool.riskTier === 'safe' || opts.writable === true) {
        allowed.push({ name: tool.name, tool });
      }
      continue;
    }
    // permission === 'confirm'
    if (opts.writable !== true) continue;
    if (tool.riskTier !== 'standard' && tool.riskTier !== 'safe') continue;
    allowed.push({ name: tool.name, tool });
  }
  return allowed;
}

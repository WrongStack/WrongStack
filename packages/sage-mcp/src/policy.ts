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
import type { Tool } from '@wrongstack/contracts/types';

export interface SageMcpPolicyOptions {
  writable?: boolean;
  /**
   * Read-only plus proposals: expose `memory_candidates` narrowed to `list` and
   * `propose`. The external agent can SUGGEST a memory; only WrongStack's
   * review path (accept/reject/resolve) turns it into one. Ignored with
   * `writable`, which already exposes the full tool.
   */
  proposals?: boolean;
  /**
   * Who is calling (`claude-code`, `codex`, ...). Stamped on every proposal's
   * review reason so the reviewer sees where a suggestion came from.
   */
  origin?: string | undefined;
}

const PROPOSAL_ACTIONS = ['list', 'propose'] as const;

/**
 * `memory_candidates` with only `list` and `propose`. The schema enum is
 * narrowed so the client never offers the other actions, and `validate`
 * refuses them anyway — a schema is advice to the caller, not enforcement.
 */
export function proposalOnlyCandidatesTool(tool: Tool, origin?: string | undefined): Tool {
  const schema = tool.inputSchema as { properties?: Record<string, Record<string, unknown>> };
  const properties = { ...(schema.properties ?? {}) };
  properties['action'] = {
    ...(properties['action'] ?? {}),
    type: 'string',
    enum: [...PROPOSAL_ACTIONS],
  };
  const inner = tool as Tool<Record<string, unknown>, unknown>;
  const narrowed: Tool<Record<string, unknown>, unknown> = {
    ...inner,
    description:
      'List pending memory candidates, or propose a new one for WrongStack review. A proposal is not a memory until a reviewer accepts it in WrongStack.',
    inputSchema: { ...tool.inputSchema, properties } as Tool['inputSchema'],
    validate(input) {
      const action = input['action'];
      if (action !== undefined && !(PROPOSAL_ACTIONS as readonly unknown[]).includes(action)) {
        return [`action "${String(action)}" is not available over MCP; use list or propose.`];
      }
      return inner.validate ? inner.validate(input) : [];
    },
    execute(input, ctx, opts) {
      if (input['action'] !== 'propose' || !origin) return inner.execute(input, ctx, opts);
      const reason = typeof input['reason'] === 'string' ? input['reason'].trim() : '';
      const stamp = `Proposed by ${origin} over MCP`;
      return inner.execute({ ...input, reason: reason ? `${stamp}: ${reason}` : stamp }, ctx, opts);
    },
  };
  return narrowed as Tool;
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
    if (tool.name === 'memory_candidates' && opts.proposals === true && opts.writable !== true) {
      allowed.push({ name: tool.name, tool: proposalOnlyCandidatesTool(tool, opts.origin) });
      continue;
    }
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

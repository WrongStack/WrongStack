/**
 * Auto-approving PermissionPolicy used for subagents. Subagents run
 * non-interactively under a director — they cannot answer permission
 * prompts, so a non-YOLO policy on the leader would silently hang the
 * delegated run on the first sensitive tool call. The user already
 * authorized the delegation when they invoked the leader; subagents
 * inherit that authorization automatically.
 *
 * Tool defaults of `permission: 'deny'` are still honored (this is a
 * subagent capability override, not a deny-bypass).
 *
 * 2026-06+: Primary decision is now based on declared `Tool.capabilities`
 * (capability allowlist / denylist model). The legacy name-based DENY set
 * is kept only for backward compatibility with tools that have not yet
 * declared capabilities.
 *
 * 2026-06-13+: Switched to allowlist-by-default. Only tools with explicitly
 * allowed capabilities are auto-approved. Everything else is denied.
 * Default allowed: fs.read, net.outbound (read-only, safe operations).
 *
 * Extracted from permission-policy.ts.
 */
import type { PermissionDecision, PermissionPolicy, PermissionTrace } from '../types/permission.js';
import type { Tool } from '../types/tool.js';
import { getDangerousCapabilities, ToolCapabilities } from './capabilities.js';
import { isSensitiveReadCall } from './permission-helpers.js';

export class AutoApprovePermissionPolicy implements PermissionPolicy {
  private readonly allowedCapabilities: readonly string[];

  constructor(allowedCapabilities?: readonly string[]) {
    // Default allowlist: read-only, safe operations
    this.allowedCapabilities = allowedCapabilities ?? [
      ToolCapabilities.FS_READ,
      ToolCapabilities.NET_OUTBOUND,
    ];
  }

  private static isMcpTool(name: string): boolean {
    return name.startsWith('mcp__');
  }

  async evaluate(tool: Tool, input?: unknown): Promise<PermissionDecision> {
    // `input` used to be absent from this signature entirely, so the sensitive
    // read check the leader applies could not run here. A subagent therefore
    // read `~/.aws/credentials` unprompted where the leader would have asked —
    // and a subagent has no `confirmAwaiter`, so there is no prompt to fall back
    // on. Deny outright instead: the director can request the file itself if it
    // genuinely needs it, which puts the decision back in front of the user.
    if (input !== undefined && isSensitiveReadCall(tool, input)) {
      return {
        permission: 'deny',
        source: 'subagent_guard',
        reason:
          'subagents may not read credential-bearing paths — the leader must perform this read so the user can approve it',
      };
    }

    const caps = tool.capabilities ?? [];
    const hasAllowedCap = caps.some((c) => this.allowedCapabilities.includes(c));
    const isMcp = AutoApprovePermissionPolicy.isMcpTool(tool.name);
    const mcpProxyAllowed = this.allowedCapabilities.includes(ToolCapabilities.MCP_PROXY);

    // A tool may bundle several capabilities (e.g. `install` declares both
    // `package.install` and `shell.restricted`). The `some()` check above only
    // confirms the tool has *a* useful allowed capability — it does not stop a
    // dangerous capability from riding along. Require every DANGEROUS capability
    // the tool declares to be explicitly present in the allowlist, so widening
    // the allowlist (e.g. `/techstack` adding `fs.write`) grants exactly that
    // capability and nothing more. This is what lets the ToolExecutor trust an
    // `auto` from this policy and skip its post-permission dangerous-capability
    // downgrade (which would otherwise force a `confirm` no subagent can answer).
    const dangerousNotAllowed = getDangerousCapabilities(tool).filter(
      (c) => !this.allowedCapabilities.includes(c),
    );

    // Block if: tool is an MCP proxy without an explicit mcp.proxy grant,
    // tool default is deny, no allowed capability, or it carries a dangerous
    // capability the leader did not explicitly grant.
    const blocked =
      tool.permission === 'deny' ||
      (isMcp && !mcpProxyAllowed) ||
      !hasAllowedCap ||
      dangerousNotAllowed.length > 0;

    if (blocked) {
      const reason =
        isMcp && !mcpProxyAllowed
          ? `MCP tool ${tool.name} is not auto-approved for subagents — ask the leader to allow mcp.proxy explicitly`
          : tool.permission === 'deny'
            ? 'tool default deny'
            : dangerousNotAllowed.length > 0
              ? `tool requires un-granted dangerous capability (needs: ${dangerousNotAllowed.join(', ')}, allowed: ${this.allowedCapabilities.join(', ')})`
              : `tool lacks allowed capability (has: ${caps.join(', ') || 'none'}, allowed: ${this.allowedCapabilities.join(', ')})`;

      return {
        permission: 'deny',
        source: 'subagent_guard',
        reason,
      };
    }

    return { permission: 'auto', source: 'yolo' };
  }
  async trust(): Promise<void> {
    // No-op: subagent permission decisions are ephemeral and must not
    // pollute the leader's persisted trust file.
  }
  async deny(): Promise<void> {
    // No-op: same as trust — subagent decisions are ephemeral.
  }
  denyOnce(): void {
    // No-op: subagent decisions are ephemeral.
  }
  allowOnce(): void {
    // No-op: subagent decisions are ephemeral.
  }
  async explain(tool: Tool, input?: unknown): Promise<PermissionTrace> {
    const decision = await this.evaluate(tool, input);
    return {
      toolName: tool.name,
      subject: null,
      steps: [
        {
          rule: 'subagent auto',
          matched: decision.permission === 'auto',
          decision: decision.permission,
          source: decision.source,
          detail: decision.reason ?? `subagent policy: ${decision.permission}`,
        },
      ],
      winnerIndex: 0,
      decision,
    };
  }
  async reload(): Promise<void> {
    // No-op: nothing to load.
  }
}

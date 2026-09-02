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
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PermissionDecision, PermissionPolicy, PermissionTrace } from '../types/permission.js';
import type { Tool } from '../types/tool.js';
import { matchGlob } from '../utils/glob-match.js';
import { safeParse } from '../utils/safe-json.js';
import { subjectForToolInput } from '../utils/tool-subject.js';
import { resolveWstackPaths } from '../utils/wstack-paths.js';
import { getDangerousCapabilities, hasCapability, ToolCapabilities } from './capabilities.js';
import {
  fsWriteTargetPaths,
  hasShellSubject,
  isInsideAgentStateRoot,
  isSensitiveReadCall,
  matchesTrust,
  shellCommandLineFromInput,
} from './permission-helpers.js';
import { validateTrustPolicy } from './permission-policy-schema.js';
import { attachesWellKnownCredential, isClearlyDestructiveBashCommand } from './yolo-risk.js';

/**
 * Structural slice of the leader `Context` the subagent guards read. Kept
 * minimal so hosts that construct contexts differently still satisfy it.
 */
interface SubagentContext {
  projectRoot?: string | undefined;
  workingDir?: string | undefined;
  cwd?: string | undefined;
}

/** Options beyond the capability allowlist. */
export interface AutoApprovePolicyOptions {
  /**
   * Leader trust.json whose DENY rules bind subagents too. When omitted, the
   * canonical per-project trust path is derived from `ctx.projectRoot` at
   * evaluation time — so every production spawn site propagates leader deny
   * rules without each having to thread the path through. Pass an empty string
   * to explicitly disable propagation (tests only).
   */
  trustFile?: string | undefined;
}

/**
 * Resolved per-project trust paths (see {@link resolveTrustFile}). The path is
 * stable for a given projectRoot + WRONGSTACK_HOME, so the resolver — which
 * reads the global bootstrap config for the profile name — runs once per root
 * rather than on every evaluation.
 */
const trustFileByProjectRoot = new Map<string, string>();

export class AutoApprovePermissionPolicy implements PermissionPolicy {
  private readonly allowedCapabilities: readonly string[];
  private readonly trustFile: string | undefined;

  constructor(allowedCapabilities?: readonly string[], opts?: AutoApprovePolicyOptions) {
    // Default allowlist: read-only, safe operations
    this.allowedCapabilities = allowedCapabilities ?? [
      ToolCapabilities.FS_READ,
      ToolCapabilities.NET_OUTBOUND,
    ];
    this.trustFile = opts?.trustFile;
  }

  private static isMcpTool(name: string): boolean {
    return name.startsWith('mcp__');
  }

  async evaluate(tool: Tool, input?: unknown, ctx?: SubagentContext): Promise<PermissionDecision> {
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

    // Deny rules the user recorded against the leader must bind delegated agents
    // too. Without this check, delegation was a one-hop bypass of the approval
    // system: deny a command, the model re-issues it through a subagent, it
    // runs. Only deny propagates — a leader "always allow" must never widen
    // what a subagent may silently do.
    const leaderDeny = await this.leaderDenyDecision(tool, input, ctx);
    if (leaderDeny) return leaderDeny;

    // The leader's YOLO gate (yoloBlockedAsDestructive in
    // DefaultPermissionPolicy) blocks clearly destructive shell and
    // credential-binding even with YOLO on. A subagent is strictly less
    // supervised than the leader, so it must not run them either — and deny is
    // the only correct terminal state, because a subagent cannot answer a
    // prompt. `shellCommandLineFromInput` joins command+args so the classifier
    // sees the full line, never the bare program name.
    const destructiveReason = this.destructiveCallReason(tool, input, ctx);
    if (destructiveReason) {
      return { permission: 'deny', source: 'subagent_guard', reason: destructiveReason };
    }

    // Same guard class for WrongStack's own trusted state: writing `hooks` into
    // config.json is boot-time RCE on next launch, writing `trust.json`
    // disables approval prompts permanently — both silent. The leader forces
    // these to a prompt (hasAgentStateWriteTarget); the subagent port denies.
    if (this.hasAgentStateWriteTarget(tool, input, ctx)) {
      return {
        permission: 'deny',
        source: 'subagent_guard',
        reason:
          'subagents may not write WrongStack agent state (config/trust/auth) — the leader must perform this write so the user can approve it',
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
  private destructiveCallReason(
    tool: Tool,
    input: unknown,
    ctx?: SubagentContext,
  ): string | undefined {
    // Binding a well-known third-party credential to a provider endpoint is an
    // exfiltration primitive, not a shell command — ported from the leader's
    // yoloBlockedAsDestructive so both principals block it.
    if (attachesWellKnownCredential(input)) {
      return 'subagents may not attach well-known credentials to provider endpoints — the leader must perform this call so the user can approve it';
    }
    // Wider than the leader's bash/exec/shell.arbitrary surface on purpose:
    // shell.restricted / shell.exec tools run commands too, and deny is the
    // safe direction for anything the classifier flags.
    if (!hasShellSubject(tool)) return undefined;
    const command = shellCommandLineFromInput(input);
    if (!command) return undefined;
    if (isClearlyDestructiveBashCommand(command, ctx?.projectRoot)) {
      return 'subagents may not run clearly destructive shell commands — the leader blocks these even with YOLO enabled';
    }
    return undefined;
  }

  /** Port of DefaultPermissionPolicy.hasAgentStateWriteTarget (leader). */
  private hasAgentStateWriteTarget(tool: Tool, input: unknown, ctx?: SubagentContext): boolean {
    if (!hasCapability(tool, ToolCapabilities.FS_WRITE)) return false;
    const base = ctx?.workingDir ?? ctx?.cwd;
    for (const targetPath of fsWriteTargetPaths(input)) {
      const resolved = base ? path.resolve(base, targetPath) : path.resolve(targetPath);
      if (isInsideAgentStateRoot(resolved)) return true;
    }
    return false;
  }

  private resolveTrustFile(ctx?: SubagentContext): string | undefined {
    if (this.trustFile !== undefined) {
      return this.trustFile.length > 0 ? this.trustFile : undefined;
    }
    const root = ctx?.projectRoot;
    if (!root) return undefined;
    let cached = trustFileByProjectRoot.get(root);
    if (cached === undefined) {
      cached = resolveWstackPaths({ projectRoot: root }).projectTrust;
      trustFileByProjectRoot.set(root, cached);
    }
    return cached;
  }

  /**
   * Deny decision when the leader's trust file forbids this call, or when the
   * file is unreadable/invalid. Fail closed on the latter: the leader refuses
   * everything until its trust file is repaired, and a delegated agent must
   * never be the weaker gate. An absent file (ENOENT) simply has no deny rules.
   */
  private async leaderDenyDecision(
    tool: Tool,
    input: unknown,
    ctx?: SubagentContext,
  ): Promise<PermissionDecision | undefined> {
    const trustFile = this.resolveTrustFile(ctx);
    if (!trustFile) return undefined;
    let raw: string;
    try {
      raw = await fs.readFile(trustFile, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      return {
        permission: 'deny',
        source: 'subagent_guard',
        reason: `leader trust policy unreadable (${err instanceof Error ? err.message : String(err)}); subagent tool execution refused until it is repaired`,
      };
    }
    const parsed = safeParse<unknown>(raw);
    if (!parsed.ok) {
      return {
        permission: 'deny',
        source: 'subagent_guard',
        reason:
          'leader trust policy is not valid JSON; subagent tool execution refused until it is repaired',
      };
    }
    const validation = validateTrustPolicy(parsed.value);
    if (!validation.ok) {
      return {
        permission: 'deny',
        source: 'subagent_guard',
        reason:
          'leader trust policy is invalid; subagent tool execution refused until it is repaired',
      };
    }
    const policy = validation.policy;
    const subject = subjectForToolInput(tool.name, input, tool.subjectKey, tool.subjectFields);
    if (!subject) return undefined;
    // Deny is the union of the exact-name entry and every matching wildcard
    // entry — a narrow grant must never drop a broad guardrail. The leader
    // matches the deny patterns with the broad glob matcher (`matchesTrust`),
    // so the identical matcher is used here: narrowing a deny pattern would
    // un-block whatever falls outside it.
    const denyPatterns = [...(policy[tool.name]?.deny ?? [])];
    for (const [key, value] of Object.entries(policy)) {
      if (!key.includes('*') || !value.deny) continue;
      if (matchGlob(key, tool.name)) denyPatterns.push(...value.deny);
    }
    if (denyPatterns.length > 0 && matchesTrust(denyPatterns, subject)) {
      return {
        permission: 'deny',
        source: 'subagent_guard',
        reason: `leader deny rule matched ${tool.name} (subject: ${subject})`,
      };
    }
    return undefined;
  }

  async explain(tool: Tool, input?: unknown, ctx?: SubagentContext): Promise<PermissionTrace> {
    const decision = await this.evaluate(tool, input, ctx);
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

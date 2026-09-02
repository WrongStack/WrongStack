/**
 * A read-only permission policy wrapper.
 *
 * Wraps an existing `PermissionPolicy` and, when the session-level
 * `readOnly` flag is set in `ctx.meta['readOnly']`, denies any tool that
 * carries a mutation capability (write, delete, shell, install, etc.) —
 * unless the tool is writing a `.md` report file under the project's
 * `.temp_files/` directory, which is the sole write operation allowed
 * in read-only mode.
 *
 * The wrapper is a no-op pass-through when `ctx.meta['readOnly']` is
 * not set or is `false`. It can be permanently installed around the
 * `DefaultPermissionPolicy`; the session toggle controls activation.
 *
 * Session-level toggle (set `ctx.meta['readOnly'] = true/false`):
 * ```ts
 * agent.ctx.meta['readOnly'] = true;  // enable
 * agent.ctx.meta['readOnly'] = false; // disable
 * ```
 *
 * This is designed for the leader agent. Subagents independently inherit
 * read-only constraints through `AutoApprovePermissionPolicy` with a
 * read-only capability allowlist.
 *
 * Usage:
 * ```ts
 * const policy = new ReadOnlyPermissionPolicy(innerPolicy, projectRoot);
 * container.rebind(TOKENS.PermissionPolicy, () => policy);
 * ```
 */

import * as path from 'node:path';
import type { Context } from '../core/context.js';
import type { PermissionDecision, PermissionPolicy, PermissionTrace } from '../types/permission.js';
import type { Tool } from '../types/tool.js';
import { ToolCapabilities } from './capabilities.js';

// ── Mutation capabilities ──────────────────────────────────────────────────
// Any tool that carries one of these is blocked in read-only mode, unless
// it matches the .temp_files/*.md exception.

const MUTATION_CAPABILITIES = new Set<string>([
  ToolCapabilities.FS_WRITE,
  ToolCapabilities.FS_WRITE_OUTSIDE_PROJECT,
  ToolCapabilities.MEMORY_WRITE,
  ToolCapabilities.MEMORY_DELETE,
  ToolCapabilities.SHELL_ARBITRARY,
  ToolCapabilities.SHELL_RESTRICTED,
  ToolCapabilities.SHELL_EXEC,
  ToolCapabilities.TOOL_MUTATE_ANY,
  ToolCapabilities.CONFIG_MUTATE,
  ToolCapabilities.PACKAGE_INSTALL,
  ToolCapabilities.SUBAGENT_SPAWN,
]);

/**
 * Does this tool change something?
 *
 * `capabilities` is the precise answer and stays authoritative — but it is
 * OPT-IN metadata, and a repo-wide count found 154 tools declaring
 * `mutating: true` of which 121 carried no mutation capability at all (28 of
 * those at `permission: 'auto'`, including tools that write API keys and one
 * that sends messages outbound). Read-only mode consulted only `capabilities`,
 * so every one of them ran unblocked and unprompted, while
 * `permission-policy.ts` was already answering the same question with
 * `tool.mutating || …`.
 *
 * Trusting `mutating` here closes all 121 at once and makes the two policies
 * agree. It fails in the safe direction: a tool that declares itself mutating
 * is blocked in read-only mode even if its capability list is incomplete.
 * Fixing the capability labels is still worth doing — it is what the finer
 * grained gates key on — but it is no longer what stands between read-only
 * mode and a write.
 */
export function toolMutates(tool: Tool): boolean {
  if (tool.mutating === true) return true;
  return (tool.capabilities ?? []).some((c) => MUTATION_CAPABILITIES.has(c));
}

/** Local alias kept for readability at the call sites below. */
const hasMutationCapability = toolMutates;

/**
 * Check whether a tool input targets a `.md` file under `.temp_files/`.
 * Both the `write` and `edit` tools use `input.path` as the target path.
 */
function isAllowedReportFile(input: unknown, projectRoot: string): boolean {
  if (!input || typeof input !== 'object') return false;
  const record = input as Record<string, unknown>;
  const inputPath = record['path'];
  if (typeof inputPath !== 'string') return false;

  // Only allow .md files.
  if (!inputPath.endsWith('.md')) return false;

  // Resolve against the project root and verify it's under .temp_files/.
  try {
    const resolved = path.resolve(projectRoot, inputPath);
    const tempDir = path.resolve(projectRoot, '.temp_files');
    if (!resolved.startsWith(tempDir + path.sep) && resolved !== tempDir) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Read-only permission policy — session-scoped toggle via ctx.meta['readOnly'].
 *
 * Wraps an inner policy and, when `ctx.meta['readOnly'] === true`, denies
 * mutation-capable tools unless they target `.temp_files/*.md`. When the
 * flag is not set or false, the wrapper is a transparent pass-through.
 *
 * Read-only tools (fs.read, net.outbound, memory.read, …) always pass
 * through to the inner policy unchanged.
 */
export class ReadOnlyPermissionPolicy implements PermissionPolicy {
  constructor(
    private readonly inner: PermissionPolicy,
    private readonly projectRoot: string,
  ) {}

  async evaluate(tool: Tool, input: unknown, ctx: Context): Promise<PermissionDecision> {
    // Session-level toggle: check ctx.meta['readOnly'].
    // When not set or false, pass through to inner policy (no-op).
    if (ctx.meta['readOnly'] !== true) {
      return this.inner.evaluate(tool, input, ctx);
    }

    // Fast path: no mutation capability → pass through to inner policy.
    if (!hasMutationCapability(tool)) {
      return this.inner.evaluate(tool, input, ctx);
    }

    // Exception: writing .md reports to .temp_files/ is allowed.
    if (isAllowedReportFile(input, this.projectRoot)) {
      return this.inner.evaluate(tool, input, ctx);
    }

    // Name the reason the tool was blocked. A tool can qualify on its
    // capability labels OR on `mutating: true` alone — the second case has no
    // capabilities to list, and printing an empty `()` reads like a bug.
    const matched = (tool.capabilities ?? []).filter((c) => MUTATION_CAPABILITIES.has(c));
    const why =
      matched.length > 0
        ? `requires mutation capabilities (${matched.join(', ')})`
        : 'is declared mutating';
    return {
      permission: 'deny',
      source: 'readonly_mode',
      reason:
        `Session is in read-only mode: tool "${tool.name}" ${why}, ` +
        `which is not allowed. Only .md report files under .temp_files/ may be written.`,
    };
  }

  async trust(rule: { tool: string; pattern: string }): Promise<void> {
    return this.inner.trust(rule);
  }

  async deny(rule: { tool: string; pattern: string }): Promise<void> {
    return this.inner.deny(rule);
  }

  denyOnce(rule: { tool: string; pattern: string }): void {
    this.inner.denyOnce(rule);
  }

  allowOnce(rule: { tool: string; pattern: string }): void {
    this.inner.allowOnce(rule);
  }

  async reload(): Promise<void> {
    if (
      'reload' in this.inner &&
      typeof (this.inner as { reload: () => Promise<void> }).reload === 'function'
    ) {
      await (this.inner as { reload: () => Promise<void> }).reload();
    }
  }

  async explain(tool: Tool, input: unknown, ctx: Context): Promise<PermissionTrace> {
    // Session-level toggle check.
    if (ctx.meta['readOnly'] !== true) {
      if (this.inner.explain) return this.inner.explain(tool, input, ctx);
      const decision = await this.inner.evaluate(tool, input, ctx);
      return {
        toolName: tool.name,
        subject: null,
        steps: [
          {
            rule: 'inner',
            matched: true,
            decision: decision.permission === 'deny' ? 'deny' : 'auto',
            source: decision.source,
            detail: decision.reason ?? 'Inner policy decision',
          },
        ],
        winnerIndex: 0,
        decision,
      };
    }

    // For read-only tools, show the inner policy's explain trace.
    // For denied tools, produce a synthetic trace with the readonly_mode step.
    if (!hasMutationCapability(tool) || isAllowedReportFile(input, this.projectRoot)) {
      if (this.inner.explain) return this.inner.explain(tool, input, ctx);
      const decision = await this.evaluate(tool, input, ctx);
      return {
        toolName: tool.name,
        subject: null,
        steps: [
          {
            rule: 'readonly_mode',
            matched: decision.permission === 'deny',
            decision: decision.permission === 'deny' ? 'deny' : 'auto',
            source: 'readonly_mode',
            detail: decision.reason ?? 'Read-only mode',
          },
        ],
        winnerIndex: 0,
        decision,
      };
    }

    return {
      toolName: tool.name,
      subject: null,
      steps: [
        {
          rule: 'readonly_mode',
          matched: true,
          decision: 'deny',
          source: 'readonly_mode',
          detail: `Read-only mode blocks ${tool.name} because it carries mutation capabilities (${(tool.capabilities ?? []).filter((c) => MUTATION_CAPABILITIES.has(c)).join(', ')}). Only .md files under .temp_files/ may be written.`,
        },
      ],
      winnerIndex: 0,
      decision: {
        permission: 'deny',
        source: 'readonly_mode',
        reason: `Read-only mode: ${tool.name} requires mutation capabilities.`,
      },
    };
  }
}

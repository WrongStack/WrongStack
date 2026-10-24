import type { BuildContext, ModelCapabilities } from '@wrongstack/contracts/types/system-prompt';

import type { Tool } from '@wrongstack/contracts/types/tool';

import type { InstructionBundle, SystemInstructionVariant } from './instruction-bundle.js';

import { type InstructionTemplateContext, renderInstructionLayer } from './instruction-template.js';

import { instructionSection, renderToolSelectionBoundary } from './system-prompt-blocks.js';

function compactToolHint(hint: string, limit: number): string {
  const text = hint.trim();
  if (text.length <= limit) return text;
  const sentenceEnd = text.indexOf('.') + 1;
  let end = Math.min(sentenceEnd > 0 ? sentenceEnd : limit, limit);
  // Keep a character intact when the configured boundary falls inside an emoji.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}

export interface SystemPromptToolUsageHost {
  instructions: (variant?: SystemInstructionVariant | undefined) => Promise<InstructionBundle>;
  templateContext: (ctx: BuildContext) => InstructionTemplateContext;
  tier: ConcreteTokenSavingTier;
  modelCapabilities: () => ModelCapabilities | undefined;
  _toolsUsageCache:
    | {
        toolsRef: readonly Tool[];
        tier: string;
        subagent: boolean;
        maxContextTokens: number;
        instructions: InstructionBundle;
        text: string;
      }
    | undefined;
  toolDescLimit: () => number;
}
export async function buildToolUsage(
  host: SystemPromptToolUsageHost,
  tools: Tool[],
  ctx: BuildContext,
  tplCtx?: InstructionTemplateContext | undefined,
): Promise<string> {
  if (tools.length === 0) return '## Tool usage\n\nNo tools registered.';
  const instructions = await host.instructions(ctx.systemVariant);
  // Sections get the same conditional-block treatment as the identity layer,
  // so a `sections/*.md` override can gate on the live tool set too.
  const tpl = tplCtx ?? host.templateContext(ctx);
  const section = (key: string, vars: Record<string, string | number> = {}): string =>
    instructionSection(instructions, key, vars, tpl);

  // Cache: tools array is stable (same reference) until a registry mutation
  // thanks to B2 (ToolRegistry snapshot). When both keys match the previous
  // build, the full output is identical — return the cached string.
  // Including `tier` in the key ensures that mutating
  // `opts.tokenSavingMode` between builds (rare but supported via the
  // `private readonly opts` design) recomputes the prompt with the
  // new tier's truncation limits and tier-gated content. The live
  // online-agents snapshot is deliberately NOT an input here — it lives in
  // the `peers` volatile block so this layer stays provider-cache-stable.
  const tier = host.tier;
  const subagent = ctx.subagent === true;
  const maxContextTokens = host.modelCapabilities()?.maxContextTokens ?? 0;
  if (
    host._toolsUsageCache?.toolsRef === tools &&
    host._toolsUsageCache?.instructions === instructions &&
    host._toolsUsageCache?.tier === tier &&
    host._toolsUsageCache?.subagent === subagent &&
    host._toolsUsageCache?.maxContextTokens === maxContextTokens
  ) {
    return host._toolsUsageCache.text;
  }

  // Group tools by category for a cleaner listing when categories are used.
  const byCat = new Map<string, Tool[]>();
  const uncategorized: Tool[] = [];
  for (const t of tools) {
    if (t.category) {
      let group = byCat.get(t.category);
      if (!group) {
        group = [];
        byCat.set(t.category, group);
      }
      group.push(t);
    } else {
      uncategorized.push(t);
    }
  }

  const lines = ['## Tool usage'];
  const descLimit = host.toolDescLimit();

  // Categorized tools
  for (const [cat, catTools] of byCat) {
    lines.push(`\n### ${cat}`);
    for (const t of catTools) {
      const hint = t.usageHint ?? t.description;
      // Trim to the tier-specific limit, preferring sentence boundaries.
      const desc = compactToolHint(hint, descLimit);
      lines.push(`- **${t.name}** — ${desc}`);
      const boundary = renderToolSelectionBoundary(t);
      if (boundary) lines.push(`  ${boundary}`);
    }
  }

  // Uncategorized tools
  if (uncategorized.length > 0) {
    if (byCat.size > 0) lines.push('');
    for (const t of uncategorized) {
      const hint = t.usageHint ?? t.description;
      lines.push(`\n### ${t.name}\n${compactToolHint(hint, descLimit)}`);
      const boundary = renderToolSelectionBoundary(t);
      if (boundary) lines.push(boundary);
    }
  }

  // Common tool chain patterns — teaches model how to compose tools effectively.
  // Skipped in minimal and aggressive tiers — model already knows these patterns
  // and aggressive users are under context pressure.
  if (host.tier !== 'minimal' && host.tier !== 'aggressive') {
    const commonPatterns = section('tool.common.patterns');
    if (commonPatterns) {
      lines.push(
        renderInstructionLayer(commonPatterns, {
          toolNames: new Set(tools.map((tool) => tool.name)),
          tier: host.tier,
          subagent: ctx.subagent === true,
        }),
      );
    }
  }

  // Delegation guidance — included when the `delegate` tool is present.
  // Without this block the model doesn't know that multi-agent work is
  // even an option, and `delegate` sits unused while the host agent
  // tries to do everything in one expensive context.
  // Tier behaviour:
  // - 'off' → full block
  // - 'light' / 'medium' → minimal one-liner
  // - 'minimal' / 'aggressive' → skipped
  const hasDelegate = tools.some((t) => t.name === 'delegate');
  if (hasDelegate) {
    const delegateTool = tools.find((t) => t.name === 'delegate');
    const enumValues = (() => {
      const role = (
        delegateTool?.inputSchema as
          | { properties?: { role?: { enum?: unknown | undefined } } }
          | undefined
      )?.properties?.role?.enum;
      return Array.isArray(role) ? (role.filter((r) => typeof r === 'string') as string[]) : [];
    })();
    // The tool's own menu first: `delegate` keeps its roster out of the wire
    // schema (an 80-id enum on every request), so a schema-only read rendered
    // "(no roster configured)" beside a full roster. The enum stays as the
    // fallback for tools that still declare one.
    const roleList =
      delegateTool?.promptVars?.roleList ??
      (enumValues.length > 0 ? enumValues.join(', ') : '(no roster configured)');
    const modelMenu = delegateTool?.promptVars?.modelMenu ?? '';
    if (host.tier === 'minimal' || host.tier === 'aggressive') {
      // Skip — don't emit any delegation guidance
    } else if (host.tier === 'light' || host.tier === 'medium') {
      // Balanced token-saving tiers get the compact one-liner instead of
      // the full multi-paragraph guidance.
      const delegation = section('tool.delegation.compact', {
        roleList,
        modelMenu,
      });
      if (delegation) lines.push(delegation);
    } else {
      const delegation = section('tool.delegation.full', {
        roleList,
        modelMenu,
      });
      if (delegation) lines.push(delegation);
    }
  }

  // Mailbox guidance — included when any mailbox tool is present.
  // Tier behaviour:
  // - 'off' → full block
  // - every token-saving tier → compact project-wide contract
  //
  // Note: 'aggressive' was previously listed with 'off' for the
  // full block, but per the parallel-session decision (Option H,
  // `leader@1b68eb14`): at aggressive, the 400-token mailbox essay
  // is the largest single guidance section and users under context
  // pressure don't need it. The compact one-liner is enough.
  const hasMailbox = tools.some(
    (t) => t.name === 'mailbox' || t.name === 'mail_send' || t.name === 'mail_inbox',
  );
  if (hasMailbox) {
    // The live online-agents snapshot intentionally does NOT render here
    // anymore: status/task/tool churn in this layer invalidated the core
    // provider-cache prefix on every fleet status change. The snapshot now
    // lives in the `peers` volatile block (see buildRegions), which the
    // request composer re-homes after the deep cache boundary.
    const onlineAgentsInfo = '';
    const hasMailboxPowerTool = tools.some((t) => t.name === 'mailbox');
    const mailStatusCommand = tools.some((t) => t.name === 'fleet_status')
      ? '`fleet_status`'
      : hasMailboxPowerTool
        ? '`mailbox action=status` or `mailbox action=online`'
        : 'the online-agent list above';
    const mailInboxCommand = tools.some((t) => t.name === 'mail_inbox')
      ? '`mail_inbox`'
      : '`mailbox action=check`';
    const mailSendCommand = tools.some((t) => t.name === 'mail_send')
      ? '`mail_send`'
      : '`mailbox action=send`';
    const mailboxVars = {
      onlineAgentsInfo,
      mailStatusCommand,
      mailInboxCommand,
      mailSendCommand,
    };
    if (host.tier !== 'off') {
      // Minimal: keep just the header and agent count.
      // `aggressive` joins `light`/`medium` — the 400-token mailbox essay
      // is the largest single guidance section; users under context pressure
      // don't need it.
      const mailbox = section('tool.mailbox.compact', mailboxVars);
      if (mailbox) lines.push(mailbox);
    } else {
      const mailbox = section('tool.mailbox.full', mailboxVars);
      if (mailbox) lines.push(mailbox);
    }
  }

  // Same-session talk — in-process notes, not mailbox. Compact on every
  // token-saving tier; full block only when the prompt is unconstrained.
  if (tools.some((t) => t.name === 'session_note')) {
    const sessionNote = section(
      host.tier === 'off' ? 'tool.session.note.full' : 'tool.session.note.compact',
    );
    if (sessionNote) lines.push(sessionNote);
  }

  // Commit hygiene — shown whenever the structured `git` tool is available.
  // Other agents (or a separate wrongstack process, or a human) may be
  // editing the SAME working tree at the same time; a blanket commit captures
  // their half-done work and there is no clean way to undo a shared commit.
  const hasGitTool = tools.some((t) => t.name === 'git');
  if (
    hasGitTool &&
    host.tier !== 'minimal' &&
    host.tier !== 'light' &&
    host.tier !== 'aggressive'
  ) {
    const commitHygiene = section('tool.commit.hygiene');
    if (commitHygiene) lines.push(commitHygiene);
  }

  // MCP lazy-loading guidance — shown whenever mcp_control is registered.
  // Tier behaviour:
  // - 'off' / 'medium' → full guidance block
  // - 'minimal' / 'light' / 'aggressive' → minimal one-liner
  //
  // Note: 'aggressive' was previously listed with 'off' for the
  // full block, but per the parallel-session decision (Option H):
  // at aggressive, the full MCP workflow (activate → use →
  // deactivate) is documented elsewhere and the meta-tool
  // `mcp_use` is sufficient. The one-liner is enough.
  const hasMcpControl = tools.some((t) => t.name === 'mcp_control');
  const hasMcpUse = tools.some((t) => t.name === 'mcp_use');
  if (hasMcpControl) {
    if (host.tier === 'minimal' || host.tier === 'light' || host.tier === 'aggressive') {
      // Minimal one-liner — `aggressive` joins `minimal`/`light`. The full
      // MCP workflow (activate → use → deactivate) is documented elsewhere
      // and the meta-tool `mcp_use` is sufficient at any tier that has it.
      const mcp = section(hasMcpUse ? 'tool.mcp.compact.use' : 'tool.mcp.compact.control');
      if (mcp) lines.push(mcp);
    } else {
      // Full block
      const mcp = section(hasMcpUse ? 'tool.mcp.full.use' : 'tool.mcp.full.control');
      if (mcp) lines.push(mcp);
    }
  }

  // Context management guidance — shown when context_manager is registered.
  // Tier behaviour:
  // - 'off' → full block
  // - 'medium' → minimal one-liner
  // - 'minimal' / 'light' → skipped
  const hasContextManager = tools.some((t) => t.name === 'context_manager');
  if (hasContextManager) {
    if (host.tier === 'minimal' || host.tier === 'light' || host.tier === 'aggressive') {
      // Skip
    } else if (host.tier === 'medium') {
      const contextManagement = section('tool.context.management.compact');
      if (contextManagement) lines.push(contextManagement);
    } else {
      // Adaptive threshold based on model context window size.
      // Small context (<=32k) → trigger earlier; large context (>32k) → more relaxed.
      // Fallback to 0 when unknown → conservative compaction (50 % threshold).
      const maxCtx = host.modelCapabilities()?.maxContextTokens ?? 0;
      const threshold = maxCtx <= 32000 ? '50' : '70';
      const contextManagement = section('tool.context.management.full', { threshold });
      if (contextManagement) lines.push(contextManagement);
    }
  }

  // Store cache — keyed by tools reference (B2 snapshot) + tier + subagent +
  // maxContextTokens + instruction bundle, so it auto-invalidates on a variant
  // switch, when tools change, the token-saving
  // tier changes, the prompt is for a different audience (host vs subagent),
  // or a /model switch changes the context-management threshold.
  const text = lines.join('\n');
  host._toolsUsageCache = {
    toolsRef: tools,
    tier,
    subagent,
    maxContextTokens,
    instructions,
    text,
  };
  return text;
}

import type { ConcreteTokenSavingTier } from '@wrongstack/contracts/types/config';

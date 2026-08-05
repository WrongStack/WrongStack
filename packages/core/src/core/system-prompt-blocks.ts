/**
 * Block provenance and the stateless render helpers of the system-prompt build.
 *
 * Split out of `system-prompt-builder.ts`. Everything here is pure: it depends
 * only on its arguments, so it moved out of the builder class unchanged.
 * `SystemBlockSource` / `SYSTEM_BLOCK_SOURCE` keep their re-export from
 * `system-prompt-builder.ts`, which remains the public import site.
 *
 * @module core/system-prompt-blocks
 */
import type { MailboxAgentStatus } from '../coordination/mailbox-types.js';
import type { TextBlock } from '../types/blocks.js';
import type { Tool } from '../types/tool.js';
import type { InstructionBundle } from './instruction-bundle.js';
import {
  type InstructionTemplateContext,
  renderInstructionLayer,
} from './instruction-template.js';

/**
 * The section of the system prompt a given TextBlock originated from. Used by
 * `getContextBreakdown()` to attribute real token counts per category in the
 * `/context` display.
 */
export type SystemBlockSource =
  | 'identity' // layer1 — instructions/system.md
  | 'tool-usage' // layer2 — tool prose summary
  | 'environment' // layer3 — OS/git/date/skills-in-scope
  | 'skills' // layer4 — Active Skills bodies (+ memory when injectMemory)
  | 'mode' // layer5 mode prompt + mode-skill hint
  | 'plan' // layer6 — active plan
  | 'leader-after-task' // leader-only after-task affordances
  | 'contributor' // plugin-contributed volatile blocks
  | 'ledger' // volatile completed-work ledger (request-time)
  | 'nextsteps'; // volatile next-steps gate (request-time)

/**
 * Side-table mapping each system-prompt TextBlock to the section it came from.
 * Kept as a WeakMap rather than a field on TextBlock so the label never reaches
 * the wire: the provider adapters spread blocks verbatim (Anthropic non-ttl
 * `: b`, OpenAI `stripCacheControl` rest-spread), so any extra field would leak.
 * Block identities survive `flattenSystemPromptRegions` into `ctx.systemPrompt`,
 * so a later read of `ctx.systemPrompt` resolves the same entries.
 */
export const SYSTEM_BLOCK_SOURCE = new WeakMap<TextBlock, SystemBlockSource>();

/** Tag a freshly-built block with its origin, returning the same reference. */
export function tagBlock(block: TextBlock, source: SystemBlockSource): TextBlock {
  SYSTEM_BLOCK_SOURCE.set(block, source);
  return block;
}

export function shortSessionId(sessionId: string): string {
  const leaf = sessionId.split('/').pop() ?? sessionId;
  return leaf.length > 12 ? `${leaf.slice(0, 12)}…` : leaf;
}

/**
 * Render one `sections/*.md` entry.
 *
 * `tplCtx` opts the section into the same conditional-block syntax the identity
 * layers use (see `instruction-template.ts`); without it the section is
 * rendered with every condition true, which matches the pre-templating
 * behaviour for callers that don't have a live tool set to hand.
 */
export function instructionSection(
  bundle: InstructionBundle,
  key: string,
  vars: Record<string, string | number> = {},
  tplCtx?: InstructionTemplateContext | undefined,
): string {
  const template = bundle.sections?.[key];
  if (!template) return '';
  return renderInstructionLayer(
    template,
    tplCtx ? { ...tplCtx, vars: { ...tplCtx.vars, ...vars } } : undefined,
  ).replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

export function renderToolSelectionBoundary(tool: Tool): string {
  const selection = tool.selection;
  if (!selection?.doNotUseWhen.trim()) return '';
  const alternatives = selection.useInstead?.filter(Boolean) ?? [];
  const instead =
    alternatives.length > 0
      ? ` Use ${alternatives.map((name) => `\`${name}\``).join(' or ')} instead.`
      : '';
  return `Do not use when ${selection.doNotUseWhen.trim()}${instead}`;
}

/**
 * Cheap content fingerprint of the online agents array. The mailbox
 * rebuilds the array as a fresh object on every status check, so caching
 * by reference always misses — this lets the renderOnlineAgents and
 * buildToolUsage caches detect rendered identity/status/task/tool changes
 * instead.
 *
 * O(n) over every field rendered in the peer snapshot. This matters because
 * status/task/tool changes should invalidate the prompt just like joins and
 * leaves do. Uses FNV-1a over character codes; a collision would only leave a
 * stale cosmetic snapshot in the prompt.
 */
export function agentsFingerprint(agents: readonly MailboxAgentStatus[] | undefined): string {
  if (!agents || agents.length === 0) return '0';
  let h = 0x811c9dc5;
  for (const a of agents) {
    const fields = [
      a.agentId,
      a.name,
      a.source,
      a.sessionId,
      a.status,
      a.currentTask,
      a.currentTool,
      a.online ? '1' : '0',
    ];
    for (const field of fields) {
      const value = field ?? '';
      for (let i = 0; i < value.length; i++) {
        h ^= value.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      h ^= 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return `${agents.length}:${h.toString(36)}`;
}

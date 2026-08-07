/**
 * Conditional templating for the file-backed instruction layers.
 *
 * Why this exists: `instructions/system.md` (and its `-lite` / `-pro`
 * variants) used to be injected as layer-1 verbatim, listing ~100 tool names
 * regardless of which tools the current request actually exposed. At
 * `minimal`/`light` tier only the 15 TIER1 tools are sent directly
 * (`@wrongstack/tools` `selectBuiltinToolsForTier`), yet the prompt still
 * spent ~8k tokens explaining `kanban`, the browser tools, the SAGE memory
 * tools and the Telegram bridge. Those tools may remain executable through
 * lazy discovery, but are not legal direct calls in that request. The
 * token-saving tier was spending most of its savings back in the prompt, and
 * the text had to carry a "some of the above may be a lie" disclaimer to
 * compensate.
 *
 * Layer-2 (`buildToolUsage`) already gated its guidance on the live tool set;
 * this module gives the markdown layers the same power without splitting the
 * files apart, so project/profile overrides keep working and the sources stay
 * readable.
 *
 * ## Syntax
 *
 * Block form — HTML comments, invisible in a markdown preview:
 *
 * ```markdown
 * <!--ws:if tool=kanban-->
 * ## Work planning with Kanban
 * ...
 * <!--ws:else-->
 * Track multi-step work with `todo`.
 * <!--ws:end-->
 * ```
 *
 * Conditions are space-separated attributes, ANDed together. Values within one
 * attribute are comma-separated and ORed. A leading `!` negates the attribute.
 *
 * - `tool=a,b,c` — at least one of those tools is registered
 * - `!tool=a,b`  — none of those tools is registered
 * - `tier=off,medium` — the active token-saving tier is one of these
 * - `role=leader` / `role=subagent`
 *
 * Inline form, for tool inventory lines:
 *
 * ```markdown
 * {{tools:read,edit,write,patch}}
 * ```
 *
 * renders only the registered names, backticked and comma-joined; it renders
 * as the empty string when none are registered.
 *
 * ## Fail-open contract
 *
 * A malformed override must never blank the identity prompt, so every error
 * path keeps text and drops only the marker:
 *
 * - unknown attribute / malformed condition → the condition is treated as true
 * - stray `ws:else` / `ws:end` → the marker is dropped, surrounding text stays
 * - unclosed `ws:if` at EOF → every branch's content is emitted in source order
 * - no context passed → every condition is true (the "all tools present" view)
 *
 * @module core/instruction-template
 */

import type { ConcreteTokenSavingTier } from '../types/config.js';
import { RUNTIME_CAPABILITY_MANIFEST } from '../types/runtime-capability-manifest.js';

const CANONICAL_TOOL_NAMES = new Set(
  RUNTIME_CAPABILITY_MANIFEST.flatMap((entry) => [...entry.tools]),
);

export interface InstructionTemplateContext {
  /** Names of the tools registered for the current request. */
  toolNames: ReadonlySet<string>;
  /** Effective token-saving tier, as resolved by the system prompt builder. */
  tier: ConcreteTokenSavingTier;
  /** True when building a subagent prompt (`role=subagent`). */
  subagent: boolean;
  /** Values for plain `{{name}}` placeholders. Unknown names are left as-is. */
  vars?: Record<string, string | number> | undefined;
  /** Drop lines that format a declared but unavailable tool as callable. */
  strictToolReferences?: boolean | undefined;
}

/**
 * Matches a `<!--ws:if ...-->` / `<!--ws:else-->` / `<!--ws:end-->` marker
 * together with the indentation and the single trailing newline around it, so
 * a directive sitting on its own line disappears without leaving that line
 * behind as whitespace.
 */
const DIRECTIVE_RE = /[ \t]*<!--\s*ws:(if|else|end)\b([^>]*?)-->[ \t]*(?:\r?\n)?/g;

/** Matches `{{tools:a,b,c}}` and plain `{{name}}` placeholders. */
const PLACEHOLDER_RE = /\{\{\s*(tools:)?\s*([a-zA-Z0-9_.,\s-]+?)\s*\}\}/g;

type Node = { kind: 'text'; value: string } | { kind: 'if'; test: Condition; body: Node[][] };

/** A parsed condition: `null` means "always true" (the fail-open value). */
type Condition = readonly Attr[] | null;

interface Attr {
  key: 'tool' | 'tier' | 'role';
  negated: boolean;
  values: readonly string[];
}

/**
 * Render an instruction markdown layer against the live request.
 *
 * Passing no context strips every marker and keeps the full text, which is the
 * right view for embedders reading the bundled prompt directly.
 */
export function renderInstructionLayer(
  text: string,
  ctx?: InstructionTemplateContext | undefined,
): string {
  if (!text) return text;
  const hasDirectives = text.includes('<!--ws:') || text.includes('<!-- ws:');
  const hasPlaceholders = text.includes('{{');
  if (!hasDirectives && !hasPlaceholders) return text;

  const rendered = hasDirectives ? emit(parse(text), ctx) : text;
  const substituted = hasPlaceholders ? substitute(rendered, ctx) : rendered;
  const guarded = ctx?.strictToolReferences
    ? dropLinesWithUnavailableToolReferences(
        substituted,
        ctx,
        new Set([...CANONICAL_TOOL_NAMES, ...declaredToolNames(text)]),
      )
    : substituted;
  return tidy(guarded);
}

function declaredToolNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const marker of text.matchAll(/<!--\s*ws:if\b([^>]*?)-->/g)) {
    for (const attr of (marker[1] ?? '').matchAll(/!?tool=([A-Za-z0-9_.,-]+)/g)) {
      for (const name of (attr[1] ?? '').split(',')) if (name.trim()) names.add(name.trim());
    }
  }
  for (const placeholder of text.matchAll(/\{\{\s*tools:\s*([^}]+)}}/g)) {
    for (const name of (placeholder[1] ?? '').split(',')) if (name.trim()) names.add(name.trim());
  }
  return names;
}

function dropLinesWithUnavailableToolReferences(
  text: string,
  ctx: InstructionTemplateContext,
  declared: ReadonlySet<string>,
): string {
  const unavailable = [...declared].filter((name) => !ctx.toolNames.has(name));
  if (unavailable.length === 0) return text;
  return text
    .split(/(?<=\n)/)
    .filter((line) => !unavailable.some((name) => formattedToolMention(line, name)))
    .join('');
}

function formattedToolMention(line: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const token = new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`);
  if (
    line.split('`').some((segment, index) => {
      if (index % 2 !== 1) return false;
      if (segment.includes(`<${name}`) || segment.includes(`</${name}`)) return false;
      return token.test(segment);
    })
  ) {
    return true;
  }
  return line.split('**').some((segment, index) => index % 2 === 1 && segment.trim() === name);
}

/**
 * Build the node tree. Stray `else`/`end` markers and unclosed `if` blocks are
 * recovered from rather than thrown on — see the fail-open contract above.
 */
function parse(text: string): Node[] {
  const root: Node[] = [];
  // Each frame is one open `ws:if`: `branches[0]` is the then-branch,
  // `branches[1]` (when present) the else-branch.
  const stack: Array<{ test: Condition; branches: Node[][] }> = [];
  const current = (): Node[] => {
    const frame = stack[stack.length - 1];
    if (!frame) return root;
    return frame.branches[frame.branches.length - 1] as Node[];
  };
  const pushText = (value: string): void => {
    if (value) current().push({ kind: 'text', value });
  };

  DIRECTIVE_RE.lastIndex = 0;
  let cursor = 0;
  for (let m = DIRECTIVE_RE.exec(text); m !== null; m = DIRECTIVE_RE.exec(text)) {
    pushText(text.slice(cursor, m.index));
    cursor = m.index + m[0].length;
    const keyword = m[1];
    if (keyword === 'if') {
      stack.push({ test: parseCondition(m[2] ?? ''), branches: [[]] });
    } else if (keyword === 'else') {
      const frame = stack[stack.length - 1];
      // A stray `else` outside any block, or a second `else` in the same
      // block, just drops the marker — the text around it keeps flowing.
      if (frame && frame.branches.length === 1) frame.branches.push([]);
    } else {
      const frame = stack.pop();
      if (frame) current().push({ kind: 'if', test: frame.test, body: frame.branches });
    }
  }
  pushText(text.slice(cursor));

  // Unclosed blocks: emit every branch's content in source order so nothing is
  // lost, innermost first.
  while (stack.length > 0) {
    const frame = stack.pop() as { test: Condition; branches: Node[][] };
    current().push(...frame.branches.flat());
  }
  return root;
}

function parseCondition(raw: string): Condition {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const attrs: Attr[] = [];
  for (const token of tokens) {
    const m = /^(!?)([a-zA-Z]+)=(.+)$/.exec(token);
    if (!m) return null;
    const key = (m[2] ?? '').toLowerCase();
    if (key !== 'tool' && key !== 'tier' && key !== 'role') return null;
    const values = (m[3] ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    if (values.length === 0) return null;
    attrs.push({ key, negated: m[1] === '!', values });
  }
  return attrs;
}

function evaluate(test: Condition, ctx: InstructionTemplateContext | undefined): boolean {
  if (test === null || !ctx) return true;
  return test.every((attr) => {
    const matched =
      attr.key === 'tool'
        ? attr.values.some((v) => ctx.toolNames.has(v))
        : attr.key === 'tier'
          ? attr.values.includes(ctx.tier)
          : attr.values.includes(ctx.subagent ? 'subagent' : 'leader');
    return attr.negated ? !matched : matched;
  });
}

function emit(nodes: readonly Node[], ctx: InstructionTemplateContext | undefined): string {
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'text') {
      out += node.value;
      continue;
    }
    const branch = evaluate(node.test, ctx) ? node.body[0] : node.body[1];
    if (branch) out += emit(branch, ctx);
  }
  return out;
}

function substitute(text: string, ctx: InstructionTemplateContext | undefined): string {
  PLACEHOLDER_RE.lastIndex = 0;
  return text.replace(PLACEHOLDER_RE, (match, toolsPrefix: string | undefined, body: string) => {
    if (toolsPrefix) {
      const names = body
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
        .filter((n) => !ctx || ctx.toolNames.has(n));
      return names.map((n) => `\`${n}\``).join(', ');
    }
    const value = ctx?.vars?.[body.trim()];
    return value === undefined ? match : String(value);
  });
}

/**
 * A dropped block leaves the blank line that preceded its opening directive
 * next to the one that followed its closing directive. Collapse those runs so
 * gating doesn't leave a ladder of blank lines in the prompt. Trailing
 * horizontal whitespace is left alone — it is not ours to normalize.
 */
function tidy(text: string): string {
  return text.replace(/(\r?\n){3,}/g, '$1$1');
}

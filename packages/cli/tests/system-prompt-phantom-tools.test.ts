import {
  type InstructionTemplateContext,
  loadInstructionBundle,
  renderInstructionLayer,
  type SystemInstructionVariant,
} from '@wrongstack/core/agent';
import type { ConcreteTokenSavingTier } from '@wrongstack/core/types';
import { builtinTools, TIER1_TOOLS } from '@wrongstack/tools';
import { describe, expect, it } from 'vitest';

/**
 * GUARD TEST — the bundled identity prompts must never describe a tool the
 * request cannot call.
 *
 * `instructions/system*.md` used to be injected verbatim, so at `minimal` tier
 * (15 TIER1 tools) the model still read ~8k tokens about `kanban`, the browser
 * tools, SAGE memory and the Telegram bridge — none of them registered. The
 * conditional-block syntax in `core/instruction-template.ts` fixes that; this
 * test is what keeps it fixed.
 *
 * The check is self-maintaining: the set of names it polices is scraped from
 * the `ws:if tool=` conditions in the markdown itself. Gate a new section on a
 * tool and it is policed automatically; describe a tool without gating it and
 * the assertion fires the moment that tool is absent from a render.
 */

const VARIANTS: readonly SystemInstructionVariant[] = ['default', 'lite', 'pro'];

async function loadVariant(variant: SystemInstructionVariant): Promise<string> {
  const bundle = await loadInstructionBundle({ systemVariant: variant });
  const identity = bundle.system?.identity;
  expect(identity, `${variant} identity should load from the bundled instructions`).toBeTruthy();
  return identity as string;
}

function ctx(
  tools: readonly { name: string }[],
  tier: ConcreteTokenSavingTier,
): InstructionTemplateContext {
  return { toolNames: new Set(tools.map((t) => t.name)), tier, subagent: false };
}

/** Every tool name mentioned in a `tool=` / `!tool=` condition in the source. */
function gatedToolNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const m of source.matchAll(/<!--\s*ws:if\b([^>]*?)-->/g)) {
    for (const attr of (m[1] ?? '').matchAll(/!?tool=([A-Za-z0-9_,-]+)/g)) {
      for (const name of (attr[1] ?? '').split(',')) {
        if (name.trim()) names.add(name.trim());
      }
    }
  }
  return names;
}

/**
 * Tool names in these prompts are always written as inline code or as a bold
 * run containing nothing but the name — `kanban`, `` `mail_send to="*"` ``,
 * **remember**. Matching only those forms keeps the check off ordinary prose,
 * where words like "plan", "task", "test" and "language" appear constantly
 * (including inside bold sentence leads such as **Match the user's
 * language.**). The custom boundaries stop `search` from matching inside
 * `codebase-search`, and `plan` inside `e2e_plan`.
 */
function mentionsTool(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const token = new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`);
  for (const line of text.split('\n')) {
    // Split on the delimiter and keep the odd-indexed segments: those are the
    // ones *inside* a span. Testing the raw line instead would also match the
    // plain prose sitting between two code spans.
    if (line.split('`').some((seg, i) => i % 2 === 1 && token.test(seg))) return true;
    // Bold is only treated as a tool mention when the run is exactly the name
    // — **remember**, not **Match the user's language.**
    if (line.split('**').some((seg, i) => i % 2 === 1 && seg.trim() === name)) return true;
  }
  return false;
}

/** First rendered line that mentions `name`, so a failure points at the text. */
function offendingLine(text: string, name: string): string {
  const line = text.split('\n').find((l) => mentionsTool(l, name)) ?? '(not found)';
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

describe.each(VARIANTS)('bundled identity prompt — %s variant', (variant) => {
  it('leaves no template markers behind at any tier', async () => {
    const source = await loadVariant(variant);
    for (const tools of [builtinTools, TIER1_TOOLS, []]) {
      const out = renderInstructionLayer(source, ctx(tools, 'off'));
      expect(out).not.toMatch(/ws:(if|else|end)/);
      expect(out).not.toContain('{{');
      expect(out.trim()).not.toBe('');
      expect(out).toContain('You are WrongStack');
    }
  });

  it('never describes a gated tool that the request has not registered', async () => {
    const source = await loadVariant(variant);
    const gated = gatedToolNames(source);
    expect(gated.size, `${variant} should gate at least a few tools`).toBeGreaterThan(0);

    for (const [label, tools, tier] of [
      ['TIER1 only', TIER1_TOOLS, 'minimal'],
      ['no tools', [], 'minimal'],
    ] as const) {
      const registered = new Set(tools.map((t) => t.name));
      const out = renderInstructionLayer(source, ctx(tools, tier));
      const leaked = [...gated]
        .filter((n) => !registered.has(n) && mentionsTool(out, n))
        .map((n) => `${n} → ${offendingLine(out, n)}`);
      expect(leaked, `${variant} / ${label} still describes unregistered tools`).toEqual([]);
    }
  });

  it('shrinks measurably when the tool set shrinks', async () => {
    const source = await loadVariant(variant);
    const full = renderInstructionLayer(source, ctx(builtinTools, 'off')).length;
    const tier1 = renderInstructionLayer(source, ctx(TIER1_TOOLS, 'minimal')).length;
    // Reported so the saving is visible when the suite runs verbosely.
    console.log(
      `[${variant}] full=${full} chars (~${Math.round(full / 4)} tok) → ` +
        `TIER1=${tier1} chars (~${Math.round(tier1 / 4)} tok), ` +
        `${Math.round((1 - tier1 / full) * 100)}% smaller`,
    );
    expect(tier1).toBeLessThan(full);
  });
});

describe('bundled identity prompt — rendering without a context', () => {
  it.each(VARIANTS)('keeps the full %s text and strips the markers', async (variant) => {
    const source = await loadVariant(variant);
    const out = renderInstructionLayer(source);
    expect(out).not.toMatch(/ws:(if|else|end)/);
    // Every gated section survives, so the no-context view is the superset.
    const withAllTools = renderInstructionLayer(source, ctx(builtinTools, 'off'));
    expect(out.length).toBeGreaterThanOrEqual(withAllTools.length);
  });
});

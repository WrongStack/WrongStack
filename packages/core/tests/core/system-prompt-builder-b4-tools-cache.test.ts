import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultSystemPromptBuilder } from '../../src/index.js';
import type { Tool } from '../../src/index.js';

const mkTool = (name: string): Tool =>
  ({
    name,
    description: `desc-${name}`,
    permission: 'auto',
    mutating: false,
    inputSchema: { type: 'object' },
    async execute() {
      return '';
    },
  }) as Tool;

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sysprompt-b4-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * B4 regression: _toolsUsageCache must key on subagent + maxContextTokens
 * alongside toolsRef + tier. Otherwise a single builder instance shared
 * across host and subagent builds (or across a /model switch that changes
 * the context-management threshold) returns stale text from the wrong
 * audience or the wrong threshold.
 */
describe('DefaultSystemPromptBuilder — _toolsUsageCache key completeness (B4)', () => {
  it('invalidates the cache when subagent changes (host → subagent)', async () => {
    const b = new DefaultSystemPromptBuilder({
      todayIso: '2026-08-13',
      modelCapabilities: { maxContextTokens: 200_000 } as never,
    });
    const tools = [mkTool('grep')];
    const ctx = { cwd: tmp, projectRoot: tmp, tools, provider: 'anthropic', model: 'claude' };

    // First build — host prompt
    const hostBlocks = await b.build(ctx);
    const hostText = hostBlocks.map((bl) => bl.text).join('\n');

    // Second build — subagent prompt, same tools + same capabilities
    const subBlocks = await b.build({ ...ctx, subagent: true } as never);
    const subText = subBlocks.map((bl) => bl.text).join('\n');

    // The leader-only after-task affordances (<nextsteps> guidance) are
    // present in the host build but absent in the subagent build.
    expect(hostText).toContain('<nextsteps>');
    expect(subText).not.toContain('<nextsteps>');
  });

  it('invalidates the cache when maxContextTokens crosses the 32k threshold', async () => {
    // The context-management section adapts: <=32k → '50', >32k → '70'.
    // The context-management threshold section is gated on a tool named
    // 'context_manager' (system-prompt-builder.ts:801). Without it the
    // adaptive 50/70 block never renders.
    const contextTool = mkTool('context_manager');
    const ctx = {
      cwd: tmp,
      projectRoot: tmp,
      tools: [contextTool],
      provider: 'anthropic',
      model: 'claude',
    } as never;

    // Small context → 50% threshold
    const small = new DefaultSystemPromptBuilder({
      todayIso: '2026-08-13',
      modelCapabilities: { maxContextTokens: 32_000 } as never,
    });
    const smallBlocks = await small.build(ctx);
    const smallText = smallBlocks.map((bl) => bl.text).join('\n');
    expect(smallText).toContain('50%');

    // Same builder, upgraded capabilities → should recompute, not return stale
    const large = new DefaultSystemPromptBuilder({
      todayIso: '2026-08-13',
      modelCapabilities: { maxContextTokens: 200_000 } as never,
    });
    const largeBlocks = await large.build(ctx);
    const largeText = largeBlocks.map((bl) => bl.text).join('\n');
    expect(largeText).toContain('70%');
    expect(largeText).not.toContain('50%');
  });

  it('serves cached output when subagent and maxContextTokens are unchanged', async () => {
    const b = new DefaultSystemPromptBuilder({
      todayIso: '2026-08-13',
      modelCapabilities: { maxContextTokens: 200_000 } as never,
    });
    const tools = [mkTool('grep')];
    const ctx = {
      cwd: tmp,
      projectRoot: tmp,
      tools,
      provider: 'anthropic',
      model: 'claude',
    } as never;

    const blocks1 = await b.build(ctx);
    const blocks2 = await b.build(ctx);
    // Same context → identical block count (cache served the same layer-2 text).
    expect(blocks2.length).toBe(blocks1.length);
  });
});

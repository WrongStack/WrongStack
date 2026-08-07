import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Context,
  createContextEvidenceState,
  DefaultSystemPromptBuilder,
  estimateMessageTokens,
  estimateTextTokens,
  getContextBreakdown,
  type Message,
  SYSTEM_BLOCK_SOURCE,
  type TextBlock,
  type Tool,
} from '../../src/index.js';

const mkTool = (name: string, capabilities?: string[]): Tool => ({
  name,
  description: `desc-${name}`,
  permission: 'auto',
  mutating: false,
  inputSchema: { type: 'object' },
  capabilities,
  async execute() {
    return '';
  },
});

/** Minimal ctx satisfying the fields getContextBreakdown reads. */
function mkCtx(over: {
  systemPrompt?: TextBlock[];
  tools?: Tool[];
  messages?: Message[];
  meta?: Record<string, unknown>;
  maxContext?: number;
  agentId?: string;
}): Context {
  return {
    systemPrompt: over.systemPrompt ?? [],
    tools: over.tools ?? [],
    messages: over.messages ?? [],
    meta: over.meta ?? {},
    provider: { capabilities: { maxContext: over.maxContext ?? 200_000 } },
    contextEvidence: createContextEvidenceState(),
    agentId: over.agentId ?? 'leader',
    todos: [],
  } as unknown as Context;
}

describe('getContextBreakdown', () => {
  describe('SYSTEM_BLOCK_SOURCE tagging via the builder', () => {
    let tmp: string;
    beforeEach(async () => {
      tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-breakdown-'));
    });
    afterEach(async () => {
      await fs.rm(tmp, { recursive: true, force: true });
    });

    it('tags each host system block with its origin section', async () => {
      const b = new DefaultSystemPromptBuilder({ todayIso: '2026-05-13' });
      const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
      // identity, tool-usage, environment, leader-after-task (host, appended last)
      expect(SYSTEM_BLOCK_SOURCE.get(blocks[0]!)).toBe('identity');
      expect(SYSTEM_BLOCK_SOURCE.get(blocks[1]!)).toBe('tool-usage');
      expect(SYSTEM_BLOCK_SOURCE.get(blocks[2]!)).toBe('environment');
      expect(SYSTEM_BLOCK_SOURCE.get(blocks[3]!)).toBe('leader-after-task');
    });

    it('per-source tokens sum to the system total', async () => {
      const b = new DefaultSystemPromptBuilder({ todayIso: '2026-05-13' });
      const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
      const bd = getContextBreakdown(mkCtx({ systemPrompt: blocks }));
      const sum = Object.values(bd.system.bySource).reduce((a, n) => a + n, 0);
      expect(sum).toBe(bd.system.total);
      expect(bd.system.bySource.identity).toBeGreaterThan(0);
    });
  });

  it('routes an untagged system block into the "other" bucket', () => {
    const tagged: TextBlock = { type: 'text', text: 'i'.repeat(350) };
    SYSTEM_BLOCK_SOURCE.set(tagged, 'identity');
    const untagged: TextBlock = { type: 'text', text: 'o'.repeat(70) };
    const bd = getContextBreakdown(mkCtx({ systemPrompt: [tagged, untagged] }));
    expect(bd.system.bySource.identity).toBe(estimateTextTokens('i'.repeat(350)));
    expect(bd.system.bySource.other).toBe(estimateTextTokens('o'.repeat(70)));
  });

  it('splits builtin vs MCP tools and groups MCP by server', () => {
    const tools = [
      mkTool('read'),
      mkTool('mcp__gmail__send', ['mcp.proxy']),
      mkTool('mcp__gmail__search', ['mcp.proxy']),
    ];
    const bd = getContextBreakdown(mkCtx({ tools }));
    expect(bd.tools.count).toBe(3);
    expect(bd.tools.builtin).toBeGreaterThan(0);
    expect(bd.tools.mcp).toBeGreaterThan(0);
    expect(bd.tools.total).toBe(bd.tools.builtin + bd.tools.mcp);
    expect(bd.tools.mcpByServer.gmail).toBe(bd.tools.mcp);
  });

  it('splits history text, tool inputs, results, and thinking', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello world' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'private reasoning', signature: 'sig' },
          { type: 'text', text: 'I will read it' },
          { type: 'tool_use', id: '1', name: 'read', input: { path: 'a.ts' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: '1', content: 'FILE CONTENTS '.repeat(20) }],
      },
    ];
    const bd = getContextBreakdown(mkCtx({ messages }));
    expect(bd.history.messageCount).toBe(3);
    expect(bd.history.text).toBeGreaterThan(0);
    expect(bd.history.toolInputs).toBeGreaterThan(0);
    expect(bd.history.toolResults).toBeGreaterThan(0);
    expect(bd.history.thinking).toBeGreaterThan(0);
    expect(bd.history.total).toBe(
      bd.history.text +
        (bd.history.toolInputs ?? 0) +
        bd.history.toolResults +
        (bd.history.thinking ?? 0) +
        (bd.history.other ?? 0),
    );
    expect(bd.history.total).toBe(estimateMessageTokens(messages));
    // The large tool_result must dominate the tool-results bucket.
    expect(bd.history.toolResults).toBeGreaterThan(bd.history.text);
  });

  it('measures the leader next-steps gate as a volatile block', () => {
    const bd = getContextBreakdown(mkCtx({ agentId: 'leader' }));
    expect(bd.volatile.nextsteps).toBeGreaterThan(0); // open-todos=0 gate is emitted
    expect(bd.volatile.total).toBe(bd.volatile.ledger + bd.volatile.nextsteps);
  });

  it('does not emit the next-steps gate for a subagent', () => {
    const bd = getContextBreakdown(mkCtx({ agentId: 'executor' }));
    expect(bd.volatile.nextsteps).toBe(0);
  });

  it('prefers the effectiveMaxContext meta override over the provider window', () => {
    const withOverride = getContextBreakdown(mkCtx({ meta: { effectiveMaxContext: 123_456 } }));
    expect(withOverride.effectiveMaxContext).toBe(123_456);
    const noOverride = getContextBreakdown(mkCtx({ maxContext: 400_000 }));
    expect(noOverride.effectiveMaxContext).toBe(400_000);
  });

  it('total equals the sum of all category totals', () => {
    const tagged: TextBlock = { type: 'text', text: 'system prompt text' };
    SYSTEM_BLOCK_SOURCE.set(tagged, 'identity');
    const bd = getContextBreakdown(
      mkCtx({
        systemPrompt: [tagged],
        tools: [mkTool('read')],
        messages: [{ role: 'user', content: 'hi there' }],
        maxContext: 200_000,
      }),
    );
    expect(bd.total).toBe(bd.system.total + bd.tools.total + bd.history.total + bd.volatile.total);
    expect(bd.usedPct).toBeCloseTo(bd.total / bd.effectiveMaxContext, 10);
  });
});

/**
 * The lean prompt is only worth anything if the real factory uses it. These
 * build an actual subagent through `createHostSubagentFactory` and inspect the
 * system prompt the worker would send.
 */

import { Container, EventBus, TOKENS } from '@wrongstack/contracts/kernel';
import type { Config, SubagentConfig, Tool } from '@wrongstack/contracts/types';
import { DEFAULT_EXPLORE_COMPANION_AGENT_ID, FLEET_ROSTER } from '@wrongstack/core/coordination';
import { DefaultErrorHandler, DefaultRetryPolicy } from '@wrongstack/core/execution';
import { DefaultLogger } from '@wrongstack/core/infrastructure';
import { ProviderRegistry, ToolRegistry } from '@wrongstack/core/registry';
import { DefaultSecretScrubber } from '@wrongstack/core/security';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@wrongstack/core/coordination', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core/coordination')>();
  return {
    ...actual,
    // The factory tolerates a mailbox failure; a test must not reach the
    // project mailbox daemon.
    getSharedProjectMailbox: () => {
      throw new Error('no mailbox in tests');
    },
  };
});

vi.mock('../../src/fleet/host-provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/fleet/host-provider.js')>();
  return {
    ...actual,
    buildHostSubagentProvider: vi.fn(async () => ({
      id: 'fake',
      capabilities: { streaming: false },
    })),
    resolveHostSubagentReasoningConfig: vi.fn(async () => undefined),
  };
});

const { createHostSubagentFactory } = await import('../../src/fleet/host-subagent-factory.js');

const template = FLEET_ROSTER[DEFAULT_EXPLORE_COMPANION_AGENT_ID] as SubagentConfig;

function fakeTool(name: string): Tool {
  return {
    name,
    description: name,
    permission: 'auto',
    mutating: false,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => '',
  } as unknown as Tool;
}

function harness() {
  const container = new Container();
  container.bind(TOKENS.Logger, () => new DefaultLogger({ level: 'error', stderr: false }));
  container.bind(TOKENS.ErrorHandler, () => new DefaultErrorHandler());
  container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());
  const build = vi.fn(async () => [{ type: 'text' as const, text: 'GENERAL SUBAGENT PROMPT' }]);
  const recordLearningRole = vi.fn();
  const config = { provider: 'fake', model: 'fake-model', apiKey: 'x' } as unknown as Config;
  const deps = {
    container,
    fallbackProfileManager: {} as never,
    toolRegistry: new ToolRegistry(),
    providerRegistry: new ProviderRegistry(),
    configStore: { get: () => config, watch: () => () => {} } as never,
    events: new EventBus(),
    systemPromptBuilder: { build } as never,
    session: {
      id: 'sess-test',
      pendingToolUses: [],
      append: vi.fn(async () => undefined),
      appendBatch: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      recordFileChange: vi.fn(() => undefined),
      writeCheckpoint: vi.fn(async () => undefined),
      writeFileSnapshot: vi.fn(async () => undefined),
      truncateToCheckpoint: vi.fn(async () => 0),
      clearSession: vi.fn(async () => undefined),
      writeInFlightMarker: vi.fn(async () => undefined),
      clearInFlightMarker: vi.fn(async () => undefined),
    } as never,
    tokenCounter: {} as never,
    projectRoot: process.cwd(),
    cwd: process.cwd(),
    secretScrubber: new DefaultSecretScrubber(),
  };
  const factory = createHostSubagentFactory(config, {
    deps,
    opts: {},
    roster: FLEET_ROSTER,
    filterTools: (allow?: string[]) => (allow ?? []).map(fakeTool),
    mailboxProjectDir: () => process.cwd(),
    recordLearningRole,
    subagentToolRegistry: () => new ToolRegistry(),
  } as never);
  return { factory, build, recordLearningRole };
}

describe('explore companion through the real subagent factory', () => {
  it('sends only the lean brief: no general prompt, baseline, or learning capture', async () => {
    const h = harness();
    const { agent, dispose } = await h.factory({
      ...template,
      id: 'explore-companion-abc12345-0f0f0f0f',
    });
    try {
      expect(h.build).not.toHaveBeenCalled();
      expect(h.recordLearningRole).not.toHaveBeenCalled();
      const system = agent.ctx.systemPrompt;
      expect(system).toHaveLength(1);
      const text = system[0]?.text ?? '';
      expect(text).toMatch(/You are the Explore Companion/);
      expect(text).toContain(`- Project root: ${process.cwd()}`);
      expect(text).not.toContain('GENERAL SUBAGENT PROMPT');
      expect(text).not.toMatch(/You are a subagent operating under a Director/);
      expect(text).not.toContain('## LEARNED');
      expect(text.length).toBeLessThan(5_000);
      expect(agent.ctx.tools.map((tool) => tool.name)).not.toContain('tree');
      expect(agent.ctx.meta?.sealedAgent).toBe(true);
    } finally {
      await dispose?.();
    }
  });

  it('leaves other roles on the general prompt and baseline', async () => {
    const h = harness();
    const { agent, dispose } = await h.factory({
      ...template,
      // Names the role but was not spawned by the companion host.
      id: 'user-explorer',
    });
    try {
      expect(h.build).toHaveBeenCalledTimes(1);
      const joined = agent.ctx.systemPrompt.map((block) => block.text).join('\n');
      expect(joined).toContain('GENERAL SUBAGENT PROMPT');
      expect(joined).toMatch(/You are a subagent operating under a Director/);
    } finally {
      await dispose?.();
    }
  });

  it('gives memory-companion a lean sealed prompt without invoking systemPromptBuilder.build', async () => {
    const h = harness();
    const { agent, dispose } = await h.factory({
      id: 'memory-companion-test-1234',
      name: 'Memory Companion',
      role: 'memory-curator',
      prompt: 'You are Memory Companion.',
      systemPromptOverride: 'You are Memory Companion.',
    });
    try {
      expect(h.build).not.toHaveBeenCalled();
      expect(h.recordLearningRole).not.toHaveBeenCalled();
      expect(agent.ctx.meta?.sealedAgent).toBe(true);
      const joined = agent.ctx.systemPrompt.map((block) => block.text).join('\n');
      expect(joined).toContain('You are Memory Companion.');
      expect(joined).toContain(`- Project root: ${process.cwd()}`);
      expect(joined).not.toContain('GENERAL SUBAGENT PROMPT');
    } finally {
      await dispose?.();
    }
  });
});

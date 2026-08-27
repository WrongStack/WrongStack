import type { Agent, TodoItem } from '@wrongstack/core/agent';
import type { EventBus } from '@wrongstack/core/kernel';
import { SlashCommandRegistry } from '@wrongstack/core/registry';
import type { AttachmentStore, Message } from '@wrongstack/core/types';
import { render } from 'ink-testing-library';
import React from 'react';
import { vi } from 'vitest';
import { App, type AppProps } from '../../src/app.js';
import type { StatuslineItem } from '../../src/components/statusline-picker.js';

const NOOP = () => {};

function createEventBus(): EventBus {
  return {
    emit: vi.fn(),
    emitCustom: vi.fn(),
    once: vi.fn(),
    on: vi.fn().mockReturnValue(NOOP),
    onPattern: vi.fn().mockReturnValue(NOOP),
    off: vi.fn(),
    removeAllListeners: vi.fn(),
  } as unknown as EventBus;
}

function createAttachmentStore(): AttachmentStore {
  return {
    add: vi.fn(),
    get: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    expand: vi.fn(async (text: string) => [{ type: 'text' as const, text }]),
    clear: vi.fn().mockResolvedValue(undefined),
  } as unknown as AttachmentStore;
}

export function createJourneyAgent(messages: Message[] = []): Agent {
  const todos: TodoItem[] = [];
  return {
    ctx: {
      todos,
      messages,
      meta: {},
      state: {
        onChange: vi.fn().mockReturnValue(NOOP),
      },
      projectRoot: '/test/project',
      model: 'anthropic/anthropic-test-model',
      provider: {
        id: 'anthropic',
        capabilities: { maxContext: 200_000, supportsVision: true },
      },
      session: { id: 'test-session', writeEvent: vi.fn() },
      // Panels and slash commands stamp their board writes with the session
      // driving the TUI, same as a real Context derives it.
      eventSessionId: () => 'test-session',
      sideEffects: [],
      signal: new AbortController().signal,
      tokenCounter: {
        countTokens: vi.fn().mockReturnValue(0),
        estimateCost: vi.fn().mockReturnValue({ total: 0 }),
        total: vi.fn().mockReturnValue({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      },
      cwd: '/test/project',
      workingDir: '/test/project',
      onWorkingDirChanged: vi.fn().mockReturnValue(NOOP),
      systemPrompt: [],
      tools: [],
      agentId: 'test',
      agentName: 'Test Agent',
      writtenFiles: new Set(),
      recordRead: vi.fn(),
    },
    run: vi.fn().mockResolvedValue({ status: 'done', iterations: 0, finalText: '' }),
    abort: vi.fn(),
    on: vi.fn().mockReturnValue(NOOP),
  } as unknown as Agent;
}

export interface AppJourney {
  readonly agent: Agent;
  readonly props: AppProps;
  mount(overrides?: Partial<AppProps>): ReturnType<typeof render>;
}

export function createAppJourney(agent = createJourneyAgent()): AppJourney {
  const props: AppProps = {
    agent,
    slashRegistry: new SlashCommandRegistry(),
    attachments: createAttachmentStore(),
    events: createEventBus(),
    model: 'anthropic/anthropic-test-model',
    onExit: vi.fn(),
    director: null,
    statuslineHiddenItems: [] as StatuslineItem[],
    setStatuslineHiddenItems: vi.fn(),
    saveStatuslineHiddenItems: vi.fn().mockResolvedValue(undefined),
  };

  return {
    agent,
    props,
    mount: (overrides = {}) => render(React.createElement(App, { ...props, ...overrides })),
  };
}

export async function waitForJourney(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for TUI journey state');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

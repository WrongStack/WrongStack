// PR 0 of the tui/src/app.tsx split refactor (Issue #23).
//
// Baseline integration test: mount the TUI's top-level <App /> component
// and assert it renders without throwing. Future hook extractions
// (PRs 1-6 of the issue plan) MUST keep this test green.

import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { App, type AppProps } from '../src/app.js';
import type { Agent, AttachmentStore, EventBus, SlashCommandRegistry, TodoItem } from '@wrongstack/core';
import type { StatuslineItem } from '../src/components/statusline-picker.js';

const NOOP = () => {};

function stubEventBus(): EventBus {
  return {
    emit: vi.fn(),
    emitCustom: vi.fn(),
    once: vi.fn(),
    on: vi.fn().mockReturnValue(NOOP),
    off: vi.fn(),
    removeAllListeners: vi.fn(),
  } as unknown as EventBus;
}

function stubSlashRegistry(): SlashCommandRegistry {
  return {
    commands: [],
    register: vi.fn(),
    unregister: vi.fn(),
    getCommand: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    getMatches: vi.fn().mockReturnValue([]),
    registerBuiltin: vi.fn(),
  } as unknown as SlashCommandRegistry;
}

function stubAttachmentStore(): AttachmentStore {
  return {
    attachments: [],
    add: vi.fn(),
    remove: vi.fn(),
    items: vi.fn().mockReturnValue([]),
    read: vi.fn(),
    clear: vi.fn(),
  } as unknown as AttachmentStore;
}

function stubAgent(): Agent {
  return {
    ctx: {
      todos: [] as TodoItem[],
      messages: [],
      projectRoot: '/test/project',
      model: 'anthropic/anthropic-test-model',
      provider: {
        id: 'anthropic',
        capabilities: { maxContext: 200_000, supportsVision: true },
      },
      session: { id: 'test-session', writeEvent: vi.fn() },
      sideEffects: [],
      signal: new AbortController().signal,
      tokenCounter: {
        countTokens: vi.fn().mockReturnValue(0),
        estimateCost: vi.fn().mockReturnValue({ total: 0 }),
        total: vi.fn().mockReturnValue({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      },
      cwd: '/test/project',
      workingDir: '/test/project',
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

function freshProps(): AppProps {
  return {
    agent: stubAgent(),
    slashRegistry: stubSlashRegistry(),
    attachments: stubAttachmentStore(),
    events: stubEventBus(),
    model: 'anthropic/anthropic-test-model',
    onExit: vi.fn(),
    director: null,
    statuslineHiddenItems: [] as StatuslineItem[],
    setStatuslineHiddenItems: vi.fn(),
    saveStatuslineHiddenItems: vi.fn().mockResolvedValue(undefined),
  };
}

describe('<App /> baseline mount (PR 0 of Issue #23)', () => {
  it('mounts without throwing', () => {
    const { lastFrame, unmount } = render(React.createElement(App, freshProps()));

    expect(lastFrame()).toBeTruthy();
    unmount();
  });
});

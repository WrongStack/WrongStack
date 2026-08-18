/**
 * Shared test harness for core integration tests.
 *
 * Provides standard mocks for EventBus, Provider, Tool, Context, and
 * in-memory session storage — so each integration test module can focus
 * on the logic under test instead of rebuilding 200 lines of setup.
 *
 * Usage:
 *   import { createTestHarness } from '../helpers/test-harness.js';
 *   const { events, provider, ctx, restore } = createTestHarness();
 *   // ... test logic ...
 *   restore(); // cleanup
 */

import { vi } from 'vitest';
import { EventBus, type EventName } from '../../src/kernel/events.js';
import type {
  Provider,
  StreamEvent,
  Request,
  Response,
  StopReason,
} from '../../src/types/provider.js';
import type { Tool, Permission } from '../../src/types/tool.js';
import type { Context } from '../../src/core/context.js';
import type { Usage } from '../../src/types/provider.js';
import type { ContentBlock } from '../../src/types/blocks.js';
import type { Message } from '../../src/types/messages.js';

// ── EventBus ─────────────────────────────────────────────────────────────

/**
 * A real EventBus instance with a helper to collect emitted events.
 * Returns `{ events, collect, events$ }` where:
 * - `events` is the live EventBus
 * - `collect(name)` subscribes and returns an array that fills with payloads
 * - `events$` is a Map<eventName, unknown[]> snapshot of all collected events
 */
export function createMockEventBus() {
  const events = new EventBus();
  const events$ = new Map<string, unknown[]>();

  const collect = (name: string): unknown[] => {
    const arr: unknown[] = [];
    events$.set(name, arr);
    events.on(name as EventName, (payload: unknown) => arr.push(payload));
    return arr;
  };

  return { events, collect, events$ };
}

// ── Provider ─────────────────────────────────────────────────────────────

export interface MockProviderOptions {
  /** canned stream events to yield (default: a single text + message_stop) */
  streamEvents?: StreamEvent[];
  /** canned complete() response (default: built from streamEvents) */
  completeResponse?: Response;
  /** throw this error on stream() instead of yielding (for error-path tests) */
  streamError?: Error;
  /** provider id (default: 'mock') */
  id?: string;
}

export function createMockProvider(opts: MockProviderOptions = {}): Provider {
  const id = opts.id ?? 'mock';
  const defaultStream: StreamEvent[] = [
    { type: 'text_delta', text: 'Hello from mock provider.' },
    { type: 'message_stop', stopReason: 'end_turn', usage: { input: 10, output: 5 } as unknown as Usage },
  ];
  const streamEvents = opts.streamEvents ?? defaultStream;

  return {
    id,
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
      maxTokens: 4096,
      contextWindow: 8192,
    },
    async *stream(_req: Request, _opts: { signal: AbortSignal }): AsyncIterable<StreamEvent> {
      if (opts.streamError) throw opts.streamError;
      for (const e of streamEvents) yield e;
    },
    async complete(_req: Request, opts: { signal: AbortSignal }): Promise<Response> {
      if (opts.completeResponse) return opts.completeResponse;
      // Build a response from the stream events
      let text = '';
      let usage: Usage = { input: 0, output: 0 } as unknown as Usage;
      let stopReason: StopReason = 'end_turn';
      for (const e of streamEvents) {
        if (e.type === 'text_delta') text += e.text;
        if (e.type === 'message_stop') {
          usage = e.usage;
          stopReason = e.stopReason;
        }
      }
      return {
        content: [{ type: 'text', text }],
        stopReason,
        usage,
        model: `${id}-model`,
      };
    },
  };
}

// ── Tool ─────────────────────────────────────────────────────────────────

export interface MockToolOptions {
  name?: string;
  description?: string;
  result?: string;
  error?: Error;
  permission?: Permission;
  riskTier?: 'safe' | 'standard' | 'destructive';
}

export function createMockTool(opts: MockToolOptions = {}): Tool {
  const name = opts.name ?? 'mock-tool';
  return {
    name,
    description: opts.description ?? 'A mock tool for testing.',
    permission: opts.permission ?? 'auto',
    mutating: false,
    riskTier: opts.riskTier ?? 'safe',
    inputSchema: { type: 'object', properties: {} },
    async execute(_input: unknown, _ctx: Context): Promise<string> {
      if (opts.error) throw opts.error;
      return opts.result ?? 'mock result';
    },
  };
}

/** Create a map of mock tools keyed by name. */
export function createMockToolRegistry(tools: MockToolOptions[] = []): Map<string, Tool> {
  const map = new Map<string, Tool>();
  for (const t of tools) {
    const tool = createMockTool(t);
    map.set(tool.name, tool);
  }
  // Always include a default if none specified
  if (map.size === 0) {
    const tool = createMockTool();
    map.set(tool.name, tool);
  }
  return map;
}

// ── Context ──────────────────────────────────────────────────────────────

export interface MockContextOptions {
  projectRoot?: string;
  sessionId?: string;
  messages?: Message[];
  tools?: Map<string, Tool>;
  events?: EventBus;
  provider?: Provider;
}

export function createMockContext(opts: MockContextOptions = {}): Context {
  const toolsMap = opts.tools ?? createMockToolRegistry();
  const projectRoot = opts.projectRoot ?? '/test-project';
  return {
    projectRoot,
    session: { id: opts.sessionId ?? 'test-session' },
    messages: opts.messages ?? [],
    tools: Array.from(toolsMap.values()),
    events: opts.events ?? new EventBus(),
    signal: new AbortController().signal,
    cwd: projectRoot,
    workingDir: projectRoot,
    // Minimal stub for the rest
    provider: opts.provider ?? createMockProvider(),
    config: { providers: {}, tools: {}, extensions: {} },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    tokenCounter: { count: vi.fn(() => 10), messages: vi.fn(() => 100) },
    readFiles: new Set<string>(),
    fileMtimes: new Map<string, number>(),
  } as unknown as Context;
}

// ── Full harness ─────────────────────────────────────────────────────────

export interface TestHarness {
  events: EventBus;
  provider: Provider;
  tools: Map<string, Tool>;
  ctx: Context;
  collect: (name: string) => unknown[];
  events$: Map<string, unknown[]>;
  /** Restore all vi mocks */
  restore: () => void;
}

/**
 * Create a fully-wired test harness with EventBus, mock provider,
 * mock tools, and a mock Context. Call `restore()` in afterEach.
 */
export function createTestHarness(opts: {
  provider?: MockProviderOptions;
  tools?: MockToolOptions[];
  context?: MockContextOptions;
} = {}): TestHarness {
  const { events, collect, events$ } = createMockEventBus();
  const provider = createMockProvider(opts.provider);
  const tools = createMockToolRegistry(opts.tools);
  const ctx = createMockContext({
    ...opts.context,
    events,
    tools,
    provider,
  });

  return {
    events,
    provider,
    tools,
    ctx,
    collect,
    events$,
    restore: () => vi.restoreAllMocks(),
  };
}

// ── Message helpers ──────────────────────────────────────────────────────

export function userMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

export function assistantMessage(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

export function toolUseMessage(id: string, name: string, input: unknown): Message {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input } as ContentBlock],
  };
}

export function toolResultMessage(toolUseId: string, content: string): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content } as ContentBlock],
  };
}

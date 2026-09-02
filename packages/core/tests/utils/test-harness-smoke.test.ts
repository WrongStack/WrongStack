/**
 * Smoke test for the test harness itself — verifies all factory functions
 * produce working mocks that integrate correctly.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  createTestHarness,
  createMockProvider,
  createMockTool,
  createMockContext,
  userMessage,
  assistantMessage,
} from '../helpers/test-harness.js';

describe('test-harness', () => {
  let harness: ReturnType<typeof createTestHarness>;

  afterEach(() => {
    harness?.restore();
  });

  describe('createTestHarness', () => {
    it('returns all required components', () => {
      harness = createTestHarness();
      expect(harness.events).toBeDefined();
      expect(harness.provider).toBeDefined();
      expect(harness.tools).toBeInstanceOf(Map);
      expect(harness.ctx).toBeDefined();
      expect(typeof harness.collect).toBe('function');
      expect(harness.events$).toBeInstanceOf(Map);
    });

    it('events bus emits and collects', () => {
      harness = createTestHarness();
      const collected = harness.collect('test.event');
      harness.events.emit('test.event' as any, { data: 42 });
      expect(collected).toHaveLength(1);
      expect(collected[0]).toEqual({ data: 42 });
    });

    it('provider stream yields canned events', async () => {
      harness = createTestHarness();
      const events: unknown[] = [];
      for await (const e of harness.provider.stream({} as any, {
        signal: new AbortController().signal,
      })) {
        events.push(e);
      }
      expect(events.length).toBeGreaterThan(0);
    });

    it('provider complete returns a response', async () => {
      harness = createTestHarness();
      const response = await harness.provider.complete({} as any, {
        signal: new AbortController().signal,
      });
      expect(response.content).toBeDefined();
      expect(response.stopReason).toBeDefined();
    });

    it('tools map contains mock tools', () => {
      harness = createTestHarness({
        tools: [{ name: 'read', result: 'file contents' }, { name: 'write' }],
      });
      expect(harness.tools.has('read')).toBe(true);
      expect(harness.tools.has('write')).toBe(true);
    });

    it('ctx uses the configured project root and harness provider', () => {
      harness = createTestHarness({
        provider: { id: 'configured-provider' },
        context: { projectRoot: '/custom', sessionId: 'sess-123' },
      });
      expect(harness.ctx.projectRoot).toBe('/custom');
      expect(harness.ctx.cwd).toBe('/custom');
      expect(harness.ctx.workingDir).toBe('/custom');
      expect(harness.ctx.session.id).toBe('sess-123');
      expect(harness.ctx.provider).toBe(harness.provider);
    });
  });

  describe('createMockProvider', () => {
    it('supports custom stream events', async () => {
      const provider = createMockProvider({
        streamEvents: [
          { type: 'text_delta', text: 'custom' },
          { type: 'message_stop', stopReason: 'end_turn', usage: { input: 1, output: 1 } as any },
        ],
      });
      const events: any[] = [];
      for await (const e of provider.stream({} as any, { signal: new AbortController().signal })) {
        events.push(e);
      }
      expect(events[0].text).toBe('custom');
    });

    it('supports stream errors', async () => {
      const provider = createMockProvider({
        streamError: new Error('connection refused'),
      });
      await expect(
        (async () => {
          for await (const _ of provider.stream({} as any, {
            signal: new AbortController().signal,
          })) {
            // should throw before yielding
          }
        })(),
      ).rejects.toThrow('connection refused');
    });
  });

  describe('createMockTool', () => {
    it('execute returns the configured result', async () => {
      const tool = createMockTool({ result: 'hello world' });
      const result = await tool.execute({}, {} as any);
      expect(result).toBe('hello world');
    });

    it('execute throws when error is configured', async () => {
      const tool = createMockTool({ error: new Error('tool failed') });
      await expect(tool.execute({}, {} as any)).rejects.toThrow('tool failed');
    });
  });

  describe('createMockContext', () => {
    it('has a default mock provider', () => {
      const ctx = createMockContext();
      expect(ctx.provider).toBeDefined();
      expect(ctx.provider.id).toBe('mock');
    });

    it('tools array is accessible', () => {
      const ctx = createMockContext();
      expect(Array.isArray(ctx.tools)).toBe(true);
      expect(ctx.tools.length).toBeGreaterThan(0);
    });
  });

  describe('message helpers', () => {
    it('userMessage creates a user text message', () => {
      const msg = userMessage('hello');
      expect(msg.role).toBe('user');
      expect(msg.content).toHaveLength(1);
    });

    it('assistantMessage creates an assistant text message', () => {
      const msg = assistantMessage('hi');
      expect(msg.role).toBe('assistant');
      expect(msg.content).toHaveLength(1);
    });
  });
});

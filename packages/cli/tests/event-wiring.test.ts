import { afterEach, describe, expect, it, vi } from 'vitest';
import { type EvOn, wireEventWiring } from '../src/boot/event-wiring.js';

const mocks = vi.hoisted(() => {
  const spinner = {
    start: vi.fn(),
    stop: vi.fn(),
    setContext: vi.fn(),
  };
  return {
    spinner,
    Spinner: vi.fn(function Spinner() {
      return spinner;
    }),
    writeErr: vi.fn(),
    color: {
      dim: (text: string) => `dim:${text}`,
      yellow: (text: string) => `yellow:${text}`,
      red: (text: string) => `red:${text}`,
    },
  };
});

vi.mock('../src/spinner.js', () => ({ Spinner: mocks.Spinner }));
vi.mock('@wrongstack/core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core/utils')>();
  return { ...actual, writeErr: mocks.writeErr, color: mocks.color };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('wireEventWiring', () => {
  it('streams only the active session and emits cumulative client status', () => {
    const handlers = new Map<string, Array<(payload: never) => void>>();
    const evOn: EvOn = (event, handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    };
    const emit = vi.fn();
    const renderer = { write: vi.fn() };
    const wiring = wireEventWiring({
      evOn,
      events: { emit } as never,
      renderer,
      getProvider: () => 'provider',
      getModel: () => 'model',
      getSessionId: () => 'current',
      projectSlug: 'wrongstack',
      getActiveModeId: () => 'default',
      tuiOwnsScreen: false,
    });
    const fire = (event: string, payload: unknown) => {
      for (const handler of handlers.get(event) ?? []) handler(payload as never);
    };

    expect(emit).toHaveBeenCalledWith(
      'client.status',
      expect.objectContaining({ clientType: 'cli', sessionId: 'current' }),
    );
    wiring.setEffectiveMaxContext(200_000);
    fire('provider.response', {
      sessionId: 'other',
      usage: { input: 99, output: 88 },
    });
    expect(mocks.spinner.setContext).toHaveBeenLastCalledWith(undefined);

    fire('provider.response', {
      sessionId: 'current',
      usage: { input: 100, output: 20, cacheRead: 4, cacheWrite: 6 },
    });
    expect(mocks.spinner.setContext).toHaveBeenLastCalledWith({
      used: 100,
      max: 200_000,
    });
    fire('iteration.started', { sessionId: 'current' });
    expect(mocks.spinner.start).toHaveBeenCalledWith('dim:provider/model thinking…');

    fire('provider.text_delta', { sessionId: 'current', text: 'hello' });
    fire('provider.text_delta', { sessionId: 'current', text: ' world' });
    expect(renderer.write).toHaveBeenCalledWith('hello');
    expect(renderer.write).toHaveBeenCalledWith(' world');
    fire('iteration.completed', { sessionId: 'current' });
    expect(renderer.write).toHaveBeenCalledWith('\n');

    fire('tool.executed', { sessionId: 'current' });
    fire('token.accounted', { sessionId: 'current', cost: { total: 1.25 } });
    expect(emit).toHaveBeenLastCalledWith(
      'client.status',
      expect.objectContaining({
        toolCalls: 1,
        inputTokens: 100,
        outputTokens: 20,
        cacheTokens: 10,
        costUsd: 1.25,
      }),
    );
  });

  it('reports retry, fallback, and provider errors while ignoring foreign sessions', () => {
    const handlers = new Map<string, Array<(payload: never) => void>>();
    const evOn: EvOn = (event, handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    };
    wireEventWiring({
      evOn,
      events: { emit: vi.fn() } as never,
      renderer: { write: vi.fn() },
      getProvider: () => 'p',
      getModel: () => 'm',
      getSessionId: () => 's',
      projectSlug: 'project',
      getActiveModeId: () => 'mode',
      tuiOwnsScreen: true,
    });
    const fire = (event: string, payload: unknown) => {
      for (const handler of handlers.get(event) ?? []) handler(payload as never);
    };

    fire('provider.retry', {
      sessionId: 's',
      delayMs: 250,
      attempt: 2,
      description: 'busy',
    });
    fire('provider.fallback', {
      sessionId: 's',
      status: 429,
      to: { providerId: 'next', model: 'fallback' },
      contextWindowWarning: {
        fromMaxContext: 200_000,
        toMaxContext: 100_000,
        currentTokens: 50_000,
      },
    });
    fire('provider.error', { sessionId: 's', description: 'failed' });
    fire('error', { sessionId: 's' });
    fire('provider.error', { sessionId: 'foreign', description: 'ignore me' });

    expect(mocks.writeErr).toHaveBeenCalledTimes(3);
    expect(mocks.writeErr.mock.calls.flat().join(' ')).toContain('0.25s');
    expect(mocks.writeErr.mock.calls.flat().join(' ')).toContain('smaller context window');
    expect(mocks.writeErr.mock.calls.flat().join(' ')).not.toContain('ignore me');
  });
});

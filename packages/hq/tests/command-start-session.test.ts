/**
 * `start-session`: the payload shape HQ forwards, and the approver switch
 * that lets a session HQ started wait for HQ's answer instead of being
 * auto-denied by the headless guard.
 */
import { EventBus } from '@wrongstack/contracts/kernel/events';
import { confirmObserverCount, resetConfirmObserversForTest } from '@wrongstack/core/agent';
import { afterEach, describe, expect, it } from 'vitest';
import { createApprovalRegistry } from '../src/approval-bridge.js';
import { parseHqStartSession } from '../src/command-start-session.js';

/** The documented bound (docs/subcommands/hq.md). */
const PROMPT_MAX = 16_000;

import { validateHqCommand } from '../src/commands.js';
import { createHqPublisherFromEnv } from '../src/factory.js';
import { HQ_PROTOCOL_VERSION, parseHqFrame } from '../src/protocol.js';

describe('parseHqStartSession', () => {
  it('accepts a prompt and trims it', () => {
    expect(parseHqStartSession({ prompt: '  fix the flaky test\n' })).toEqual({
      type: 'start-session',
      prompt: 'fix the flaky test',
    });
  });

  it.each([
    ['a missing prompt', {}],
    ['a non-string prompt', { prompt: ['run'] }],
    ['an empty prompt', { prompt: '   ' }],
    ['an over-long prompt', { prompt: 'x'.repeat(PROMPT_MAX + 1) }],
    ['a NUL in the prompt', { prompt: 'a\u0000b' }],
  ])('refuses %s', (_name, payload) => {
    expect(parseHqStartSession(payload as Record<string, unknown>)).toBeNull();
  });

  it('keeps characters a shell would interpret as plain text', () => {
    const prompt = '--yolo-plus; rm -rf / && echo "$HOME" `id` | tee x';
    expect(parseHqStartSession({ prompt })?.prompt).toBe(prompt);
  });

  it('is a recognised HQ command type, validated through validateHqCommand', () => {
    expect(
      validateHqCommand({
        commandId: 'c1',
        type: 'start-session',
        payload: { prompt: 'write the release notes', sessionId: 'ignored' },
      }),
    ).toEqual({ type: 'start-session', prompt: 'write the release notes' });
    expect(validateHqCommand({ commandId: 'c2', type: 'start-session', payload: {} })).toBeNull();
  });
});

describe('createApprovalRegistry approver option', () => {
  afterEach(() => resetConfirmObserversForTest());

  it('mirrors by default: the registry counts as a passive observer', () => {
    resetConfirmObserversForTest();
    const registry = createApprovalRegistry(new EventBus());
    expect(confirmObserverCount()).toBe(1);
    registry.dispose();
    expect(confirmObserverCount()).toBe(0);
  });

  it('answers when HQ started the session: it is not a passive observer', () => {
    resetConfirmObserversForTest();
    const registry = createApprovalRegistry(new EventBus(), { approver: true });
    expect(confirmObserverCount()).toBe(0);
    registry.dispose();
    expect(confirmObserverCount()).toBe(0);
  });
});

describe('start-session announcement in the hello', () => {
  function captureHello(startsSessions?: boolean): Record<string, unknown> | undefined {
    const sent: string[] = [];
    const listeners = new Map<string, (event: unknown) => void>();
    const socket = {
      readyState: 0,
      send: (data: string) => sent.push(data),
      close: () => undefined,
      addEventListener: (type: string, listener: (event: unknown) => void) =>
        listeners.set(type, listener),
      removeEventListener: () => undefined,
    };
    const publisher = createHqPublisherFromEnv({
      config: { enabled: true, url: 'ws://127.0.0.1:1', token: 't' },
      clientKind: 'tui',
      projectRoot: '/srv/proj',
      projectName: 'proj',
      socketFactory: () => socket as never,
      ...(startsSessions !== undefined ? { startsSessions } : {}),
    } as never);
    publisher?.connect();
    socket.readyState = 1;
    listeners.get('open')?.({});
    publisher?.close();
    const hello = sent
      .map((frame) => JSON.parse(frame) as { type: string; payload: Record<string, unknown> })
      .find((frame) => frame.type === 'client.hello');
    return hello?.payload;
  }

  it('carries startsSessions through the factory into the hello, and only when set', () => {
    expect(captureHello(true)?.['startsSessions']).toBe(true);
    expect(captureHello()).not.toHaveProperty('startsSessions');
  });

  it('a current server accepts the field and rejects a non-boolean one', () => {
    const hello = (startsSessions: unknown) =>
      parseHqFrame(
        JSON.stringify({
          type: 'client.hello',
          payload: {
            protocolVersion: HQ_PROTOCOL_VERSION,
            client: {
              clientId: 'c',
              kind: 'tui',
              machineId: 'm',
              startedAt: '2026-11-02T00:00:00Z',
            },
            project: {
              projectId: 'p',
              projectRoot: '/p',
              projectName: 'p',
              machineId: 'm',
              workspaceKind: 'git',
            },
            capabilities: ['telemetry.publish'],
            startsSessions,
          },
        }),
      );
    expect(hello(true).ok).toBe(true);
    expect(hello('yes').ok).toBe(false);
  });
});

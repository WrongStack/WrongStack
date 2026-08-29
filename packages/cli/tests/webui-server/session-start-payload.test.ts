import type { Context } from '@wrongstack/core/agent';
import { describe, expect, it } from 'vitest';
import type { SessionStartPayloadDeps } from '../../src/webui-server/session-start-payload.js';

/**
 * Tests for the session.start payload builder.
 *
 * What these tests pin:
 *
 *   1. Payload includes version fields when `updateInfo` is provided.
 *   2. `appVersion` / `latestVersion` match the update info values.
 *   3. `updateAvailable` / `updateCheckFailed` booleans are set from
 *      `outdated` / `checkFailed`.
 *   4. When `updateInfo` is absent, version fields fall back gracefully
 *      (undefined / false).
 */

// Minimal agent context mock — the payload builder only reads a few fields.
function mockAgentCtx(overrides?: Record<string, unknown>): Context {
  return {
    provider: {
      id: 'test-provider',
      capabilities: { maxContext: 128_000 },
    },
    model: 'test-model',
    session: { id: 'sess_test', startedAt: '2026-07-25T10:00:00.000Z' },
    meta: {},
    lastRequestTokens: 0,
    ...overrides,
  } as unknown as Context;
}

function mockDeps(overrides?: Partial<SessionStartPayloadDeps>): SessionStartPayloadDeps {
  return {
    agent: { ctx: mockAgentCtx() },
    session: { id: 'sess_test' },
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('createSessionStartPayloadBuilder', () => {
  it('includes version fields when updateInfo is provided', async () => {
    const { createSessionStartPayloadBuilder } = await import(
      '../../src/webui-server/session-start-payload.js'
    );

    const buildPayload = createSessionStartPayloadBuilder(
      mockDeps({
        updateInfo: {
          current: '1.0.0',
          latest: '2.0.0',
          outdated: true,
          checkFailed: false,
        },
      }),
    );

    const payload = await buildPayload();
    expect(payload.appVersion).toBe('1.0.0');
    expect(payload.latestVersion).toBe('2.0.0');
    expect(payload.updateAvailable).toBe(true);
    expect(payload.updateCheckFailed).toBe(false);
  });

  it('sets updateAvailable=false when outdated=false', async () => {
    const { createSessionStartPayloadBuilder } = await import(
      '../../src/webui-server/session-start-payload.js'
    );

    const buildPayload = createSessionStartPayloadBuilder(
      mockDeps({
        updateInfo: {
          current: '1.0.0',
          latest: '1.0.0',
          outdated: false,
          checkFailed: false,
        },
      }),
    );

    const payload = await buildPayload();
    expect(payload.appVersion).toBe('1.0.0');
    expect(payload.latestVersion).toBe('1.0.0');
    expect(payload.updateAvailable).toBe(false);
  });

  it('propagates checkFailed flag', async () => {
    const { createSessionStartPayloadBuilder } = await import(
      '../../src/webui-server/session-start-payload.js'
    );

    const buildPayload = createSessionStartPayloadBuilder(
      mockDeps({
        updateInfo: {
          current: '1.0.0',
          latest: '1.0.0',
          outdated: false,
          checkFailed: true,
        },
      }),
    );

    const payload = await buildPayload();
    expect(payload.updateCheckFailed).toBe(true);
  });

  it('defaults version fields when updateInfo is absent', async () => {
    const { createSessionStartPayloadBuilder } = await import(
      '../../src/webui-server/session-start-payload.js'
    );

    const buildPayload = createSessionStartPayloadBuilder(mockDeps());

    const payload = await buildPayload();
    expect(payload).toHaveProperty('appVersion');
    expect(payload.appVersion).toBeUndefined();
    expect(payload).toHaveProperty('latestVersion');
    expect(payload.latestVersion).toBeUndefined();
    expect(payload.updateAvailable).toBe(false);
    expect(payload.updateCheckFailed).toBe(false);
  });

  it('carries the original session start time', async () => {
    const { createSessionStartPayloadBuilder } = await import(
      '../../src/webui-server/session-start-payload.js'
    );

    const buildPayload = createSessionStartPayloadBuilder(mockDeps());

    const payload = await buildPayload();
    expect(payload.startedAt).toBe('2026-07-25T10:00:00.000Z');
  });
});

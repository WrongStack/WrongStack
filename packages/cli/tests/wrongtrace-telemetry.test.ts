/**
 * WrongTrace session-telemetry unit tests — pure builder mapping + the
 * fail-open reporter contract (offline → no-op, throw → swallowed). The
 * live POST /api/telemetry round-trip is covered by the adapter's client
 * tests plus the 2026-08-24 live probe recorded on the board.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  buildWrongTraceTelemetryReport,
  reportWrongTraceSessionTelemetry,
} from '../src/wiring/wrongtrace-telemetry.js';

describe('buildWrongTraceTelemetryReport', () => {
  it('maps session facts onto the daemon payload contract', () => {
    const r = buildWrongTraceTelemetryReport({
      sessionId: 'sess-1',
      agentName: 'wrongstack-cli',
      model: 'claude-x',
      provider: 'anthropic',
      usage: { input: 100, output: 50, cacheRead: 7, cacheWrite: 3 },
      costUsd: 0.42,
    });
    expect(r).toMatchObject({
      run_id: 'sess-1',
      agent_name: 'wrongstack-cli',
      model_name: 'claude-x',
      provider: 'anthropic',
      prompt_tokens: 100,
      completion_tokens: 50,
      cost_usd: 0.42,
      intent: 'session_complete',
    });
    expect(r.cache_read_tokens).toBe(7);
    expect(r.cache_write_tokens).toBe(3);
  });
});

describe('reportWrongTraceSessionTelemetry', () => {
  it('reports once when the client is available', async () => {
    const reportTelemetry = vi.fn(async () => ({ ok: true }));
    await reportWrongTraceSessionTelemetry(
      {
        sessionId: 's',
        agentName: 'a',
        model: 'm',
        provider: 'p',
        usage: { input: 1, output: 2 },
        costUsd: 0,
      },
      { client: { isAvailable: true, reportTelemetry } },
    );
    expect(reportTelemetry).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the daemon is offline', async () => {
    const reportTelemetry = vi.fn(async () => null);
    await reportWrongTraceSessionTelemetry(
      {
        sessionId: 's',
        agentName: 'a',
        model: 'm',
        provider: 'p',
        usage: { input: 1, output: 2 },
        costUsd: 0,
      },
      { client: { isAvailable: false, reportTelemetry } },
    );
    expect(reportTelemetry).not.toHaveBeenCalled();
  });

  it('never throws when the transport rejects', async () => {
    const reportTelemetry = vi.fn(async () => {
      throw new Error('transport down');
    });
    await expect(
      reportWrongTraceSessionTelemetry(
        {
          sessionId: 's',
          agentName: 'a',
          model: 'm',
          provider: 'p',
          usage: { input: 1, output: 2 },
          costUsd: 0,
        },
        { client: { isAvailable: true, reportTelemetry } },
      ),
    ).resolves.toBeUndefined();
  });
});

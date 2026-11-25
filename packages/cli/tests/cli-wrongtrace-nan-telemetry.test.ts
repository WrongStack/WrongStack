import { describe, expect, it } from 'vitest';
import { buildWrongTraceTelemetryReport } from '../src/wiring/wrongtrace-telemetry.js';

describe('buildWrongTraceTelemetryReport numeric sanitization (F2310)', () => {
  it('clamps non-finite and negative token/cost fields to 0', () => {
    const report = buildWrongTraceTelemetryReport({
      sessionId: 's1',
      agentName: 'cli',
      model: 'gpt-4o',
      provider: 'openai',
      usage: { input: Number.NaN, output: -10, cacheRead: Number.POSITIVE_INFINITY },
      costUsd: Number.NaN,
    });
    expect(report.prompt_tokens).toBe(0);
    expect(report.completion_tokens).toBe(0);
    expect(report.cost_usd).toBe(0);
    expect(report.cache_read_tokens).toBe(0);
  });
});

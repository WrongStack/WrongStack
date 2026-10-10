import { describe, expect, it } from 'vitest';
import {
  applyHealthThresholds,
  createMCPServerOperationState,
  evaluateHealthThresholds,
  healthStateFor,
  MCP_OPERATION_LIMITS,
  pushBounded,
  safeOperationReason,
  summarizeLatency,
} from '../src/operations.js';

describe('MCP operational health primitives', () => {
  it('distinguishes disabled, dormant, transitional, degraded, failed, and healthy states', () => {
    const operations = createMCPServerOperationState();
    expect(healthStateFor('connected', operations, false)).toBe('disabled');
    expect(healthStateFor('dormant', operations)).toBe('dormant');
    expect(healthStateFor('connecting', operations)).toBe('connecting');
    expect(healthStateFor('disconnected', operations)).toBe('degraded');
    expect(healthStateFor('failed', operations)).toBe('failed');
    expect(healthStateFor('connected', operations)).toBe('healthy');
    operations.consecutiveFailures = 1;
    expect(healthStateFor('connected', operations)).toBe('degraded');
  });

  it('summarizes bounded latency samples deterministically', () => {
    const samples: number[] = [];
    for (let value = 1; value <= MCP_OPERATION_LIMITS.LATENCY_SAMPLES + 5; value++) {
      pushBounded(samples, value, MCP_OPERATION_LIMITS.LATENCY_SAMPLES);
    }
    expect(samples).toHaveLength(MCP_OPERATION_LIMITS.LATENCY_SAMPLES);
    expect(samples[0]).toBe(6);
    expect(summarizeLatency([40, 10, 30, 20])).toEqual({
      count: 4,
      lastMs: 20,
      minMs: 10,
      maxMs: 40,
      p50Ms: 20,
      p95Ms: 40,
    });
  });

  it('turns reasons into bounded codes instead of preserving secret-bearing text', () => {
    const reason = safeOperationReason(
      'some-bearer-token-https://user:password@example.test/path?token=secret',
    );
    expect(reason.length).toBeLessThanOrEqual(MCP_OPERATION_LIMITS.REASON_CHARS);
    expect(reason).not.toContain(' ');
    expect(reason).not.toContain('/');
    expect(reason).not.toContain('?');
  });

  it('returns count 0 when summarizing empty latency samples', () => {
    expect(summarizeLatency([])).toEqual({ count: 0 });
  });

  it('returns "other" for unrecognized safe operation reasons', () => {
    expect(safeOperationReason('unknown-reason-that-is-not-in-the-set')).toBe('other');
    expect(safeOperationReason('')).toBe('other');
  });

  it('maps connecting, reconnecting, and idle all to connecting health state', () => {
    const operations = createMCPServerOperationState();
    expect(healthStateFor('connecting', operations)).toBe('connecting');
    expect(healthStateFor('reconnecting', operations)).toBe('connecting');
    expect(healthStateFor('idle', operations)).toBe('connecting');
  });

  it('returns empty checks when no thresholds are configured', () => {
    const operations = createMCPServerOperationState();
    operations.callSamples.push(100, 200, 300);
    expect(evaluateHealthThresholds(operations, undefined)).toEqual([]);
  });

  it('flags degraded when call latency p95 exceeds threshold', () => {
    const operations = createMCPServerOperationState();
    operations.callSamples.push(10, 20, 30, 40, 50);
    const checks = evaluateHealthThresholds(operations, { callLatencyP95Ms: 25 });
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      name: 'call-latency-p95',
      passed: false,
      threshold: 25,
    });
    expect(applyHealthThresholds('healthy', checks)).toBe('degraded');
  });

  it('keeps healthy when all thresholds pass', () => {
    const operations = createMCPServerOperationState();
    operations.connectionSamples.push(10, 20, 30);
    operations.discoverySamples.push(50, 60, 70);
    operations.callSamples.push(100, 110, 120);
    operations.peakInFlightCalls = 4;
    const checks = evaluateHealthThresholds(operations, {
      connectionLatencyP95Ms: 100,
      discoveryLatencyP95Ms: 200,
      callLatencyP95Ms: 500,
      inFlightCalls: 5,
    });
    expect(checks.every((c) => c.passed)).toBe(true);
    expect(applyHealthThresholds('healthy', checks)).toBe('healthy');
  });

  it('ignores a threshold that is not a usable number instead of failing the check', () => {
    // `!== undefined` is not enough. These values are read straight off
    // config.json (registry-health.ts / registry-operations.ts pass
    // `slot.cfg.health?.thresholds`), where `null` and a hand-edited string both
    // pass it while being useless as a bound. Every threshold is compared with
    // `<=`, false for a non-number on every sample, so one typo pinned an
    // otherwise-healthy server to `degraded` permanently — recomputed from the
    // same config on every read and across restarts.
    const operations = createMCPServerOperationState();
    operations.connectionSamples.push(10, 20, 30, 40, 50);
    operations.callSamples.push(10, 20, 30, 40, 50);

    for (const unusable of [
      { connectionLatencyP95Ms: 'soon' },
      { connectionLatencyP95Ms: null },
      { callLatencyP95Ms: 'soon' },
    ]) {
      // A value that is not a number is not a configured threshold at all, so it
      // produces no check — and per the contract it cannot mark a server degraded.
      const checks = evaluateHealthThresholds(operations, unusable as never);
      expect(checks).toEqual([]);
      expect(applyHealthThresholds('healthy', checks)).toBe('healthy');
    }

    // NaN and Infinity are not usable bounds either, so they must not pin
    // `degraded` either.
    for (const unusable of [
      { connectionLatencyP95Ms: Number.NaN },
      { connectionLatencyP95Ms: Number.POSITIVE_INFINITY },
    ]) {
      expect(
        applyHealthThresholds('healthy', evaluateHealthThresholds(operations, unusable as never)),
      ).toBe('healthy');
    }

    // A malformed in-flight threshold fires with no latency samples at all.
    const noSamples = createMCPServerOperationState();
    const inFlight = evaluateHealthThresholds(noSamples, { inFlightCalls: 'lots' } as never);
    expect(inFlight).toEqual([]);
    expect(applyHealthThresholds('healthy', inFlight)).toBe('healthy');
  });

  it('still enforces a legitimate 0 threshold', () => {
    // Guards the fix above: a guard written as truthiness (`if (!threshold)`)
    // would drop this check and report a busy server as healthy.
    const operations = createMCPServerOperationState();
    operations.peakInFlightCalls = 1;
    const checks = evaluateHealthThresholds(operations, { inFlightCalls: 0 });
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: 'in-flight-calls', passed: false, threshold: 0 });
    expect(applyHealthThresholds('healthy', checks)).toBe('degraded');
  });

  it('does not downgrade already-failed or degraded lifecycle states', () => {
    const operations = createMCPServerOperationState();
    operations.callSamples.push(10000);
    const checks = evaluateHealthThresholds(operations, { callLatencyP95Ms: 1 });
    expect(applyHealthThresholds('failed', checks)).toBe('failed');
    expect(applyHealthThresholds('degraded', checks)).toBe('degraded');
  });

  it('flags in-flight saturation when peak exceeds threshold', () => {
    const operations = createMCPServerOperationState();
    operations.peakInFlightCalls = 12;
    const checks = evaluateHealthThresholds(operations, { inFlightCalls: 10 });
    expect(checks[0]).toEqual({
      name: 'in-flight-calls',
      passed: false,
      value: 12,
      threshold: 10,
    });
  });

  it('skips latency checks until at least one sample exists', () => {
    const operations = createMCPServerOperationState();
    const checks = evaluateHealthThresholds(operations, { callLatencyP95Ms: 1 });
    expect(checks).toHaveLength(0);
    expect(applyHealthThresholds('healthy', checks)).toBe('healthy');
  });
});

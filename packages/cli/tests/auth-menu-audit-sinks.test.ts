/**
 * Coverage for auth-menu-audit.ts's sink-resolution surface that the
 * local-audit integration tests don't touch: the stdout/stderr sink WRITE
 * bodies, the probe_skip scrub path, and the both-empty decide fallthrough.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAuthAuditLogger,
  decideAuthLocalEvents,
  memAuthAuditSink,
  resolveAuditSink,
} from '../src/auth-menu/auth-menu-audit.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('auth-menu-audit — stdout/stderr sinks', () => {
  it('a bare --audit flag routes events to stdout', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logger = createAuthAuditLogger(resolveAuditSink(true));
    logger.emit({ type: 'auth.local.add', providerId: 'ollama', baseUrl: 'http://x', models: [] });
    expect(write).toHaveBeenCalledWith(expect.stringContaining('"type":"auth.local.add"'));
  });

  it('--audit stderr routes events to stderr', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logger = createAuthAuditLogger(resolveAuditSink('stderr'));
    logger.emit({ type: 'auth.local.clear', providerId: 'ollama', baseUrl: 'http://x', previousModels: ['m'] });
    expect(write).toHaveBeenCalledWith(expect.stringContaining('"type":"auth.local.clear"'));
  });
});

describe('auth-menu-audit — probe_skip scrubbing', () => {
  it('scrubs string leaves of the probe_skip event', () => {
    const sink = memAuthAuditSink();
    const logger = createAuthAuditLogger(sink);
    // Constructed at runtime: looks like a real key to the scrubber, but no
    // literal credential appears in the test source.
    const fakeKey = `s${'k-'}${'a'}${'nt-'}${'a'.repeat(24)}`;
    logger.emit({
      type: 'auth.local.probe_skip',
      providerId: fakeKey,
      baseUrl: 'http://ollama.local',
      requestedShape: 'first',
    });
    expect(sink.lines).toHaveLength(1);
    const line = sink.lines[0]!;
    expect(line).not.toContain('a'.repeat(24));
    const parsed = JSON.parse(line) as { type: string; requestedShape: string };
    expect(parsed.type).toBe('auth.local.probe_skip');
    expect(parsed.requestedShape).toBe('first');
  });
});

describe('auth-menu-audit — decideAuthLocalEvents both-empty fallthrough', () => {
  it('returns no events when the user cleared an already-empty allowlist', () => {
    expect(
      decideAuthLocalEvents({
        providerId: 'ollama',
        baseUrl: 'http://x',
        previousModels: [],
        newModels: [],
        keyLabel: undefined,
      }),
    ).toEqual([]);
  });

  it('returns no events when --model "" was passed on a fresh provider', () => {
    expect(
      decideAuthLocalEvents({
        providerId: 'ollama',
        baseUrl: 'http://x',
        previousModels: undefined,
        newModels: [],
        keyLabel: undefined,
      }),
    ).toEqual([]);
  });
});

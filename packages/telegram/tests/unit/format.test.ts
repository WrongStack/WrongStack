import { describe, expect, it } from 'vitest';
import {
  type DelegateCompletedLike,
  fmtDuration,
  fmtTokens,
  fmtToolOutput,
  formatDelegateCompleted,
  formatSessionEnded,
  formatToolExecuted,
  type SessionEndedLike,
} from '../../src/format.js';

const base: DelegateCompletedLike = {
  target: 'bug-hunter',
  task: 'audit src/parser.ts for null derefs',
  ok: true,
  status: 'success',
  summary: '[bug-hunter] done in 3m (4 iter, 37 tools) — fixed 2 null derefs',
  durationMs: 180_000,
  iterations: 4,
  toolCalls: 37,
  costUsd: 0.082,
  subagentId: 'bug-hunter-abcd1234',
};

// Synthetic canaries that exercise the redaction paths without using
// shapes that look like real secrets (which trip source-level scanners
// and would also be misleading in a test fixture). The dedicated
// `redact.test.ts` suite covers the full regex matrix against realistic
// inputs.
const CANARY_A = 'CANARY_SENTINEL_AAA';
const CANARY_B = 'CANARY_SENTINEL_BBB';

describe('fmtDuration', () => {
  it('renders seconds, minutes, and hours', () => {
    expect(fmtDuration(5_000)).toBe('5s');
    expect(fmtDuration(180_000)).toBe('3m');
    expect(fmtDuration(5_400_000)).toBe('1.5h');
  });
});

describe('formatDelegateCompleted', () => {
  it('derives status labels and truncates long tasks when status is absent', () => {
    expect(formatDelegateCompleted({ ...base, status: undefined })).toContain('· success');
    const failed = formatDelegateCompleted({
      ...base,
      ok: false,
      status: undefined,
      summary: '',
      task: 'x'.repeat(200),
    });
    expect(failed).toContain('· failed');
    expect(failed).toContain(`${'x'.repeat(159)}…`);
  });

  it('produces a humanized multi-line message (not JSON)', () => {
    const msg = formatDelegateCompleted(base);
    expect(msg).not.toMatch(/[{}]/); // no raw JSON braces
    expect(msg).toContain('✅ Delegate → bug-hunter · success');
    expect(msg).toContain('fixed 2 null derefs');
    expect(msg).toContain('4 iter');
    expect(msg).toContain('37 tools');
    expect(msg).toContain('💲0.0820');
  });

  it('marks failures with ❌ and the failure status', () => {
    const msg = formatDelegateCompleted({
      ...base,
      ok: false,
      status: 'host_timeout',
      summary: '[bug-hunter] timed out — no result within 30s',
    });
    expect(msg).toContain('❌ Delegate → bug-hunter · host_timeout');
  });

  it('omits the cost stat when cost is missing or zero', () => {
    const msg = formatDelegateCompleted({ ...base, costUsd: 0 });
    expect(msg).not.toContain('💲');
    const msg2 = formatDelegateCompleted({ ...base, costUsd: undefined });
    expect(msg2).not.toContain('💲');
  });

  it('falls back to the task when there is no summary', () => {
    const msg = formatDelegateCompleted({ ...base, ok: false, summary: '' });
    expect(msg).toContain('(no summary)');
    expect(msg).toContain('audit src/parser.ts');
  });

  it('redacts a --token flag in the summary body', () => {
    const msg = formatDelegateCompleted({
      ...base,
      summary: `done. used --token=${CANARY_A}`,
    });
    expect(msg).not.toContain(CANARY_A);
    expect(msg).toContain('[REDACTED]');
  });

  it('redacts an env-style SECRET= assignment in the summary body', () => {
    const msg = formatDelegateCompleted({
      ...base,
      summary: `done. SECRET=${CANARY_B} was set`,
    });
    expect(msg).not.toContain(CANARY_B);
    expect(msg).toContain('[REDACTED]');
  });
});

describe('fmtTokens', () => {
  it('formats small numbers without commas', () => {
    expect(fmtTokens(42)).toBe('42');
  });

  it('formats thousands with commas', () => {
    expect(fmtTokens(1234)).toBe('1,234');
  });

  it('formats large numbers', () => {
    expect(fmtTokens(12345678)).toBe('12,345,678');
  });

  it('formats zero', () => {
    expect(fmtTokens(0)).toBe('0');
  });
});

describe('fmtToolOutput', () => {
  it('truncates previews longer than 300 characters', () => {
    const output = fmtToolOutput('x'.repeat(400));
    expect(output).toHaveLength(298);
    expect(output.endsWith('…')).toBe(true);
  });
  it('returns placeholder for undefined', () => {
    expect(fmtToolOutput(undefined)).toBe('(no output)');
  });

  it('returns placeholder for empty', () => {
    expect(fmtToolOutput('')).toBe('(no output)');
  });

  it('strips JSON braces from simple objects', () => {
    const raw = JSON.stringify({ ok: true, message: 'Build succeeded' });
    const result = fmtToolOutput(raw);
    expect(result).not.toContain('{');
    expect(result).not.toContain('}');
    expect(result).toContain('ok: true');
    expect(result).toContain('Build succeeded');
  });

  it('limits to 300 chars', () => {
    const raw = 'line '.repeat(50);
    const result = fmtToolOutput(raw);
    expect(result.length).toBeLessThanOrEqual(310);
  });

  it('shows first 3 meaningful lines', () => {
    const raw = 'line1\nline2\nline3\nline4\nline5';
    const result = fmtToolOutput(raw);
    expect(result).toContain('line1');
    expect(result).toContain('line2');
    expect(result).toContain('line3');
    expect(result).toContain('+2 more lines');
  });

  it('redacts a --mysecret flag value', () => {
    const raw = `curl --mysecret=${CANARY_A} https://x`;
    const out = fmtToolOutput(raw);
    expect(out).not.toContain(CANARY_A);
    expect(out).toContain('[REDACTED]');
  });

  it('redacts a SECRET= env assignment', () => {
    const raw = `MY_SECRET=${CANARY_B} node app.js`;
    const out = fmtToolOutput(raw);
    expect(out).not.toContain(CANARY_B);
    expect(out).toContain('MY_SECRET=[REDACTED]');
  });

  it('does not redact when there is nothing sensitive', () => {
    const raw = 'line1\nline2\nline3';
    expect(fmtToolOutput(raw)).toBe(raw);
  });
});

describe('formatToolExecuted', () => {
  it('falls back to the redacted source when JSON-wrapper stripping is empty', () => {
    expect(fmtToolOutput('{}')).toBe('{}');
  });
  it('formats a successful tool execution with output', () => {
    const msg = formatToolExecuted({
      name: 'bash',
      ok: true,
      durationMs: 45_200,
      output: JSON.stringify({ stdout: '12 tests passed\n0 failures', ok: true }),
    });
    expect(msg).toContain('✅ bash completed in 45.2s');
    expect(msg).toContain('12 tests passed');
    expect(msg).not.toContain('{'); // no raw JSON
  });

  it('shows ❌ for failed tools', () => {
    const msg = formatToolExecuted({
      name: 'bash',
      ok: false,
      durationMs: 30_000,
    });
    expect(msg).toContain('❌ bash completed in 30.0s');
  });

  it('omits output section when there is no output', () => {
    const msg = formatToolExecuted({
      name: 'read',
      ok: true,
      durationMs: 100,
    });
    expect(msg).toBe('✅ read completed in 0.1s');
  });
});

describe('formatSessionEnded', () => {
  it('keeps short session ids intact', () => {
    expect(formatSessionEnded({ id: 'short', inputTokens: 0, outputTokens: 0 })).toContain(
      'Session short ended',
    );
  });

  const baseSession: SessionEndedLike = {
    id: 'sess_abcdef1234567890',
    inputTokens: 8234,
    outputTokens: 3456,
    cacheRead: 1200,
    cacheWrite: 800,
  };

  it('produces a humanized multi-line summary', () => {
    const msg = formatSessionEnded(baseSession);
    expect(msg).toContain('🏁 Session sess_abc ended');
    expect(msg).toContain('⬇ 8,234 in');
    expect(msg).toContain('⬆ 3,456 out');
    expect(msg).toContain('11,690 total');
    expect(msg).toContain('📦 1,200 cache read · 800 cache written');
  });

  it('omits cache line when no cache usage', () => {
    const msg = formatSessionEnded({
      ...baseSession,
      cacheRead: undefined,
      cacheWrite: undefined,
    });
    expect(msg).not.toContain('📦');
  });

  it('shows only cache read when no cache write', () => {
    const msg = formatSessionEnded({
      ...baseSession,
      cacheWrite: undefined,
    });
    expect(msg).toContain('1,200 cache read');
    expect(msg).not.toContain('written');
  });

  it('omits an empty cache detail line for non-positive truthy counters', () => {
    const msg = formatSessionEnded({
      ...baseSession,
      cacheRead: -1,
      cacheWrite: -2,
    });
    expect(msg).not.toContain('📦');
  });
});

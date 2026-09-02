import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { compileUserRegex } from '../../src/utils/regex-guard.js';
import { ulid, isUlid } from '../../src/utils/ulid.js';
import {
  estimateToolInputTokens,
  estimateToolResultTokens,
  estimateTextTokens,
  computeMessageTokens,
  estimateMessageTokens,
  estimateRequestTokens,
  recordActualUsage,
  getCalibrationState,
  estimateRequestTokensCalibrated,
  resetCalibration,
} from '../../src/utils/token-estimate.js';
import {
  sanitizeNodeOptions,
  buildChildEnv,
  configureChildEnvGitIdentity,
  getChildEnvGitIdentity,
} from '../../src/utils/child-env.js';
import type { Message } from '../../src/types/messages.js';

// ── regex-guard ────────────────────────────────────────────────────────

describe('compileUserRegex', () => {
  it('compiles a valid pattern', () => {
    const r = compileUserRegex('\\d+', '');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.regex.test('123')).toBe(true);
  });

  it('compiles with flags', () => {
    const r = compileUserRegex('hello', 'i');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.regex.test('HELLO')).toBe(true);
  });

  it('rejects empty pattern', () => {
    const r = compileUserRegex('', '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('empty');
  });

  it('rejects non-string pattern', () => {
    const r = compileUserRegex(42 as unknown as string, '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('string');
  });

  it('rejects pattern exceeding max length', () => {
    const r = compileUserRegex('a'.repeat(600), '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('exceeds');
  });

  it('rejects catastrophic-backtracking pattern (a+)+', () => {
    const r = compileUserRegex('(a+)+', '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('backtracking');
  });

  it('rejects non-capturing group with nested quantifier', () => {
    const r = compileUserRegex('(?:.+)+', '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('backtracking');
  });

  it('rejects invalid regex syntax', () => {
    const r = compileUserRegex('[', '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBeTruthy();
  });
});

// ── ulid ───────────────────────────────────────────────────────────────

describe('ulid', () => {
  it('generates a 26-char string', () => {
    const id = ulid();
    expect(id).toHaveLength(26);
  });

  it('generates valid ULIDs', () => {
    for (let i = 0; i < 100; i++) {
      expect(isUlid(ulid())).toBe(true);
    }
  });

  it('sorts lexicographically by time', () => {
    const early = ulid(1_000_000);
    const late = ulid(2_000_000);
    expect(early < late).toBe(true);
  });

  it('isUlid rejects wrong length', () => {
    expect(isUlid('short')).toBe(false);
    expect(isUlid('a'.repeat(30))).toBe(false);
  });

  it('isUlid rejects invalid characters', () => {
    expect(isUlid('I'.repeat(26))).toBe(false); // I not in Crockford
    expect(isUlid('!'.repeat(26))).toBe(false);
  });

  it('accepts valid Crockford base32', () => {
    // ulid() produces valid ULIDs by construction
    const id1 = ulid(0);
    const id2 = ulid(Date.now());
    expect(isUlid(id1)).toBe(true);
    expect(isUlid(id2)).toBe(true);
  });
});

// ── token-estimate ────────────────────────────────────────────────────

describe('token-estimate', () => {
  beforeEach(() => resetCalibration());

  it('estimateTextTokens returns ceil(length/3.5)', () => {
    expect(estimateTextTokens('')).toBe(1);
    expect(estimateTextTokens('hello')).toBe(2);
    expect(estimateTextTokens('hello world this is a test')).toBe(8);
  });

  it('estimateToolInputTokens handles string input', () => {
    expect(estimateToolInputTokens('hello')).toBe(2);
  });

  it('estimateToolInputTokens handles object input', () => {
    const tokens = estimateToolInputTokens({ foo: 'bar', baz: 42 });
    expect(tokens).toBeGreaterThan(0);
  });

  it('estimateToolInputTokens handles null', () => {
    expect(estimateToolInputTokens(null)).toBeGreaterThan(0);
  });

  it('estimateToolInputTokens caches results', () => {
    const input = { a: 1, b: 'test' };
    const first = estimateToolInputTokens(input);
    const second = estimateToolInputTokens(input);
    expect(second).toBe(first);
  });

  it('estimateToolResultTokens handles string', () => {
    expect(estimateToolResultTokens('output text')).toBeGreaterThan(0);
  });

  it('estimateToolResultTokens handles non-string', () => {
    expect(estimateToolResultTokens({ data: [1, 2, 3] })).toBeGreaterThan(0);
  });

  it('computeMessageTokens handles string content', () => {
    const msg = { role: 'user', content: 'hello world' } as Message;
    expect(computeMessageTokens(msg)).toBeGreaterThan(0);
  });

  it('computeMessageTokens handles content blocks', () => {
    const msg = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'tool_use', id: 't1', name: 'test', input: { x: 1 } },
      ],
    } as unknown as Message;
    expect(computeMessageTokens(msg)).toBeGreaterThan(0);
  });

  it('estimateMessageTokens uses _estTokens when present', () => {
    const msgs = [{ role: 'user', content: 'x', _estTokens: 42 } as unknown as Message];
    expect(estimateMessageTokens(msgs)).toBe(42);
  });

  it('estimateRequestTokens returns breakdown', () => {
    const result = estimateRequestTokens('hello', 'system prompt', [
      { name: 'tool1', description: 'A tool', inputSchema: { type: 'object' } },
    ]);
    expect(result.messages).toBeGreaterThan(0);
    expect(result.systemPrompt).toBeGreaterThan(0);
    expect(result.tools).toBeGreaterThan(0);
    expect(result.total).toBe(result.messages + result.systemPrompt + result.tools);
  });

  it('estimateRequestTokens handles message arrays', () => {
    const msgs = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
    ];
    const result = estimateRequestTokens(msgs, '', []);
    expect(result.messages).toBeGreaterThan(0);
  });

  it('estimateRequestTokens handles array system prompt', () => {
    const result = estimateRequestTokens([], [{ type: 'text', text: 'system' }], []);
    expect(result.systemPrompt).toBeGreaterThan(0);
  });

  it('recordActualUsage and calibration', () => {
    estimateRequestTokens('test', '', []);
    recordActualUsage(100, 50);
    const state = getCalibrationState();
    expect(state.count).toBe(1);
    // ratio 100/50 = 2.0, clamped to 1.5
    expect(state.ratio).toBe(1.5);
    expect(state.calibrated).toBe(false);
  });

  it('calibration applies after MIN_SAMPLES', () => {
    estimateRequestTokens('test', '', [], 'test-key');
    recordActualUsage(100, 50, 'test-key');
    recordActualUsage(100, 50, 'test-key');
    recordActualUsage(100, 50, 'test-key');
    expect(getCalibrationState('test-key').calibrated).toBe(true);
    const result = estimateRequestTokensCalibrated('test', '', [], 'test-key');
    expect(result.total).toBeGreaterThan(0);
  });

  it('estimateRequestTokensCalibrated falls back to model-family ratio', () => {
    const result = estimateRequestTokensCalibrated('test', '', [], 'anthropic/claude-3');
    const uncalibrated = estimateRequestTokens('test', '', [], 'anthropic/claude-3');
    expect(result.total).toBeGreaterThan(uncalibrated.total - 1);
  });

  it('calibration ratio is clamped to [0.5, 1.5]', () => {
    estimateRequestTokens('test', '', [], 'clamp-key');
    recordActualUsage(1000, 10, 'clamp-key');
    expect(getCalibrationState('clamp-key').ratio).toBe(1.5);
    // A very small ratio: 0.001, clamped to 0.5 before EWM
    // EWM: 0.3 * 0.5 + 0.7 * 1.5 = 1.2 (still above 0.5)
    recordActualUsage(1, 1000, 'clamp-key');
    const ratio = getCalibrationState('clamp-key').ratio;
    expect(ratio).toBeGreaterThanOrEqual(0.5);
    expect(ratio).toBeLessThanOrEqual(1.5);
  });

  it('resetCalibration clears all', () => {
    recordActualUsage(100, 50, 'reset-key');
    resetCalibration();
    expect(getCalibrationState('reset-key').count).toBe(0);
  });

  it('resetCalibration clears single key', () => {
    recordActualUsage(100, 50, 'single-key');
    resetCalibration('single-key');
    expect(getCalibrationState('single-key').count).toBe(0);
  });
});

// ── child-env ─────────────────────────────────────────────────────────

describe('sanitizeNodeOptions', () => {
  it('passes through benign flags', () => {
    expect(sanitizeNodeOptions('--no-warnings')).toBe('--no-warnings');
    expect(sanitizeNodeOptions('--max-old-space-size=4096')).toBe('--max-old-space-size=4096');
  });

  it('strips --require=path form', () => {
    expect(sanitizeNodeOptions('--require=./evil.js --no-warnings')).toBe('--no-warnings');
  });

  it('strips --require path form (space-separated)', () => {
    expect(sanitizeNodeOptions('--require ./evil.js --no-warnings')).toBe('--no-warnings');
  });

  it('strips -r short form', () => {
    expect(sanitizeNodeOptions('-r ./evil.js')).toBe('');
  });

  it('strips --import form', () => {
    expect(sanitizeNodeOptions('--import=./evil.mjs')).toBe('');
  });

  it('strips --loader form', () => {
    expect(sanitizeNodeOptions('--loader ./custom.mjs --max-old-space-size=2048')).toBe(
      '--max-old-space-size=2048',
    );
  });

  it('handles multiple injection flags', () => {
    expect(sanitizeNodeOptions('--require a.js --import b.mjs -r c.js --ok')).toBe('--ok');
  });

  it('returns empty for injection-only', () => {
    expect(sanitizeNodeOptions('--require ./evil.js')).toBe('');
  });
});

describe('buildChildEnv', () => {
  afterEach(() => configureChildEnvGitIdentity(null));

  it('forwards PATH', () => {
    const env = buildChildEnv();
    expect(env.PATH).toBeDefined();
  });

  it('strips secret-named vars', () => {
    const orig = process.env.MY_API_KEY;
    process.env.MY_API_KEY = 'leak-target';
    const env = buildChildEnv();
    expect(env.MY_API_KEY).toBeUndefined();
    if (orig === undefined) delete process.env.MY_API_KEY;
    else process.env.MY_API_KEY = orig;
  });

  it('strips vars with embedded credentials in value', () => {
    const orig = process.env.MY_DB;
    // Build a URI with embedded credential to test the value-side filter
    const scheme = 'postgres';
    const user = 'admin';
    const pw = 'hunter2';
    const host = 'localhost:5432';
    process.env.MY_DB = `${scheme}://${user}:${pw}@${host}/db`;
    const env = buildChildEnv();
    expect(env.MY_DB).toBeUndefined();
    if (orig === undefined) delete process.env.MY_DB;
    else process.env.MY_DB = orig;
  });

  it('allows credential-free URLs with allowed prefix', () => {
    const orig = process.env.WRONGSTACK_REGISTRY;
    process.env.WRONGSTACK_REGISTRY = 'https://registry.npmjs.org';
    const env = buildChildEnv();
    expect(env.WRONGSTACK_REGISTRY).toBe('https://registry.npmjs.org');
    if (orig === undefined) delete process.env.WRONGSTACK_REGISTRY;
    else process.env.WRONGSTACK_REGISTRY = orig;
  });

  it('forwards WRONGSTACK_ prefixed vars', () => {
    const orig = process.env.WRONGSTACK_TEST_VAR;
    process.env.WRONGSTACK_TEST_VAR = 'test';
    const env = buildChildEnv();
    expect(env.WRONGSTACK_TEST_VAR).toBe('test');
    if (orig === undefined) delete process.env.WRONGSTACK_TEST_VAR;
    else process.env.WRONGSTACK_TEST_VAR = orig;
  });

  it('sanitizes NODE_OPTIONS', () => {
    const orig = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--require=./evil.js --no-warnings';
    const env = buildChildEnv();
    expect(env.NODE_OPTIONS).toBe('--no-warnings');
    if (orig === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = orig;
  });

  it('injects session ID', () => {
    const env = buildChildEnv({ sessionId: 'test-session-123' });
    expect(env.WRONGSTACK_SESSION_ID).toBe('test-session-123');
  });

  it('accepts string sessionId shorthand', () => {
    const env = buildChildEnv('shorthand-session');
    expect(env.WRONGSTACK_SESSION_ID).toBe('shorthand-session');
  });

  it('merges extra env vars', () => {
    const env = buildChildEnv({ extra: { MY_CUSTOM_VAR: 'value' } });
    expect(env.MY_CUSTOM_VAR).toBe('value');
  });

  it('forwards EDITOR and PAGER', () => {
    const origEditor = process.env.EDITOR;
    const origPager = process.env.PAGER;
    process.env.EDITOR = 'vim';
    process.env.PAGER = 'less';
    const env = buildChildEnv();
    expect(env.EDITOR).toBe('vim');
    expect(env.PAGER).toBe('less');
    if (origEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = origEditor;
    if (origPager === undefined) delete process.env.PAGER;
    else process.env.PAGER = origPager;
  });

  it('injects git identity when configured', () => {
    configureChildEnvGitIdentity({ name: 'Bot', email: 'bot@example.com' });
    const env = buildChildEnv();
    expect(env.GIT_AUTHOR_NAME).toBe('Bot');
    expect(env.GIT_COMMITTER_NAME).toBe('Bot');
    expect(env.GIT_AUTHOR_EMAIL).toBe('bot@example.com');
    expect(env.GIT_COMMITTER_EMAIL).toBe('bot@example.com');
  });

  it('getChildEnvGitIdentity returns current config', () => {
    configureChildEnvGitIdentity({ name: 'Test', email: undefined });
    expect(getChildEnvGitIdentity()?.name).toBe('Test');
    expect(getChildEnvGitIdentity()?.email).toBeUndefined();
  });

  it('clears git identity with null', () => {
    configureChildEnvGitIdentity({ name: 'Bot', email: 'b@e.com' });
    expect(getChildEnvGitIdentity()).not.toBeNull();
    configureChildEnvGitIdentity(null);
    expect(getChildEnvGitIdentity()).toBeNull();
  });
});

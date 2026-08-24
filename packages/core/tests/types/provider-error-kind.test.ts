import { describe, expect, it } from 'vitest';
import {
  ProviderError,
  StreamHangError,
  classifyProviderError,
  isContextOverflowShaped,
  isRetryableKind,
} from '../../src/types/provider.js';
import { ERROR_CODES } from '../../src/types/errors.js';

describe('ProviderError.isProviderError', () => {
  it('returns true for a genuine ProviderError', () => {
    const err = new ProviderError('test', 429, true, 'anthropic');
    expect(ProviderError.isProviderError(err)).toBe(true);
  });

  it('returns true for a duck-type-compatible object', () => {
    const err = {
      name: 'ProviderError',
      status: 502,
      retryable: true,
      kind: 'server',
      message: 'upstream gateway error',
      describe: () => 'provider server error',
    };
    expect(ProviderError.isProviderError(err)).toBe(true);
  });

  it('returns false for a lookalike missing the describe method used by the runner', () => {
    expect(
      ProviderError.isProviderError({
        name: 'ProviderError',
        status: 502,
        retryable: true,
        kind: 'server',
        message: 'upstream gateway error',
      }),
    ).toBe(false);
  });

  it('returns false for a plain Error', () => {
    expect(ProviderError.isProviderError(new Error('boom'))).toBe(false);
  });

  it('returns false for null and undefined', () => {
    expect(ProviderError.isProviderError(null)).toBe(false);
    expect(ProviderError.isProviderError(undefined)).toBe(false);
  });

  it('returns false for a plain object missing required fields', () => {
    expect(ProviderError.isProviderError({ name: 'ProviderError', status: 502 })).toBe(false);
  });

  it('returns false for a StreamHangError (subclass) since all fields match', () => {
    const hang = new StreamHangError({
      providerId: 'anthropic',
      model: 'claude-opus-4',
      hangTimeoutMs: 60_000,
      bytesReceived: 0,
      elapsedMs: 60_000,
    });
    // Subclass inherits the name and fields, so the duck-type check should pass
    expect(ProviderError.isProviderError(hang)).toBe(true);
  });
});

describe('classifyProviderError', () => {
  it('classifies by status code', () => {
    expect(classifyProviderError(0)).toBe('network');
    expect(classifyProviderError(408)).toBe('timeout');
    expect(classifyProviderError(429)).toBe('rate_limit');
    expect(classifyProviderError(529)).toBe('overloaded');
    expect(classifyProviderError(500)).toBe('server');
    expect(classifyProviderError(503)).toBe('server');
    expect(classifyProviderError(599)).toBe('stream_hang');
    expect(classifyProviderError(401)).toBe('auth');
    expect(classifyProviderError(403)).toBe('auth'); // plain 403 = permission denied, not quota
    expect(classifyProviderError(413)).toBe('context_overflow');
    expect(classifyProviderError(400)).toBe('invalid_request');
    expect(classifyProviderError(404)).toBe('invalid_request');
  });

  it('lets provider body.type override an ambiguous status', () => {
    // Anthropic sometimes wraps overload in a 503; rate limits in odd statuses
    expect(classifyProviderError(400, { type: 'rate_limit_error' })).toBe('rate_limit');
    expect(classifyProviderError(400, { type: 'overloaded_error' })).toBe('overloaded');
    expect(classifyProviderError(400, { type: 'authentication_error' })).toBe('auth');
    expect(classifyProviderError(400, { type: 'permission_error' })).toBe('auth');
  });

  it('classifies 403 with quota-usage message as quota_exhausted, not auth', () => {
    // Chinese providers (Kimi, Z.AI, Moonshot) return 403 instead of 402 for
    // billing-cycle quota exhaustion. The message text must route to quota_exhausted
    // so the tracker applies the 15-minute block instead of a 5-minute auth delay.
    expect(
      classifyProviderError(403, undefined, 'You\'ve reached your usage limit for this billing cycle'),
    ).toBe('quota_exhausted');

    expect(
      classifyProviderError(403, undefined, 'Usage limit reached. Quota will refresh in the next cycle'),
    ).toBe('quota_exhausted');

    // Bare 403 (no quota signal in message) = permission/auth denial — not quota.
    expect(classifyProviderError(403)).toBe('auth');
    expect(classifyProviderError(403, undefined, 'Access denied')).toBe('auth');
  });

  it('prefers an explicit transient rate-limit code over ambiguous message prose', () => {
    expect(
      classifyProviderError(429, {
        type: 'rate_limit_exceeded',
        message: 'Rate limit exceeded',
      }),
    ).toBe('rate_limit');
  });

  it('detects more overflow phrasings on 4xx', () => {
    expect(classifyProviderError(400, undefined, 'too many tokens in the request')).toBe(
      'context_overflow',
    );
    expect(classifyProviderError(400, undefined, 'please reduce the length of your messages')).toBe(
      'context_overflow',
    );
    expect(classifyProviderError(400, undefined, 'your input is too large')).toBe(
      'context_overflow',
    );
    expect(
      classifyProviderError(400, undefined, 'your messages resulted in 130000 tokens'),
    ).toBe('context_overflow');
  });

  it('does not classify unrelated generic too-long validation errors as context overflow', () => {
    expect(classifyProviderError(400, undefined, 'tool name is too long')).toBe('invalid_request');
    expect(classifyProviderError(400, undefined, 'metadata field too long')).toBe('invalid_request');
  });

  it('detects context overflow from message shapes on 4xx', () => {
    expect(classifyProviderError(400, { message: 'prompt is too long: 250000 tokens' })).toBe(
      'context_overflow',
    );
    expect(
      classifyProviderError(400, {
        message: "This model's maximum context length is 128000 tokens",
      }),
    ).toBe('context_overflow');
    expect(classifyProviderError(400, undefined, 'context length exceeded')).toBe(
      'context_overflow',
    );
    // ... but NOT on 5xx (server error wins) and not without an overflow-shaped message
    expect(classifyProviderError(500, { message: 'context length exceeded' })).toBe('server');
    expect(classifyProviderError(400, { message: 'bad temperature value' })).toBe(
      'invalid_request',
    );
  });

  it('detects content-filter refusals', () => {
    expect(classifyProviderError(400, { type: 'content_filter' })).toBe('content_filter');
    expect(
      classifyProviderError(400, { message: 'The response was filtered due to content policy' }),
    ).toBe('content_filter');
  });
});

describe('isRetryableKind', () => {
  it('marks capacity/transport failures retryable, request failures not', () => {
    expect(isRetryableKind('rate_limit')).toBe(true);
    expect(isRetryableKind('overloaded')).toBe(true);
    expect(isRetryableKind('server')).toBe(true);
    expect(isRetryableKind('timeout')).toBe(true);
    expect(isRetryableKind('network')).toBe(true);
    expect(isRetryableKind('stream_hang')).toBe(true);
    expect(isRetryableKind('auth')).toBe(false);
    expect(isRetryableKind('invalid_request')).toBe(false);
    expect(isRetryableKind('context_overflow')).toBe(false);
    expect(isRetryableKind('content_filter')).toBe(false);
    expect(isRetryableKind('unknown')).toBe(false);
  });
});

describe('ProviderError.kind', () => {
  it('is computed at construction from status + body + message', () => {
    expect(new ProviderError('x', 429, true, 'p').kind).toBe('rate_limit');
    expect(new ProviderError('prompt is too long', 400, false, 'p').kind).toBe('context_overflow');
  });

  it('honours an explicit kind override', () => {
    const err = new ProviderError('x', 400, false, 'p', { kind: 'content_filter' });
    expect(err.kind).toBe('content_filter');
  });

  it('drives the WrongStackError code', () => {
    expect(new ProviderError('x', 429, true, 'p').code).toBe(ERROR_CODES.PROVIDER_RATE_LIMITED);
    expect(new ProviderError('x', 403, false, 'p').code).toBe(ERROR_CODES.PROVIDER_AUTH_FAILED);
    expect(new ProviderError('prompt is too long', 400, false, 'p').code).toBe(
      ERROR_CODES.PROVIDER_CONTEXT_OVERFLOW,
    );
  });

  it('StreamHangError classifies as stream_hang via its 599 sentinel', () => {
    const err = new StreamHangError({
      providerId: 'p',
      model: 'm',
      hangTimeoutMs: 1000,
      bytesReceived: 10,
      elapsedMs: 1200,
    });
    expect(err.kind).toBe('stream_hang');
    expect(isRetryableKind(err.kind)).toBe(true);
  });
});

describe('ProviderError.describe — new kind labels', () => {
  it('labels 599 as a stream hang, not a generic server error', () => {
    const err = new StreamHangError({
      providerId: 'zai',
      model: 'm',
      hangTimeoutMs: 1000,
      bytesReceived: 10,
      elapsedMs: 1200,
    });
    expect(err.describe()).toContain('zai stream hang (599)');
  });

  it('labels content_filter bodies as content filtered', () => {
    const err = new ProviderError('x', 400, false, 'azure', {
      body: { type: 'content_filter', message: 'The response was filtered' },
    });
    expect(err.describe()).toBe('azure content filtered (400): The response was filtered');
  });
});

describe('isContextOverflowShaped', () => {
  it('is true for a cleanly-classified context_overflow', () => {
    const err = new ProviderError('prompt is too long', 413, false, 'anthropic');
    expect(err.kind).toBe('context_overflow');
    expect(isContextOverflowShaped(err)).toBe(true);
  });

  it('is true for an overflow mislabeled as invalid_request by a gateway', () => {
    // A gateway forces kind=invalid_request but the message is clearly an overflow.
    const err = new ProviderError(
      'This request exceeds the context window: 200000 tokens',
      400,
      false,
      'gateway',
      { kind: 'invalid_request' },
    );
    expect(err.kind).toBe('invalid_request'); // mislabeled
    expect(isContextOverflowShaped(err)).toBe(true); // but shape is detected
  });

  it('is true for the Codex agent-run overflow phrasing under a mislabeled kind', () => {
    const err = new ProviderError(
      'Failed [error]: AGENT_RUN_FAILED: Your input exceeds the context window of this model. Please adjust your input and try again.',
      400,
      false,
      'openai-codex',
      { kind: 'invalid_request' },
    );
    expect(err.kind).toBe('invalid_request');
    expect(isContextOverflowShaped(err)).toBe(true);
  });

  it('is true for a bare 413 regardless of message', () => {
    const err = new ProviderError('Request Entity Too Large', 413, false, 'proxy', {
      kind: 'invalid_request',
    });
    expect(isContextOverflowShaped(err)).toBe(true);
  });

  it('is false for a genuine invalid_request and for non-ProviderErrors', () => {
    const err = new ProviderError('messages.0.role is invalid', 400, false, 'anthropic');
    expect(isContextOverflowShaped(err)).toBe(false);
    expect(isContextOverflowShaped(new Error('boom'))).toBe(false);
    expect(isContextOverflowShaped(undefined)).toBe(false);
  });
});

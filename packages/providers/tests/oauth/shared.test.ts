/**
 * Tests for shared OAuth primitives — IO-free utilities.
 *
 * Coverage targets:
 * - generatePkce creates verifier + challenge pair
 * - createState generates unique state strings
 * - parseAuthorizationInput handles various URL formats
 * - callbackHtml requires ok + message parameters
 */
import { describe, expect, it } from 'vitest';
import {
  generatePkce,
  createState,
  parseAuthorizationInput,
  callbackHtml,
} from '../../src/oauth/shared.js';

describe('generatePkce', () => {
  it('returns a verifier and challenge pair', () => {
    const result = generatePkce();
    expect(result).toHaveProperty('verifier');
    expect(result).toHaveProperty('challenge');
    expect(result.verifier.length).toBeGreaterThan(0);
    expect(result.challenge.length).toBeGreaterThan(0);
  });

  it('generates unique verifiers on each call', () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });

  it('produces a base64url-encoded challenge (no padding)', () => {
    const result = generatePkce();
    expect(result.challenge).not.toContain('=');
    expect(result.challenge).not.toContain('+');
    expect(result.challenge).not.toContain('/');
  });
});

describe('createState', () => {
  it('returns a non-empty hex-like string', () => {
    const state = createState();
    expect(state).toBeDefined();
    expect(typeof state).toBe('string');
    expect(state.length).toBeGreaterThan(0);
  });

  it('returns unique states on each call', () => {
    const a = createState();
    const b = createState();
    expect(a).not.toBe(b);
  });
});

describe('callbackHtml', () => {
  it('returns success HTML when ok is true', () => {
    const html = callbackHtml(true, 'Login complete');
    expect(html.toLowerCase()).toContain('successful');
  });

  it('returns failure HTML when ok is false', () => {
    const html = callbackHtml(false, 'Error occurred');
    expect(html.toLowerCase()).toContain('failed');
  });

  it('includes the message in the HTML', () => {
    const html = callbackHtml(true, 'All good');
    expect(html).toContain('All good');
  });
});

describe('parseAuthorizationInput', () => {
  it('extracts code and state from a standard callback URL', () => {
    const result = parseAuthorizationInput(
      'http://localhost:53692/callback?code=abc123&state=xyz789',
    );
    expect(result).toEqual({
      code: 'abc123',
      state: 'xyz789',
    });
  });

  it('handles a bare code#state string', () => {
    const result = parseAuthorizationInput('abc123#xyz789');
    expect(result.code).toBe('abc123');
    expect(result.state).toBe('xyz789');
  });

  it('returns undefined fields for an empty URL', () => {
    const result = parseAuthorizationInput('');
    expect(result).toEqual({});
  });

  it('handles a query-string fragment', () => {
    const result = parseAuthorizationInput('code=def456&state=state123');
    expect(result.code).toBe('def456');
    expect(result.state).toBe('state123');
  });

  it('returns the input as code when it is a bare value', () => {
    const result = parseAuthorizationInput('bare-code-value');
    expect(result.code).toBe('bare-code-value');
    expect(result.state).toBeUndefined();
  });
});

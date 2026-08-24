/**
 * Unit tests for the WrongProxy / WrongTrace base-URL rewriter.
 *
 * The rewriter is pure logic — no I/O, no timers, no side effects. These
 * tests pin the runtime contract:
 *
 *   rewriteBaseUrl(originalBaseUrl, proxyUrl) | → | description |
 *   ----------------------------------------+---+------------------------------|
 *   undefined                              | undefined | missing input → undefined |
 *   "https://api.openai.com/v1"            | undefined | no proxy → original |
 *   "https://api.openai.com/v1"            | ""        | no proxy → original |
 *   "https://api.openai.com/v1"            | "http://x" | rewrite happy path |
 *   "http://x/proxy/api.openai.com/v1"     | "http://x" | double-wrap guard |
 *   "not a url"                            | "http://x" | malformed → original |
 *   "https://api.openai.com/v1"            | "no-scheme" | malformed proxy → original |
 *   "https://api.openai.com/v1?q=1#h"      | "http://x" | query + hash preserved |
 *
 * `isProxyEligible` pins the openai-codex exclusion (the OAuth-only
 * provider whose token audience forbids generic proxying).
 *
 * `shouldRewriteFor` centralizes the "enabled + active + url + eligible"
 * rule so future call sites can't accidentally skip a check.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyProxyConfig,
  getProxyConfig,
  isProxyEligible,
  PROXY_EXCLUDED_PROVIDERS,
  rewriteBaseUrl,
  shouldRewriteFor,
  __resetProxyConfigForTests,
} from '../../src/wiring/proxy-rewrite.js';

describe('rewriteBaseUrl', () => {
  it('returns undefined when the original URL is missing', () => {
    expect(rewriteBaseUrl(undefined, 'http://localhost:8000')).toBeUndefined();
    expect(rewriteBaseUrl('', 'http://localhost:8000')).toBeUndefined();
  });

  it('returns the original when the proxy URL is missing', () => {
    expect(rewriteBaseUrl('https://api.openai.com/v1', undefined)).toBe(
      'https://api.openai.com/v1',
    );
    expect(rewriteBaseUrl('https://api.openai.com/v1', '')).toBe(
      'https://api.openai.com/v1',
    );
  });

  it('rewrites a standard base URL through the proxy', () => {
    expect(rewriteBaseUrl('https://api.openai.com/v1', 'http://localhost:8000')).toBe(
      'http://localhost:8000/proxy/api.openai.com/v1',
    );
  });

  it('strips trailing slashes from the proxy URL', () => {
    expect(rewriteBaseUrl('https://api.openai.com/v1', 'http://localhost:8000/')).toBe(
      'http://localhost:8000/proxy/api.openai.com/v1',
    );
    expect(rewriteBaseUrl('https://api.openai.com/v1', 'http://localhost:8000///')).toBe(
      'http://localhost:8000/proxy/api.openai.com/v1',
    );
  });

  it('preserves query string and hash on the rewritten URL', () => {
    expect(rewriteBaseUrl('https://api.openai.com/v1?q=1#hash', 'http://x')).toBe(
      'http://x/proxy/api.openai.com/v1?q=1#hash',
    );
  });

  it('does NOT double-wrap when the original already starts with the proxy path', () => {
    expect(rewriteBaseUrl('http://localhost:8000/proxy/api.openai.com/v1', 'http://localhost:8000')).toBe(
      'http://localhost:8000/proxy/api.openai.com/v1',
    );
  });

  it('returns the original when the original is malformed', () => {
    expect(rewriteBaseUrl('not a url', 'http://localhost:8000')).toBe('not a url');
  });

  it('returns the original when the proxy URL is malformed', () => {
    expect(rewriteBaseUrl('https://api.openai.com/v1', 'no-scheme')).toBe(
      'https://api.openai.com/v1',
    );
  });
});

describe('isProxyEligible', () => {
  it('excludes openai-codex (OAuth-bound token audience)', () => {
    expect(isProxyEligible('openai-codex')).toBe(false);
    expect(PROXY_EXCLUDED_PROVIDERS.has('openai-codex')).toBe(true);
  });

  it('eligible providers pass through', () => {
    expect(isProxyEligible('openai')).toBe(true);
    expect(isProxyEligible('anthropic')).toBe(true);
    expect(isProxyEligible('google')).toBe(true);
    expect(isProxyEligible('openai-compatible')).toBe(true);
    expect(isProxyEligible('my-custom-saved-config-alias')).toBe(true);
  });

  it('rejects empty / missing provider ids', () => {
    expect(isProxyEligible('')).toBe(false);
  });
});

describe('shouldRewriteFor', () => {
  beforeEach(() => __resetProxyConfigForTests());
  afterEach(() => __resetProxyConfigForTests());

  it('returns false when the toggle is off', () => {
    applyProxyConfig({ enabled: false, url: 'http://localhost:8000', active: true });
    expect(shouldRewriteFor('openai')).toBe(false);
  });

  it('returns false when the proxy URL is missing', () => {
    applyProxyConfig({ enabled: true, url: '', active: true });
    expect(shouldRewriteFor('openai')).toBe(false);
  });

  it('returns false when the daemon is not active', () => {
    applyProxyConfig({ enabled: true, url: 'http://localhost:8000', active: false });
    expect(shouldRewriteFor('openai')).toBe(false);
  });

  it('returns false for openai-codex even when everything else is on', () => {
    applyProxyConfig({ enabled: true, url: 'http://localhost:8000', active: true });
    expect(shouldRewriteFor('openai-codex')).toBe(false);
  });

  it('returns true only when all four guards pass', () => {
    applyProxyConfig({ enabled: true, url: 'http://localhost:8000', active: true });
    expect(shouldRewriteFor('openai')).toBe(true);
    expect(shouldRewriteFor('anthropic')).toBe(true);
  });
});

describe('applyProxyConfig / getProxyConfig', () => {
  beforeEach(() => __resetProxyConfigForTests());
  afterEach(() => __resetProxyConfigForTests());

  it('applies a partial patch without dropping siblings', () => {
    applyProxyConfig({ enabled: true, url: 'http://a', active: true });
    expect(getProxyConfig()).toEqual({ enabled: true, url: 'http://a', active: true });
    applyProxyConfig({ url: 'http://b' });
    expect(getProxyConfig()).toEqual({ enabled: true, url: 'http://b', active: true });
    applyProxyConfig({ active: false });
    expect(getProxyConfig()).toEqual({ enabled: true, url: 'http://b', active: false });
  });
});
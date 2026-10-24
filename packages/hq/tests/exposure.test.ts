import { describe, expect, it } from 'vitest';
import { assessHqExposure, isLoopbackHost, isOpenMode } from '../src/exposure.js';

describe('isLoopbackHost', () => {
  it('accepts the usual loopback spellings', () => {
    for (const host of ['127.0.0.1', 'localhost', 'LOCALHOST', '::1', '[::1]', ' 127.0.0.1 ']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it('accepts the whole 127.0.0.0/8 block, not just .1', () => {
    expect(isLoopbackHost('127.0.0.2')).toBe(true);
    expect(isLoopbackHost('127.42.7.9')).toBe(true);
  });

  it('rejects network-reachable hosts', () => {
    for (const host of ['0.0.0.0', '192.168.1.10', '10.0.0.4', '::', 'hq.example.com']) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it('does not treat a look-alike prefix as loopback', () => {
    // 127.0.0.1.example.com is a hostname, not the loopback block.
    expect(isLoopbackHost('127.0.0.1.example.com')).toBe(false);
    expect(isLoopbackHost('1270.0.0.1')).toBe(false);
  });
});

describe('isOpenMode', () => {
  it('is open only when neither a token nor a password is configured', () => {
    expect(isOpenMode({ hasBrowserTokens: false, hasPassword: false })).toBe(true);
    expect(isOpenMode({ hasBrowserTokens: true, hasPassword: false })).toBe(false);
    expect(isOpenMode({ hasBrowserTokens: false, hasPassword: true })).toBe(false);
  });
});

describe('assessHqExposure', () => {
  it('says nothing when bound to loopback, even in open mode', () => {
    expect(
      assessHqExposure({ host: '127.0.0.1', hasBrowserTokens: false, hasPassword: false }),
    ).toEqual({ kind: 'ok' });
  });

  it('refuses an open-mode bind to all interfaces', () => {
    const verdict = assessHqExposure({
      host: '0.0.0.0',
      hasBrowserTokens: false,
      hasPassword: false,
    });
    expect(verdict.kind).toBe('refuse');
    if (verdict.kind !== 'refuse') throw new Error('expected refuse');
    // The remedies are the whole point of the message.
    expect(verdict.message).toContain('--host 127.0.0.1');
    expect(verdict.message).toContain('hq token create');
    expect(verdict.message).toContain('--insecure-open');
  });

  it('downgrades the refusal to a warning when the operator opts in', () => {
    const verdict = assessHqExposure({
      host: '0.0.0.0',
      hasBrowserTokens: false,
      hasPassword: false,
      allowInsecure: true,
    });
    expect(verdict.kind).toBe('warn');
  });

  it('still warns about cleartext when a non-loopback bind is authenticated', () => {
    const verdict = assessHqExposure({
      host: '0.0.0.0',
      hasBrowserTokens: true,
      hasPassword: false,
    });
    expect(verdict.kind).toBe('warn');
    if (verdict.kind !== 'warn') throw new Error('expected warn');
    expect(verdict.message).toContain('cleartext');
  });

  it('treats a password alone as authenticated', () => {
    expect(
      assessHqExposure({ host: '0.0.0.0', hasBrowserTokens: false, hasPassword: true }).kind,
    ).toBe('warn');
  });

  it('never refuses a loopback bind regardless of the opt-in flag', () => {
    expect(
      assessHqExposure({
        host: 'localhost',
        hasBrowserTokens: false,
        hasPassword: false,
        allowInsecure: false,
      }).kind,
    ).toBe('ok');
  });
});

// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  compactTokens,
  messageId,
  payloadText,
  payloadSucceeded,
  isIncomingMailboxPayload,
} from '../src/simple-ui-session.js';

describe('simple-ui-session helpers', () => {
  describe('compactTokens', () => {
    it('returns "0" for zero', () => {
      expect(compactTokens(0)).toBe('0');
    });
    it('returns "0" for NaN', () => {
      expect(compactTokens(NaN)).toBe('0');
    });
    it('returns raw number below 1000', () => {
      expect(compactTokens(42)).toBe('42');
      expect(compactTokens(999)).toBe('999');
    });
    it('returns k format for thousands', () => {
      expect(compactTokens(1000)).toBe('1.0k');
      expect(compactTokens(15000)).toBe('15.0k');
    });
    it('returns integer k for large thousands', () => {
      expect(compactTokens(100000)).toBe('100k');
    });
    it('returns m format for millions', () => {
      expect(compactTokens(1_000_000)).toBe('1.0m');
      expect(compactTokens(2_500_000)).toBe('2.5m');
    });
    it('handles fractional values', () => {
      expect(compactTokens(1234)).toBe('1.2k');
    });
  });

  describe('messageId', () => {
    it('prefixes with the given prefix', () => {
      const id = messageId('mail');
      expect(id.startsWith('mail-')).toBe(true);
    });
    it('generates unique ids', () => {
      const id1 = messageId('test');
      const id2 = messageId('test');
      expect(id1).not.toBe(id2);
    });
  });

  describe('payloadText', () => {
    it('returns string value when present', () => {
      expect(payloadText({ key: 'hello' }, 'key')).toBe('hello');
    });
    it('returns empty string for non-string value', () => {
      expect(payloadText({ key: 42 }, 'key')).toBe('');
      expect(payloadText({ key: null }, 'key')).toBe('');
      expect(payloadText({ key: undefined }, 'key')).toBe('');
    });
    it('returns empty string for missing key', () => {
      expect(payloadText({}, 'missing')).toBe('');
    });
    it('returns empty string for undefined payload', () => {
      expect(payloadText(undefined, 'key')).toBe('');
    });
  });

  describe('payloadSucceeded', () => {
    it('returns true when success is exactly true', () => {
      expect(payloadSucceeded({ success: true })).toBe(true);
    });
    it('returns false when success is false', () => {
      expect(payloadSucceeded({ success: false })).toBe(false);
    });
    it('returns false when success is missing', () => {
      expect(payloadSucceeded({})).toBe(false);
    });
    it('returns false for undefined payload', () => {
      expect(payloadSucceeded(undefined)).toBe(false);
    });
    it('returns false for truthy non-boolean', () => {
      expect(payloadSucceeded({ success: 'yes' })).toBe(false);
      expect(payloadSucceeded({ success: 1 })).toBe(false);
    });
  });

  describe('isIncomingMailboxPayload', () => {
    it('returns true for a normal incoming message', () => {
      expect(isIncomingMailboxPayload({ from: 'worker@one', to: 'leader' })).toBe(true);
    });
    it('returns false for empty from', () => {
      expect(isIncomingMailboxPayload({ from: '', to: 'leader' })).toBe(false);
    });
    it('returns false when from is webui (self)', () => {
      expect(isIncomingMailboxPayload({ from: 'webui', to: 'leader' })).toBe(false);
    });
    it('returns false when from is simpleui (self)', () => {
      expect(isIncomingMailboxPayload({ from: 'simpleui', to: 'leader' })).toBe(false);
    });
    it('returns false for undefined payload', () => {
      expect(isIncomingMailboxPayload(undefined)).toBe(false);
    });
    it('returns false when from is missing', () => {
      expect(isIncomingMailboxPayload({ to: 'leader' })).toBe(false);
    });
  });
});

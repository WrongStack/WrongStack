import { describe, expect, it } from 'vitest';
import { normalizeAnthropic, normalizeGemini, normalizeOpenAI } from '../src/stop-reason.js';

describe('stop-reason', () => {
  describe('normalizeAnthropic', () => {
    it('maps end_turn', () => expect(normalizeAnthropic('end_turn')).toBe('end_turn'));
    it('maps tool_use', () => expect(normalizeAnthropic('tool_use')).toBe('tool_use'));
    it('maps max_tokens', () => expect(normalizeAnthropic('max_tokens')).toBe('max_tokens'));
    it('maps stop_sequence', () =>
      expect(normalizeAnthropic('stop_sequence')).toBe('stop_sequence'));
    it('maps refusal', () => expect(normalizeAnthropic('refusal')).toBe('refusal'));
    it('unknown value falls back to end_turn', () => {
      expect(normalizeAnthropic('bogus')).toBe('end_turn');
      expect(normalizeAnthropic(null)).toBe('end_turn');
      expect(normalizeAnthropic(undefined)).toBe('end_turn');
    });
  });

  describe('normalizeOpenAI', () => {
    it('maps stop to end_turn', () => expect(normalizeOpenAI('stop')).toBe('end_turn'));
    it('maps tool_calls to tool_use', () => expect(normalizeOpenAI('tool_calls')).toBe('tool_use'));
    it('maps function_call to tool_use', () =>
      expect(normalizeOpenAI('function_call')).toBe('tool_use'));
    it('maps length to max_tokens', () => expect(normalizeOpenAI('length')).toBe('max_tokens'));
    it('maps content_filter to refusal', () =>
      expect(normalizeOpenAI('content_filter')).toBe('refusal'));
    it('unknown value falls back to end_turn', () => {
      expect(normalizeOpenAI('unknown')).toBe('end_turn');
      expect(normalizeOpenAI(null)).toBe('end_turn');
      expect(normalizeOpenAI(undefined)).toBe('end_turn');
    });
  });

  describe('normalizeGemini', () => {
    it('maps SAFETY to refusal', () => expect(normalizeGemini('SAFETY')).toBe('refusal'));
    it('maps RECITATION to refusal', () => expect(normalizeGemini('RECITATION')).toBe('refusal'));
    it('maps BLOCKLIST to refusal', () => expect(normalizeGemini('BLOCKLIST')).toBe('refusal'));
    it('maps PROHIBITED_CONTENT to refusal', () =>
      expect(normalizeGemini('PROHIBITED_CONTENT')).toBe('refusal'));
    it('maps SPII to refusal', () => expect(normalizeGemini('SPII')).toBe('refusal'));
    it('maps MALICIOUS to refusal', () => expect(normalizeGemini('MALICIOUS')).toBe('refusal'));
    it('maps hallucination to refusal', () =>
      expect(normalizeGemini('hallucination')).toBe('refusal'));
    it('maps stop / STOP to end_turn', () => {
      expect(normalizeGemini('stop')).toBe('end_turn');
      expect(normalizeGemini('STOP')).toBe('end_turn');
    });
    it('maps max_tokens / MAX_TOKENS to max_tokens', () => {
      expect(normalizeGemini('max_tokens')).toBe('max_tokens');
      expect(normalizeGemini('MAX_TOKENS')).toBe('max_tokens');
    });
    it('maps tool_use / TOOL_USE to tool_use', () => {
      expect(normalizeGemini('tool_use')).toBe('tool_use');
      expect(normalizeGemini('TOOL_USE')).toBe('tool_use');
    });
    it('unknown value falls back to end_turn', () => {
      expect(normalizeGemini('other')).toBe('end_turn');
      expect(normalizeGemini(null)).toBe('end_turn');
      expect(normalizeGemini(undefined)).toBe('end_turn');
    });
  });
});

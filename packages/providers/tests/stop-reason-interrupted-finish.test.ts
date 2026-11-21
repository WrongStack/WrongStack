import { describe, expect, it } from 'vitest';
import { normalizeGemini, normalizeOpenAI } from '../src/stop-reason.js';

describe('stop-reason: interrupted and image-safety finish reasons', () => {
  // DeepSeek documents two finish reasons for a generation that was cut short
  // (https://api-docs.deepseek.com/api/create-chat-completion). Reading them as
  // `end_turn` committed an interrupted reply as a finished turn.
  it.each(['insufficient_system_resource', 'aborted'])(
    'maps DeepSeek %s to max_tokens, not end_turn',
    (reason) => {
      expect(normalizeOpenAI(reason)).toBe('max_tokens');
    },
  );

  // Gemini's image-modality safety stops are the twins of SAFETY /
  // PROHIBITED_CONTENT / RECITATION and must not silently become end_turn.
  it.each(['IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION'])(
    'maps Gemini %s to refusal',
    (reason) => {
      expect(normalizeGemini(reason)).toBe('refusal');
    },
  );
});

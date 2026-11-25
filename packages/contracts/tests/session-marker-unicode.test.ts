import { describe, expect, it } from 'vitest';
import { sessionEventToMarker } from '../src/types/session-markers.js';

const hasLoneSurrogate = (value: string): boolean =>
  [...value].some((character) => character.length === 1 && /[\uD800-\uDFFF]/u.test(character));

describe('session marker Unicode boundaries', () => {
  it('keeps checkpoint previews well-formed', () => {
    const marker = sessionEventToMarker({
      type: 'checkpoint',
      ts: 'x',
      promptIndex: 1,
      promptPreview: `${'a'.repeat(59)}😀tail`,
    });
    expect(hasLoneSurrogate(marker?.text ?? '')).toBe(false);
  });

  it('keeps delegation task previews well-formed', () => {
    const marker = sessionEventToMarker({
      type: 'delegate_started',
      ts: 'x',
      subagentId: 's',
      target: 'agent',
      task: `${'a'.repeat(98)}😀tail`,
    });
    expect(hasLoneSurrogate(marker?.text ?? '')).toBe(false);
  });

  it('keeps agent error previews well-formed', () => {
    const marker = sessionEventToMarker({
      type: 'agent_error',
      ts: 'x',
      agentId: 'a',
      error: `${'a'.repeat(79)}😀tail`,
    });
    expect(hasLoneSurrogate(marker?.text ?? '')).toBe(false);
  });

  it('normalizes non-finite compaction token counts', () => {
    const marker = sessionEventToMarker({
      type: 'compaction',
      ts: 'x',
      before: Number.NaN,
      after: Number.POSITIVE_INFINITY,
    });
    expect(marker?.text).toContain('0K → 0K');
  });

  it('normalizes non-finite provider retry delays', () => {
    const marker = sessionEventToMarker({
      type: 'provider_retry',
      ts: 'x',
      providerId: 'test-provider',
      delayMs: Number.NaN,
      attempt: 1,
      description: 'retry',
    });
    expect(marker?.text).toContain('0.00s');
  });

  it('omits non-finite delegation costs', () => {
    const marker = sessionEventToMarker({
      type: 'delegate_completed',
      ts: 'x',
      subagentId: 's',
      target: 'a',
      task: 't',
      ok: true,
      summary: 'done',
      durationMs: 1,
      iterations: 1,
      toolCalls: 1,
      costUsd: Number.POSITIVE_INFINITY,
    });
    expect(marker?.text).not.toContain('$');
  });
});

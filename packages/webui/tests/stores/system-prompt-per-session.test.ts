import { beforeEach, describe, expect, it } from 'vitest';
import { handleSystemPromptInfo } from '../../src/hooks/ws-handlers/misc-handlers';
import { systemPromptCurrent, useSystemPromptStore } from '../../src/stores/system-prompt-store';
import type { WSServerMessage, WSSystemPromptVariantInfo } from '../../src/types';

/**
 * The identity-prompt CATALOGUE is a project fact; the chosen variant is not.
 *
 * `systemPromptVariant` is session-scoped on the server — it lives on each
 * conversation's own meta and is applied when that conversation's prompt is
 * rebuilt. The browser folded every `system_prompt.info` into one `current`,
 * so the picker in tab 3 reported tab 1's size, and confirming it re-sent a
 * variant the user had not chosen for that tab. The catalogue is still shared;
 * only `current` moved per tab.
 */

const variants: WSSystemPromptVariantInfo[] = [
  { variant: 'lite', label: 'Lite', tokens: 100 },
  { variant: 'default', label: 'Standard', tokens: 400 },
  { variant: 'pro', label: 'Pro', tokens: 900 },
] as unknown as WSSystemPromptVariantInfo[];

const info = (current: string, sessionId?: string): WSServerMessage =>
  ({
    type: 'system_prompt.info',
    payload: { current, chosen: true, variants, ...(sessionId ? { sessionId } : {}) },
  }) as unknown as WSServerMessage;

beforeEach(() => {
  useSystemPromptStore.setState({ info: null, currentBySession: {} });
});

describe('the live identity variant is per tab', () => {
  it('files each tab’s variant under its own session', () => {
    handleSystemPromptInfo(info('pro', 'tab-a'));
    handleSystemPromptInfo(info('lite', 'tab-b'));

    const s = useSystemPromptStore.getState();
    expect(systemPromptCurrent(s, 'tab-a')).toBe('pro');
    expect(systemPromptCurrent(s, 'tab-b')).toBe('lite');
  });

  it('keeps the shared catalogue whichever tab answered', () => {
    handleSystemPromptInfo(info('pro', 'tab-a'));

    // Variants and their token costs come from the project's own instruction
    // files — the same for every tab, so one reply seeds them all.
    expect(useSystemPromptStore.getState().info?.variants).toHaveLength(3);
  });

  it('falls back to the last reply for a tab that has never been answered for', () => {
    handleSystemPromptInfo(info('lite', 'tab-a'));

    // A single-session host and the first reply after connect are both
    // unstamped; a brand-new tab has nothing of its own yet.
    expect(systemPromptCurrent(useSystemPromptStore.getState(), 'tab-new')).toBe('lite');
  });

  it('accepts an unstamped reply without pinning it to a session', () => {
    handleSystemPromptInfo(info('pro'));

    const s = useSystemPromptStore.getState();
    expect(s.currentBySession).toEqual({});
    expect(systemPromptCurrent(s, null)).toBe('pro');
  });

  it('forgets a closed tab’s variant', () => {
    handleSystemPromptInfo(info('pro', 'tab-a'));
    useSystemPromptStore.getState().dropSession('tab-a');

    expect(useSystemPromptStore.getState().currentBySession).toEqual({});
  });

  it('ignores a malformed payload rather than blanking the catalogue', () => {
    handleSystemPromptInfo(info('pro', 'tab-a'));
    handleSystemPromptInfo({
      type: 'system_prompt.info',
      payload: { current: 'lite', sessionId: 'tab-a' },
    } as unknown as WSServerMessage);

    expect(systemPromptCurrent(useSystemPromptStore.getState(), 'tab-a')).toBe('pro');
  });
});

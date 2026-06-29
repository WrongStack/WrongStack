/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearAnalyticsQueue,
  clearReferralClick,
  getAnalyticsQueue,
  getReferralClick,
  recordReferralClick,
  trackReferralConversion,
} from '../../src/lib/analytics';

describe('referral click tracking', () => {
  beforeEach(() => {
    clearAnalyticsQueue();
    clearReferralClick();
  });

  it('records a referral click in sessionStorage', () => {
    recordReferralClick({
      providerId: 'minimax',
      providerName: 'MiniMax',
      referralCode: 'ABC123',
      clickedAt: '2026-06-29T12:00:00Z',
      docsUrl: 'https://platform.minimax.io/',
    });

    const click = getReferralClick();
    expect(click).not.toBeNull();
    expect(click!.providerId).toBe('minimax');
    expect(click!.providerName).toBe('MiniMax');
    expect(click!.referralCode).toBe('ABC123');
  });

  it('emits a referral_link_clicked analytics event', () => {
    recordReferralClick({
      providerId: 'minimax',
      providerName: 'MiniMax',
      referralCode: 'ABC123',
      clickedAt: '2026-06-29T12:00:00Z',
      docsUrl: 'https://platform.minimax.io/',
    });

    const events = getAnalyticsQueue();
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe('referral_link_clicked');
    expect(events[0]!.category).toBe('engagement');
    expect(events[0]!.metadata).toMatchObject({
      providerId: 'minimax',
      referralCode: 'ABC123',
      docsUrl: 'https://platform.minimax.io/',
    });
  });

  it('clears the referral click', () => {
    recordReferralClick({
      providerId: 'minimax',
      providerName: 'MiniMax',
      referralCode: 'ABC123',
      clickedAt: '2026-06-29T12:00:00Z',
      docsUrl: 'https://platform.minimax.io/',
    });

    expect(getReferralClick()).not.toBeNull();
    clearReferralClick();
    expect(getReferralClick()).toBeNull();
  });

  it('tracks conversion when click matches provider', () => {
    recordReferralClick({
      providerId: 'minimax',
      providerName: 'MiniMax',
      referralCode: 'ABC123',
      clickedAt: new Date(Date.now() - 5000).toISOString(), // 5 seconds ago
      docsUrl: 'https://platform.minimax.io/',
    });

    trackReferralConversion('minimax', 'MiniMax');

    const events = getAnalyticsQueue();
    expect(events).toHaveLength(2); // click + conversion
    const conversion = events.find((e) => e.event === 'referral_converted');
    expect(conversion).toBeDefined();
    expect(conversion!.category).toBe('conversion');
    expect(conversion!.label).toBe('MiniMax');
    expect(conversion!.value).toBeGreaterThanOrEqual(5); // at least 5 seconds
    expect(conversion!.metadata).toMatchObject({
      providerId: 'minimax',
      referralCode: 'ABC123',
    });
    expect(conversion!.metadata).toHaveProperty('timeToConvertMs');
  });

  it('does not track conversion when no click was recorded', () => {
    trackReferralConversion('minimax', 'MiniMax');

    const events = getAnalyticsQueue();
    const conversion = events.find((e) => e.event === 'referral_converted');
    expect(conversion).toBeUndefined();
  });

  it('does not track conversion when provider IDs do not match', () => {
    recordReferralClick({
      providerId: 'openai',
      providerName: 'OpenAI',
      referralCode: 'XYZ789',
      clickedAt: new Date().toISOString(),
      docsUrl: 'https://openai.com/',
    });

    trackReferralConversion('minimax', 'MiniMax');

    const events = getAnalyticsQueue();
    const conversion = events.find((e) => e.event === 'referral_converted');
    expect(conversion).toBeUndefined();
  });

  it('clears the click after successful conversion', () => {
    recordReferralClick({
      providerId: 'minimax',
      providerName: 'MiniMax',
      referralCode: 'ABC123',
      clickedAt: new Date().toISOString(),
      docsUrl: 'https://platform.minimax.io/',
    });

    expect(getReferralClick()).not.toBeNull();
    trackReferralConversion('minimax', 'MiniMax');
    expect(getReferralClick()).toBeNull();
  });
});

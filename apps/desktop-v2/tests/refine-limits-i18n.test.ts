import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { RefinementPolicySettings } from '../src/RefinementPolicySettings';
import { LimitsPolicySettings, TierPolicySettings } from '../src/ResourcePolicySettings';
import { surfaceI18n } from '../src/surface-i18n';

const change = () => undefined;
const command = () => new Promise<Record<string, unknown>>(() => undefined);
const draft = {
  refinerFallbackProfile: 'gone',
  modelTiers: { enabled: true, levels: { fast: {} }, leader: { mode: 'propose' } },
};

const html = () =>
  renderToStaticMarkup(
    createElement('div', null, [
      createElement(RefinementPolicySettings, { key: 'r', draft, saved: draft, change, command }),
      createElement(LimitsPolicySettings, { key: 'l', draft, change }),
      createElement(TierPolicySettings, { key: 't', draft, change, command }),
    ]),
  ).replaceAll('<!-- -->', '');

describe('refinement, limits and tier settings in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('keeps English and translates them in Turkish, keeping option values', async () => {
    await surfaceI18n.changeLanguage('en');
    const english = html();
    for (const text of [
      'Review refinement on submit',
      'gone · unavailable',
      'Conversation history messages',
      'aria-label="Remove tier fast"',
      'fast Spend ceiling (USD)',
      '<option value="propose" selected="">propose</option>',
    ])
      expect(english).toContain(text);

    await surfaceI18n.changeLanguage('tr');
    const turkish = html();
    for (const text of [
      'Gönderirken iyileştirmeyi incele',
      'gone · kullanılamıyor',
      'Konuşma geçmişi mesajları',
      'aria-label="fast kademesini kaldır"',
      'fast Harcama tavanı (USD)',
      '<option value="propose" selected="">öner</option>',
    ])
      expect(turkish).toContain(text);
  });
});

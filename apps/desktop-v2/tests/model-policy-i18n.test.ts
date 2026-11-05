import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { FallbackPolicySettings, RoutingPolicySettings } from '../src/ModelPolicySettings';
import { surfaceI18n } from '../src/surface-i18n';

const change = () => undefined;
const command = () => new Promise<Record<string, unknown>>(() => undefined);
const draft = {
  fallbackModels: ['openai/gpt-x'],
  fallbackProfiles: { nightly: [] },
  refinerFallbackProfile: 'nightly',
  modelMatrix: { '*': { fallbackProfile: 'nightly' } },
};

const html = () =>
  renderToStaticMarkup(
    createElement('div', null, [
      createElement(FallbackPolicySettings, { key: 'f', draft, change, command }),
      createElement(RoutingPolicySettings, { key: 'r', draft, change, command }),
    ]),
  ).replaceAll('<!-- -->', '');

describe('model policy settings in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('keeps English and translates fallback chains, profiles and routes in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    const english = html();
    for (const text of [
      '1 model · tried in order',
      'aria-label="Move Default fallback chain model 1 up"',
      'Used by refinement, review, routing or a cost tier.',
      'ALL AGENTS',
      'aria-label="* preserve reasoning"',
      '<option value="nightly" selected="">nightly</option>',
    ])
      expect(english).toContain(text);

    await surfaceI18n.changeLanguage('tr');
    const turkish = html();
    for (const text of [
      '1 model · sırayla denenir',
      'aria-label="Varsayılan yedek zinciri model 1 yukarı taşı"',
      'İyileştirme, inceleme, yönlendirme ya da bir maliyet kademesi tarafından kullanılıyor.',
      'TÜM AJANLAR',
      'aria-label="* akıl yürütmeyi koru"',
      '<option value="nightly" selected="">nightly</option>',
    ])
      expect(turkish).toContain(text);
  });
});

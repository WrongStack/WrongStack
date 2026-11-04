import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { ExecutionPolicySettings } from '../src/ExecutionPolicySettings';
import { FleetPolicySettings } from '../src/FleetPolicySettings';
import { ProviderVisibilityControl } from '../src/ProviderVisibilityControl';
import { ReviewPolicySettings } from '../src/ReviewPolicySettings';
import { surfaceI18n } from '../src/surface-i18n';

const change = () => undefined;
const command = async () => ({});
const draft = {
  yolo: true,
  yoloPlus: false,
  maxConcurrent: 3,
  memoryCompanionEnabled: true,
  disabledProviders: ['openai'],
  autoReviewFallbackProfile: 'gone',
};

const html = () =>
  renderToStaticMarkup(
    createElement('div', null, [
      createElement(ExecutionPolicySettings, { key: 'e', draft, change }),
      createElement(FleetPolicySettings, { key: 'f', draft, change }),
      createElement(ProviderVisibilityControl, { key: 'p', provider: 'openai', draft, change }),
      createElement(ReviewPolicySettings, { key: 'r', draft, saved: draft, change, command }),
    ]),
  );

describe('policy settings in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('keeps English and translates confirmation, fleet, provider and review policies in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    const english = html();
    for (const text of [
      'YOLO skips routine prompts and asks about the selected categories below.',
      'aria-label="Confirm: Rewrite Git history"',
      'Enabled in profile',
      'Disabled across model catalogs and fallback selection.',
      'Enable provider',
      'Enable Chimera reviews',
      'This saved fallback profile is missing. Choose an existing profile or inherit.',
    ])
      expect(english).toContain(text);

    await surfaceI18n.changeLanguage('tr');
    const turkish = html();
    for (const text of [
      'YOLO rutin soruları atlar ve aşağıda seçili kategoriler için sorar.',
      'aria-label="Onayla: Git geçmişini yeniden yaz"',
      'Profilde etkin',
      'Model kataloglarında ve yedek seçiminde devre dışı.',
      'Sağlayıcıyı etkinleştir',
      'Chimera incelemelerini etkinleştir',
      'Bu kayıtlı yedek profil bulunamadı. Mevcut bir profil seç ya da devral.',
    ])
      expect(turkish).toContain(text);
    expect(turkish).not.toContain('Enabled in profile');
  });
});

// @vitest-environment jsdom

import { afterAll, describe, expect, it } from 'vitest';
import { englishText, localizedText } from '../src/desktop-text';
import { executionModeValues } from '../src/execution-policy-model';
import english from '../src/locales/en/desktop.json';
import { applyModelPriceTiers, priceTierDraft } from '../src/model-price-tiers';
import { rosterConfig } from '../src/roster-model';
import { agentModelPlan, resizeAgentLanes } from '../src/session-agent-plan';
import { surfaceI18n } from '../src/surface-i18n';

const group = english.settingsMessage as Record<string, string>;
const sample = { n: 2, field: 'cache read', label: 'Tool calls', key: 'tools' };

describe('settings editor messages in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('keeps the English of the validators exactly as it was', () => {
    expect(() => executionModeValues('loose' as never)).toThrow(
      'Choose a valid tool confirmation mode.',
    );
    const plan = agentModelPlan({ slots: [{}] });
    expect(() => resizeAgentLanes(plan, 17)).toThrow('Choose between 1 and 16 lanes.');
    expect(() => agentModelPlan('nope')).toThrow(
      'The session returned an unreadable agent plan. It has been preserved.',
    );
    expect(() => rosterConfig({ availability: { timezone: 'UTC', days: [] } })).toThrow(
      'Choose at least one availability day.',
    );
    const draft = { changed: true, rows: [{ ...priceTierDraft(), size: '0' }], unsupported: false };
    expect(() => applyModelPriceTiers({}, draft as never)).toThrow(
      'Price tier 1 needs a positive whole context threshold.',
    );
    expect(englishText('settingsMessage', 'rosterWhole', { label: 'Tool calls' })).toBe(
      'Tool calls must be a non-negative whole number. Leave it empty to inherit.',
    );
  });

  it('turns every English line back into its display-language line, values included', async () => {
    for (const language of ['tr', 'de', 'fr', 'it', 'es', 'pt-BR']) {
      await surfaceI18n.changeLanguage(language);
      const t = surfaceI18n.getFixedT(language, 'desktop');
      const say = (key: string, values: Record<string, string | number>) => t(key, values);
      for (const key of Object.keys(group)) {
        const text = englishText('settingsMessage', key, sample);
        const shown = localizedText(text, 'settingsMessage', say);
        expect(shown, `${language} ${key}`).toBe(t(`settingsMessage.${key}`, sample));
        expect(shown, `${language} ${key}`).not.toBe(text);
      }
    }
  });

  it('recognises each English line as itself only', () => {
    const keyOf = (key: string) => key;
    for (const key of Object.keys(group))
      expect(
        localizedText(englishText('settingsMessage', key, sample), 'settingsMessage', keyOf),
      ).toBe(`settingsMessage.${key}`);
  });
});

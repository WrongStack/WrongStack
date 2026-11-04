// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { AvailabilitySettings } from '../src/AvailabilitySettings';
import { availabilityIssue } from '../src/availability-model';
import { availabilityWords } from '../src/availability-words';
import { BackgroundServices } from '../src/BackgroundServices';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const rule = {
  id: 'w1',
  label: '',
  enabled: true,
  start: '22:00',
  end: '07:00',
  days: [1],
  mode: 'allow_only',
  provider: 'openai',
};
const windows = () =>
  renderToStaticMarkup(
    createElement(AvailabilitySettings, {
      draft: { modelAvailabilitySchedule: [rule] },
      change: () => undefined,
      command: () => new Promise<Record<string, unknown>>(() => undefined),
    }),
  ).replaceAll('<!-- -->', '');

// The settings pass their hook's `t`; the test words the issues from the same catalog.
const words = () =>
  availabilityWords(((key: string, options?: Record<string, unknown>) =>
    surfaceI18n.t(key, { ns: 'desktop', ...options })) as unknown as Parameters<
    typeof availabilityWords
  >[0]);

async function services() {
  const host = document.createElement('div');
  const root = createRoot(host);
  const command = async () => ({
    overall: 'degraded',
    services: [{ id: 'chronicle', label: 'Chronicle', status: 'healthy', required: true }],
  });
  await act(async () => root.render(createElement(BackgroundServices, { command })));
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const text = host.textContent ?? '';
  act(() => root.unmount());
  return text;
}

describe('availability windows and background services in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('keeps English and translates windows, weekdays, issues and services in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    const english = windows();
    for (const text of [
      'ENABLED · ALLOW WINDOW',
      'aria-label="Window 1 Monday"',
      '>Mon<',
      'Use only inside matching allow windows',
    ])
      expect(english).toContain(text);
    expect(availabilityIssue([{ ...rule, provider: '' }], words())).toBe(
      'Window 1: choose a provider or model target.',
    );
    expect(await services()).toContain('Chronicle · healthy · required');

    await surfaceI18n.changeLanguage('tr');
    const turkish = windows();
    for (const text of [
      'ETKİN · İZİN PENCERESİ',
      'aria-label="Pencere 1 Pazartesi"',
      '>Pzt<',
      'Yalnızca eşleşen izin pencerelerinde kullan',
    ])
      expect(turkish).toContain(text);
    expect(availabilityIssue([{ ...rule, provider: '' }], words())).toBe(
      'Pencere 1: bir sağlayıcı ya da model hedefi seç.',
    );
    const turkishServices = await services();
    expect(turkishServices).toContain('Genel: kısıtlı');
    expect(turkishServices).toContain('Chronicle · sağlıklı · zorunlu');
  });
});

// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { PromptJournal } from '../src/PromptJournal';
import { PromptTemplateForm } from '../src/PromptTemplateForm';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const form = () =>
  renderToStaticMarkup(
    createElement(PromptTemplateForm, {
      command: (async () => ({})) as never,
      onDirty: () => undefined,
      onLocked: () => undefined,
      onCancel: () => undefined,
      onCreated: async () => undefined,
    }),
  ).replaceAll('<!-- -->', '');

const command = (async (_type: string, payload: { filter: { category: string } }) => ({
  entries:
    payload.filter.category === 'raw_user'
      ? [
          {
            id: 'e1',
            category: 'raw_user',
            content: 'Fix the login bug',
            sessionId: 's1',
            timestamp: '2026-11-04T10:00:00.000Z',
            metadata: { tokenEstimate: 1200 },
          },
        ]
      : [],
})) as never;

async function journal() {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(PromptJournal, { command, sessionId: 's1', onInsert: () => undefined }),
    ),
  );
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const text = host.textContent ?? '';
  act(() => root.unmount());
  return text;
}

describe('Prompt template form and journal in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('keeps English and translates them in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    const english = form();
    for (const text of [
      'Create a reusable prompt',
      'Use <code>{{name}}</code> for variables; existing prompts are checked before saving.',
      'aria-label="Template instructions"',
      'Back to library',
      'Save template',
    ])
      expect(english).toContain(text);
    const englishJournal = await journal();
    for (const text of [
      'Fix the login bug',
      'Original input',
      'Session: s1',
      '1 visible · searching within the loaded window',
      'Export Markdown',
    ])
      expect(englishJournal).toContain(text);
    expect(englishJournal).toMatch(/~1[,.]?200 estimated tokens/);

    await surfaceI18n.changeLanguage('tr');
    const turkish = form();
    for (const text of [
      'Yeniden kullanılabilir bir prompt oluştur',
      'Değişkenler için <code>{{name}}</code> kullan',
      'aria-label="Şablon talimatları"',
      'Kütüphaneye dön',
      'Şablonu kaydet',
    ])
      expect(turkish).toContain(text);
    const turkishJournal = await journal();
    for (const text of [
      'Orijinal girdi',
      'Oturum: s1',
      '1 görünür · yüklenen pencere içinde aranıyor',
      'Markdown olarak dışa aktar',
    ])
      expect(turkishJournal).toContain(text);
    expect(turkishJournal).toContain('tahmini token');
  });
});

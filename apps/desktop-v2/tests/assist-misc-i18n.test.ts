// @vitest-environment jsdom

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { BrainDecisions, brainAnswerText } from '../src/BrainDecisions';
import { CodeAssistEditReview } from '../src/CodeAssistEditReview';
import { DesktopCodeAssist } from '../src/DesktopCodeAssist';
import { EngineDataView } from '../src/EngineDataView';
import { MODEL_DETAIL_WORDS, modelDetailLine, pickerModel } from '../src/model-picker-details';
import { surfaceI18n } from '../src/surface-i18n';

const command = (async () => ({})) as never;

const render = () =>
  renderToStaticMarkup(
    createElement('div', null, [
      createElement(DesktopCodeAssist, {
        key: 'a',
        filePath: 'src/app.ts',
        send: (async () => undefined) as never,
        state: { assists: {} } as never,
      }),
      createElement(CodeAssistEditReview, { key: 'r', command, path: 'src/app.ts', before: 'x' }),
      createElement(EngineDataView, {
        key: 'd',
        tab: 'files',
        state: { connected: false, results: {} } as never,
        send: (async () => undefined) as never,
        onError: () => undefined,
      }),
      createElement(BrainDecisions, { key: 'b', command }),
    ]),
  ).replaceAll('<!-- -->', '');

const model = pickerModel({
  id: 'm1',
  contextWindow: 200000,
  capabilities: ['vision'],
  inputCost: 0,
  outputCost: 0,
});
const decision = { decision: { type: 'answer', text: 'Yes', rationale: 'low risk' } };

describe('Code Assist, engine data and Brain decisions in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('keeps English and translates them in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    const english = render();
    for (const text of [
      'Architecture overview',
      'Read-only analysis · no project files are modified',
      'Run analysis',
      'Reading the current file…',
      'Only this file was captured before the run.',
      'aria-label="files panel"',
      'Waiting for the local engine…',
      'Ask the Brain',
    ])
      expect(english).toContain(text);
    expect(brainAnswerText(decision)).toBe('Answer: Yes (low risk)');
    expect(modelDetailLine(model)).toBe('200K context · no catalog price · images');

    await surfaceI18n.changeLanguage('tr');
    const turkish = render();
    for (const text of [
      'Mimari genel bakış',
      'Salt okunur analiz · hiçbir proje dosyası değiştirilmez',
      'Analizi çalıştır',
      'Güncel dosya okunuyor…',
      'Çalıştırmadan önce yalnızca bu dosya yakalandı.',
      'aria-label="dosyalar paneli"',
      'Yerel motor bekleniyor…',
      'Brain’e sor',
    ])
      expect(turkish).toContain(text);
    const t = surfaceI18n.getFixedT('tr', 'desktop');
    expect(
      brainAnswerText(decision, (word, values) => t(`brainDecisions.answer.${word}`, values ?? {})),
    ).toBe('Yanıt: Yes (low risk)');
    expect(
      modelDetailLine(model, {
        ...MODEL_DETAIL_WORDS,
        context: (value) => t('modelPicker.detail.context', { value }),
        noPrice: () => t('modelPicker.detail.noPrice'),
        capability: (id) => t(`modelPicker.detail.${id}`, { defaultValue: id }),
      }),
    ).toBe('200K bağlam · katalog fiyatı yok · görseller');
  });
});

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { ComposerQueue } from '../src/ComposerQueue';
import { ContextUsageSummary } from '../src/ContextUsageSummary';
import { emptyContextUsage } from '../src/context-usage';
import { RefinementComparison } from '../src/RefinementComparison';
import { SessionMemoryInjections } from '../src/SessionMemoryInjections';
import { ShortcutsOverlay } from '../src/ShortcutsOverlay';
import { surfaceI18n } from '../src/surface-i18n';

const html = () =>
  [
    createElement(ComposerQueue, {
      queue: [{ id: 'q1', text: 'Run the tests', addedAt: 1, imageCount: 2 }],
      panel: null,
      busy: false,
      connected: true,
      sending: false,
      onAction: () => undefined,
      onCopy: () => undefined,
    }),
    createElement(ContextUsageSummary, {
      usage: { ...emptyContextUsage, tokens: 0, responses: 3 },
    }),
    createElement(SessionMemoryInjections, { runs: [], context: null }),
    createElement(ShortcutsOverlay, { onClose: () => undefined }),
    createElement(RefinementComparison, { original: 'fix the bug', text: 'fix the parser bug' }),
  ]
    .map((element) => renderToStaticMarkup(element))
    .join('\n');

describe('conversation parts in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('keeps English and translates the queue, context, memory, shortcuts and draft diff in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    const english = html();
    for (const text of [
      '1 queued prompt',
      'Copy text only',
      ' · 2 attachments',
      'Prompt / completion tokens over 3 responses',
      'The engine has not reported the memory context of a request yet.',
      'Keyboard shortcuts',
      'Stop the running turn (in the composer)',
      '1 word added · 0 removed',
    ])
      expect(english).toContain(text);

    await surfaceI18n.changeLanguage('tr');
    const turkish = html();
    for (const text of [
      '1 sıradaki istem',
      'Yalnızca metni kopyala',
      ' · 2 ek',
      '3 yanıt boyunca istem / tamamlama tokenları',
      'Motor henüz bir isteğin bellek bağlamını bildirmedi.',
      'Klavye kısayolları',
      'Çalışan turu durdur (mesaj kutusunda)',
      '1 kelime eklendi · 0 silindi',
    ])
      expect(turkish).toContain(text);
    expect(turkish).not.toContain('Keyboard shortcuts');
  });
});

// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { BinaryChange } from '../src/BinaryChange';
import { DraftMergeChoices } from '../src/DraftMergeChoices';
import { EditorFindBar } from '../src/EditorFindBar';
import { surfaceI18n } from '../src/surface-i18n';
import { ViewerFindBar } from '../src/ViewerFindBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Types into the find bar the way a person does, so React sees the change. */
async function findCount(scope: 'source' | 'conversation', query: string) {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(ViewerFindBar, {
        content: 'foo\nbar foo\n',
        onChange: vi.fn(),
        onClose: vi.fn(),
        scope,
      }),
    ),
  );
  const input = host.querySelector('input')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(input, query);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const text = host.querySelector('[role="status"]')?.textContent ?? '';
  const label = host.querySelector('section')?.getAttribute('aria-label');
  act(() => root.unmount());
  return { text, label };
}

const bars = () =>
  [
    createElement(EditorFindBar, { content: 'foo', onChange: vi.fn(), onClose: vi.fn() }),
    createElement(DraftMergeChoices, {
      mine: 'a\nb',
      stored: 'a\nc',
      busy: false,
      onKeep: vi.fn(),
    }),
    createElement(BinaryChange, { diff: { binary: true }, path: 'logo.bin' }),
  ]
    .map((bar) => renderToStaticMarkup(bar))
    .join('\n');

describe('the file tools in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('count matches and name their controls in English, then in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    expect(await findCount('source', 'foo')).toEqual({
      text: '2 matches on 2 lines',
      label: 'Find in read-only source',
    });
    expect((await findCount('conversation', 'bar')).text).toBe('1 matches in 1 message');
    let html = bars();
    for (const text of [
      'aria-label="Find and replace"',
      'Replace all',
      'Merge change by change (1)',
      'Both, mine first',
      'Binary file — text review is unavailable.',
    ])
      expect(html).toContain(text);

    await surfaceI18n.changeLanguage('tr');
    expect(await findCount('source', 'foo')).toEqual({
      text: '2 satırda 2 eşleşme',
      label: 'Salt okunur kaynakta bul',
    });
    expect((await findCount('conversation', 'bar')).text).toBe('1 mesajda 1 eşleşme');
    html = bars();
    for (const text of [
      'aria-label="Bul ve değiştir"',
      'Tümünü değiştir',
      'Değişiklik değişiklik birleştir (1)',
      'İkisi de, önce benimki',
      'İkili dosya — metin incelemesi kullanılamaz.',
    ])
      expect(html).toContain(text);
  });
});

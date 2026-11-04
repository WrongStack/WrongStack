// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, describe, expect, it } from 'vitest';
import { useConversationShortcuts } from '../src/ConversationShortcuts';
import { surfaceI18n } from '../src/surface-i18n';
import { useTranscriptFind } from '../src/TranscriptFind';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness() {
  const find = useTranscriptFind({ messages: [], enabled: true, reveal: () => undefined });
  const overlay = useConversationShortcuts(() => undefined);
  return createElement('div', null, [
    createElement('button', { key: 'b', id: 'elsewhere', type: 'button' }, 'x'),
    // The composer as SessionComposer renders it: a translated name inside its container.
    createElement(
      'div',
      { key: 't', className: 'composer-input' },
      createElement('textarea', {
        'aria-label': surfaceI18n.t('composer.message', { ns: 'desktop' }),
      }),
    ),
    find.bar,
    overlay,
  ]);
}

const press = (key: string) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true }));
  });

describe('Focus shortcuts in a translated window', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('finds the composer and the find field without their English names', async () => {
    await surfaceI18n.changeLanguage('tr');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Harness)));
    const elsewhere = host.querySelector<HTMLButtonElement>('#elsewhere')!;

    press('/');
    expect(document.activeElement?.tagName).toBe('TEXTAREA');
    expect(document.activeElement?.getAttribute('aria-label')).not.toBe('Message WrongStack');

    press('f');
    const field = host.querySelector<HTMLInputElement>('input[data-find-input="conversation"]');
    expect(field?.getAttribute('aria-label')).toBe('Konuşmada bul');
    elsewhere.focus();
    press('f');
    expect(document.activeElement).toBe(field);

    act(() => root.unmount());
    host.remove();
  });
});

// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { SessionSideEffects } from '../src/SessionSideEffects';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const reply = {
  sessionId: 'owner',
  sideEffects: [
    {
      toolUseId: 'call-1',
      toolName: 'bash',
      risk: 'shell',
      ts: '2026-11-04T10:00:00Z',
      input: { command: 'npm test' },
      outcome: 'exit 0',
    },
    {
      toolUseId: 'call-2',
      toolName: 'write_file',
      risk: 'fs.write',
      ts: '2026-11-04T10:01:00Z',
      input: { path: 'src/a.ts' },
    },
  ],
  total: 70,
  start: 68,
  truncated: true,
};

async function render() {
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | undefined;
  await act(async () => {
    root = createRoot(host);
    root.render(
      createElement(SessionSideEffects, {
        sessionId: 'owner',
        connected: true,
        command: vi.fn(async () => reply),
        onBack: () => undefined,
      }),
    );
  });
  await act(async () => {});
  // Open the first record's detail.
  await act(async () => host.querySelector<HTMLButtonElement>('[data-effect-id]')?.click());
  const text = host.textContent ?? '';
  const labels = [...host.querySelectorAll('[aria-label]')].map((node) =>
    node.getAttribute('aria-label'),
  );
  const options = [...host.querySelectorAll('option')].map((node) => node.textContent);
  act(() => root?.unmount());
  host.remove();
  return { text, labels, options };
}

describe('side effects in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('keeps the English page and translates it in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    const english = await render();
    for (const text of [
      'Side effects',
      '2 loaded',
      '70 retained by runtime',
      'Showing records 69–70 of 70 retained by the runtime. Search and export apply only to the loaded records.',
      'Load older records',
      '2 visible records',
      'Outcome not reported',
      'RECORDED OPERATION',
      'Recorded input',
      "conversation's run activity",
    ])
      expect(english.text).toContain(text);
    expect(english.options).toEqual(
      expect.arrayContaining([
        'Live runtime window',
        'File writes',
        'Other recorded kinds',
        'Newest first',
      ]),
    );
    expect(english.labels).toEqual(
      expect.arrayContaining(['Session side effects', 'Side-effect detail', 'Search side effects']),
    );
    await surfaceI18n.changeLanguage('tr');
    const turkish = await render();
    for (const text of [
      'Yan etkiler',
      '2 yüklendi',
      '70 çalışma zamanında tutuluyor',
      'Çalışma zamanının tuttuğu 70 kaydın 69–70 arası gösteriliyor.',
      'Daha eski kayıtları yükle',
      '2 görünür kayıt',
      'Sonuç bildirilmedi',
      'Kaydedilmiş girdi',
    ])
      expect(turkish.text).toContain(text);
    expect(turkish.options).toEqual(
      expect.arrayContaining(['Canlı çalışma zamanı penceresi', 'Dosya yazmaları', 'Önce en yeni']),
    );
    expect(turkish.labels).toEqual(
      expect.arrayContaining(['Oturum yan etkileri', 'Yan etki ayrıntısı']),
    );
  });
});

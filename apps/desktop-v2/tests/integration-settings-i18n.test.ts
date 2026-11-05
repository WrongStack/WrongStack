// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { IntegrationSettings } from '../src/IntegrationSettings';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no modal dialogs; opening one only has to mark it open here.
HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
  this.open = false;
};

// One connected remote server with a read-only tool. Other requests never answer.
const command = vi.fn((type: string) =>
  type === 'mcp.list'
    ? Promise.resolve({
        servers: [
          {
            name: 'docs',
            url: 'https://docs.example/mcp',
            status: 'connected',
            enabled: true,
            tools: [{ name: 'search', description: 'Search the docs' }],
            toolAnnotations: { search: { readOnlyHint: true } },
          },
        ],
      })
    : new Promise<never>(() => {}),
);

/** Renders the settings, optionally opens the add dialog, then reads text and accessible names. */
async function mount(openDialog: boolean) {
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | undefined;
  await act(async () => {
    root = createRoot(host);
    root.render(createElement(IntegrationSettings, { command: command as never }));
  });
  await act(async () => {});
  if (openDialog)
    await act(async () => {
      (host.querySelector('.settings-section-heading button') as HTMLElement | null)?.click();
    });
  const text = host.textContent ?? '';
  const labels = [...host.querySelectorAll('[aria-label]')].map((node) =>
    node.getAttribute('aria-label'),
  );
  act(() => root?.unmount());
  host.remove();
  return { text, labels };
}

describe('integration settings in the display language', () => {
  afterAll(() => surfaceI18n.changeLanguage('en'));

  it('shows a connection card and the add dialog in English, then in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    let page = await mount(false);
    for (const text of [
      'Connected tools',
      'Add connection',
      'connected',
      '1 tool available',
      'Available tools',
      'Server-reported hints: read-only. Execution permissions are evaluated separately.',
      'Edit connection',
      'Browse resources & prompts',
      'Disable',
      'Pause',
      'Refresh tools',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(expect.arrayContaining(['Restart docs', 'Remove docs']));
    page = await mount(true);
    for (const text of [
      'MCP CONNECTION',
      'Make your tools available.',
      'Start from',
      'A custom connection',
      'Remote endpoint',
      'Server URL',
      'Allow private network addresses for this connection',
      'The connection will be saved disabled. Enable it from its card to connect.',
      'Save connection',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining([
        'Add MCP connection',
        'Connection name',
        'MCP server URL',
        'Recommended MCP server',
      ]),
    );

    await surfaceI18n.changeLanguage('tr');
    page = await mount(false);
    for (const text of [
      'Bağlı araçlar',
      'Bağlantı ekle',
      'bağlı',
      '1 araç kullanılabilir',
      'Kullanılabilir araçlar',
      'Sunucunun bildirdiği ipuçları: salt okunur.',
      'Bağlantıyı düzenle',
      'Kaynaklara ve istemlere göz at',
      'Devre dışı bırak',
      'Duraklat',
      'Araçları yenile',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining(['docs bağlantısını yeniden başlat', 'docs bağlantısını kaldır']),
    );
    page = await mount(true);
    for (const text of [
      'MCP BAĞLANTISI',
      'Araçlarını kullanılabilir yap.',
      'Başlangıç',
      'Özel bir bağlantı',
      'Uzak uç nokta',
      'Sunucu URL’si',
      'Bu bağlantı için özel ağ adreslerine izin ver',
      'Bağlantı devre dışı olarak kaydedilir.',
      'Bağlantıyı kaydet',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining([
        'MCP bağlantısı ekle',
        'Bağlantı adı',
        'MCP sunucu URL’si',
        'Önerilen MCP sunucusu',
      ]),
    );
  });
});

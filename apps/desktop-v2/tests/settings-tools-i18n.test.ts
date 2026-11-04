// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { BrowserNetworkPolicy } from '../src/BrowserNetworkPolicy';
import { ConfigDoctor } from '../src/ConfigDoctor';
import { PluginToggles } from '../src/PluginToggles';
import { surfaceI18n } from '../src/surface-i18n';
import { ToolAccessSettings } from '../src/ToolAccessSettings';
import { UserInstructionsSettings } from '../src/UserInstructionsSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const idle = () => new Promise<Record<string, unknown>>(() => undefined);

const staticHtml = () =>
  renderToStaticMarkup(
    createElement('div', null, [
      createElement(UserInstructionsSettings, {
        key: 'u',
        command: idle,
        value: { document: { text: 'one', exists: true, mtimeMs: 1 }, text: 'one\ntwo' },
        onChange: () => undefined,
      }),
      createElement(BrowserNetworkPolicy, { key: 'b', command: idle }),
      createElement(PluginToggles, { key: 'p', draft: {}, change: () => undefined }),
      createElement(ConfigDoctor, { key: 'c', command: idle }),
    ]),
  ).replaceAll('<!-- -->', '');

async function toolCatalog() {
  const host = document.createElement('div');
  const root = createRoot(host);
  const command = async () => ({
    tools: [
      { name: 'read_file', owner: 'core', direct: true, permission: 'auto' },
      { name: 'deploy', owner: 'ops', disabled: true, mutating: true, permission: 'confirm' },
    ],
  });
  await act(async () => root.render(createElement(ToolAccessSettings, { command })));
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const text = host.textContent ?? '';
  const labels = [...host.querySelectorAll('[aria-label]')].map((n) =>
    n.getAttribute('aria-label'),
  );
  act(() => root.unmount());
  return { text, labels };
}

describe('tool, instruction, network, plugin and configuration settings in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('keeps English and translates them in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    const english = staticHtml();
    for (const text of [
      '7 characters · 2 lines · unsaved',
      'Browser and network access',
      'Per-plugin controls',
      'Check configuration',
    ])
      expect(english).toContain(text);
    const tools = await toolCatalog();
    expect(tools.text).toContain('2 registered · 1 direct · 0 on demand · 1 disabled');
    expect(tools.text).toContain('Direct provider tool');
    expect(tools.labels).toContain('Enable deploy');

    await surfaceI18n.changeLanguage('tr');
    const turkish = staticHtml();
    for (const text of [
      '7 karakter · 2 satır · kaydedilmedi',
      'Tarayıcı ve ağ erişimi',
      'Eklenti bazında denetimler',
      'Yapılandırmayı denetle',
    ])
      expect(turkish).toContain(text);
    const turkishTools = await toolCatalog();
    expect(turkishTools.text).toContain('2 kayıtlı · 1 doğrudan · 0 isteğe bağlı · 1 devre dışı');
    expect(turkishTools.text).toContain('Doğrudan sağlayıcı aracı');
    expect(turkishTools.labels).toContain('deploy etkinleştir');
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { DesktopCommandHelp } from '../src/DesktopCommandHelp';
import { commandTextKey } from '../src/desktop-command-text';
import { DESKTOP_CATEGORY_ORDER, desktopCommands } from '../src/desktop-commands';
import { ShortcutsOverlay } from '../src/ShortcutsOverlay';
import { surfaceI18n } from '../src/surface-i18n';

const english = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../src/locales/en/desktop.json'), 'utf8'),
) as { commandHelp: { cmd: Record<string, string>; category: Record<string, string> } };

describe('desktop commands in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('words every command outside the hunts, with the table’s English unchanged', () => {
    for (const command of desktopCommands.filter((item) => item.category !== 'Hunts'))
      expect(english.commandHelp.cmd[commandTextKey(command.name)], command.name).toBe(
        command.description,
      );
    for (const category of DESKTOP_CATEGORY_ORDER)
      expect(english.commandHelp.category[category]).toBe(category);
  });

  it('shows the help, its categories and the function key views in Turkish', async () => {
    const render = () =>
      renderToStaticMarkup(
        createElement('div', null, [
          createElement(DesktopCommandHelp, {
            key: 'help',
            onChoose: () => undefined,
            onClose: () => undefined,
          }),
          createElement(ShortcutsOverlay, { key: 'keys', onClose: () => undefined }),
        ]),
      );
    await surfaceI18n.changeLanguage('en');
    const englishHtml = render();
    expect(englishHtml).toContain('Stop the active turn');
    expect(englishHtml).toContain('use <code>//</code> for literal slash-prefixed text.');
    expect(englishHtml).toContain('Live fleet: running conversations and their agents');

    await surfaceI18n.changeLanguage('tr');
    const turkish = render();
    expect(turkish).toContain('Masaüstü komutları');
    expect(turkish).toContain('<h3>Çalıştırma</h3>');
    expect(turkish).toContain('Etkin turu durdur');
    expect(turkish).toContain('ayrıca /abort, /interrupt, /int');
    expect(turkish).toContain('<code>//</code>');
    expect(turkish).toContain('Canlı filo: çalışan konuşmalar ve ajanları');
    expect(turkish).not.toContain('Stop the active turn');
  });
});

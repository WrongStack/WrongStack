import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { McpAuthorization } from '../src/McpAuthorization';
import { McpConnectionEditor } from '../src/McpConnectionEditor';
import { mcpAuthSummary } from '../src/mcp-auth-model';
import { MCP_SECRET_MASK } from '../src/mcp-secret-map';
import { surfaceI18n } from '../src/surface-i18n';

const command = (async () => ({})) as never;

const editor = () =>
  renderToStaticMarkup(
    createElement(McpConnectionEditor, {
      server: {
        name: 'docs',
        transport: 'stdio',
        command: 'node',
        env: { TOKEN: MCP_SECRET_MASK },
      },
      command,
      onClose: () => undefined,
      onSaved: () => undefined,
      onRefresh: () => undefined,
      secretMaps: true,
    }),
  ).replaceAll('<!-- -->', '');

const authorization = () =>
  renderToStaticMarkup(createElement(McpAuthorization, { name: 'docs', command })).replaceAll(
    '<!-- -->',
    '',
  );

const status = { state: 'authorized' as const, scopes: ['read'], canRefresh: true };

describe('MCP connection editing and authorization in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('keeps English and translates them in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    const english = editor();
    for (const text of [
      'PROFILE CONNECTION · docs',
      'Local process · stdio',
      'aria-label="MCP connection executable"',
      'Environment',
      'Hidden value',
      'Add environment variable',
      'Save connection changes',
    ])
      expect(english).toContain(text);
    expect(authorization()).toContain('Reading authorization…');
    expect(mcpAuthSummary(status)).toBe(
      'Signed in with read. It can be refreshed without signing in again.',
    );

    await surfaceI18n.changeLanguage('tr');
    const turkish = editor();
    for (const text of [
      'PROFİL BAĞLANTISI · docs',
      'Yerel süreç · stdio',
      'aria-label="MCP bağlantısı çalıştırılabilir dosyası"',
      'Ortam',
      'Gizli değer',
      'Ortam değişkeni ekle',
      'Bağlantı değişikliklerini kaydet',
    ])
      expect(turkish).toContain(text);
    expect(authorization()).toContain('Yetkilendirme okunuyor…');
    const t = surfaceI18n.getFixedT('tr', 'desktop');
    expect(
      mcpAuthSummary(status, Date.now(), (word, values) =>
        t(`mcpAuth.summary.${word}`, values ?? {}),
      ),
    ).toBe('read ile oturum açık. Yeniden oturum açmadan yenilenebilir.');
  });
});

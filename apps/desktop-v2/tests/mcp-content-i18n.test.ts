// @vitest-environment jsdom

import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpComposerPicker } from '../src/McpComposerPicker';
import { McpContentBrowser } from '../src/McpContentBrowser';
import { McpToolRunner } from '../src/McpToolRunner';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const command = (async (type: string) =>
  type === 'mcp.list'
    ? {
        servers: [
          { name: 'docs', enabled: true },
          { name: 'old', enabled: false },
        ],
      }
    : type === 'mcp.resources'
      ? { resources: [{ uri: 'file:///a.md', name: 'Notes' }], resourceTemplates: [] }
      : type === 'mcp.prompts'
        ? { prompts: [] }
        : { tools: [{ name: 'search', description: 'Find pages' }] }) as never;

async function text(element: ReactElement) {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(element));
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const shown = host.textContent ?? '';
  act(() => root.unmount());
  return shown;
}

// One view at a time: overlapping act() scopes leave later roots unrendered.
const views = async () => [
  await text(
    createElement(McpComposerPicker, {
      command,
      onInsert: async () => undefined,
      onClose: () => undefined,
      sessionId: 's1',
      onNotice: () => undefined,
    }),
  ),
  await text(createElement(McpContentBrowser, { name: 'docs', command, onClose: () => undefined })),
  await text(
    createElement(McpToolRunner, {
      name: 'docs',
      command,
      onRun: () => undefined,
      onClose: () => undefined,
    }),
  ),
];

describe('MCP content, tools and picker in the display language', () => {
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
      this.open = false;
    };
  });
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('keeps English and translates them in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    const [picker, content, tools] = await views();
    for (const shown of ['EXTERNAL CONTEXT', 'Disabled', 'Tools', 'Return to draft'])
      expect(picker).toContain(shown);
    for (const shown of [
      'Resources',
      'Notes',
      'No matching templates.',
      'Select a resource or prompt.',
    ])
      expect(content).toContain(shown);
    for (const shown of [
      'Run a tool in this conversation',
      'search',
      'Choose a tool to see its input.',
    ])
      expect(tools).toContain(shown);

    await surfaceI18n.changeLanguage('tr');
    const [pickerTr, contentTr, toolsTr] = await views();
    for (const shown of ['DIŞ BAĞLAM', 'Kapalı', 'Araçlar', 'Taslağa dön'])
      expect(pickerTr).toContain(shown);
    for (const shown of ['Kaynaklar', 'Eşleşen şablon yok.', 'Bir kaynak ya da prompt seç.'])
      expect(contentTr).toContain(shown);
    for (const shown of ['Bu konuşmada bir araç çalıştır', 'Girdisini görmek için bir araç seç.'])
      expect(toolsTr).toContain(shown);
  });
});

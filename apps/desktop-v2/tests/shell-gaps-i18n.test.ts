// @vitest-environment jsdom

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { AutoContinue } from '../src/AutoContinue';
import { DraftCounter } from '../src/DraftCounter';
import { MarkdownContent } from '../src/MarkdownContent';
import { McpBinaryBlock } from '../src/McpBinaryBlock';
import { SessionWorklist } from '../src/SessionWorklist';
import { surfaceI18n } from '../src/surface-i18n';

const state = {
  sessionId: 's1',
  running: false,
  results: {
    'plan.updated': {
      plan: { title: 'Ship', items: [{ id: 'p1', title: 'Fix', status: 'in_progress' }] },
    },
    'tasks.updated': { tasks: [{ id: 't1', title: 'Test', status: 'blocked' }] },
  },
};
const render = () =>
  renderToStaticMarkup(
    createElement('div', null, [
      createElement(DraftCounter, {
        key: 'd',
        draft: 'x'.repeat(800),
        context: { tokens: 1_700, max: 2_000 },
      }),
      createElement(AutoContinue, {
        key: 'a',
        stepKey: 'k',
        text: 'Run the tests',
        onSubmit: () => undefined,
      }),
      createElement(SessionWorklist, {
        key: 'w',
        state: state as never,
        command: (async () => ({})) as never,
      }),
      createElement(McpBinaryBlock, {
        key: 'm',
        value: { type: 'blob', mimeType: 'application/zip', blob: 'UEsDBA==', uri: 'x.zip' },
      }),
      createElement(MarkdownContent, { key: 'i', text: '![](https://example.com/a.png)' }),
    ]),
  ).replaceAll('<!-- -->', '');

describe('conversation and shell text in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('keeps the English wording and shows German in German', async () => {
    await surfaceI18n.changeLanguage('en');
    const english = render();
    for (const text of [
      ' · ≈200 tokens',
      'title="Projected 98%',
      'Continuing in 5 s with:',
      'Cancel',
      'Plan: Ship · 0 of 1 done',
      'Tasks · 0 of 1 done',
      'in progress',
      'aria-label="Status of Fix"',
      'No preview for application/zip.',
      'text copy omits this block',
      'Save x.zip',
      'Image',
    ])
      expect(english).toContain(text);

    await surfaceI18n.changeLanguage('de');
    const german = render();
    for (const text of [
      ' · ≈200 Token',
      'title="Voraussichtlich 98 %',
      'Weiter in 5 s mit:',
      'Abbrechen',
      'Plan: Ship · 0 von 1 erledigt',
      'Aufgaben · 0 von 1 erledigt',
      'in Arbeit',
      'blockiert',
      'Keine Vorschau für application/zip.',
      'x.zip speichern',
      'Bild',
    ])
      expect(german).toContain(text);
    for (const text of ['Continuing in', 'Tasks ·', 'No preview for', 'text copy omits'])
      expect(german).not.toContain(text);
  });
});

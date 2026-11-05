// @vitest-environment jsdom

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { DiffPreview } from '../src/DiffPreview';
import { surfaceI18n } from '../src/surface-i18n';

const render = (edit: boolean) =>
  renderToStaticMarkup(
    createElement(DiffPreview, {
      before: 'a\n',
      after: 'b\n',
      path: 'src/app.ts',
      ...(edit
        ? { edit: { command: (async () => ({})) as never, onApplied: () => undefined } }
        : {}),
    }),
  );

describe('editable side-by-side diff', () => {
  afterAll(() => surfaceI18n.changeLanguage('en'));

  it('offers the side-by-side editor only where a change can be written back', () => {
    expect(render(true)).toContain('aria-label="Edit side by side"');
    expect(render(false)).not.toContain('Edit side by side');
    // The read-only unified diff stays the first view.
    expect(render(true)).toContain('diff-line-add');
  });

  it('names the editor in the display language', async () => {
    await surfaceI18n.changeLanguage('de');
    expect(render(true)).toContain('aria-label="Nebeneinander bearbeiten"');
  });
});

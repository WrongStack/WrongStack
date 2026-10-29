import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { FileBulkDialog } from '../src/FileBulkDialog';

const noop = async () => {};
const dialog = (copyMany: typeof noop | undefined, initialTarget: string) =>
  renderToStaticMarkup(
    createElement(FileBulkDialog, {
      kind: 'copy',
      paths: ['src', 'README.md'],
      initialTarget,
      isDirectory: (path: string) => path === 'src',
      hasUnsaved: () => false,
      move: noop,
      copy: noop,
      rename: noop,
      remove: noop,
      copyMany,
      onClose() {},
      onFinished() {},
    }),
  );

it('describes the all-or-nothing copy only when the engine supports it', () => {
  const batch = dialog(noop, 'lib');
  expect(batch).toContain('or none is');
  expect(batch).not.toContain('at most 200 files');
  const perItem = dialog(undefined, 'lib');
  expect(perItem).toContain('at most 200 files');
  expect(perItem).not.toContain('or none is');
});

it('refuses to copy a folder into itself before asking the engine', () => {
  const markup = dialog(noop, 'src/nested');
  expect(markup).toContain('A folder cannot be copied into itself');
  expect(markup).toMatch(/<button type="submit"[^>]*disabled/);
});

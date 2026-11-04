// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BoardDialog } from '../src/KanbanBoardDialog';
import { KanbanContractMap } from '../src/KanbanContractMap';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dialog = () =>
  renderToStaticMarkup(
    createElement(BoardDialog, {
      busy: false,
      onClose: () => undefined,
      onCreate: () => undefined,
      onGenerate: () => undefined,
    }),
  ).replaceAll('<!-- -->', '');

const command = (async () => ({
  data: {
    graph: {
      enforcement: 'strict',
      nodes: [
        {
          id: 'n1',
          taskId: 't1',
          kind: 'objective',
          title: 'Fast',
          enforcement: 'blocking',
          state: 'active',
        },
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'task:t2', type: 'verified_by' }],
    },
  },
})) as never;

async function map() {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(KanbanContractMap, {
        command,
        board: {
          id: 'b1',
          tasks: [
            { id: 't1', title: 'Cache' },
            { id: 't2', title: 'Bench' },
          ],
        },
        onClose: () => undefined,
      }),
    ),
  );
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const text = host.textContent ?? '';
  act(() => root.unmount());
  return text;
}

describe('Kanban board creation and contract map in the display language', () => {
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
    for (const text of [
      'PROJECT PLANNING',
      'An empty board',
      'aria-label="Board name"',
      'Create board',
    ])
      expect(dialog()).toContain(text);
    const english = await map();
    for (const text of [
      'Strict · blocking contracts stop a start',
      'objective',
      ' · blocking',
      'objective: Fast verified by Card: Bench',
      'Add relation',
    ])
      expect(english).toContain(text);

    await surfaceI18n.changeLanguage('tr');
    for (const text of ['PROJE PLANLAMA', 'Boş bir pano', 'aria-label="Pano adı"', 'Pano oluştur'])
      expect(dialog()).toContain(text);
    const turkish = await map();
    for (const text of [
      'Katı · engelleyici sözleşmeler başlatmayı durdurur',
      ' · engelleyici',
      'hedef: Fast şununla doğrulanır Kart: Bench',
      'İlişki ekle',
    ])
      expect(turkish).toContain(text);
  });
});

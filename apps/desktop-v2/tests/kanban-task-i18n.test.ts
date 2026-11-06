import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { KanbanTaskTransfer } from '../src/KanbanTaskTransfer';
import { surfaceI18n } from '../src/surface-i18n';

const board = {
  id: 'b1',
  tasks: [
    {
      id: 't1',
      title: 'Ship it',
      goalMetrics: [{ id: 'm1', name: 'latency', target: 200, unit: 'ms', status: 'met' }],
    },
    { id: 't2', title: 'Test it' },
  ],
};

const tools = () =>
  renderToStaticMarkup(
    createElement(KanbanTaskTransfer, {
      command: (async () => ({})) as never,
      board,
      task: board.tasks[0]!,
      boards: [board, { id: 'b2', title: 'Later' }],
      disabled: false,
      onDone: async () => undefined,
    }),
  ).replaceAll('<!-- -->', '');

describe('Kanban task tools in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('keeps English and translates them in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    const english = tools();
    for (const text of [
      'Goal metrics · 1',
      ' · target 200 ms',
      '<option value="met" selected="">Met</option>',
      'Chain with other cards',
      'Merge with other cards',
      'Merge  cards',
      'Another board',
      'Move card',
    ])
      expect(english).toContain(text);

    await surfaceI18n.changeLanguage('tr');
    const turkish = tools();
    for (const text of [
      'Hedef metrikleri · 1',
      ' · hedef 200 ms',
      '<option value="met" selected="">Karşılandı</option>',
      'Diğer kartlarla zincirle',
      'Diğer kartlarla birleştir',
      'Başka bir pano',
      'Kartı taşı',
    ])
      expect(turkish).toContain(text);
  });
});

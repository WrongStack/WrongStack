import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { EngineState } from '../src/engine-state';
import { NextStepsPanel } from '../src/NextStepsPanel';
import { SessionTodos } from '../src/SessionTodos';
import { surfaceI18n } from '../src/surface-i18n';
import { ToolApprovalCard } from '../src/ToolApprovalCard';
import { TurnTools } from '../src/TurnTools';

const approval = {
  id: 'a1',
  toolName: 'exec',
  input: { command: 'pnpm test', cwd: 'D:/shop' },
  riskTier: 'destructive',
};
const todosState = {
  sessionId: 's1',
  running: false,
  results: {
    'todos.updated': {
      todos: [
        { id: '1', content: 'Write the fix', status: 'completed' },
        { id: '2', content: 'Ship', status: 'in_progress', activeForm: 'Shipping' },
      ],
    },
  },
} as unknown as EngineState;

function cards(): string {
  return [
    createElement(ToolApprovalCard, { approval, send: vi.fn(), connected: true }),
    createElement(TurnTools, {
      events: [],
      stats: { iterations: 2, prompt: 1000, output: 200, cacheRead: 500 },
      onOpenFile: vi.fn(),
    }),
    createElement(NextStepsPanel, {
      steps: [{ index: 1, text: 'Run the tests' }],
      onAdd: vi.fn(),
      onSend: vi.fn(),
    }),
    createElement(SessionTodos, { state: todosState, command: vi.fn() }),
  ]
    .map((card) => renderToStaticMarkup(card))
    .join('\n');
}

describe('the conversation cards in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('keep their English text, then follow Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    let html = cards();
    for (const text of [
      'aria-label="Approval for exec"',
      'APPROVAL REQUIRED',
      'Destructive',
      'Allow once',
      'All requests for exec',
      '2 iterations',
      '50% from cache',
      'Send 0 steps',
      'Todo list · 1 of 2 done · Shipping',
    ])
      expect(html).toContain(text);
    await surfaceI18n.changeLanguage('tr');
    html = cards();
    for (const text of [
      'aria-label="exec için onay"',
      'ONAY GEREKİYOR',
      'Yıkıcı',
      'Bir kez izin ver',
      'exec için tüm istekler',
      '2 yineleme',
      '%50 önbellekten',
      '0 adımı gönder',
      'Yapılacaklar · 2 işin 1 tanesi bitti · Shipping',
    ])
      expect(html).toContain(text);
  });
});

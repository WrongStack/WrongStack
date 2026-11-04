import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { DiffPreview } from '../src/DiffPreview';
import type { EngineState } from '../src/engine-state';
import { FallbackPicker } from '../src/FallbackPicker';
import { NextStepsPanel } from '../src/NextStepsPanel';
import { ScheduledJobs } from '../src/ScheduledJobs';
import { SessionTodos } from '../src/SessionTodos';
import { surfaceI18n } from '../src/surface-i18n';
import { ToolApprovalCard } from '../src/ToolApprovalCard';
import { ToolInputView } from '../src/ToolInputView';
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

// The fallback gate and the scheduler count from now, so their state is made at render time.
const liveState = () =>
  ({
    results: {
      'provider.fallback_pending': {
        requestId: 'r1',
        from: { providerId: 'openai', model: 'gpt' },
        status: 429,
        candidates: [{ providerId: 'anthropic', model: 'claude' }],
        autoSwitchSeconds: 30,
        timestamp: Date.now(),
      },
      'cron.snapshot': {
        maxConcurrent: 2,
        jobs: [
          {
            name: 'check-ci',
            intervalMs: 300_000,
            enabled: true,
            lastRun: null,
            nextRun: new Date(Date.now() + 181_000).toISOString(),
            runCount: 4,
            overdue: false,
          },
        ],
      },
    },
  }) as unknown as EngineState;

function cards(): string {
  const live = liveState();
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
    createElement(FallbackPicker, { state: live, send: vi.fn() }),
    createElement(ScheduledJobs, { state: live }),
    createElement(ToolInputView, { name: 'grep', input: { pattern: 'TODO', path: 'src' } }),
    createElement(DiffPreview, { before: 'a', after: 'b', path: 'src/x.ts' }),
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
      'openai / gpt failed (status 429) after its retries. Switching to <strong>anthropic / claude</strong> in 30 s.',
      'Scheduled jobs · 1 of 1 active · 4 runs',
      'every 5m · 4 runs · next in 3m · last —',
      'Up to 2 run at once. Ask the agent to schedule a job with <code>cron_schedule</code>',
      'Search for <code>TODO</code> in <code>src</code>',
      'aria-label="Changes in src/x.ts"',
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
      'openai / gpt yeniden denemelerinden sonra başarısız oldu (durum 429). 30 sn içinde <strong>anthropic / claude</strong> modeline geçiliyor.',
      'Zamanlanmış işler · 1 işin 1 tanesi etkin · 4 çalışma',
      'her 5m · 4 çalışma · sonraki 3m sonra · son —',
      'Aynı anda en çok 2 çalışma. Ajandan <code>cron_schedule</code> ile',
      '<code>src</code> içinde <code>TODO</code> ara',
      'aria-label="src/x.ts içindeki değişiklikler"',
    ])
      expect(html).toContain(text);
  });
});

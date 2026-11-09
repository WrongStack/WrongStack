// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ComposerAttachments } from '../src/ComposerAttachments';
import type { ComposerAttachment } from '../src/composer-attachments';
import { DiffPreview } from '../src/DiffPreview';
import type { EngineState } from '../src/engine-state';
import { FallbackPicker } from '../src/FallbackPicker';
import { HuntRoundCard } from '../src/HuntRounds';
import { NextStepsPanel } from '../src/NextStepsPanel';
import { ScheduledJobs } from '../src/ScheduledJobs';
import { SessionModelControls } from '../src/SessionModelControls';
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

const modelState = {
  connected: true,
  needsSetup: false,
  provider: 'openai',
  model: 'gpt',
  results: {
    'session.start': {
      provider: 'openai',
      model: 'gpt',
      effortSupported: true,
      projectReasoningEffort: 'high',
    },
  },
} as unknown as EngineState;
const draft = [
  { id: 'd1', name: 'a.png', bytes: 2048, mediaType: 'image/png', data: 'AA==' },
] as unknown as ComposerAttachment[];
const tray = {
  processing: false,
  error: '',
  dragging: false,
  add: vi.fn(),
  picker: { current: null },
  setDragging: vi.fn(),
};
const round = { mode: 'bughunt', currentRound: 1, maxBugs: 2, scope: 'src/auth' } as never;

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
    createElement(SessionModelControls, {
      state: modelState,
      command: vi.fn(),
      send: vi.fn(),
      onSettings: vi.fn(),
    }),
    createElement(ComposerAttachments, {
      items: draft,
      disabled: false,
      onChange: vi.fn(),
      control: tray as never,
    }),
    createElement(HuntRoundCard, { round }),
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
      'Session wakeups · 1 of 1 active · 4 runs',
      'every 5m · 4 runs · next in 3m · last —',
      'Up to 2 per session. Ask the agent to set a wakeup with <code>session_wakeup</code>',
      'Search for <code>TODO</code> in <code>src</code>',
      'aria-label="Changes in src/x.ts"',
      'Auto effort · High',
      'aria-label="Remove attachment a.png"',
      'Round 1 of 2',
      'src/auth and below',
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
      'Oturum uyandırmaları · 1 işin 1 tanesi etkin · 4 çalışma',
      'her 5m · 4 çalışma · sonraki 3m sonra · son —',
      'Oturum başına en çok 2. Ajandan <code>session_wakeup</code> ile',
      '<code>src</code> içinde <code>TODO</code> ara',
      'aria-label="src/x.ts içindeki değişiklikler"',
      'Otomatik efor · Yüksek',
      'aria-label="a.png ekini kaldır"',
      'Tur 1 / 2',
      'src/auth ve altı',
    ])
      expect(html).toContain(text);
  });
});

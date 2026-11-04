// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ContextEditorDialog } from '../src/ContextEditorDialog';
import { SessionContextPanel } from '../src/SessionContextPanel';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
  this.open = false;
};

const debug = {
  total: 1200,
  systemPrompt: 400,
  mode: 'balanced',
  tools: { total: 300, count: 2, breakdown: [{ name: 'read', tokens: 150 }] },
  messages: { total: 500, count: 4, breakdown: [{ role: 'user', preview: 'first', tokens: 5 }] },
  residency: {
    seq: 3,
    at: 1,
    providerId: 'local',
    model: 'm1',
    mechanism: 'explicit',
    segments: [{ kind: 'tools', tokens: 400, lane: 'cached', count: 12 }],
    lanes: { cached: 400, written: 0, uncached: 0 },
    total: 400,
    expectedCacheRatio: 1,
    verdict: 'hit',
    breakers: [],
    next: { rewritten: false, pendingMessages: 0, pendingTokens: 0 },
  },
  retention: {
    preserveK: 4,
    eliseThreshold: 2000,
    preserveStart: 2,
    total: 950,
    classes: {
      protected: { messages: 4, tokens: 900 },
      'elision-candidate': { messages: 0, tokens: 0 },
      compactable: { messages: 0, tokens: 0 },
      elided: { messages: 0, tokens: 0 },
      digest: { messages: 1, tokens: 50 },
    },
  },
};
const modes = {
  activeId: 'focus',
  modes: [
    {
      id: 'focus',
      name: 'Focus',
      description: '',
      isActive: true,
      custom: true,
      thresholds: { warn: 0.5, soft: 0.6, hard: 0.8 },
      preserveK: 4,
      eliseThreshold: 1000,
    },
  ],
};
const editor = {
  revision: 'rev-1',
  messages: [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'answer one' },
  ],
  messageBreakdown: [
    { index: 0, role: 'user', tokens: 5, preview: 'first', pairedAssistantIndices: [1] },
    { index: 1, role: 'assistant', tokens: 9, preview: 'answer one' },
  ],
  readonlyContext: { totalTokens: 1200 },
};

async function render(
  element: ReturnType<typeof createElement>,
  after?: (host: HTMLElement) => void,
) {
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | undefined;
  await act(async () => {
    root = createRoot(host);
    root.render(element);
  });
  await act(async () => {});
  if (after) await act(async () => after(document.body));
  const text = document.body.textContent ?? '';
  const labels = [...document.body.querySelectorAll('[aria-label]')].map((node) =>
    node.getAttribute('aria-label'),
  );
  act(() => root?.unmount());
  host.remove();
  return { text, labels };
}

const command = vi.fn(async (type: string) =>
  type === 'context.debug' ? debug : type === 'context.modes.list' ? modes : editor,
);
const panel = () =>
  createElement(SessionContextPanel, {
    command,
    running: false,
    maxContext: 0,
    onClose: () => undefined,
  });
const dialog = () =>
  createElement(ContextEditorDialog, {
    command,
    running: false,
    onClose: () => undefined,
    onApplied: () => undefined,
  });
// Choosing the first message also takes the reply it produced.
const choose = (root: HTMLElement) =>
  root.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();

describe('context dialogs in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('keeps the English inspector and editor and translates them in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    const english = await render(panel());
    for (const text of [
      'Context & instructions',
      'Estimated current tokens',
      'Not reported',
      'Model context window',
      'Tool definitions · 2',
      'Conversation messages · 4',
      'Read effective instructions',
      'Compact aggressively',
      'Clear provider context',
      'Context modes',
      'focus · warn 50% · compact 60% · hard 80% · keeps 4 recent turns · custom',
      'In use',
      'Last request cache layout · hit — the prefix was reused as expected',
      'What the next compaction keeps',
      'protected (recent turns) · 4',
    ])
      expect(english.text).toContain(text);
    expect(english.labels).toEqual(
      expect.arrayContaining(['Close context inspector', 'Estimated context sections']),
    );
    const englishEditor = await render(dialog(), choose);
    for (const text of [
      'Edit provider context',
      `2 messages · ~${(1200).toLocaleString()} tokens in the full request · 2 selected for removal`,
      'Removed with the user message it answers.',
      'Remove 2 messages',
      'Check removal',
    ])
      expect(englishEditor.text).toContain(text);
    expect(englishEditor.labels).toEqual(
      expect.arrayContaining(['Remove message 1 (user)', 'Context messages']),
    );

    await surfaceI18n.changeLanguage('tr');
    const turkish = await render(panel());
    for (const text of [
      'Bağlam ve talimatlar',
      'Tahmini güncel token',
      'Bildirilmedi',
      'Araç tanımları · 2',
      'Geçerli talimatları oku',
      'Agresif sıkıştır',
      'Bağlam modları',
      'focus · uyarı %50 · sıkıştırma %60 · kesin sınır %80 · son 4 turu tutar · özel',
      'Kullanımda',
      'Son isteğin önbellek düzeni · isabet — önek beklendiği gibi yeniden kullanıldı',
      'Sonraki sıkıştırmanın tuttukları',
      'korunuyor (son turlar) · 4',
    ])
      expect(turkish.text).toContain(text);
    const turkishEditor = await render(dialog(), choose);
    for (const text of [
      'Sağlayıcı bağlamını düzenle',
      `2 mesaj · tam istekte ~${(1200).toLocaleString()} token · çıkarılmak üzere 2 seçili`,
      'Yanıtladığı kullanıcı mesajıyla birlikte çıkarıldı.',
      '2 mesajı çıkar',
      'Çıkarmayı denetle',
    ])
      expect(turkishEditor.text).toContain(text);
    expect(turkishEditor.labels).toEqual(expect.arrayContaining(['1. mesajı çıkar (user)']));
  });
});

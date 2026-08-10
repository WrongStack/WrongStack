// @vitest-environment jsdom

import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrainPanel } from '../src/brain-panel.js';
import { Composer } from '../src/composer.js';
import { FileDiffPanel } from '../src/file-diff-panel.js';
import { createMailboxStore } from '../src/lib/mailbox-store.js';
import { MailboxSidebar } from '../src/mailbox-sidebar.js';
import { MemoryDrawer } from '../src/memory-drawer.js';
import { ToolCallEntry } from '../src/tool-call-entry.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function mount(element: React.ReactElement): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(element));
  return container;
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function socketHarness() {
  const handlers: Array<(message: { type: string; payload?: unknown }) => void> = [];
  return {
    handlers,
    socket: {
      send: vi.fn(),
      onMessage: vi.fn((handler) => {
        handlers.push(handler);
        return vi.fn();
      }),
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('SimpleUI socket-backed panels', () => {
  it('loads brain status and submits a question', () => {
    const { socket, handlers } = socketHarness();
    const container = mount(<BrainPanel socketRef={{ current: socket } as never} />);
    act(() => (container.querySelector('.brain-panel-trigger') as HTMLButtonElement).click());
    expect(socket.send).toHaveBeenCalledWith('brain.status');

    act(() => {
      for (const handler of handlers) {
        handler({
          type: 'brain.status',
          payload: {
            maxAutoRisk: 'high',
            log: [{ at: 1, kind: 'review', question: 'Safe?', outcome: 'high' }],
          },
        });
      }
    });
    expect(container.textContent).toContain('Auto-risk: high');
    expect(container.textContent).toContain('Safe? → high');

    const input = container.querySelector('input') as HTMLInputElement;
    act(() => setValue(input, ' Should we proceed? '));
    act(() => (container.querySelector('.brain-panel-ask button') as HTMLButtonElement).click());
    expect(socket.send).toHaveBeenCalledWith('brain.ask', { question: 'Should we proceed?' });

    act(() => {
      for (const handler of handlers) {
        handler({
          type: 'brain.answer',
          payload: { question: 'Should we proceed?', decision: { reason: 'Yes, guarded.' } },
        });
      }
    });
    expect(container.textContent).toContain('Yes, guarded.');
  });

  it('searches memory by path and renders nested memory matches', () => {
    const { socket, handlers } = socketHarness();
    const container = mount(<MemoryDrawer socketRef={{ current: socket } as never} />);
    act(() => (container.querySelector('.memory-drawer-trigger') as HTMLButtonElement).click());
    const input = container.querySelector('input') as HTMLInputElement;
    act(() => setValue(input, ' src/app.ts '));
    act(() =>
      (container.querySelector('.memory-drawer-search button') as HTMLButtonElement).click(),
    );
    expect(socket.send).toHaveBeenCalledWith('memory.sage.forFile', {
      filePath: 'src/app.ts',
      limit: 20,
    });

    act(() => {
      handlers.at(-1)?.({
        type: 'memory.sage.forFile',
        payload: {
          response: {
            primaryMatches: [
              {
                memory: {
                  id: 'm1',
                  text: 'Keep this contract.',
                  kind: 'decision',
                  tags: ['ipc', 'owner'],
                  anchors: [{ type: 'file', path: 'src/app.ts' }],
                },
              },
            ],
          },
        },
      });
    });
    expect(container.textContent).toContain('Keep this contract.');
    expect(container.textContent).toContain('ipc, owner');
    expect(container.textContent).toContain('src/app.ts');
  });

  it('loads current content when a changed file has no inline diff', () => {
    const { socket, handlers } = socketHarness();
    const onClose = vi.fn();
    const container = mount(
      <FileDiffPanel
        files={[{ path: 'src/app.ts', replacements: 2 }] as never}
        socketRef={{ current: socket } as never}
        onClose={onClose}
      />,
    );
    expect(socket.send).toHaveBeenCalledWith('files.read', { filePath: 'src/app.ts' });
    expect(container.textContent).toContain('Loading file content');

    act(() =>
      handlers.at(-1)?.({
        type: 'files.read',
        payload: { filePath: 'src/app.ts', content: 'export const ready = true;' },
      }),
    );
    expect(container.textContent).toContain('export const ready = true;');
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('SimpleUI interaction components', () => {
  it('expands tool details and separates replayed SAGE memory from output', () => {
    const output = [
      'updated file',
      '--- SAGE: task-aware project knowledge (Memory Injector) ---',
      '- [project] <memory id="m1">Use one owner.</memory>',
    ].join('\n');
    const container = mount(
      <ToolCallEntry
        toolCall={
          {
            id: 'tool-1',
            name: 'grep',
            status: 'done',
            input: { query: 'owner' },
            output,
            durationMs: 12,
            ts: '2026-08-09T10:00:00Z',
          } as never
        }
      />,
    );
    act(() => (container.querySelector('.timeline-tool-trigger') as HTMLButtonElement).click());
    expect(container.querySelector('.timeline-tool-detail')?.textContent).toContain('updated file');
    expect(container.querySelector('.timeline-tool-memory')?.textContent).toContain(
      'Use one owner',
    );
    expect(container.querySelector('.timeline-tool-detail')?.textContent).not.toContain(
      'Memory Injector',
    );
  });

  it('routes composer permissions, file choices, attachments, and send modes', () => {
    const actions = {
      setDraft: vi.fn(),
      setFileRefs: vi.fn(),
      setFileMention: vi.fn(),
      setFilePickerIndex: vi.fn(),
      submitWith: vi.fn(),
      abort: vi.fn(),
      decideConfirm: vi.fn(),
      selectFile: vi.fn(),
      clearQueue: vi.fn(),
      removeQueued: vi.fn(),
      onAttachImages: vi.fn(),
      onRemoveImage: vi.fn(),
    };
    const props = {
      draft: 'ship it',
      fileRefs: ['src/app.ts'],
      fileMention: { query: 'app', start: 0, end: 4 },
      fileMatches: ['src/app.ts', 'src/api.ts'],
      filePickerIndex: 0,
      fileSearching: false,
      running: true,
      connection: 'open',
      session: { model: 'gpt-5.6' },
      pendingConfirm: { toolName: 'shell', input: { command: 'pnpm test' }, riskTier: 'elevated' },
      notice: null,
      textareaRef: createRef<HTMLTextAreaElement>(),
      queue: [],
      refineState: null,
      attachedImages: [{ id: 'img-1', data: 'x', mime: 'image/png', name: 'shot.png' }],
      visionSupported: true,
      onRefineDecision: vi.fn(),
      onRefineRetry: vi.fn(),
      onRefineRetryFallback: vi.fn(),
      onRefineStartNow: vi.fn(),
      onRefineSendEdited: vi.fn(),
      ...actions,
    } as unknown as React.ComponentProps<typeof Composer>;
    const container = mount(<Composer {...props} />);

    const buttons = [...container.querySelectorAll('button')];
    act(() => buttons.find((button) => button.textContent === 'Allow')?.click());
    expect(actions.decideConfirm).toHaveBeenCalledWith('yes');
    act(() => (container.querySelector('[role="option"]') as HTMLButtonElement).click());
    expect(actions.selectFile).toHaveBeenCalledWith('src/app.ts');
    act(() =>
      (container.querySelector('[aria-label="Remove shot.png"]') as HTMLButtonElement).click(),
    );
    expect(actions.onRemoveImage).toHaveBeenCalledWith('img-1');
    act(() => (container.querySelector('[aria-label="Stop run"]') as HTMLButtonElement).click());
    expect(actions.abort).toHaveBeenCalledOnce();
    act(() =>
      (container.querySelector('[aria-label="Add message to queue"]') as HTMLButtonElement).click(),
    );
    expect(actions.submitWith).toHaveBeenCalledWith('queue');
  });

  it('sends and acts on live mailbox messages', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-09T10:05:00Z'));
    const store = createMailboxStore();
    store.applyMessage({
      type: 'mailbox.messages',
      payload: {
        messages: [
          {
            id: 'mail-1',
            from: 'worker',
            to: 'leader',
            type: 'status',
            subject: 'Audit complete',
            body: 'All checks passed.',
            priority: 'high',
            timestamp: '2026-08-09T10:04:00Z',
            completed: false,
            readByCount: 0,
          },
        ],
      },
    });
    store.applyMessage({
      type: 'mailbox.agents',
      payload: { agents: [{ agentId: 'worker', name: 'Worker', status: 'busy', online: true }] },
    });
    const onSend = vi.fn(() => true);
    const onAction = vi.fn();
    const onRefresh = vi.fn();
    const container = mount(
      <MailboxSidebar store={store} onRefresh={onRefresh} onSend={onSend} onAction={onAction} />,
    );
    expect(container.textContent).toContain('1 UNREAD');
    expect(container.textContent).toContain('Mailbox service online');
    expect(container.textContent).toContain('Audit complete');

    act(() =>
      (container.querySelector('.simple-mailbox-compose-toggle') as HTMLButtonElement).click(),
    );
    act(() => setValue(container.querySelector('textarea') as HTMLTextAreaElement, ' Ready. '));
    act(() =>
      (container.querySelector('.simple-mailbox-compose button') as HTMLButtonElement).click(),
    );
    expect(onSend).toHaveBeenCalledWith({
      to: 'leader',
      subject: 'SimpleUI message',
      body: 'Ready.',
    });
    act(() =>
      (
        container.querySelector('[aria-label="Mark mailbox message read"]') as HTMLButtonElement
      ).click(),
    );
    expect(onAction).toHaveBeenCalledWith('mail-1', 'mark-read');
    act(() =>
      (container.querySelector('[aria-label="Refresh mailbox"]') as HTMLButtonElement).click(),
    );
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});

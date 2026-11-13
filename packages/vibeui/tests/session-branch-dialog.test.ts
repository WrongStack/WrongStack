// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionBranchDialog } from '../src/components/session-branch-dialog';
import type { SessionController } from '../src/lib/use-session';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Frame = { type: string; payload?: unknown };
type Sent = { type: string; payload: Record<string, unknown> };

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = '';
  vi.useRealTimers();
});

const branch = (
  id: string,
  parentBranchId: string | null,
  extra: Partial<{ forkSeq: number; status: string; turnCount: number }> = {},
) => ({
  id,
  name: id,
  parentBranchId,
  forkSeq: extra.forkSeq ?? 0,
  createdAt: '2026-11-12T10:00:00.000Z',
  lastActivityAt: '2026-11-12T10:05:00.000Z',
  status: extra.status ?? 'active',
  turnCount: extra.turnCount ?? 1,
});

const TREE = JSON.stringify({
  activeBranchId: 'main',
  headSeq: 9,
  branches: {
    main: branch('main', null, { turnCount: 3 }),
    'spike-1': branch('spike-1', 'main', { forkSeq: 4, turnCount: 2 }),
    'old-try': branch('old-try', 'main', { forkSeq: 6, status: 'folded' }),
  },
});

function fakeController(
  options: {
    connection?: string;
    sessionId?: string | null;
    sessionLocked?: boolean;
    sendResult?: boolean;
  } = {},
) {
  const listeners = new Set<(frame: Frame) => void>();
  const sent: Sent[] = [];
  const switchSession = vi.fn();
  const notice = vi.fn();
  const controller = {
    state: { id: options.sessionId === undefined ? 'sess-1' : options.sessionId },
    connection: options.connection ?? 'open',
    sessionLocked: options.sessionLocked ?? false,
    send: (type: string, payload: Record<string, unknown> = {}) => {
      sent.push({ type, payload });
      return options.sendResult ?? true;
    },
    subscribe: (listener: (frame: Frame) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    switchSession,
    notice,
  } as unknown as SessionController;
  const emit = async (frame: Frame) => {
    await act(async () => {
      for (const listener of [...listeners]) listener(frame);
    });
  };
  /** Answers the most recent `/tree` request the dialog sent. */
  const reply = async (result: { message?: string; error?: string }) => {
    const last = sent.at(-1);
    if (!last) throw new Error('nothing was sent');
    await emit({
      type: 'command.result',
      payload: { requestId: last.payload.requestId, ...result },
    });
  };
  return { controller, sent, switchSession, notice, emit, reply, listeners };
}

function mount(controller: SessionController, open = true) {
  const onOpenChange = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(createElement(SessionBranchDialog, { open, onOpenChange, controller })));
  return { onOpenChange };
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((item) =>
    item.textContent?.includes(text),
  );
const branchButton = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (item) => item.querySelector('span')?.textContent === name,
  );
const nameInput = () => document.querySelector<HTMLInputElement>('#vibe-branch-name')!;
const keepFilesBox = () =>
  document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')!;

function typeName(value: string) {
  const input = nameInput();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const treeCommand = (sent: Sent) => ({ type: sent.type, args: sent.payload.args });

describe('VibeUI session branch dialog', () => {
  it('stays closed and sends nothing until opened', () => {
    const fake = fakeController();
    mount(fake.controller, false);
    expect(dialog()).toBe(null);
    expect(fake.sent).toEqual([]);
  });

  it('loads the tree with a correlated /tree list --json request and renders the hierarchy', async () => {
    const fake = fakeController();
    mount(fake.controller);
    expect(fake.sent).toHaveLength(1);
    const request = fake.sent[0]!;
    expect(request.type).toBe('command.run');
    expect(request.payload).toMatchObject({
      sessionId: 'sess-1',
      name: 'tree',
      args: 'list --json',
    });
    expect(typeof request.payload.requestId).toBe('string');
    expect(dialog()!.textContent).toContain('Loading session tree…');

    // Unrelated frames and results for other requests are ignored.
    await fake.emit({ type: 'session.updated', payload: {} });
    await fake.emit({
      type: 'command.result',
      payload: { requestId: 'someone-else', message: TREE },
    });
    expect(dialog()!.textContent).toContain('Loading session tree…');

    await fake.reply({ message: TREE });
    expect(fake.listeners.size).toBe(0);

    const main = branchButton('main')!;
    expect(main.className).toBe('primary-button');
    expect(main.disabled).toBe(true);
    expect(main.textContent).toContain('(3t)');

    const spike = branchButton('spike-1')!;
    expect(spike.className).toBe('secondary-button');
    expect(spike.disabled).toBe(false);
    expect(spike.textContent).toContain('(2t)');
    expect((spike.parentElement as HTMLElement).style.paddingLeft).toBe('14px');

    // Only active child branches can be folded: never the root, never an already folded branch.
    const folds = [...document.querySelectorAll<HTMLButtonElement>('button[title^="Fold "]')];
    expect(folds.map((item) => item.title)).toEqual(['Fold spike-1 into main']);
    expect(branchButton('old-try')).toBeDefined();
  });

  it('shows the single-branch hint when the tree payload is not parseable', async () => {
    const fake = fakeController();
    mount(fake.controller);
    await fake.reply({ message: 'Session tree is unavailable' });
    expect(dialog()!.textContent).toContain('Single main branch active. Fork a new branch below.');
    expect(branchButton('main')).toBeUndefined();
  });

  it('reports an offline workspace without sending anything', async () => {
    const fake = fakeController({ connection: 'closed' });
    await act(async () => {
      mount(fake.controller);
    });
    expect(fake.sent).toEqual([]);
    expect(dialog()!.textContent).toContain('Workspace connection is offline.');
  });

  it('reports a missing session as offline too', async () => {
    const fake = fakeController({ sessionId: null });
    await act(async () => {
      mount(fake.controller);
    });
    expect(fake.sent).toEqual([]);
    expect(dialog()!.textContent).toContain('Workspace connection is offline.');
  });

  it('surfaces a send failure and a server-side error', async () => {
    const failing = fakeController({ sendResult: false });
    await act(async () => {
      mount(failing.controller);
    });
    expect(dialog()!.textContent).toContain('Could not send /tree command.');
    expect(failing.listeners.size).toBe(0);

    act(() => {
      for (const root of roots.splice(0)) root.unmount();
    });
    document.body.innerHTML = '';

    const erroring = fakeController();
    mount(erroring.controller);
    await erroring.reply({ message: '', error: 'Session tree is unavailable.' });
    expect(dialog()!.textContent).toContain('Session tree is unavailable.');
  });

  it('times out when no result arrives', async () => {
    vi.useFakeTimers();
    const fake = fakeController();
    mount(fake.controller);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(dialog()!.textContent).toContain('Timed out waiting for session tree response.');
    expect(fake.listeners.size).toBe(0);
  });

  it('switches branches, honouring keep-files, then reloads, refreshes the transcript and notices', async () => {
    const fake = fakeController();
    mount(fake.controller);
    await fake.reply({ message: TREE });

    act(() => keepFilesBox().click());
    expect(keepFilesBox().checked).toBe(true);

    act(() => branchButton('spike-1')!.click());
    expect(treeCommand(fake.sent.at(-1)!)).toEqual({
      type: 'command.run',
      args: 'switch spike-1 --keep-files',
    });
    // Busy state locks every action while the mutation is in flight.
    expect(button('Fold')!.disabled).toBe(true);

    await fake.reply({ message: '  Switched from main to spike-1.  \nrestored 3 files' });
    expect(treeCommand(fake.sent.at(-1)!).args).toBe('list --json');
    expect(fake.switchSession).not.toHaveBeenCalled();

    await fake.reply({
      message: TREE.replace('"activeBranchId":"main"', '"activeBranchId":"spike-1"'),
    });
    expect(fake.switchSession).toHaveBeenCalledWith('sess-1');
    expect(fake.notice).toHaveBeenCalledWith('Switched from main to spike-1.');
    expect(branchButton('spike-1')!.className).toBe('primary-button');
    expect(branchButton('main')!.disabled).toBe(false);
  });

  it('switches without --keep-files by default and folds a child branch', async () => {
    const fake = fakeController();
    mount(fake.controller);
    await fake.reply({ message: TREE });

    act(() => branchButton('spike-1')!.click());
    expect(treeCommand(fake.sent.at(-1)!).args).toBe('switch spike-1');
    await fake.reply({ message: '' });
    await fake.reply({ message: TREE });
    expect(fake.notice).not.toHaveBeenCalled();

    act(() => button('Fold')!.click());
    expect(treeCommand(fake.sent.at(-1)!).args).toBe('fold spike-1');
    await fake.reply({ message: 'Folded branch spike-1 → main.' });
    await fake.reply({ message: TREE });
    expect(fake.switchSession).toHaveBeenCalledTimes(2);
    expect(fake.notice).toHaveBeenCalledWith('Folded branch spike-1 → main.');
  });

  it('keeps a failed mutation error visible without reloading or switching', async () => {
    const fake = fakeController();
    mount(fake.controller);
    await fake.reply({ message: TREE });

    act(() => button('Fold')!.click());
    const before = fake.sent.length;
    await fake.reply({ message: '', error: 'Fold failed: branch has no new turns.' });
    expect(fake.sent).toHaveLength(before);
    expect(dialog()!.textContent).toContain('Fold failed: branch has no new turns.');
    expect(fake.switchSession).not.toHaveBeenCalled();
    expect(button('Fold')!.disabled).toBe(false);
  });

  it('forks a trimmed branch name, clears the field and does not refresh the transcript', async () => {
    const fake = fakeController();
    mount(fake.controller);
    await fake.reply({ message: TREE });

    const create = button('Create branch')!;
    expect(create.disabled).toBe(true);
    typeName('   ');
    expect(create.disabled).toBe(true);

    // Submitting a blank name is a no-op.
    const before = fake.sent.length;
    act(() => nameInput().form!.requestSubmit());
    expect(fake.sent).toHaveLength(before);

    typeName('  auth-spike  ');
    expect(create.disabled).toBe(false);
    act(() => create.click());
    expect(treeCommand(fake.sent.at(-1)!).args).toBe('new auth-spike');
    expect(nameInput().value).toBe('');

    await fake.reply({ message: 'Created and switched to branch auth-spike (b-1) from main.' });
    await fake.reply({ message: TREE });
    expect(fake.switchSession).not.toHaveBeenCalled();
    expect(fake.notice).toHaveBeenCalledWith(
      'Created and switched to branch auth-spike (b-1) from main.',
    );
  });

  it('disables every mutation while the session is locked', async () => {
    const fake = fakeController({ sessionLocked: true });
    mount(fake.controller);
    await fake.reply({ message: TREE });
    typeName('auth-spike');
    expect(branchButton('spike-1')!.disabled).toBe(true);
    expect(button('Fold')!.disabled).toBe(true);
    expect(button('Create branch')!.disabled).toBe(true);
  });

  it('closes through the Close button', async () => {
    const fake = fakeController();
    const { onOpenChange } = mount(fake.controller);
    await fake.reply({ message: TREE });
    act(() => button('Close')!.click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

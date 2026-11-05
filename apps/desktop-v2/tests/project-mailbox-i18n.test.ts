// @vitest-environment jsdom

import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { emptyEngineState } from '../src/engine-state';
import { MailboxComposer } from '../src/MailboxComposer';
import { emptyMailDraft } from '../src/mailbox-model';
import { ProjectMailbox } from '../src/ProjectMailbox';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no modal dialogs; opening one only has to mark it open here.
HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
  this.open = false;
};

const mail = {
  id: 'm1',
  from: 'lead',
  to: 'desktop',
  subject: 'Plan',
  body: 'Ship it',
  type: 'note',
  priority: 'high',
  audience: 'leaders',
  timestamp: 1_700_000_000_000,
  completed: false,
  readByCount: 0,
};
const command = () =>
  vi.fn(async (type: string) =>
    type === 'mailbox.messages'
      ? { messages: [mail] }
      : { agents: [{ agentId: 'w1', name: 'Worker', online: true }] },
  );

/** Renders a page, optionally clicks the first element matching `click`, then reads it. */
async function mount(page: ReactElement, click?: string) {
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | undefined;
  await act(async () => {
    root = createRoot(host);
    root.render(page);
  });
  await act(async () => {});
  if (click)
    await act(async () => {
      (host.querySelector(click) as HTMLElement | null)?.click();
    });
  const text = document.body.textContent ?? '';
  const labels = [...document.body.querySelectorAll('[aria-label]')].map((node) =>
    node.getAttribute('aria-label'),
  );
  act(() => root?.unmount());
  host.remove();
  return { text, labels };
}

const mailbox = () =>
  createElement(ProjectMailbox, {
    command: command(),
    projectId: 'mail',
    state: emptyEngineState,
  });
const composer = () =>
  createElement(MailboxComposer, {
    draft: { ...emptyMailDraft(), replyTo: 'm1' },
    setDraft: vi.fn(),
    busy: false,
    replacement: null,
    setReplacement: vi.fn(),
    setComposing: vi.fn(),
    send: vi.fn(),
    displayedError: '',
  });

describe('the project mailbox in the display language', () => {
  afterAll(() => surfaceI18n.changeLanguage('en'));

  it('shows the mailbox and a conversation in English, then in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    let page = await mount(mailbox(), '.mailbox-thread');
    for (const text of [
      'Refresh mailbox',
      'All recent messages',
      '1 message · 1 conversation',
      '1 loaded message in this conversation',
      'Note',
      'High',
      'Audience: Leaders only',
      'Mark read',
      'Registered agents (1)',
      'Retention and maintenance',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining(['Project mailbox', 'Mailbox actor', 'Search mailbox messages']),
    );

    await surfaceI18n.changeLanguage('tr');
    page = await mount(mailbox(), '.mailbox-thread');
    for (const text of [
      'Posta kutusunu yenile',
      'Tüm son mesajlar',
      '1 mesaj · 1 konuşma',
      'Bu konuşmada 1 yüklü mesaj',
      'Yüksek',
      'Hedef kitle: Yalnızca liderler',
      'Okundu işaretle',
      'Kayıtlı ajanlar (1)',
      'Saklama ve bakım',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining([
        'Proje posta kutusu',
        'Posta kutusu aktörü',
        'Posta kutusu mesajlarında ara',
      ]),
    );
  });

  it('shows the composer in English, then in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    let page = await mount(composer());
    for (const text of ['PROJECT MAILBOX', 'Reply to message', 'Reply reference: m1', 'Ask'])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining(['Mailbox recipient', 'Mailbox message type', 'Mailbox subject']),
    );

    await surfaceI18n.changeLanguage('tr');
    page = await mount(composer());
    for (const text of ['PROJE POSTA KUTUSU', 'Mesajı yanıtla', 'Yanıt referansı: m1', 'Soru'])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining(['Posta kutusu alıcısı', 'Posta kutusu mesaj türü']),
    );
  });
});

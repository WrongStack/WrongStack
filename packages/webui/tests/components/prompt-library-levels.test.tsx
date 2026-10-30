import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import prompt from '../../../core/data/prompts/prompts/design/fluidflow-design-d2-glassmorphism-style.json';

const transport = vi.hoisted(() => ({
  listeners: new Map<string, (message: unknown) => void>(),
  insert: vi.fn(),
  deferContent: false,
  requests: [] as { slug?: string; requestId?: string }[],
}));
vi.mock('@/hooks/useWebSocket', () => ({ useWebSocket: () => ({ client }) }));
vi.mock('@/stores', () => ({
  useUIStore: (selector: (s: unknown) => unknown) =>
    selector({
      promptLibraryOpen: true,
      setPromptLibraryOpen: () => {},
      requestPromptInsert: transport.insert,
    }),
}));
vi.mock('@/i18n', () => ({
  i18n: { t: (key: string) => key },
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

const client = {
  on(type: string, listener: (message: unknown) => void) {
    transport.listeners.set(type, listener);
  },
  off(type: string) {
    transport.listeners.delete(type);
  },
  send(message: { type: string; payload?: { slug?: string; requestId?: string } }) {
    if (message.type === 'prompts.list')
      transport.listeners.get(message.type)?.({
        payload: {
          prompts: [prompt, { ...prompt, slug: 'other', title: 'Other style' }],
          categories: [{ id: 'design', label: 'Design & Style', count: 1 }],
        },
      });
    if (message.type === 'prompts.content') {
      transport.requests.push(message.payload ?? {});
      if (!transport.deferContent)
        transport.listeners.get(message.type)?.({
          payload: { ...prompt, found: true, requestId: message.payload?.requestId },
        });
    }
  },
};

import { PromptLibraryModal } from '../../src/components/PromptLibraryModal.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  transport.listeners.clear();
  transport.insert.mockClear();
  transport.deferContent = false;
  transport.requests.length = 0;
});

describe('prompt detail levels', () => {
  it('keeps a variable field mounted and focused while its name is edited', () => {
    render(<PromptLibraryModal />);
    fireEvent.click(screen.getByRole('button', { name: 'activity:promptLib.newPrompt' }));
    fireEvent.click(screen.getByRole('button', { name: 'activity:promptLib.addVar' }));
    const name = screen.getByRole('textbox', { name: 'activity:promptLib.varNamePlaceholder' });
    name.focus();
    fireEvent.change(name, { target: { value: 'workspace' } });
    expect(document.activeElement).toBe(name);
    expect(screen.getByRole('textbox', { name: 'activity:promptLib.varNamePlaceholder' })).toBe(
      name,
    );
  });

  it('updates the selected favorite without reloading its preview or resetting its level', () => {
    const send = vi.spyOn(client, 'send');
    render(<PromptLibraryModal />);
    fireEvent.click(screen.getByText(prompt.title));
    const level = screen.getByRole('combobox', { name: 'activity:promptLib.detailLevel' });
    fireEvent.change(level, { target: { value: 'advanced' } });
    const star = screen.getByTitle('activity:promptLib.toggleFavoriteTitle');
    expect(star.textContent).toBe('☆');
    fireEvent.click(star);
    expect(star.textContent).toBe('★');
    expect(send).toHaveBeenCalledWith({
      type: 'prompts.favorite',
      payload: { slug: prompt.slug, favorite: true },
    });
    fireEvent.click(star);
    expect(star.textContent).toBe('☆');
    expect(send).toHaveBeenCalledWith({
      type: 'prompts.favorite',
      payload: { slug: prompt.slug, favorite: false },
    });
    expect((level as HTMLSelectElement).value).toBe('advanced');
    expect(transport.requests).toHaveLength(1);
    send.mockRestore();
  });

  it.each([undefined, 'foreign-request'])('ignores unowned content replies (%s)', (foreignId) => {
    transport.deferContent = true;
    render(<PromptLibraryModal />);
    fireEvent.click(screen.getByText(prompt.title));
    const currentRequest = transport.requests[0];
    const reply = (requestId: string | undefined) =>
      act(() => {
        transport.listeners.get('prompts.content')?.({
          payload: { ...prompt, found: true, requestId },
        });
      });
    reply(foreignId);
    expect(
      (
        screen.getByRole('button', {
          name: 'activity:promptLib.insertIntoChat',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    reply(currentRequest.requestId);
    expect(
      (
        screen.getByRole('button', {
          name: 'activity:promptLib.insertIntoChat',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it('ignores superseded replies after selecting the same prompt again', () => {
    transport.deferContent = true;
    render(<PromptLibraryModal />);
    fireEvent.click(screen.getByText(prompt.title));
    fireEvent.click(screen.getByText('Other style'));
    fireEvent.click(screen.getByText(prompt.title));
    const [oldRequest, , currentRequest] = transport.requests;
    expect(transport.requests).toHaveLength(3);
    const reply = (requestId: string | undefined, text: string) =>
      act(() => {
        transport.listeners.get('prompts.content')?.({
          payload: {
            slug: prompt.slug,
            found: true,
            requestId,
            content: text,
            variants: { simple: `${text} simple`, detailed: text, advanced: `${text} advanced` },
          },
        });
      });
    reply(currentRequest.requestId, 'Current design');
    fireEvent.change(screen.getByRole('combobox', { name: 'activity:promptLib.detailLevel' }), {
      target: { value: 'advanced' },
    });
    expect(screen.getByText('Current design advanced')).toBeDefined();
    reply(oldRequest.requestId, 'Superseded design');
    fireEvent.click(screen.getByRole('button', { name: 'activity:promptLib.insertIntoChat' }));
    expect(transport.insert).toHaveBeenCalledWith('Current design advanced');
  });

  it('previews and inserts the selected original design prompt without submitting it', async () => {
    render(<PromptLibraryModal />);
    fireEvent.click(screen.getByText(prompt.title));
    expect(await screen.findByText(prompt.variants.detailed)).toBeDefined();
    fireEvent.change(screen.getByRole('combobox', { name: 'activity:promptLib.detailLevel' }), {
      target: { value: 'advanced' },
    });
    expect(screen.getByText(prompt.variants.advanced)).toBeDefined();
    expect(transport.insert).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'activity:promptLib.insertIntoChat' }));
    expect(transport.insert).toHaveBeenCalledWith(prompt.variants.advanced);
  });

  it('resets the selected level when another prompt is selected', async () => {
    render(<PromptLibraryModal />);
    fireEvent.click(screen.getByText(prompt.title));
    const level = await screen.findByRole('combobox', { name: 'activity:promptLib.detailLevel' });
    fireEvent.change(level, { target: { value: 'simple' } });
    await act(async () => {
      transport.listeners.get('prompts.list')?.({
        payload: { prompts: [{ ...prompt, slug: 'other', title: 'Other style' }] },
      });
    });
    fireEvent.click(screen.getByText('Other style'));
    // The fixture intentionally replies with the old slug: it must not replace the new selection.
    expect(screen.queryByRole('combobox', { name: 'activity:promptLib.detailLevel' })).toBeNull();
    expect(screen.queryByText(prompt.variants.simple)).toBeNull();
  });
});

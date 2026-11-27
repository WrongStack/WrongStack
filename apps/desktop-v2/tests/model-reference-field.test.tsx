/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AvailabilitySettings } from '../src/AvailabilitySettings';
import { BrainTargetEditor } from '../src/BrainTargetEditor';
import { RefinementPolicySettings } from '../src/RefinementPolicySettings';

/** Two saved providers, each with one model, as the engine reports them. */
const command = vi.fn(async (type: string, payload: Record<string, unknown> = {}) => {
  if (type === 'providers.saved') return { providers: [{ id: 'desktop-local' }, { id: 'openai' }] };
  if (type === 'providers.list')
    return {
      providers: [
        { id: 'desktop-local', name: 'Desktop Local' },
        { id: 'openai', name: 'OpenAI' },
      ],
    };
  if (type === 'provider.models')
    return {
      provider: payload['providerId'],
      models:
        payload['providerId'] === 'openai'
          ? [{ id: 'gpt-x', name: 'GPT X' }]
          : [{ id: 'fixture', name: 'Fixture Model', contextWindow: 1000 }],
    };
  return {};
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(element: ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(element);
  });
  // The catalogs arrive through two chained engine replies.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return host;
}

beforeEach(() => {
  command.mockClear();
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  host?.remove();
  root = null;
  host = null;
});

const field = (label: string) =>
  host!.querySelector<HTMLInputElement>(`input[aria-label="${label}"][role="combobox"]`)!;
const type = (label: string, text: string) =>
  act(async () => {
    const input = field(label);
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const clickOption = (text: string) =>
  act(async () => {
    const option = [...host!.querySelectorAll('[role="option"]')].find(
      (item) => item.querySelector('strong')?.textContent === text,
    );
    if (!option) throw Error(`No option ${text}`);
    option.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    option.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
/** The chevron lists every choice again after typing narrowed them (a second click reopens). */
const click = (element: Element) =>
  act(async () => {
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
const browse = (label: string) =>
  act(async () => {
    const input = field(label);
    const chevron = input.parentElement!.querySelector('button.is-chevron')!;
    if (input.getAttribute('aria-expanded') === 'true') await click(chevron);
    await click(chevron);
  });

describe('model reference fields across the settings pages', () => {
  it('holds one reference per Brain target, split into provider and model for the engine', async () => {
    const onChange = vi.fn();
    await mount(
      createElement(BrainTargetEditor, {
        value: {
          strategy: 'fallback',
          pool: [{ provider: '', model: '' }],
          voters: [],
          seats: [],
          judge: { provider: '', model: '' },
        },
        onChange,
        snapshot: { personaCatalog: [] },
        command: command as never,
      }),
    );
    // One field replaces the former saved-model select and the two text inputs.
    expect(host!.querySelectorAll('input[role="combobox"]')).toHaveLength(2);
    expect(host!.querySelector('select[aria-label$="saved model"]')).toBeNull();
    await type('Brain pool model 1 model', 'desktop-local/fixture');
    expect(onChange.mock.lastCall![0].pool[0]).toEqual({
      provider: 'desktop-local',
      model: 'fixture',
    });
    // A model ID alone inherits the runtime provider.
    await type('Brain pool model 1 model', 'bare-model');
    expect(onChange.mock.lastCall![0].pool[0]).toEqual({ provider: '', model: 'bare-model' });
    // A saved choice is named as its catalog names it and carries both parts.
    await browse('Brain pool model 1 model');
    await clickOption('GPT X');
    expect(onChange.mock.lastCall![0].pool[0]).toEqual({ provider: 'openai', model: 'gpt-x' });
  });

  it('writes the refiner reference into the provider and model settings', async () => {
    const change = vi.fn();
    await mount(
      createElement(RefinementPolicySettings, {
        draft: {},
        saved: {},
        change,
        command: command as never,
      }),
    );
    await type('Refiner model', 'desktop-local/fixture');
    expect(change.mock.calls).toEqual([
      ['refinerProvider', 'desktop-local'],
      ['refinerModel', 'fixture'],
    ]);
    await type('Refiner model', 'lone');
    expect(change.mock.calls.slice(-2)).toEqual([
      ['refinerProvider', ''],
      ['refinerModel', 'lone'],
    ]);
  });

  it('keeps a rule’s provider when only the model is typed, and overrides it with a reference', async () => {
    const change = vi.fn();
    await mount(
      createElement(AvailabilitySettings, {
        draft: {
          modelAvailabilitySchedule: [
            {
              id: 'r1',
              enabled: true,
              provider: 'openai',
              model: '',
              mode: 'blackout',
              start: '00:00',
              end: '08:00',
            },
          ],
        },
        change,
        command: command as never,
      }),
    );
    // With a provider chosen, the model choices are that provider's, committed bare.
    await browse('Window 1 model');
    await clickOption('GPT X');
    expect(change.mock.lastCall).toEqual([
      'modelAvailabilitySchedule',
      [expect.objectContaining({ provider: 'openai', model: 'gpt-x' })],
    ]);
    await type('Window 1 model', 'zai/glm');
    expect(change.mock.lastCall![1][0]).toEqual(
      expect.objectContaining({ provider: 'zai', model: 'glm' }),
    );
    // The provider field offers "any provider" as a real choice.
    await browse('Window 1 provider');
    expect([...host!.querySelectorAll('[role="option"]')].map((item) => item.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('Any provider')]),
    );
  });
});

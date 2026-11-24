// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { EngineReplyError } from '../src/engine-operations';
import { emptyEngineState } from '../src/engine-state';
import { ProviderHqImport } from '../src/ProviderHqImport';
import { providerChoices } from '../src/provider-settings-model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Reply = Record<string, unknown> | Error;

/** A command that answers each request type from a queue (last answer repeats). */
function engine(answers: Record<string, Reply[]>) {
  return vi.fn(
    async (
      type: string,
      _payload: Record<string, unknown>,
      _replies?: unknown,
      _options?: unknown,
    ) => {
      const queue = answers[type] ?? [];
      const answer = queue.length > 1 ? queue.shift()! : queue[0];
      if (!answer) throw new Error(`unexpected ${type}`);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  );
}

async function mount(command: ReturnType<typeof engine>, onChanged = vi.fn()) {
  const host = document.createElement('div');
  // Connected: jsdom submits only a form that is in the document.
  document.body.appendChild(host);
  await act(async () =>
    createRoot(host).render(
      createElement(ProviderHqImport, { command: command as never, connected: true, onChanged }),
    ),
  );
  return { host, onChanged };
}

function button(host: HTMLElement, name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
  if (!found) throw new Error(`no button ${name}`);
  return found;
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const enrolled = {
  available: true,
  enrolled: true,
  hqUrl: 'https://hq.example',
  hqFingerprint: 'aa',
  deviceFingerprint: 'bb',
  granted: [{ id: 'team', type: 'openai', family: 'openai-compatible' }, { type: 'nameless' }],
};

describe('Import from HQ in Desktop provider settings', () => {
  it('marks HQ-managed saved connections', () => {
    const choices = providerChoices({
      ...emptyEngineState,
      results: {
        'providers.saved': {
          providers: [{ id: 'team', hq: { profileId: 'team' } }, { id: 'mine' }],
        },
      },
    });
    expect(choices.find((c) => c.id === 'team')?.hq).toBe(true);
    expect(choices.find((c) => c.id === 'mine')?.hq).toBeUndefined();
  });

  it('shows nothing on an engine without an HQ client', async () => {
    const { host } = await mount(engine({ 'hq.status': [{ available: false, enrolled: false }] }));
    expect(host.textContent).toBe('');
  });

  it('enrolls, imports and refreshes the saved list, and shows a refusal with its state', async () => {
    const command = engine({
      'hq.status': [{ available: true, enrolled: false }],
      'hq.enroll': [enrolled],
      'hq.import': [{ ...enrolled, report: ['Added team', 1] }],
      'hq.unenroll': [
        new EngineReplyError('HQ unreachable', {
          available: true,
          enrolled: true,
          hqUrl: 'https://hq.example',
          error: 'HQ unreachable',
        }),
      ],
    });
    const { host, onChanged } = await mount(command);
    const [url, token] = [...host.querySelectorAll('input')];
    await act(async () => {
      type(url!, 'https://hq.example');
      type(token!, 'WSHQ-code');
    });
    await act(async () => button(host, 'Connect this machine').click());
    expect(command).toHaveBeenLastCalledWith(
      'hq.enroll',
      { hqUrl: 'https://hq.example', token: 'WSHQ-code' },
      ['hq.state'],
      { timeoutMs: 45_000 },
    );
    expect(host.textContent).toContain('Connected to https://hq.example');
    expect(host.textContent).toContain('team · openai-compatible');
    expect(host.textContent).toContain('HQ aa · this machine bb');
    expect(host.querySelectorAll('li')).toHaveLength(1);
    expect(onChanged).not.toHaveBeenCalled();

    await act(async () => button(host, 'Import all').click());
    expect(command).toHaveBeenLastCalledWith('hq.import', {}, ['hq.state'], { timeoutMs: 45_000 });
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Added team');
    expect(onChanged).toHaveBeenCalledTimes(1);

    await act(async () => button(host, 'Disconnect and remove keys').click());
    expect(command).toHaveBeenLastCalledWith('hq.unenroll', { removeKeys: true }, ['hq.state'], {
      timeoutMs: 45_000,
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('HQ unreachable');
    expect(host.textContent).toContain('Connected to https://hq.example');
  });
});

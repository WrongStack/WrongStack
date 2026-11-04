import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type SurfaceHost, SurfaceHostProvider } from '@wrongstack/project-surfaces/host';
import { afterEach, describe, expect, it, vi } from 'vitest';
// The setup screen lives in the shared package and translates with the app's i18next instance.
import '../../src/i18n';
import { SetupScreen } from '../../src/components/SetupScreen';

afterEach(cleanup);

type Handler = (message: { type: string; payload: unknown }) => void;

/** A setup host on a fake profile connection the test answers frame by frame. */
function fakeSetup(result = { success: true, message: '' }) {
  const handlers = new Map<string, Set<Handler>>();
  const send = vi.fn();
  // One client for every render, as the application's connection is.
  const client = {
    send,
    on: (type: string, handler: Handler) => {
      const set = handlers.get(type) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(type, set);
      return () => {
        set.delete(handler);
      };
    },
  };
  const chooseModel = vi.fn(async () => result);
  const notify = { success: vi.fn(), error: vi.fn() };
  const host = {
    useScrollRestore: () => ({ current: null }),
    setup: {
      useClient: () => client,
      useConnected: () => true,
      useCurrentModel: () => '',
      notify,
      chooseModel,
    },
  } as unknown as SurfaceHost;
  const emit = (type: string, payload: unknown) =>
    act(async () => {
      for (const handler of handlers.get(type) ?? []) handler({ type, payload });
    });
  render(
    <SurfaceHostProvider host={host}>
      <SetupScreen />
    </SurfaceHostProvider>,
  );
  return { send, emit, chooseModel, notify };
}

const openai = {
  id: 'openai',
  name: 'OpenAI',
  family: 'openai',
  envVars: [],
  modelCount: 1,
  hasApiKey: false,
};

/** Saves an OpenAI key and answers until the model list is on screen. */
async function saveKeyAndListModels(setup: ReturnType<typeof fakeSetup>) {
  await setup.emit('provider.catalog', { providers: [openai] });
  // OpenAI leads the popular list; other OpenAI-style providers share its key hint.
  const [key] = screen.getAllByPlaceholderText('sk-...');
  if (!key) throw new Error('No OpenAI key field.');
  fireEvent.change(key, { target: { value: 'sk-test' } });
  fireEvent.keyDown(key, { key: 'Enter' });
  expect(setup.send).toHaveBeenCalledWith({
    type: 'key.add',
    payload: { providerId: 'openai', label: 'default', apiKey: 'sk-test' },
  });
  await setup.emit('key.operation_result', { success: true, message: 'saved' });
  expect(setup.send).toHaveBeenCalledWith({
    type: 'provider.models',
    payload: { providerId: 'openai' },
  });
  await setup.emit('provider.models', {
    provider: 'openai',
    models: [{ id: 'gpt-5', name: 'GPT-5', capabilities: ['tools'] }],
  });
}

describe('SetupScreen on a setup host', () => {
  it('reads the catalog, saves a key, probes it and starts with the only model', async () => {
    const setup = fakeSetup();
    expect(setup.send).toHaveBeenCalledWith({ type: 'providers.list' });
    await saveKeyAndListModels(setup);
    expect(setup.notify.success).toHaveBeenCalled();
    expect(setup.send).toHaveBeenCalledWith({
      type: 'provider.probe',
      payload: { providerId: 'openai' },
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Start Session'));
    });
    expect(setup.chooseModel).toHaveBeenCalledWith('openai', 'gpt-5', true);
    await act(async () => {
      fireEvent.click(screen.getByText('Save Configuration'));
    });
    expect(setup.chooseModel).toHaveBeenLastCalledWith('openai', 'gpt-5', false);
  });

  it("shows the application's refusal of the model", async () => {
    const setup = fakeSetup({ success: false, message: 'The model is not available.' });
    await saveKeyAndListModels(setup);
    await act(async () => {
      fireEvent.click(screen.getByText('Start Session'));
    });
    expect(setup.notify.error).toHaveBeenCalledWith('The model is not available.');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const confirm = vi.hoisted(() => ({ answer: true, asked: 0 }));
vi.mock('../../src/components/ConfirmModal', () => ({
  confirmModal: async () => {
    confirm.asked++;
    return confirm.answer;
  },
}));

type Handler = (message: { type: string; payload: unknown }) => void;

function fakeClient() {
  const handlers = new Map<string, Set<Handler>>();
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const client = {
    on: (type: string, handler: Handler) => {
      const set = handlers.get(type) ?? new Set<Handler>();
      handlers.set(type, set);
      set.add(handler);
      return () => set.delete(handler);
    },
    send: (message: { type: string; payload: Record<string, unknown> }) => sent.push(message),
  };
  const emit = (type: string, payload: unknown) => {
    for (const handler of [...(handlers.get(type) ?? [])]) handler({ type, payload });
  };
  return { client: client as never, sent, emit };
}

const catalog = {
  commands: [
    { name: 'sandbox', aliases: [], description: 'Show the sandbox.', destructive: false },
    { name: 'prune', aliases: ['gc'], description: 'Delete old sessions.', destructive: true },
  ],
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function load() {
  vi.resetModules();
  return import('../../src/components/ChatInput/slash-routing-engine');
}

describe('engine commands in the WebUI chat', () => {
  beforeEach(() => {
    confirm.answer = true;
    confirm.asked = 0;
  });

  it('asks for the catalog once and runs a listed command into the chat', async () => {
    const bridge = await load();
    const { client, sent, emit } = fakeClient();
    bridge.requestEngineCommands(client);
    bridge.requestEngineCommands(client);
    expect(sent).toEqual([{ type: 'command.list', payload: {} }]);
    emit('command.catalog', catalog);

    const messages: Array<{ content: string }> = [];
    expect(
      bridge.runEngineSlashCommand('/sandbox', '--audit', client, (m) => messages.push(m)),
    ).toBe(true);
    const run = sent[1];
    expect(run).toMatchObject({
      type: 'command.run',
      payload: { name: 'sandbox', args: '--audit' },
    });
    emit('command.result', { requestId: 'other', name: 'sandbox', message: 'not ours' });
    emit('command.result', {
      requestId: run?.payload['requestId'],
      name: 'sandbox',
      message: 'mode: off',
    });
    expect(messages).toEqual([{ role: 'assistant', content: '```text\nmode: off\n```' }]);
  });

  it('sends the follow-up turn a command asks for as the user', async () => {
    const bridge = await load();
    const { client, sent, emit } = fakeClient();
    bridge.requestEngineCommands(client);
    emit('command.catalog', catalog);
    const followUps: string[] = [];
    bridge.runEngineSlashCommand(
      '/sandbox',
      'deep',
      client,
      () => undefined,
      (text) => followUps.push(text),
    );
    const run = sent.find((message) => message.type === 'command.run');
    emit('command.result', {
      requestId: run?.payload['requestId'],
      name: 'sandbox',
      message: 'report',
      runText: 'Plan the fixes.',
    });
    expect(followUps).toEqual(['Plan the fixes.']);
  });

  it('leaves unknown names to the model and confirms destructive commands', async () => {
    const bridge = await load();
    const { client, sent, emit } = fakeClient();
    bridge.requestEngineCommands(client);
    emit('command.catalog', catalog);
    expect(bridge.runEngineSlashCommand('/nonsense', '', client, () => undefined)).toBe(false);

    confirm.answer = false;
    expect(bridge.runEngineSlashCommand('/gc', '14', client, () => undefined)).toBe(true);
    await settle();
    expect(confirm.asked).toBe(1);
    expect(sent.filter((message) => message.type === 'command.run')).toEqual([]);

    confirm.answer = true;
    bridge.runEngineSlashCommand('/gc', '14', client, () => undefined);
    await settle();
    expect(sent.filter((message) => message.type === 'command.run')).toHaveLength(1);
    // A dry run deletes nothing and is not asked about.
    bridge.runEngineSlashCommand('/prune', '--dry-run', client, () => undefined);
    expect(confirm.asked).toBe(2);
  });
});

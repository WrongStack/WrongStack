/**
 * Per-session config options (`ProtocolHandlerOptions.sessionConfigOptions`):
 * the hook a host uses to offer a model picker whose values depend on what is
 * configured when the session opens.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ACPProtocolHandler,
  type ProtocolHandlerOptions,
  type RunTurn,
  type SessionConfigOption,
  type SessionState,
} from '../src/agent/protocol-handler.js';
import type { AgentServerTransport } from '../src/agent/stdio-transport.js';

const CWD = process.cwd();
const RUN_TURN: RunTurn = async () => ({ stopReason: 'end_turn' });

function modelOption(currentValue = 'openai/gpt-x'): SessionConfigOption {
  return {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue,
    options: [
      {
        group: 'openai',
        name: 'openai',
        options: [
          { value: 'openai/gpt-x', name: 'GPT X' },
          { value: 'openai/gpt-y', name: 'GPT Y' },
        ],
      },
      {
        group: 'openrouter',
        name: 'openrouter',
        options: [{ value: 'openrouter/a/b', name: 'a/b' }],
      },
    ],
  };
}

function memoryStore() {
  const saved = new Map<string, Partial<SessionState> & { history?: unknown }>();
  return {
    saved,
    save: vi.fn(async (state: SessionState, history?: unknown) => {
      saved.set(
        state.id,
        structuredClone({ ...state, abort: undefined, ...(history ? { history } : {}) }) as never,
      );
    }),
    load: vi.fn(async (id: string) => (saved.get(id) as never) ?? null),
  };
}

function makeHandler(opts: Partial<ProtocolHandlerOptions> = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const transport = {
    send: vi.fn(async (m: Record<string, unknown>) => {
      sent.push(m);
    }),
  } as never as AgentServerTransport;
  const handler = new ACPProtocolHandler({
    transport,
    defaultCwd: CWD,
    runTurn: RUN_TURN,
    ...opts,
  });
  const call = async (id: number, method: string, params?: unknown) => {
    await handler.handleMessage({ id, method, params });
    return sent.findLast((m) => m['id'] === id) as {
      result?: Record<string, unknown>;
      error?: { code: number; message: string };
    };
  };
  return { handler, sent, call };
}

describe('session config options built per session', () => {
  it('drops the persisted YOLO+ choice when the new host offers only standard modes', async () => {
    const mode = (currentValue: string, values: string[]): SessionConfigOption => ({
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue,
      options: values.map((value) => ({ value, name: value })),
    });
    const standard = { id: 'default', name: 'Default', description: 'Ask' };
    const plus = { id: 'yolo-plus', name: 'YOLO+', description: 'Host opted in' };
    const store = memoryStore();
    const first = makeHandler({
      store,
      modes: [plus, standard],
      configOptions: [mode('yolo-plus', ['yolo-plus', 'default'])],
    });
    await first.call(1, 'initialize', { protocolVersion: 1 });
    const { result } = await first.call(2, 'session/new', { cwd: CWD, mcpServers: [] });
    const sessionId = result?.['sessionId'];
    const second = makeHandler({
      store,
      modes: [standard],
      configOptions: [mode('default', ['default'])],
    });
    await second.call(1, 'initialize', { protocolVersion: 1 });
    const reopened = await second.call(2, 'session/load', { sessionId, cwd: CWD, mcpServers: [] });
    expect(reopened.result?.['modes']).toMatchObject({
      currentModeId: 'default',
      availableModes: [standard],
    });
    expect(reopened.result?.['configOptions']).toEqual([mode('default', ['default'])]);
    const rejected = await second.call(3, 'session/set_config_option', {
      sessionId,
      configId: 'mode',
      value: 'yolo-plus',
    });
    expect(rejected.error?.code).toBe(-32602);
  });
  it('keeps the modern mode selector and legacy mode endpoint synchronized', async () => {
    const seen: Array<string | undefined> = [];
    const modes = [
      { id: 'default', name: 'Default', description: 'Ask' },
      { id: 'plan', name: 'Plan', description: 'Read only' },
    ];
    const { call, sent } = makeHandler({
      modes,
      configOptions: [
        {
          id: 'mode',
          name: 'Session Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'default',
          options: modes.map(({ id, name }) => ({ value: id, name })),
        },
      ],
      sessionConfigOptions: async () => [modelOption()],
      runTurn: async ({ modeId }) => {
        seen.push(modeId);
        return { stopReason: 'end_turn' };
      },
    });
    await call(1, 'initialize', { protocolVersion: 1 });
    const { result } = await call(2, 'session/new', { cwd: CWD, mcpServers: [] });
    const sessionId = result?.['sessionId'];
    await call(3, 'session/set_config_option', { sessionId, configId: 'mode', value: 'plan' });
    await call(4, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] });
    expect(seen).toEqual(['plan']);

    await call(5, 'session/set_mode', { sessionId, modeId: 'default' });
    expect(sent).toContainEqual(
      expect.objectContaining({
        method: 'session/update',
        params: expect.objectContaining({
          sessionId,
          update: expect.objectContaining({
            sessionUpdate: 'config_option_update',
            configOptions: expect.arrayContaining([
              expect.objectContaining({ id: 'mode', currentValue: 'default' }),
            ]),
          }),
        }),
      }),
    );
    await call(6, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] });
    expect(seen).toEqual(['plan', 'default']);
  });

  it('keeps the committed selection when a picker refresh fails', async () => {
    let modelUsed: unknown;
    const { call } = makeHandler({
      sessionConfigOptions: async (current) => {
        if (current?.[0]?.currentValue === 'openai/gpt-y') throw Error('catalog offline');
        return [modelOption()];
      },
      runTurn: async ({ configOptions }) => {
        modelUsed = configOptions?.[0]?.currentValue;
        return { stopReason: 'end_turn' };
      },
    });
    await call(1, 'initialize', { protocolVersion: 1 });
    const { result } = await call(2, 'session/new', { cwd: CWD, mcpServers: [] });
    const sessionId = result?.['sessionId'];
    const rejected = await call(3, 'session/set_config_option', {
      sessionId,
      configId: 'model',
      value: 'openai/gpt-y',
    });
    expect(rejected.error?.code).toBe(-32603);
    await call(4, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] });
    expect(modelUsed).toBe('openai/gpt-x');
  });

  it('keeps pending model changes out of prompts and applies overlapping selections in order', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const seen: unknown[] = [];
    const { call } = makeHandler({
      sessionConfigOptions: async (current) => {
        if (current?.[0]?.currentValue === 'openai/gpt-y') {
          started.resolve();
          await release.promise;
        }
        return [modelOption()];
      },
      runTurn: async ({ configOptions }) => {
        seen.push(configOptions?.[0]?.currentValue);
        return { stopReason: 'end_turn' };
      },
    });
    await call(1, 'initialize', { protocolVersion: 1 });
    const { result } = await call(2, 'session/new', { cwd: CWD, mcpServers: [] });
    const sessionId = result?.['sessionId'];
    const first = call(3, 'session/set_config_option', {
      sessionId,
      configId: 'model',
      value: 'openai/gpt-y',
    });
    await started.promise;
    const second = call(4, 'session/set_config_option', {
      sessionId,
      configId: 'model',
      value: 'openrouter/a/b',
    });
    const prompt = { sessionId, prompt: [{ type: 'text', text: 'hi' }] };
    try {
      await call(5, 'session/prompt', prompt);
      expect(seen).toEqual(['openai/gpt-x']);
    } finally {
      release.resolve();
      await Promise.all([first, second]);
    }
    await call(6, 'session/prompt', prompt);
    expect(seen).toEqual(['openai/gpt-x', 'openrouter/a/b']);
  });
  it('appends the host options to session/new, after the static ones', async () => {
    const builder = vi.fn(async () => [modelOption()]);
    const { call } = makeHandler({
      configOptions: [
        {
          id: 'size',
          name: 'Size',
          type: 'select',
          currentValue: 's',
          options: [{ value: 's', name: 'S' }],
        },
      ],
      sessionConfigOptions: builder,
    });
    await call(1, 'initialize', { protocolVersion: 1 });
    const created = await call(2, 'session/new', { cwd: CWD, mcpServers: [] });
    const ids = ((created.result?.['configOptions'] ?? []) as SessionConfigOption[]).map(
      (o) => o.id,
    );
    expect(ids).toEqual(['size', 'model']);
    expect(builder).toHaveBeenCalledTimes(1);
  });

  it('opens the session without the extra options when the builder fails', async () => {
    const { call } = makeHandler({
      sessionConfigOptions: async () => {
        throw new Error('catalog offline');
      },
    });
    await call(1, 'initialize', { protocolVersion: 1 });
    const created = await call(2, 'session/new', { cwd: CWD, mcpServers: [] });
    expect(created.result?.['sessionId']).toEqual(expect.stringMatching(/^sess_/));
    expect(created.result?.['configOptions']).toEqual([]);
  });

  it('accepts a value from any group and rejects one no group offers', async () => {
    const { call } = makeHandler({ sessionConfigOptions: async () => [modelOption()] });
    await call(1, 'initialize', { protocolVersion: 1 });
    const { result } = await call(2, 'session/new', { cwd: CWD, mcpServers: [] });
    const sessionId = result?.['sessionId'];

    const switched = await call(3, 'session/set_config_option', {
      sessionId,
      configId: 'model',
      value: 'openrouter/a/b',
    });
    const options = switched.result?.['configOptions'] as SessionConfigOption[];
    expect(options[0]?.currentValue).toBe('openrouter/a/b');

    const bogus = await call(4, 'session/set_config_option', {
      sessionId,
      configId: 'model',
      value: 'openai/not-offered',
    });
    expect(bogus.error?.code).toBe(-32602);
  });

  it('hands the selection to the turn', async () => {
    const seen: string[] = [];
    const { call } = makeHandler({
      sessionConfigOptions: async () => [modelOption()],
      runTurn: async (input) => {
        seen.push(String(input.configOptions?.[0]?.currentValue ?? 'none'));
        return { stopReason: 'end_turn' };
      },
    });
    await call(1, 'initialize', { protocolVersion: 1 });
    const { result } = await call(2, 'session/new', { cwd: CWD, mcpServers: [] });
    const sessionId = result?.['sessionId'];
    await call(3, 'session/set_config_option', {
      sessionId,
      configId: 'model',
      value: 'openai/gpt-y',
    });
    await call(4, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] });
    expect(seen).toEqual(['openai/gpt-y']);
  });

  it('rebuilds the options on a cold load and keeps the saved selection only while it is offered', async () => {
    const store = memoryStore();
    const first = makeHandler({ store, sessionConfigOptions: async () => [modelOption()] });
    await first.call(1, 'initialize', { protocolVersion: 1 });
    const { result } = await first.call(2, 'session/new', { cwd: CWD, mcpServers: [] });
    const sessionId = result?.['sessionId'] as string;
    await first.call(3, 'session/set_config_option', {
      sessionId,
      configId: 'model',
      value: 'openai/gpt-y',
    });

    // Restart: same store, the saved choice is still offered.
    const second = makeHandler({ store, sessionConfigOptions: async () => [modelOption()] });
    await second.call(1, 'initialize', { protocolVersion: 1 });
    const kept = await second.call(2, 'session/load', { sessionId, cwd: CWD, mcpServers: [] });
    expect(((kept.result?.['configOptions'] ?? []) as SessionConfigOption[])[0]?.currentValue).toBe(
      'openai/gpt-y',
    );

    // Restart again: that provider's key was removed, so the model is gone.
    const narrowed: SessionConfigOption = {
      ...modelOption(),
      options: [
        { group: 'openai', name: 'openai', options: [{ value: 'openai/gpt-x', name: 'X' }] },
      ],
    };
    const third = makeHandler({ store, sessionConfigOptions: async () => [narrowed] });
    await third.call(1, 'initialize', { protocolVersion: 1 });
    const reset = await third.call(2, 'session/load', { sessionId, cwd: CWD, mcpServers: [] });
    expect(
      ((reset.result?.['configOptions'] ?? []) as SessionConfigOption[])[0]?.currentValue,
    ).toBe('openai/gpt-x');
  });

  it('recomputes dependent thought_level options when the model changes via session/set_config_option', async () => {
    const dynamicBuilder = vi.fn(
      async (current?: readonly SessionConfigOption[]): Promise<SessionConfigOption[]> => {
        const selectedModel = String(
          current?.find((o) => o.id === 'model')?.currentValue ?? 'openai/gpt-x',
        );
        const base = modelOption(selectedModel);
        if (selectedModel === 'openai/gpt-x') {
          return [
            base,
            {
              id: 'thought_level',
              name: 'Reasoning Effort',
              category: 'thought_level',
              type: 'select',
              currentValue: 'default',
              options: [
                { value: 'default', name: 'Default' },
                { value: 'low', name: 'Low' },
                { value: 'high', name: 'High' },
              ],
            },
          ];
        }
        if (selectedModel === 'openai/gpt-y') {
          return [
            base,
            {
              id: 'thought_level',
              name: 'Reasoning Effort',
              category: 'thought_level',
              type: 'select',
              currentValue: 'default',
              options: [
                { value: 'default', name: 'Default' },
                { value: 'medium', name: 'Medium' },
              ],
            },
          ];
        }
        // Non-reasoning model: omits thought_level entirely.
        return [base];
      },
    );

    const { call, sent } = makeHandler({ sessionConfigOptions: dynamicBuilder });
    await call(1, 'initialize', { protocolVersion: 1 });
    const created = await call(2, 'session/new', { cwd: CWD, mcpServers: [] });
    const sessionId = created.result?.['sessionId'] as string;
    expect(
      ((created.result?.['configOptions'] ?? []) as SessionConfigOption[]).map((o) => o.id),
    ).toEqual(['model', 'thought_level']);

    // Set effort to high on gpt-x.
    const setHigh = await call(3, 'session/set_config_option', {
      sessionId,
      configId: 'thought_level',
      value: 'high',
    });
    expect(
      ((setHigh.result?.['configOptions'] ?? []) as SessionConfigOption[]).find(
        (o) => o.id === 'thought_level',
      )?.currentValue,
    ).toBe('high');

    // Switch to gpt-y (does not support 'high'): effort clamps back to 'default'.
    const toY = await call(4, 'session/set_config_option', {
      sessionId,
      configId: 'model',
      value: 'openai/gpt-y',
    });
    const yOptions = (toY.result?.['configOptions'] ?? []) as SessionConfigOption[];
    expect(yOptions.find((o) => o.id === 'model')?.currentValue).toBe('openai/gpt-y');
    expect(yOptions.find((o) => o.id === 'thought_level')?.currentValue).toBe('default');

    // Switch to openrouter/a/b (non-reasoning): thought_level disappears, and
    // config_option_update carries the updated list.
    const toPlain = await call(5, 'session/set_config_option', {
      sessionId,
      configId: 'model',
      value: 'openrouter/a/b',
    });
    const plainOptions = (toPlain.result?.['configOptions'] ?? []) as SessionConfigOption[];
    expect(plainOptions.map((o) => o.id)).toEqual(['model']);
    const lastUpdate = sent.findLast(
      (m) =>
        m['method'] === 'session/update' &&
        (m['params'] as { update?: { sessionUpdate?: string } })?.update?.sessionUpdate ===
          'config_option_update',
    );
    expect(
      (
        lastUpdate?.['params'] as { update?: { configOptions?: SessionConfigOption[] } }
      )?.update?.configOptions?.map((o) => o.id),
    ).toEqual(['model']);
  });

  it('supports cold session/fork from persisted store after restart', async () => {
    const store = memoryStore();
    const first = makeHandler({
      store,
      sessionConfigOptions: async () => [modelOption()],
      replayFor: () => [
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello' } },
      ],
    });
    await first.call(1, 'initialize', { protocolVersion: 1 });
    const created = await first.call(2, 'session/new', { cwd: CWD, mcpServers: [] });
    const sessionId = created.result?.['sessionId'] as string;
    await first.call(3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hello' }] });

    // Restart with a fresh handler sharing the store: fork the persisted session.
    const seeded: Array<{ id: string; count: number }> = [];
    const second = makeHandler({
      store,
      sessionConfigOptions: async () => [modelOption()],
      seedFor: (id, history) => seeded.push({ id, count: history.length }),
    });
    await second.call(1, 'initialize', { protocolVersion: 1 });
    const forked = await second.call(2, 'session/fork', { sessionId, cwd: CWD, mcpServers: [] });
    const forkedId = forked.result?.['sessionId'] as string;
    expect(forkedId).toEqual(expect.stringMatching(/^sess_/));
    expect(forkedId).not.toBe(sessionId);
    expect(seeded).toEqual([{ id: forkedId, count: 1 }]);
  });

  it('derives session title from the first prompt, lists it, and replays it on cold load', async () => {
    const store = memoryStore();
    const first = makeHandler({ store });
    await first.call(1, 'initialize', { protocolVersion: 1 });
    const created = await first.call(2, 'session/new', { cwd: CWD, mcpServers: [] });
    const sessionId = created.result?.['sessionId'] as string;

    await first.call(3, 'session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '  Fix the   ACP session title bug\nwith tests ' }],
    });

    const listed = await first.call(4, 'session/list', { cwd: CWD });
    expect(listed.result?.['sessions']).toEqual([
      expect.objectContaining({
        sessionId,
        title: 'Fix the ACP session title bug with tests',
      }),
    ]);

    // Cold load also replays session_info_update with the persisted title.
    const second = makeHandler({ store });
    await second.call(1, 'initialize', { protocolVersion: 1 });
    await second.call(2, 'session/load', { sessionId, cwd: CWD, mcpServers: [] });
    const coldInfo = second.sent.find(
      (m) =>
        m['method'] === 'session/update' &&
        (m['params'] as { update?: { sessionUpdate?: string } })?.update?.sessionUpdate ===
          'session_info_update',
    );
    expect((coldInfo?.['params'] as { update?: { title?: string } })?.update?.title).toBe(
      'Fix the ACP session title bug with tests',
    );
  });

  it('never cuts an astral character in half when it shortens the derived title (F1465)', async () => {
    // The title goes out in session/list and session_info_update; a lone high
    // surrogate there makes a strict client reject the whole frame.
    const emoji = String.fromCodePoint(0x1f600);
    const { call } = makeHandler();
    await call(1, 'initialize', { protocolVersion: 1 });
    const created = await call(2, 'session/new', { cwd: CWD, mcpServers: [] });
    const sessionId = created.result?.['sessionId'] as string;
    await call(3, 'session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: `${'a'.repeat(76)}${emoji}${'b'.repeat(10)}` }],
    });
    const listed = await call(4, 'session/list', { cwd: CWD });
    const sessions = (listed.result?.['sessions'] ?? []) as Array<{ title?: string }>;
    const title = sessions[0]?.title ?? '';
    expect(title).toBe(`${'a'.repeat(76)}…`);
    const lone = [...title].some((ch) => {
      const code = ch.charCodeAt(0);
      return ch.length === 1 && code >= 0xd800 && code <= 0xdfff;
    });
    expect(lone, 'derived title must carry no unpaired surrogate').toBe(false);
  });

  it('passes session cwd to store.delete and sorts session/list by updatedAt descending', async () => {
    const deleted: Array<{ id: string; cwd: string | undefined }> = [];
    const baseStore = memoryStore();
    const store = {
      ...baseStore,
      delete: vi.fn(async (id: string, cwd?: string) => {
        deleted.push({ id, cwd });
        baseStore.saved.delete(id);
      }),
    };
    const { call } = makeHandler({ store });
    await call(1, 'initialize', { protocolVersion: 1 });
    const first = await call(2, 'session/new', { cwd: CWD, mcpServers: [] });
    const firstId = first.result?.['sessionId'] as string;
    await new Promise((r) => setTimeout(r, 15));
    const second = await call(3, 'session/new', { cwd: CWD, mcpServers: [] });
    const secondId = second.result?.['sessionId'] as string;

    const listed = await call(4, 'session/list', { cwd: CWD });
    const ids = ((listed.result?.['sessions'] ?? []) as Array<{ sessionId: string }>).map(
      (s) => s.sessionId,
    );
    expect(ids).toEqual([secondId, firstId]);

    await call(5, 'session/delete', { sessionId: firstId });
    expect(deleted).toEqual([{ id: firstId, cwd: CWD }]);
  });

  it('supports boolean config options and client-provided systemPrompt (append/override) across cold load', async () => {
    const store = memoryStore();
    const seenPrompts: Array<{ mode: string; text: string } | undefined> = [];
    const boolOption: SessionConfigOption = {
      id: 'auto_verify',
      name: 'Auto Verify',
      type: 'boolean',
      currentValue: false,
    };
    const first = makeHandler({
      store,
      sessionConfigOptions: async () => [boolOption],
      runTurn: async (input) => {
        seenPrompts.push(input.systemPrompt);
        return { stopReason: 'end_turn' };
      },
    });
    await first.call(1, 'initialize', { protocolVersion: 2 });
    const created = await first.call(2, 'session/new', {
      cwd: CWD,
      mcpServers: [],
      systemPrompt: { mode: 'override', text: 'Always answer in Turkish.' },
    });
    const sessionId = created.result?.['sessionId'] as string;

    // Toggle boolean config option to true; reject non-boolean values.
    const bad = await first.call(3, 'session/set_config_option', {
      sessionId,
      configId: 'auto_verify',
      value: 'true',
    });
    expect(bad.error?.code).toBe(-32602);

    const toggled = await first.call(4, 'session/set_config_option', {
      sessionId,
      configId: 'auto_verify',
      value: true,
    });
    expect(
      ((toggled.result?.['configOptions'] ?? []) as SessionConfigOption[])[0]?.currentValue,
    ).toBe(true);

    await first.call(5, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] });
    expect(seenPrompts[0]).toEqual({ mode: 'override', text: 'Always answer in Turkish.' });

    // Cold load preserves both boolean option and systemPrompt.
    const second = makeHandler({
      store,
      sessionConfigOptions: async () => [boolOption],
      runTurn: async (input) => {
        seenPrompts.push(input.systemPrompt);
        return { stopReason: 'end_turn' };
      },
    });
    await second.call(1, 'initialize', { protocolVersion: 1 });
    const loaded = await second.call(2, 'session/load', { sessionId, cwd: CWD, mcpServers: [] });
    expect(
      ((loaded.result?.['configOptions'] ?? []) as SessionConfigOption[])[0]?.currentValue,
    ).toBe(true);
    await second.call(3, 'session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'again' }],
    });
    expect(seenPrompts[1]).toEqual({ mode: 'override', text: 'Always answer in Turkish.' });
  });
});

/**
 * Full ACP v1 conformance check driven by the official `@agentclientprotocol/sdk`
 * client over real ndJsonStream pipes against `ACPProtocolHandler` + `ACPSessionStore`.
 *
 * Exercises: initialize (loadSession + sessionCapabilities), session/new,
 * session/set_config_option (model + model-dependent thought_level + config_option_update),
 * session/prompt (live thought/text/usage updates), session/list (derived title + ordering),
 * cold session/load (history replay + title + persisted configOptions), cold session/fork,
 * session/resume, session/close, and session/delete.
 */
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { client, ndJsonStream } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACPProtocolHandler,
  ACPSessionStore,
  type AgentServerTransport,
  type SessionConfigOption,
} from '../src/agent/index.js';
import type { ACPMessage } from '../src/types/acp-messages.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

function createPipedServer(opts: {
  store: ACPSessionStore;
  cwd: string;
  historyBySession?: Map<string, Array<{ sessionUpdate: string; content: unknown }>>;
}) {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const historyMap = opts.historyBySession ?? new Map();

  const transport: AgentServerTransport = {
    send: async (msg: ACPMessage) => {
      serverToClient.write(`${JSON.stringify(msg)}\n`);
    },
    sendRaw: (chunk: string) => {
      serverToClient.write(chunk);
    },
    read: async () => null,
    onMessage: () => () => {},
  };

  const sessionConfigOptions = async (
    current?: readonly SessionConfigOption[],
  ): Promise<SessionConfigOption[]> => {
    const model = current?.find((o) => o.id === 'model')?.currentValue ?? 'openai/o3';
    const modelOpt: SessionConfigOption = {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: model,
      options: [
        {
          group: 'openai',
          name: 'openai',
          options: [
            { value: 'openai/o3', name: 'o3' },
            { value: 'openai/gpt-4o', name: 'gpt-4o' },
          ],
        },
      ],
    };
    if (model === 'openai/o3') {
      return [
        modelOpt,
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
    return [modelOpt];
  };

  const handler = new ACPProtocolHandler({
    transport,
    defaultCwd: opts.cwd,
    store: opts.store,
    sessionConfigOptions,
    replayFor: (sid) => [...(historyMap.get(sid) ?? [])],
    seedFor: (sid, hist) => {
      historyMap.set(sid, [...hist]);
    },
    runTurn: async (input, emit) => {
      const text = input.prompt
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      const effort =
        input.configOptions?.find((o) => o.category === 'thought_level')?.currentValue ?? 'none';
      const reply = `echo:${text}|effort=${effort}`;
      emit({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking…' } });
      emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } });
      emit({ sessionUpdate: 'usage_update', used: 512, size: 128_000 });
      const prev = historyMap.get(input.sessionId) ?? [];
      prev.push(
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } },
      );
      historyMap.set(input.sessionId, prev);
      return { stopReason: 'end_turn' };
    },
  });

  let buf = '';
  clientToServer.setEncoding('utf8');
  clientToServer.on('data', (chunk: string) => {
    buf += chunk;
    for (;;) {
      const idx = buf.indexOf('\n');
      if (idx < 0) break;
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      void handler.handleMessage(JSON.parse(line));
    }
  });

  const updates: Array<{ sessionId: string; update: Record<string, unknown> }> = [];
  const conn = client()
    .onNotification('session/update', ({ params }) => {
      updates.push(params as never);
    })
    .connect(ndJsonStream(Writable.toWeb(clientToServer), Readable.toWeb(serverToClient)));

  const close = () => {
    conn.close();
    handler.close();
    clientToServer.end();
    serverToClient.end();
  };

  return { conn, updates, close };
}

describe('ACP v1 conformance with official @agentclientprotocol/sdk', () => {
  it('passes full lifecycle: initialize → new → set_config_option → prompt → list → cold load → cold fork → resume → delete', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-acp-sdk-conformance-'));
    cleanup.push(dir);
    const store = new ACPSessionStore({ dir: path.join(dir, 'acp-sessions') });
    const cwd = dir;

    const first = createPipedServer({ store, cwd });
    let sessionId: string;
    try {
      const init = await first.conn.agent.request('initialize', { protocolVersion: 1 });
      expect(init.protocolVersion).toBe(1);
      expect(init.agentCapabilities?.loadSession).toBe(true);
      expect(init.agentCapabilities?.sessionCapabilities).toMatchObject({
        close: {},
        list: {},
        delete: {},
        resume: {},
        fork: {},
      });

      const created = await first.conn.agent.request('session/new', { cwd, mcpServers: [] });
      sessionId = created.sessionId;
      expect(created.configOptions?.map((o) => o.id)).toEqual(['model', 'thought_level']);

      const setEffort = await first.conn.agent.request('session/set_config_option', {
        sessionId,
        configId: 'thought_level',
        value: 'high',
      });
      expect(setEffort.configOptions?.find((o) => o.id === 'thought_level')?.currentValue).toBe(
        'high',
      );

      const turn = await first.conn.agent.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'Audit ACP compliance' }],
      });
      expect(turn.stopReason).toBe('end_turn');
      expect(first.updates.some((u) => u.update.sessionUpdate === 'agent_thought_chunk')).toBe(
        true,
      );
      expect(first.updates.some((u) => u.update.sessionUpdate === 'usage_update')).toBe(true);
      expect(
        first.updates.some(
          (u) =>
            u.update.sessionUpdate === 'agent_message_chunk' &&
            (u.update.content as { text?: string })?.text ===
              'echo:Audit ACP compliance|effort=high',
        ),
      ).toBe(true);

      // Switching to non-reasoning model removes thought_level and notifies client.
      const toPlain = await first.conn.agent.request('session/set_config_option', {
        sessionId,
        configId: 'model',
        value: 'openai/gpt-4o',
      });
      expect(toPlain.configOptions?.map((o) => o.id)).toEqual(['model']);

      // Switch back to reasoning model and set effort to high for persistence check.
      await first.conn.agent.request('session/set_config_option', {
        sessionId,
        configId: 'model',
        value: 'openai/o3',
      });
      await first.conn.agent.request('session/set_config_option', {
        sessionId,
        configId: 'thought_level',
        value: 'high',
      });
    } finally {
      first.close();
    }

    // Fresh server process (cold restart) sharing the same on-disk store.
    const second = createPipedServer({ store, cwd });
    try {
      await second.conn.agent.request('initialize', { protocolVersion: 1 });

      const listed = await second.conn.agent.request('session/list', { cwd });
      expect(listed.sessions).toEqual([
        expect.objectContaining({
          sessionId,
          cwd,
          title: 'Audit ACP compliance',
        }),
      ]);

      // Cold session/load replays history + title + restores model & thought_level.
      const loaded = await second.conn.agent.request('session/load', {
        sessionId,
        cwd,
        mcpServers: [],
      });
      expect(loaded.configOptions?.find((o) => o.id === 'thought_level')?.currentValue).toBe(
        'high',
      );
      expect(
        second.updates.some(
          (u) =>
            u.update.sessionUpdate === 'user_message_chunk' &&
            (u.update.content as { text?: string })?.text === 'Audit ACP compliance',
        ),
      ).toBe(true);
      expect(
        second.updates.some(
          (u) =>
            u.update.sessionUpdate === 'session_info_update' &&
            u.update.title === 'Audit ACP compliance',
        ),
      ).toBe(true);

      // Close then cold-fork the persisted session.
      await second.conn.agent.request('session/close', { sessionId });
      const forked = (await second.conn.agent.request('session/fork', {
        sessionId,
        cwd,
        mcpServers: [],
      })) as { sessionId: string };
      expect(forked.sessionId).not.toBe(sessionId);

      // Resume original without replaying history.
      const beforeResume = second.updates.length;
      const resumed = await second.conn.agent.request('session/resume', {
        sessionId,
        cwd,
        mcpServers: [],
      });
      expect(resumed.configOptions?.find((o) => o.id === 'thought_level')?.currentValue).toBe(
        'high',
      );
      expect(
        second.updates
          .slice(beforeResume)
          .some((u) => u.update.sessionUpdate === 'user_message_chunk'),
      ).toBe(false);

      // Delete both sessions and confirm session/list is empty.
      await second.conn.agent.request('session/delete', { sessionId });
      await second.conn.agent.request('session/delete', { sessionId: forked.sessionId });
      const afterDelete = await second.conn.agent.request('session/list', { cwd });
      expect(afterDelete.sessions).toEqual([]);
    } finally {
      second.close();
    }
  });
});

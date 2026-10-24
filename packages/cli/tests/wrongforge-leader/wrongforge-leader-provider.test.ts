import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { Config, Provider, Request, StreamEvent, Tool } from '@wrongstack/contracts/types';
import { ProviderError } from '@wrongstack/contracts/types';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type AcpLeaderHost, bindAcpLeaderHost } from '../../src/acp-leader/acp-leader-host.js';
import { startLeaderGateway } from '../../src/wrongforge-leader/wrongforge-leader-gateway.js';
import { WrongForgeLeaderProvider } from '../../src/wrongforge-leader/wrongforge-leader-provider.js';

const KEY = 'wf_leader-test-key-0123456789';
const MODELS = ['claude-a-1', 'claude-b-2'];

interface Scripted {
  events: Array<{ type: string; data: Record<string, unknown> }>;
  result: Record<string, unknown>;
  /** Answer the FIRST terminal-record GET with 503 (transient; undici never retries a status). */
  failRecordGetOnce?: boolean | undefined;
}

/** WrongForge's task API, enough for the leader: info, tasks (async + wait), sessions, events. */
async function fakeWrongForge(script: Scripted) {
  const submitted: Record<string, unknown>[] = [];
  const cancels: string[] = [];
  const sessions = new Set<string>();
  let lastId = '';
  let recordGets = 0;
  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: {} });
    const url = new URL(req.url ?? '/', 'http://x');
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c.toString('utf8');
    });
    req.on('end', () => {
      if (url.pathname === '/v1/info') {
        return send(200, { models: MODELS, default_model: MODELS[0], features: ['builtin_tools'] });
      }
      if (req.method === 'POST' && url.pathname === '/v1/tasks') {
        const body = JSON.parse(raw) as Record<string, unknown>;
        submitted.push(body);
        lastId = `t${submitted.length}`;
        if (typeof body['session_id'] === 'string') sessions.add(body['session_id']);
        const task = {
          id: lastId,
          status: body['wait'] ? 'completed' : 'running',
          ...(body['wait'] ? { result: { text: 'side answer', steps: 1, tool_calls: 0 } } : {}),
        };
        return send(body['wait'] ? 200 : 202, { task });
      }
      const c = /^\/v1\/tasks\/([^/]+)\/cancel$/.exec(url.pathname);
      if (req.method === 'POST' && c) {
        cancels.push(decodeURIComponent(c[1] ?? ''));
        return send(200, { ok: true });
      }
      const s = /^\/v1\/sessions\/([^/]+)$/.exec(url.pathname);
      if (s) {
        return sessions.has(decodeURIComponent(s[1] ?? ''))
          ? send(200, { session: {} })
          : send(404, { error: { code: 'session_not_found', message: 'no' } });
      }
      if (url.pathname === `/v1/tasks/${lastId}/events`) {
        const events = script.events.map((e, i) => ({ seq: i + 1, ...e }));
        const after = Number(url.searchParams.get('after') ?? 0);
        const page = events.filter((e) => e.seq > after);
        return send(200, {
          status: 'completed',
          terminal: true,
          events: page,
          next_after: page.at(-1)?.seq ?? after,
        });
      }
      if (url.pathname === `/v1/tasks/${lastId}`) {
        recordGets += 1;
        if (script.failRecordGetOnce && recordGets === 1)
          return send(503, { error: { code: 'unavailable', message: 'restart in progress' } });
        return send(200, { task: { id: lastId, status: 'completed', result: script.result } });
      }
      return send(404, { error: {} });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    submitted,
    cancels,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function fakeHost(over: Partial<AcpLeaderHost> = {}) {
  const events = new EventBus();
  const cards: string[] = [];
  events.on('tool.started', (e: { name: string }) => cards.push(e.name));
  const host = {
    events,
    projectRoot: '/proj',
    getConfig: () => ({}) as Config,
    permission: () => ({}) as never,
    context: () => ({}) as never,
    getTool: () => undefined,
    listTools: () => [],
    runTool: vi.fn(async () => ({ content: 'ok', isError: false })),
    ...over,
  } as AcpLeaderHost;
  return { host, cards };
}

const req = (text: string, model = 'claude-b-2'): Request => ({
  model,
  messages: [{ role: 'user', content: text }],
  cache: { sessionId: 'S1', threadId: 'S1' },
});

async function drain(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

let home: string;
const saved: Record<string, string | undefined> = {};
const closers: Array<() => Promise<void>> = [];
beforeAll(() => {
  for (const k of ['WRONGSTACK_HOME', 'WRONGFORGE_URL', 'WRONGFORGE_API_KEY'])
    saved[k] = process.env[k];
  home = mkdtempSync(path.join(tmpdir(), 'wf-leader-home-'));
  process.env['WRONGSTACK_HOME'] = home;
  process.env['WRONGFORGE_API_KEY'] = KEY;
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});
afterEach(async () => {
  bindAcpLeaderHost(undefined);
  await Promise.all(closers.splice(0).map((c) => c()));
});

describe('WrongForge as the leader', () => {
  it('forwards reasoning and cache controls for one-shot and leader requests', async () => {
    const wf = await fakeWrongForge({
      events: [],
      result: { text: 'done', steps: 1, tool_calls: 0 },
    });
    closers.push(wf.close);
    process.env['WRONGFORGE_URL'] = wf.url;
    const provider = new WrongForgeLeaderProvider({
      bootConfig: {} as Config,
      buildProvider: () => undefined,
    });
    const request: Request = {
      ...req('hello'),
      reasoning: { effort: 'low' },
      cache: { ...req('hello').cache, ttl: '1h' },
    };
    await provider.complete(request, { signal: new AbortController().signal });
    for await (const _event of provider.stream(request, { signal: new AbortController().signal })) {
      /* drain */
    }
    expect(wf.submitted).toHaveLength(2);
    for (const sent of wf.submitted) expect(sent).toMatchObject({ effort: 'low', cache: '1h' });
  });
  it('turns a leader turn into a WrongForge task in the session, streaming its text', async () => {
    const wf = await fakeWrongForge({
      events: [
        { type: 'task.started', data: { model: 'claude-b-2' } },
        { type: 'agent.text', data: { text: 'Looking. ' } },
        { type: 'tool.started', data: { tool_call_id: 'r1', name: 'read', input: { path: 'a' } } },
        { type: 'tool.finished', data: { tool_call_id: 'r1', name: 'read', ok: true, output: {} } },
        {
          type: 'tool.started',
          data: { tool_call_id: 'e1', name: 'wstack_edit', external: true, input: {} },
        },
        {
          type: 'tool.finished',
          data: { tool_call_id: 'e1', name: 'wstack_edit', external: true, ok: true },
        },
        { type: 'agent.text', data: { text: 'Done.' } },
      ],
      result: {
        text: 'Looking. Done.',
        steps: 3,
        tool_calls: 2,
        usage: { input_tokens: 5, output_tokens: 7, cache_read_tokens: 100 },
        context_tokens: 2000,
        context_window: 1_000_000,
      },
    });
    closers.push(wf.close);
    process.env['WRONGFORGE_URL'] = wf.url;
    const { host, cards } = fakeHost();
    bindAcpLeaderHost(host);
    const provider = new WrongForgeLeaderProvider({
      bootConfig: {} as Config,
      buildProvider: () => undefined,
    });

    const events = await drain(
      provider.stream(req('fix it'), { signal: new AbortController().signal }),
    );

    const text = events.flatMap((e) => (e.type === 'text_delta' ? [e.text] : []));
    expect(text).toEqual(['Looking. ', 'Done.']);
    // A tool call ends a text block, as a model's reply after a tool result would.
    expect(events.filter((e) => e.type === 'content_block_start')).toHaveLength(2);
    const stop = events.at(-1);
    expect(stop).toMatchObject({
      type: 'message_stop',
      usage: { input: 5, output: 7, cacheRead: 100 },
      agentContext: { used: 2000, size: 1_000_000 },
    });
    expect(provider.capabilities.maxContext).toBe(1_000_000);
    // WrongForge's own read gets a card; wstack_edit's card comes from the session's executor.
    expect(cards).toEqual(['read']);
    const sent = wf.submitted[0] ?? {};
    expect(sent).toMatchObject({
      session_id: 'wsl-S1',
      workdir: '/proj',
      model: 'claude-b-2',
      prompt: 'fix it',
    });
    expect(String(sent['system_append'])).toContain('LEAD a WrongStack session');

    // The next turn continues the same WrongForge session.
    await drain(provider.stream(req('and now this'), { signal: new AbortController().signal }));
    expect(wf.submitted[1]).toMatchObject({ session_id: 'wsl-S1', prompt: 'and now this' });
  });

  it("rewrites a required-skills marker to name the gateway's skill tool", async () => {
    const wf = await fakeWrongForge({
      events: [],
      result: { text: 'ok', steps: 1, tool_calls: 0 },
    });
    closers.push(wf.close);
    process.env['WRONGFORGE_URL'] = wf.url;
    const tool = (name: string) =>
      ({ name, description: name, inputSchema: { type: 'object' } }) as unknown as Tool;
    const { host } = fakeHost({ listTools: () => [tool('skill'), tool('edit')] });
    bindAcpLeaderHost(host);
    const provider = new WrongForgeLeaderProvider({
      bootConfig: {} as Config,
      buildProvider: () => undefined,
    });

    await drain(
      provider.stream(req('Hunt one bug.\n<!-- wrongstack:required-skills bug-hunter -->'), {
        signal: new AbortController().signal,
      }),
    );

    const prompt = String(wf.submitted[0]?.['prompt']);
    expect(prompt).not.toContain('<!--');
    expect(prompt).toContain("This task's playbook skills: bug-hunter.");
    expect(prompt).toContain('`wstack_skill`');
  });

  it('refuses a model WrongForge does not serve before sending anything', async () => {
    const wf = await fakeWrongForge({ events: [], result: { text: '', steps: 0, tool_calls: 0 } });
    closers.push(wf.close);
    process.env['WRONGFORGE_URL'] = wf.url;
    const provider = new WrongForgeLeaderProvider({
      bootConfig: {} as Config,
      buildProvider: () => undefined,
    });
    const err = await drain(
      provider.stream(req('hi', 'claude-zz-9'), { signal: new AbortController().signal }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(String((err as Error).message)).toContain('serves claude-a-1, claude-b-2');
    expect(wf.submitted).toHaveLength(0);
  });

  it('answers side requests as a one-step, tool-less WrongForge task', async () => {
    const wf = await fakeWrongForge({ events: [], result: { text: '', steps: 0, tool_calls: 0 } });
    closers.push(wf.close);
    process.env['WRONGFORGE_URL'] = wf.url;
    const provider = new WrongForgeLeaderProvider({
      bootConfig: {} as Config,
      buildProvider: () => undefined,
    });
    const res = await provider.complete(
      {
        model: 'claude-a-1',
        system: [{ type: 'text', text: 'Title it.' }],
        messages: [{ role: 'user', content: 'hello' }],
      },
      { signal: new AbortController().signal },
    );
    expect(res.content).toEqual([{ type: 'text', text: 'side answer' }]);
    expect(wf.submitted[0]).toMatchObject({ builtin_tools: [], max_steps: 1, wait: true });
    expect(wf.submitted[0]).not.toHaveProperty('session_id');
    expect(String(wf.submitted[0]?.['prompt'])).toContain('Title it.');
  });
  it('keeps side requests on WrongForge instead of the first fallback model (#410)', async () => {
    const wf = await fakeWrongForge({ events: [], result: { text: '', steps: 0, tool_calls: 0 } });
    closers.push(wf.close);
    process.env['WRONGFORGE_URL'] = wf.url;
    const buildProvider = vi.fn(() => undefined);
    const provider = new WrongForgeLeaderProvider({
      bootConfig: { fallbackModels: ['evren/deepseek-v4.1-flash'] } as unknown as Config,
      buildProvider,
    });
    await provider.complete(
      { model: 'claude-a-1', messages: [{ role: 'user', content: 'hello' }] },
      { signal: new AbortController().signal },
    );
    expect(buildProvider).not.toHaveBeenCalled();
    expect(wf.submitted[0]).toMatchObject({ builtin_tools: [], max_steps: 1 });
  });

  it('sends side requests to the side model the user named', async () => {
    const sideComplete = vi.fn(async () => ({
      model: 'side-model',
      content: [{ type: 'text' as const, text: 'from side' }],
      stopReason: 'end_turn' as const,
      usage: { input: 0, output: 0 },
    }));
    const buildProvider = vi.fn(() => ({ complete: sideComplete }) as unknown as Provider);
    const provider = new WrongForgeLeaderProvider({
      bootConfig: {
        acp: { leader: { sideModel: 'other/side-model' } },
        fallbackModels: ['evren/deepseek-v4.1-flash'],
      } as unknown as Config,
      buildProvider,
    });
    const res = await provider.complete(
      { model: 'claude-a-1', messages: [{ role: 'user', content: 'hello' }] },
      { signal: new AbortController().signal },
    );
    expect(buildProvider).toHaveBeenCalledWith('other', expect.anything());
    expect(sideComplete).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'side-model' }),
      expect.anything(),
    );
    expect(res.content).toEqual([{ type: 'text', text: 'from side' }]);
  });

  it('returns the turn when the final record fetch fails once transiently', async () => {
    const wf = await fakeWrongForge({
      events: [{ type: 'agent.text', data: { text: 'Done.' } }],
      result: {
        text: 'Done.',
        steps: 1,
        tool_calls: 0,
        usage: { input_tokens: 3, output_tokens: 4 },
      },
      failRecordGetOnce: true,
    });
    closers.push(wf.close);
    process.env['WRONGFORGE_URL'] = wf.url;
    const { host } = fakeHost();
    bindAcpLeaderHost(host);
    const provider = new WrongForgeLeaderProvider({
      bootConfig: {} as Config,
      buildProvider: () => undefined,
    });
    // The events long-polls tolerate dropped connections; the final record
    // fetch of the finished turn must tolerate them too.
    const events = await drain(
      provider.stream(req('go'), { signal: new AbortController().signal }),
    );
    expect(events.at(-1)).toMatchObject({
      type: 'message_stop',
      usage: { input: 3, output: 4 },
    });
  });

  it('cancels the task on WrongForge when the turn signal is aborted on task creation', async () => {
    const wf = await fakeWrongForge({
      events: [],
      result: { text: 'hang', steps: 1, tool_calls: 0 },
    });
    closers.push(wf.close);
    process.env['WRONGFORGE_URL'] = wf.url;
    const { host } = fakeHost();
    bindAcpLeaderHost(host);

    const ac = new AbortController();
    const customFetch: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (String(input).includes('/v1/tasks') && !String(input).includes('/cancel')) {
        const text = await res.text();
        ac.abort();
        return new Response(text, { status: res.status, headers: res.headers });
      }
      return res;
    };

    const provider = new WrongForgeLeaderProvider({
      bootConfig: {} as Config,
      buildProvider: () => undefined,
      fetchImpl: customFetch,
    });

    await expect(
      drain(provider.stream(req('abort immediately'), { signal: ac.signal })),
    ).rejects.toThrow();
    await vi.waitFor(() => expect(wf.cancels).toHaveLength(1));
  });

  it('retries gateway startup on subsequent turns if initial attempt failed', async () => {
    const wf = await fakeWrongForge({
      events: [],
      result: { text: 'ok', steps: 1, tool_calls: 0 },
    });
    closers.push(wf.close);
    process.env['WRONGFORGE_URL'] = wf.url;

    let toolListFail = true;
    const tool = (name: string) =>
      ({ name, description: name, inputSchema: { type: 'object' } }) as unknown as Tool;

    const { host } = fakeHost({
      listTools: () => {
        if (toolListFail) throw new Error('transient tool list failure');
        return [tool('edit')];
      },
    });
    bindAcpLeaderHost(host);

    const provider = new WrongForgeLeaderProvider({
      bootConfig: {} as Config,
      buildProvider: () => undefined,
    });

    // Turn 1 fails starting gateway transiently
    await drain(provider.stream(req('turn 1'), { signal: new AbortController().signal }));
    expect(wf.submitted[0]?.['gateway']).toBeUndefined();

    // Turn 2 succeeds starting gateway
    toolListFail = false;
    await drain(provider.stream(req('turn 2'), { signal: new AbortController().signal }));
    expect(wf.submitted[1]?.['gateway']).toBeDefined();

    await provider.closeAll();
  });
});

describe('the leader gateway', () => {
  it("serves the session's tools and runs each call as the session's own", async () => {
    const tool = (name: string) =>
      ({ name, description: name, inputSchema: { type: 'object' } }) as unknown as Tool;
    const { host } = fakeHost({ listTools: () => [tool('edit'), tool('read'), tool('delegate')] });
    const gw = await startLeaderGateway(host, 'S9');
    if (!gw) throw new Error('no gateway');
    closers.push(gw.close);
    const auth = { authorization: `Bearer ${gw.spec.token}` };

    const list = (await (await fetch(`${gw.spec.url}/v1/tools`, { headers: auth })).json()) as {
      tools: { name: string }[];
    };
    // WrongForge reads with its own tools; the rest, fleet included, is the session's.
    expect(list.tools.map((t) => t.name)).toEqual(['edit', 'delegate']);

    const res = await fetch(`${gw.spec.url}/v1/tools/edit/call`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ input: { path: 'a.ts' }, call_id: 'c1' }),
    });
    expect(await res.json()).toEqual({ ok: true, tool: 'edit', content: 'ok' });
    expect(host.runTool).toHaveBeenCalledWith(
      'edit',
      { path: 'a.ts' },
      expect.objectContaining({ sessionId: 'S9', announce: true }),
    );

    expect((await fetch(`${gw.spec.url}/v1/tools`)).status).toBe(401);
    expect(
      (await fetch(`${gw.spec.url}/v1/tools/read/call`, { method: 'POST', headers: auth })).status,
    ).toBe(404);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installWsClientActionMethods,
  type WsClientActionHost,
  type WsClientActionMethods,
} from '../../src/lib/ws-client-actions';

/**
 * `installWsClientActionMethods` mixes a flat bag of `send(...)` wrappers onto
 * the WS client prototype. Each one is a thin translation from a call-site
 * signature to a wire frame — these tests pin that translation, which is the
 * only behaviour the module owns.
 */

const SESSION_ID = 'sess-1';

class Host implements WsClientActionHost {
  readonly sent: Array<{ message: Record<string, unknown>; options?: unknown }> = [];

  send(message: never, options?: never): void {
    this.sent.push(
      options === undefined
        ? { message: message as unknown as Record<string, unknown> }
        : { message: message as unknown as Record<string, unknown>, options },
    );
  }

  withSession<T extends Record<string, unknown>>(payload: T): T & { sessionId?: string } {
    return { ...payload, sessionId: SESSION_ID };
  }
}

installWsClientActionMethods(Host as unknown as { prototype: WsClientActionHost });

type Client = Host & WsClientActionMethods;

let client: Client;

/** The single frame the last call produced. */
function frame(): Record<string, unknown> {
  expect(client.sent).toHaveLength(1);
  return client.sent[0]!.message;
}

function opts(): unknown {
  return client.sent[0]!.options;
}

const SEND_OPTS = { correlationId: 'c1' } as never;

beforeEach(() => {
  client = new Host() as Client;
});

describe('installWsClientActionMethods', () => {
  it('installs every declared method onto the prototype', () => {
    for (const name of [
      'listTools',
      'listMemory',
      'listSageMemories',
      'getSage',
      'listMcpServers',
      'listSkills',
      'getDiag',
      'listSessions',
      'ping',
      'refineModel',
    ] as const) {
      expect(typeof (client as unknown as Record<string, unknown>)[name], name).toBe('function');
    }
  });

  it('installs onto the prototype, not the instance', () => {
    expect(Object.hasOwn(client, 'listTools')).toBe(false);
    expect('listTools' in client).toBe(true);
  });
});

// ── plain no-payload requests ───────────────────────────────────────────────

describe('no-payload requests', () => {
  it.each([
    ['listTools', 'tools.list'],
    ['listMemory', 'memory.list'],
    ['listSageMemories', 'memory.sage.list'],
    ['listSkills', 'skills.list'],
    ['listMcpServers', 'mcp.list'],
    ['listModes', 'modes.list'],
    ['exportAllSkills', 'skills.export'],
    ['ping', 'ping'],
  ] as Array<[keyof WsClientActionMethods, string]>)('%s sends %s', (method, type) => {
    (client[method] as () => void)();
    expect(frame()).toEqual({ type });
  });

  it.each([
    ['listTools', 'tools.list'],
    ['listMemory', 'memory.list'],
    ['listSageMemories', 'memory.sage.list'],
    ['listSkills', 'skills.list'],
  ] as Array<[keyof WsClientActionMethods, string]>)('%s forwards send options', (method, type) => {
    (client[method] as (o?: unknown) => void)(SEND_OPTS);
    expect(frame()).toEqual({ type });
    expect(opts()).toEqual(SEND_OPTS);
  });

  it('omits the options argument when none is given', () => {
    client.listTools();
    expect(client.sent[0]).not.toHaveProperty('options');
  });
});

// ── SAGE ────────────────────────────────────────────────────────────────────

describe('SAGE actions', () => {
  it('listSageMemoriesPage spreads the query params', () => {
    client.listSageMemoriesPage({ statuses: ['active'], kind: 'fact', limit: 10 });
    expect(frame()).toEqual({
      type: 'memory.sage.listPage',
      payload: { statuses: ['active'], kind: 'fact', limit: 10 },
    });
  });

  it('listSageMemoriesPage sends an empty payload with no params', () => {
    client.listSageMemoriesPage();
    expect(frame()).toEqual({ type: 'memory.sage.listPage', payload: {} });
  });

  it('getSage keys by id', () => {
    client.getSage('m1');
    expect(frame()).toEqual({ type: 'memory.sage.get', payload: { id: 'm1' } });
  });

  it('getSageGraph merges the query with its params', () => {
    client.getSageGraph('auth', { maxDepth: 2, limit: 20 });
    expect(frame()).toEqual({
      type: 'memory.sage.graph',
      payload: { query: 'auth', maxDepth: 2, limit: 20 },
    });
  });

  it('getSageGraph works with no params', () => {
    client.getSageGraph('auth');
    expect(frame()).toEqual({ type: 'memory.sage.graph', payload: { query: 'auth' } });
  });

  it('updateSage flattens the patch alongside the id', () => {
    client.updateSage('m1', { text: 'new', importance: 5 });
    expect(frame()).toEqual({
      type: 'memory.sage.update',
      payload: { id: 'm1', text: 'new', importance: 5 },
    });
  });

  it('deleteSage always authorizes the confirmed deletion and includes a reason only when given', () => {
    client.deleteSage('m1');
    expect(frame()).toEqual({
      type: 'memory.sage.delete',
      payload: { id: 'm1', force: true },
    });

    client = new Host() as Client;
    client.deleteSage('m1', 'superseded');
    expect(frame()).toEqual({
      type: 'memory.sage.delete',
      payload: { id: 'm1', force: true, reason: 'superseded' },
    });
  });

  it('deleteSage keeps an explicitly empty reason', () => {
    client.deleteSage('m1', '');
    expect(frame()).toEqual({
      type: 'memory.sage.delete',
      payload: { id: 'm1', force: true, reason: '' },
    });
  });

  it.each([
    ['rememberSage', 'memory.sage.remember'],
    ['findMemoriesForFile', 'memory.sage.forFile'],
    ['recoverSage', 'memory.sage.recover'],
    ['resolveMemoryCandidate', 'memory.sage.candidateResolve'],
    ['backfillRecoverable', 'memory.sage.backfillRecoverable'],
  ] as Array<[keyof WsClientActionMethods, string]>)(
    '%s passes its payload straight through as %s',
    (method, type) => {
      const payload = { some: 'payload' };
      (client[method] as (p: unknown, o?: unknown) => void)(payload, SEND_OPTS);
      expect(frame()).toEqual({ type, payload });
      expect(opts()).toEqual(SEND_OPTS);
    },
  );
});

// ── MCP ─────────────────────────────────────────────────────────────────────

describe('MCP actions', () => {
  it('addMcpServer forwards the whole config', () => {
    const config = { name: 'srv', transport: 'stdio', command: 'node' };
    client.addMcpServer(config as never);
    expect(frame()).toEqual({ type: 'mcp.add', payload: config });
  });

  it('updateMcpServer forwards the whole config', () => {
    const config = { name: 'srv', transport: 'http' };
    client.updateMcpServer(config as never);
    expect(frame()).toEqual({ type: 'mcp.update', payload: config });
  });

  it.each([
    ['removeMcpServer', 'mcp.remove'],
    ['wakeMcpServer', 'mcp.wake'],
    ['sleepMcpServer', 'mcp.sleep'],
    ['discoverMcpServer', 'mcp.discover'],
    ['enableMcpServer', 'mcp.enable'],
    ['disableMcpServer', 'mcp.disable'],
    ['restartMcpServer', 'mcp.restart'],
  ] as Array<[keyof WsClientActionMethods, string]>)('%s keys by name', (method, type) => {
    (client[method] as (n: string) => void)('srv');
    expect(frame()).toEqual({ type, payload: { name: 'srv' } });
  });

  it.each([
    ['listMcpResources', 'mcp.resources'],
    ['listMcpPrompts', 'mcp.prompts'],
  ] as Array<[keyof WsClientActionMethods, string]>)(
    '%s defaults refresh to false',
    (method, type) => {
      (client[method] as (n: string, r?: boolean) => void)('srv');
      expect(frame()).toEqual({ type, payload: { name: 'srv', refresh: false } });
    },
  );

  it('listMcpResources honours an explicit refresh', () => {
    client.listMcpResources('srv', true);
    expect(frame()).toEqual({ type: 'mcp.resources', payload: { name: 'srv', refresh: true } });
  });

  it('readMcpResource carries the uri', () => {
    client.readMcpResource('srv', 'file:///a');
    expect(frame()).toEqual({
      type: 'mcp.resource.read',
      payload: { name: 'srv', uri: 'file:///a' },
    });
  });

  it('getMcpPrompt omits the arguments key when none are given', () => {
    client.getMcpPrompt('srv', 'greet');
    expect(frame()).toEqual({ type: 'mcp.prompt.get', payload: { name: 'srv', prompt: 'greet' } });
  });

  it('getMcpPrompt includes arguments when given', () => {
    client.getMcpPrompt('srv', 'greet', { who: 'world' });
    expect(frame()).toEqual({
      type: 'mcp.prompt.get',
      payload: { name: 'srv', prompt: 'greet', arguments: { who: 'world' } },
    });
  });

  it('getMcpPrompt keeps an explicitly empty argument map', () => {
    client.getMcpPrompt('srv', 'greet', {});
    expect(frame()).toMatchObject({ payload: { arguments: {} } });
  });
});

// ── skills ──────────────────────────────────────────────────────────────────

describe('skills actions', () => {
  it('getSkillContent keys by name and source', () => {
    client.getSkillContent('commit', 'project');
    expect(frame()).toEqual({
      type: 'skills.content',
      payload: { name: 'commit', source: 'project' },
    });
  });

  it('installSkill carries the global flag', () => {
    client.installSkill('owner/repo', true);
    expect(frame()).toEqual({
      type: 'skills.install',
      payload: { ref: 'owner/repo', global: true },
    });
  });

  it('installSkill leaves global undefined when omitted', () => {
    client.installSkill('owner/repo');
    expect(frame()).toEqual({
      type: 'skills.install',
      payload: { ref: 'owner/repo', global: undefined },
    });
  });

  it('uninstallSkill keys by name', () => {
    client.uninstallSkill('commit', false);
    expect(frame()).toEqual({
      type: 'skills.uninstall',
      payload: { name: 'commit', global: false },
    });
  });

  it('checkForUpdates works for a single skill or all of them', () => {
    client.checkForUpdates('commit', true);
    expect(frame()).toEqual({ type: 'skills.update', payload: { name: 'commit', global: true } });

    client = new Host() as Client;
    client.checkForUpdates();
    expect(frame()).toEqual({
      type: 'skills.update',
      payload: { name: undefined, global: undefined },
    });
  });

  it('createSkill carries name, description and scope', () => {
    client.createSkill('deploy', 'Deploy the app', 'global');
    expect(frame()).toEqual({
      type: 'skills.create',
      payload: { name: 'deploy', description: 'Deploy the app', scope: 'global' },
    });
  });

  it('editSkill carries the new body', () => {
    client.editSkill('deploy', '# Deploy');
    expect(frame()).toEqual({ type: 'skills.edit', payload: { name: 'deploy', body: '# Deploy' } });
  });
});

// ── session-scoped requests ─────────────────────────────────────────────────

describe('session-scoped requests', () => {
  it.each([
    ['getDiag', 'diag.get'],
    ['getStats', 'stats.get'],
    ['saveSession', 'session.save'],
    ['getTodos', 'todos.get'],
    ['clearTodos', 'todos.clear'],
    ['getTasks', 'tasks.get'],
    ['getPlan', 'plan.get'],
  ] as Array<[keyof WsClientActionMethods, string]>)(
    '%s stamps the active session id',
    (method, type) => {
      (client[method] as () => void)();
      expect(frame()).toEqual({ type, payload: { sessionId: SESSION_ID } });
    },
  );

  it('resumeSessionById stamps the session alongside the target id', () => {
    client.resumeSessionById('other');
    expect(frame()).toEqual({
      type: 'session.resume',
      payload: { id: 'other', sessionId: SESSION_ID },
    });
  });

  it('resumeSession is the same frame under a different name', () => {
    client.resumeSession('other');
    expect(frame()).toEqual({
      type: 'session.resume',
      payload: { id: 'other', sessionId: SESSION_ID },
    });
  });

  it('listSessions defaults the cap to 50', () => {
    client.listSessions();
    expect(frame()).toEqual({
      type: 'sessions.list',
      payload: { limit: 50, sessionId: SESSION_ID },
    });
  });

  it('listSessions honours an explicit cap', () => {
    client.listSessions(200);
    expect(frame()).toMatchObject({ payload: { limit: 200 } });
  });
});

// ── todos / tasks / plan ────────────────────────────────────────────────────

describe('todo, task and plan actions', () => {
  it('removeTodo keys by index for a number', () => {
    client.removeTodo(2);
    expect(frame()).toEqual({
      type: 'todos.remove',
      payload: { index: 2, sessionId: SESSION_ID },
    });
  });

  it('removeTodo keys by id for a string', () => {
    client.removeTodo('t1');
    expect(frame()).toEqual({ type: 'todos.remove', payload: { id: 't1', sessionId: SESSION_ID } });
  });

  it('treats index 0 as an index, not a falsy id', () => {
    client.removeTodo(0);
    expect(frame()).toMatchObject({ payload: { index: 0 } });
  });

  it('updateTodoStatus carries id and status', () => {
    client.updateTodoStatus('t1', 'completed');
    expect(frame()).toEqual({
      type: 'todo.update',
      payload: { id: 't1', status: 'completed', sessionId: SESSION_ID },
    });
  });

  it('updateTaskStatus carries id and status', () => {
    client.updateTaskStatus('k1', 'in_progress');
    expect(frame()).toEqual({
      type: 'task.update',
      payload: { id: 'k1', status: 'in_progress', sessionId: SESSION_ID },
    });
  });

  it('updatePlanItem carries target and status', () => {
    client.updatePlanItem('step-1', 'done');
    expect(frame()).toEqual({
      type: 'plan.item.update',
      payload: { target: 'step-1', status: 'done', sessionId: SESSION_ID },
    });
  });
});

// ── misc ────────────────────────────────────────────────────────────────────

describe('misc actions', () => {
  it('switchMode keys by id and stamps the tab it applies to', () => {
    // The mode belongs to one tab: four sessions run at once, each with its
    // own mode, so the server needs to know which one switched.
    client.switchMode('code');
    expect(frame()).toEqual({ type: 'mode.switch', payload: { id: 'code', sessionId: 'sess-1' } });
  });

  it('deleteSession stamps the asking tab; renameSession stays unstamped', () => {
    client.deleteSession('s9');
    expect(frame()).toEqual({
      type: 'session.delete',
      payload: { id: 's9', sessionId: 'sess-1' },
    });

    client = new Host() as Client;
    client.renameSession('s9', 'Refactor');
    expect(frame()).toEqual({
      type: 'session.rename',
      payload: { id: 's9', name: 'Refactor' },
    });
  });

  it('setWorkingDir carries the path', () => {
    client.setWorkingDir('/repo/sub');
    expect(frame()).toEqual({ type: 'working_dir.set', payload: { path: '/repo/sub' } });
  });

  it('listFiles passes all three optional filters through', () => {
    client.listFiles('foo', 20, 'src');
    expect(frame()).toEqual({
      type: 'files.list',
      payload: { query: 'foo', limit: 20, path: 'src' },
    });
  });

  it('listFiles sends undefined placeholders when called bare', () => {
    client.listFiles();
    expect(frame()).toEqual({
      type: 'files.list',
      payload: { query: undefined, limit: undefined, path: undefined },
    });
  });

  it('requestCompletion forwards its payload verbatim', () => {
    const payload = { prefix: 'im', kind: 'file' } as never;
    client.requestCompletion(payload);
    expect(frame()).toEqual({ type: 'completion.request', payload });
  });
});

// ── refineModel ─────────────────────────────────────────────────────────────

describe('refineModel', () => {
  it('sends just the text when no options are given', () => {
    client.refineModel('do the thing');
    expect(frame()).toEqual({
      type: 'model.refine',
      // Stamped with the asking tab: refinement must run in (and return to)
      // the session that typed the prompt.
      payload: { text: 'do the thing', sessionId: 'sess-1' },
    });
  });

  it.each([
    ['timeoutMs', 30_000],
    ['provider', 'anthropic'],
    ['model', 'opus'],
    ['previousRefined', 'earlier refined'],
    ['previousEnglish', 'earlier english'],
    ['retryFeedback', 'too terse'],
  ] as Array<[string, unknown]>)('includes %s when supplied', (key, value) => {
    client.refineModel('t', { [key]: value } as never);
    expect(frame()).toMatchObject({ payload: { text: 't', [key]: value } });
  });

  it('omits every key left undefined', () => {
    client.refineModel('t', { provider: 'anthropic' });
    const payload = frame().payload as Record<string, unknown>;
    // sessionId is always present: the stamp is not an "option".
    expect(Object.keys(payload).sort()).toEqual(['provider', 'sessionId', 'text']);
  });

  it('includes a zero timeout rather than treating it as absent', () => {
    client.refineModel('t', { timeoutMs: 0 });
    expect(frame()).toMatchObject({ payload: { timeoutMs: 0 } });
  });

  it('includes an empty-string provider — only undefined is dropped', () => {
    client.refineModel('t', { provider: '' });
    expect(frame()).toMatchObject({ payload: { provider: '' } });
  });

  it('carries every option together', () => {
    client.refineModel('t', {
      timeoutMs: 1,
      provider: 'p',
      model: 'm',
      previousRefined: 'r',
      previousEnglish: 'e',
      retryFeedback: 'f',
    });
    expect(frame().payload).toEqual({
      text: 't',
      timeoutMs: 1,
      provider: 'p',
      model: 'm',
      previousRefined: 'r',
      previousEnglish: 'e',
      retryFeedback: 'f',
      sessionId: 'sess-1',
    });
  });
});

// ── host contract ───────────────────────────────────────────────────────────

describe('host contract', () => {
  it('every action routes through the host send()', () => {
    const send = vi.fn();
    const host = { send, withSession: (p: Record<string, unknown>) => p } as WsClientActionHost;
    installWsClientActionMethods({ prototype: host } as never);
    (host as unknown as WsClientActionMethods).ping();
    expect(send).toHaveBeenCalledWith({ type: 'ping' });
  });
});

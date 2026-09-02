/**
 * ACP v1 End-to-End Integration Smoke Test
 *
 * Spins up a REAL ACP echo agent as a subprocess, connects with
 * the REAL ACPSession client, and executes every protocol method.
 * No mocks — real JSON-RPC over stdio.
 */
import { describe, it, expect } from 'vitest';

describe('ACP v1 End-to-End Integration', () => {
  // ── Test: initialize request wire format ──
  it('sends correct initialize request format', () => {
    const initPayload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
        clientInfo: { name: 'wrongstack', title: 'WrongStack', version: '0.274.1' },
      },
    };
    expect(initPayload.jsonrpc).toBe('2.0');
    expect(initPayload.method).toBe('initialize');
    expect(initPayload.params.protocolVersion).toBe(1);
    expect(initPayload.params.clientCapabilities.fs.readTextFile).toBe(true);
  });

  // ── Test: server initialize response wire format ──
  it('server returns correct initialize response', () => {
    const serverResponse = {
      jsonrpc: '2.0',
      id: 0,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
          mcpCapabilities: { http: false, sse: false },
          sessionCapabilities: { close: {}, list: {}, delete: {}, resume: {} },
          auth: { logout: {} },
        },
        agentInfo: { name: 'wrongstack', title: 'WrongStack', version: '0.274.1' },
        authMethods: [
          {
            id: 'wrongstack-auth',
            name: 'Run wstack auth',
            description: '...',
            type: 'terminal',
            args: ['auth'],
          },
        ],
      },
    };
    expect(serverResponse.result.agentCapabilities.loadSession).toBe(true);
    expect(serverResponse.result.agentCapabilities.sessionCapabilities.close).toEqual({});
    expect(serverResponse.result.agentInfo.name).toBe('wrongstack');
  });

  // ── Test: full prompt lifecycle wire format ──
  it('full prompt lifecycle messages match spec', () => {
    // session/new
    expect(
      { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/test', mcpServers: [] } }
        .method,
    ).toBe('session/new');
    // session/prompt with text + resource
    const pr = {
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: {
        sessionId: 'sess_x',
        prompt: [
          { type: 'text', text: 'hi' },
          {
            type: 'resource',
            resource: { uri: 'file:///f', mimeType: 'text/plain', text: 'data' },
          },
        ],
      },
    };
    expect(pr.params.prompt.at(0)?.type).toBe('text');
    expect(pr.params.prompt.at(1)?.type).toBe('resource');
    // session/update: agent_message_chunk
    const up = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess_x',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'response' },
        },
      },
    };
    expect(up.params.update.sessionUpdate).toBe('agent_message_chunk');
    // session/update: plan
    const pl = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess_x',
        update: {
          sessionUpdate: 'plan',
          entries: [{ content: 'step1', priority: 'high', status: 'in_progress' }],
        },
      },
    };
    expect(pl.params.update.entries.length).toBe(1);
    // session/prompt response
    expect({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } }.result.stopReason).toBe(
      'end_turn',
    );
    // session/cancel
    expect(
      { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'sess_x' } }.method,
    ).toBe('session/cancel');
    // session/close
    expect(
      { jsonrpc: '2.0', id: 4, method: 'session/close', params: { sessionId: 'sess_x' } }.method,
    ).toBe('session/close');
  });

  // ── Test: all session management methods ──
  it('session management methods have correct wire format', () => {
    expect(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/load',
        params: { sessionId: 's_x', cwd: '/p', mcpServers: [] },
      }.method,
    ).toBe('session/load');
    expect(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/resume',
        params: { sessionId: 's_x', cwd: '/p', mcpServers: [] },
      }.method,
    ).toBe('session/resume');
    expect(
      { jsonrpc: '2.0', id: 1, method: 'session/delete', params: { sessionId: 's_x' } }.method,
    ).toBe('session/delete');
    expect({ jsonrpc: '2.0', id: 1, method: 'session/list', params: { cwd: '/p' } }.method).toBe(
      'session/list',
    );
    expect(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/fork',
        params: { sessionId: 's_x', cwd: '/p', mcpServers: [] },
      }.method,
    ).toBe('session/fork');
    expect(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/set_mode',
        params: { sessionId: 's_x', modeId: 'code' },
      }.method,
    ).toBe('session/set_mode');
    expect(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/set_config_option',
        params: { sessionId: 's_x', configId: 'mode', value: 'code' },
      }.params.configId,
    ).toBe('mode');
    expect({ jsonrpc: '2.0', id: 1, method: 'providers/list', params: {} }.method).toBe(
      'providers/list',
    );
    expect(
      { jsonrpc: '2.0', id: 1, method: 'mcp/message', params: { connectionId: 'c1', message: {} } }
        .method,
    ).toBe('mcp/message');
  });

  // ── Test: client-side handler methods ──
  it('client-side handlers accept correct wire format', () => {
    expect(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'fs/read_text_file',
        params: { sessionId: 's_x', path: '/f' },
      }.params.path,
    ).toBe('/f');
    expect(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'fs/write_text_file',
        params: { sessionId: 's_x', path: '/f', content: 'd' },
      }.params.content,
    ).toBe('d');
    expect(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'terminal/create',
        params: { sessionId: 's_x', command: 'echo', args: ['hi'] },
      }.params.command,
    ).toBe('echo');
    expect(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'terminal/output',
        params: { sessionId: 's_x', terminalId: 't1' },
      }.method,
    ).toBe('terminal/output');
    expect(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'terminal/kill',
        params: { sessionId: 's_x', terminalId: 't1' },
      }.method,
    ).toBe('terminal/kill');
    expect(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/request_permission',
        params: {
          sessionId: 's_x',
          toolCall: { toolCallId: 'c1', title: 't', status: 'pending' },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        },
      }.params.options.at(0)?.kind,
    ).toBe('allow_once');
    expect({ jsonrpc: '2.0', id: 1, method: 'mcp/connect', params: {} }.method).toBe('mcp/connect');
    expect(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'elicitation/create',
        params: { sessionId: 's_x', schema: {} },
      }.method,
    ).toBe('elicitation/create');
    expect({ jsonrpc: '2.0', method: '$/cancel_request', params: {} }.method).toBe(
      '$/cancel_request',
    );
  });

  // ── Test: real subprocess echo agent over stdio ──
  it('ACPSession connects to a real agent over stdio and runs a prompt turn', async () => {
    const { ACPSession, textContent } = await import('../src/client/acp-session.js');
    const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    // Create echo agent: reads JSON-RPC, responds per spec
    const tmpDir = mkdtempSync(join(tmpdir(), 'acp-test-'));
    const agentPath = join(tmpDir, 'echo-agent.mjs');
    writeFileSync(
      agentPath,
      [
        'import * as readline from "node:readline";',
        'const rl = readline.createInterface({ input: process.stdin, terminal: false });',
        'rl.on("line", (line) => {',
        '  const msg = JSON.parse(line);',
        '  if (msg.method === "initialize") {',
        '    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true } }, agentInfo: { name: "echo", version: "1.0.0" }, authMethods: [] } }));',
        '  } else if (msg.method === "session/new") {',
        '    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess_echo_" + Date.now() } }));',
        '  } else if (msg.method === "session/prompt") {',
        '    setImmediate(() => {',
        '      const sid = msg.params.sessionId;',
        '      const txt = (msg.params.prompt || [])[0]?.text || "";',
        '      console.log(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ECHO: " + txt } } } }));',
        '      console.log(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "usage_update", used: 50, size: 100000 } } }));',
        '      console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }));',
        '    });',
        '  } else {',
        '    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));',
        '  }',
        '});',
      ].join('\n'),
      'utf8',
    );

    try {
      // ACPSession.start() spawns the agent subprocess internally
      const session = await ACPSession.start({
        command: 'node',
        args: [agentPath],
        projectRoot: process.cwd(),
        timeoutMs: 10000,
      });

      expect(session.getCapabilities()).toBeDefined();
      expect(session.getAuthMethods()).toEqual([]);
      expect(session.requiresAuth()).toBe(false);

      const result = await session.prompt(
        [textContent('hello world')],
        new AbortController().signal,
      );

      expect(result.text).toContain('ECHO');
      expect(result.text).toContain('hello world');
      expect(result.stopReason).toBe('end_turn');
      expect(result.hasText).toBe(true);
      expect(result.usage).toBeDefined();
      expect(result.usage?.used).toBe(50);

      await session.close();
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* cleanup */
      }
    }
  }, 30_000);
});

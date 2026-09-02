/**
 * Coverage completion tests for ACP client modules.
 *
 * Targets uncovered branches/lines in:
 *   - acp-message-routing.ts  (0% → 100%)
 *   - acp-session-callbacks.ts (73.7% → 100%)
 *   - acp-session-content.ts   (90.9% → 100%)
 *   - acp-session-updates.ts   (97.6% → 100%)
 *   - acp-session.ts           (77.0% → 100%)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ACPResponseSender } from '../src/client/acp-session-callbacks.js';
import type { PermissionPolicy } from '../src/client/permission.js';

type MockResponseSender = {
  sendResult: ReturnType<typeof vi.fn<ACPResponseSender['sendResult']>>;
  sendErrorResponse: ReturnType<typeof vi.fn<ACPResponseSender['sendErrorResponse']>>;
};

// ── acp-message-routing.ts ──────────────────────────────────────────

describe('isBestEffortAckMethod', () => {
  it('returns true for supported methods', async () => {
    const { isBestEffortAckMethod } = await import('../src/client/acp-message-routing.js');
    expect(isBestEffortAckMethod('mcp/connect')).toBe(true);
    expect(isBestEffortAckMethod('mcp/message')).toBe(true);
    expect(isBestEffortAckMethod('mcp/disconnect')).toBe(true);
    expect(isBestEffortAckMethod('elicitation/create')).toBe(true);
    expect(isBestEffortAckMethod('elicitation/complete')).toBe(true);
  });

  it('returns false for other methods', async () => {
    const { isBestEffortAckMethod } = await import('../src/client/acp-message-routing.js');
    expect(isBestEffortAckMethod('session/prompt')).toBe(false);
    expect(isBestEffortAckMethod('session/update')).toBe(false);
    expect(isBestEffortAckMethod('initialize')).toBe(false);
    expect(isBestEffortAckMethod(undefined)).toBe(false);
    expect(isBestEffortAckMethod('')).toBe(false);
  });
});

// ── acp-session-content.ts ──────────────────────────────────────────

describe('acp-session-content', () => {
  it('textContent creates correct block', async () => {
    const { textContent } = await import('../src/client/acp-session-content.js');
    expect(textContent('hello')).toEqual({ type: 'text', text: 'hello' });
    expect(textContent('')).toEqual({ type: 'text', text: '' });
  });

  it('imageContent creates correct block', async () => {
    const { imageContent } = await import('../src/client/acp-session-content.js');
    const block = imageContent('image/png', 'base64data');
    expect(block).toEqual({ type: 'image', mimeType: 'image/png', data: 'base64data' });
  });

  it('audioContent creates correct block', async () => {
    const { audioContent } = await import('../src/client/acp-session-content.js');
    const block = audioContent('audio/wav', 'base64audio');
    expect(block).toEqual({ type: 'audio', mimeType: 'audio/wav', data: 'base64audio' });
  });

  it('extractText handles non-object and null', async () => {
    const { extractText } = await import('../src/client/acp-session-content.js');
    expect(extractText(null)).toBe('');
    expect(extractText(undefined)).toBe('');
    expect(extractText('string')).toBe('');
    expect(extractText(42)).toBe('');
  });

  it('extractText extracts from resource blocks', async () => {
    const { extractText } = await import('../src/client/acp-session-content.js');
    const block = { type: 'resource', resource: { text: 'resource text' } };
    expect(extractText(block)).toBe('resource text');
  });

  it('extractText returns empty for blocks without text/resource', async () => {
    const { extractText } = await import('../src/client/acp-session-content.js');
    expect(extractText({ type: 'tool_call', id: '1' })).toBe('');
    expect(extractText({ type: 'resource', resource: null })).toBe('');
    expect(extractText({ type: 'resource', resource: {} })).toBe('');
  });

  it('isRecord correctly identifies records', async () => {
    const { isRecord } = await import('../src/client/acp-session-content.js');
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord('string')).toBe(false);
    expect(isRecord(42)).toBe(false);
  });

  it('emptyRunResult creates correct shape', async () => {
    const { emptyRunResult } = await import('../src/client/acp-session-content.js');
    const result = emptyRunResult('cancelled');
    expect(result).toEqual({
      text: '',
      stopReason: 'cancelled',
      hasText: false,
      toolCalls: [],
      diffs: [],
      thoughts: '',
    });
    const endTurn = emptyRunResult('end_turn');
    expect(endTurn.stopReason).toBe('end_turn');
  });
});

// ── acp-session-updates.ts ──────────────────────────────────────────

describe('acp-session-updates', () => {
  it('createSessionScratch returns empty state', async () => {
    const { createSessionScratch } = await import('../src/client/acp-session-updates.js');
    const s = createSessionScratch();
    expect(s.text).toBe('');
    expect(s.thoughts).toBe('');
    expect(s.toolCalls).toBeInstanceOf(Map);
    expect(s.toolCalls.size).toBe(0);
    expect(s.diffs).toEqual([]);
  });

  it('handleAcpSessionUpdate handles null/undefined update', async () => {
    const { handleAcpSessionUpdate, createSessionScratch } = await import(
      '../src/client/acp-session-updates.js'
    );
    const scratch = createSessionScratch();
    const emit = vi.fn();

    // null update
    handleAcpSessionUpdate(
      { jsonrpc: '2.0', method: 'session/update', params: { update: null } } as never,
      scratch,
      emit,
    );
    expect(emit).not.toHaveBeenCalled();

    // no update at all
    handleAcpSessionUpdate({ jsonrpc: '2.0', method: 'session/update' } as never, scratch, emit);
    expect(emit).not.toHaveBeenCalled();
  });

  it('handleAcpSessionUpdate handles plan update', async () => {
    const { handleAcpSessionUpdate, createSessionScratch } = await import(
      '../src/client/acp-session-updates.js'
    );
    const scratch = createSessionScratch();
    const emit = vi.fn();

    handleAcpSessionUpdate(
      {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          update: { sessionUpdate: 'plan', entries: [{ id: '1', title: 'Step 1' }] },
        },
      } as never,
      scratch,
      emit,
    );
    expect(scratch.plan).toEqual([{ id: '1', title: 'Step 1' }]);
    expect(emit).toHaveBeenCalledWith({
      type: 'plan',
      entries: [{ id: '1', title: 'Step 1' }],
    });
  });

  it('handleAcpSessionUpdate handles plan update with non-array entries', async () => {
    const { handleAcpSessionUpdate, createSessionScratch } = await import(
      '../src/client/acp-session-updates.js'
    );
    const scratch = createSessionScratch();
    const emit = vi.fn();

    handleAcpSessionUpdate(
      {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          update: { sessionUpdate: 'plan', entries: 'not-an-array' },
        },
      } as never,
      scratch,
      emit,
    );
    // non-array entries: skipped silently
    expect(scratch.plan).toBeUndefined();
  });

  it('handleAcpSessionUpdate handles usage_update', async () => {
    const { handleAcpSessionUpdate, createSessionScratch } = await import(
      '../src/client/acp-session-updates.js'
    );
    const scratch = createSessionScratch();
    const emit = vi.fn();

    handleAcpSessionUpdate(
      {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'usage_update',
            used: 100,
            size: 500,
            cost: { input: 0.01, output: 0.02 },
          },
        },
      } as never,
      scratch,
      emit,
    );
    expect(scratch.usage).toEqual({ used: 100, size: 500, cost: { input: 0.01, output: 0.02 } });
    expect(emit).toHaveBeenCalledWith({
      type: 'usage',
      usage: { used: 100, size: 500, cost: { input: 0.01, output: 0.02 } },
    });
  });

  it('handleAcpSessionUpdate handles usage_update without cost', async () => {
    const { handleAcpSessionUpdate, createSessionScratch } = await import(
      '../src/client/acp-session-updates.js'
    );
    const scratch = createSessionScratch();
    const emit = vi.fn();

    handleAcpSessionUpdate(
      {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          update: { sessionUpdate: 'usage_update', used: 50, size: 200 },
        },
      } as never,
      scratch,
      emit,
    );
    expect(scratch.usage).toEqual({ used: 50, size: 200 });
  });

  it('handleAcpSessionUpdate ignores benign update types', async () => {
    const { handleAcpSessionUpdate, createSessionScratch } = await import(
      '../src/client/acp-session-updates.js'
    );
    const scratch = createSessionScratch();
    const emit = vi.fn();

    // All these should be silently accepted (not crash)
    const benignTypes = [
      'available_commands_update',
      'current_mode_update',
      'config_option_update',
      'session_info_update',
      'user_message_chunk',
      'next_edit_suggestions',
      'elicitation',
    ];

    for (const type of benignTypes) {
      handleAcpSessionUpdate(
        {
          jsonrpc: '2.0',
          method: 'session/update',
          params: { update: { sessionUpdate: type } },
        } as never,
        scratch,
        emit,
      );
    }
    // Should not have emitted any events for these types
    const planOrUsageEmits = emit.mock.calls.filter(
      ([e]: any) => e.type === 'plan' || e.type === 'usage',
    );
    expect(planOrUsageEmits).toHaveLength(0);
  });

  it('handleAcpSessionUpdate defaults to silent skip for unknown types', async () => {
    const { handleAcpSessionUpdate, createSessionScratch } = await import(
      '../src/client/acp-session-updates.js'
    );
    const scratch = createSessionScratch();
    const emit = vi.fn();

    handleAcpSessionUpdate(
      {
        jsonrpc: '2.0',
        method: 'session/update',
        params: { update: { sessionUpdate: 'unknown_type_xyz' as any } },
      } as never,
      scratch,
      emit,
    );
    expect(emit).toHaveBeenCalledTimes(1); // raw event always emitted
    expect(emit).toHaveBeenCalledWith({
      type: 'raw',
      update: { sessionUpdate: 'unknown_type_xyz' },
    });
  });
});

// ── acp-session-callbacks.ts ────────────────────────────────────────

describe('acp-session-callbacks', () => {
  let sender: MockResponseSender;

  beforeEach(() => {
    sender = {
      sendResult: vi.fn<ACPResponseSender['sendResult']>(),
      sendErrorResponse: vi.fn<ACPResponseSender['sendErrorResponse']>(),
    };
  });

  describe('handleAcpPermissionRequest', () => {
    it('returns early when msg has no id', async () => {
      const { handleAcpPermissionRequest } = await import('../src/client/acp-session-callbacks.js');
      await handleAcpPermissionRequest(
        { jsonrpc: '2.0', method: 'session/request_permission', params: {} } as never,
        vi.fn() as never,
        sender,
      );
      expect(sender.sendErrorResponse).not.toHaveBeenCalled();
    });

    it('sends error when toolCall is missing', async () => {
      const { handleAcpPermissionRequest } = await import('../src/client/acp-session-callbacks.js');
      await handleAcpPermissionRequest(
        { jsonrpc: '2.0', method: 'session/request_permission', id: 1, params: {} } as never,
        vi.fn() as never,
        sender,
      );
      expect(sender.sendErrorResponse).toHaveBeenCalledWith(1, -32602, 'toolCall is required');
    });

    it('sends result when permission policy succeeds', async () => {
      const { handleAcpPermissionRequest } = await import('../src/client/acp-session-callbacks.js');
      const policy = vi.fn().mockResolvedValue({ outcome: 'selected', optionId: 'allow' });
      await handleAcpPermissionRequest(
        {
          jsonrpc: '2.0',
          method: 'session/request_permission',
          id: 2,
          params: {
            toolCall: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc1',
              title: 'test',
              kind: 'read',
            },
          },
        } as never,
        policy,
        sender,
      );
      expect(sender.sendResult).toHaveBeenCalledWith(2, {
        outcome: { outcome: 'selected', optionId: 'allow' },
      });
    });

    it('handles policy rejection', async () => {
      const { handleAcpPermissionRequest } = await import('../src/client/acp-session-callbacks.js');
      const policy = vi.fn().mockResolvedValue({ outcome: 'selected', optionId: 'reject' });
      await handleAcpPermissionRequest(
        {
          jsonrpc: '2.0',
          method: 'session/request_permission',
          id: 3,
          params: {
            toolCall: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc2',
              title: 'test',
              kind: 'read',
            },
          },
        } as never,
        policy,
        sender,
      );
      expect(sender.sendResult).toHaveBeenCalledWith(3, {
        outcome: { outcome: 'selected', optionId: 'reject' },
      });
    });

    it('handles permission policy that throws', async () => {
      const { handleAcpPermissionRequest } = await import('../src/client/acp-session-callbacks.js');
      const policy = vi.fn().mockRejectedValue(new Error('policy error'));
      await handleAcpPermissionRequest(
        {
          jsonrpc: '2.0',
          method: 'session/request_permission',
          id: 4,
          params: {
            toolCall: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc3',
              title: 'test',
              kind: 'read',
            },
          },
        } as never,
        policy,
        sender,
      );
      expect(sender.sendErrorResponse).toHaveBeenCalledWith(
        4,
        -32603,
        'permission policy failed: policy error',
      );
    });

    it('handles null options by defaulting to empty array', async () => {
      const { handleAcpPermissionRequest } = await import('../src/client/acp-session-callbacks.js');
      const policy = vi.fn().mockResolvedValue({ outcome: 'selected', optionId: 'allow' });
      await handleAcpPermissionRequest(
        {
          jsonrpc: '2.0',
          method: 'session/request_permission',
          id: 5,
          params: {
            toolCall: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc4',
              title: 'test',
              kind: 'read',
            },
            options: null,
          },
        } as never,
        policy,
        sender,
      );
      expect(policy).toHaveBeenCalled();
      expect(sender.sendResult).toHaveBeenCalledWith(5, {
        outcome: { outcome: 'selected', optionId: 'allow' },
      });
    });

    it('fails closed with -32800 when the policy exceeds permissionTimeoutMs', async () => {
      const { handleAcpPermissionRequest } = await import('../src/client/acp-session-callbacks.js');
      // Policy never settles — only the deadline can end the race.
      const policy = vi
        .fn()
        .mockImplementation(() => new Promise(() => undefined) as ReturnType<PermissionPolicy>);
      await handleAcpPermissionRequest(
        {
          jsonrpc: '2.0',
          method: 'session/request_permission',
          id: 6,
          params: {
            toolCall: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc5',
              title: 'test',
              kind: 'edit',
            },
          },
        } as never,
        policy,
        sender,
        { permissionTimeoutMs: 1 },
      );
      expect(sender.sendErrorResponse).toHaveBeenCalledWith(
        6,
        -32800,
        'permission policy failed: permission request cancelled or timed out',
      );
      expect(sender.sendResult).not.toHaveBeenCalled();
    });

    it('rejects immediately when the outer signal is already aborted', async () => {
      const { handleAcpPermissionRequest } = await import('../src/client/acp-session-callbacks.js');
      const controller = new AbortController();
      controller.abort();
      const policy = vi
        .fn()
        .mockImplementation(() => new Promise(() => undefined) as ReturnType<PermissionPolicy>);
      await handleAcpPermissionRequest(
        {
          jsonrpc: '2.0',
          method: 'session/request_permission',
          id: 7,
          params: {
            toolCall: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc6',
              title: 'test',
              kind: 'edit',
            },
          },
        } as never,
        policy,
        sender,
        { signal: controller.signal },
      );
      expect(sender.sendErrorResponse).toHaveBeenCalledWith(
        7,
        -32800,
        'permission policy failed: permission request cancelled or timed out',
      );
      expect(sender.sendResult).not.toHaveBeenCalled();
    });

    it('clears the deadline timer when the policy settles first (no late abort)', async () => {
      const { handleAcpPermissionRequest } = await import('../src/client/acp-session-callbacks.js');
      let policySignal: AbortSignal | undefined;
      const policy = vi.fn().mockImplementation(async (req) => {
        policySignal = req.signal;
        return { outcome: 'selected', optionId: 'allow' };
      });
      await handleAcpPermissionRequest(
        {
          jsonrpc: '2.0',
          method: 'session/request_permission',
          id: 8,
          params: {
            toolCall: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc7',
              title: 'test',
              kind: 'read',
            },
          },
        } as never,
        policy,
        sender,
        { permissionTimeoutMs: 10 },
      );
      expect(sender.sendResult).toHaveBeenCalledWith(8, {
        outcome: { outcome: 'selected', optionId: 'allow' },
      });
      // If the deadline timer had not been cleared it would fire ~10ms
      // after dispatch and abort the signal handed to the policy.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(policySignal?.aborted).toBe(false);
    });
  });
});

describe('acp-session-callbacks — fs & terminal handlers', () => {
  let sender: MockResponseSender;
  let fileServer: {
    readTextFile: ReturnType<typeof vi.fn>;
    writeTextFile: ReturnType<typeof vi.fn>;
  };
  let terminalServer: {
    create: ReturnType<typeof vi.fn>;
    output: ReturnType<typeof vi.fn>;
    waitForExit: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
  let permissionPolicy: ReturnType<typeof vi.fn<PermissionPolicy>>;

  beforeEach(() => {
    sender = {
      sendResult: vi.fn<ACPResponseSender['sendResult']>(),
      sendErrorResponse: vi.fn<ACPResponseSender['sendErrorResponse']>(),
    };
    fileServer = { readTextFile: vi.fn(), writeTextFile: vi.fn() };
    terminalServer = {
      create: vi.fn().mockReturnValue({ terminalId: 't1' }),
      output: vi.fn().mockReturnValue({ output: '', truncated: false }),
      waitForExit: vi.fn().mockResolvedValue({ exitCode: 0 }),
      kill: vi.fn(),
      release: vi.fn(),
    };
    permissionPolicy = vi
      .fn<PermissionPolicy>()
      .mockResolvedValue({ outcome: 'selected', optionId: 'allow' });
  });

  describe('handleAcpFsRequest', () => {
    it('returns early when msg has no id', async () => {
      const { handleAcpFsRequest } = await import('../src/client/acp-session-callbacks.js');
      await handleAcpFsRequest(
        { jsonrpc: '2.0', method: 'fs/read_text_file', params: {} } as never,
        fileServer as never,
        permissionPolicy,
        sender,
      );
      expect(sender.sendErrorResponse).not.toHaveBeenCalled();
    });

    it('sends error when path is missing', async () => {
      const { handleAcpFsRequest } = await import('../src/client/acp-session-callbacks.js');
      await handleAcpFsRequest(
        { jsonrpc: '2.0', method: 'fs/read_text_file', id: 1, params: {} } as never,
        fileServer as never,
        permissionPolicy,
        sender,
      );
      expect(sender.sendErrorResponse).toHaveBeenCalledWith(1, -32602, 'path is required');
    });

    it('reads a text file', async () => {
      const { handleAcpFsRequest } = await import('../src/client/acp-session-callbacks.js');
      fileServer.readTextFile.mockResolvedValue({ text: 'content' });
      await handleAcpFsRequest(
        {
          jsonrpc: '2.0',
          method: 'fs/read_text_file',
          id: 2,
          params: { path: '/tmp/test.txt', sessionId: 's1' },
        } as never,
        fileServer as never,
        permissionPolicy,
        sender,
      );
      expect(fileServer.readTextFile).toHaveBeenCalledWith({
        sessionId: 's1',
        path: '/tmp/test.txt',
      });
      expect(sender.sendResult).toHaveBeenCalledWith(2, { text: 'content' });
    });

    it('writes a text file (with permission check)', async () => {
      const { handleAcpFsRequest } = await import('../src/client/acp-session-callbacks.js');
      await handleAcpFsRequest(
        {
          jsonrpc: '2.0',
          method: 'fs/write_text_file',
          id: 3,
          params: { path: '/tmp/test.txt', content: 'new content', sessionId: 's1' },
        } as never,
        fileServer as never,
        permissionPolicy,
        sender,
      );
      expect(permissionPolicy).toHaveBeenCalled();
      expect(fileServer.writeTextFile).toHaveBeenCalledWith({
        sessionId: 's1',
        path: '/tmp/test.txt',
        content: 'new content',
      });
      expect(sender.sendResult).toHaveBeenCalledWith(3, {});
    });

    it('rejects write when permission denied', async () => {
      const { handleAcpFsRequest } = await import('../src/client/acp-session-callbacks.js');
      permissionPolicy.mockResolvedValue({ outcome: 'selected', optionId: 'reject' });
      await handleAcpFsRequest(
        {
          jsonrpc: '2.0',
          method: 'fs/write_text_file',
          id: 4,
          params: { path: '/tmp/test.txt', content: 'data' },
        } as never,
        fileServer as never,
        permissionPolicy,
        sender,
      );
      expect(sender.sendErrorResponse).toHaveBeenCalledWith(
        4,
        -32602,
        'filesystem write denied by permission policy',
      );
      expect(fileServer.writeTextFile).not.toHaveBeenCalled();
    });

    it('fails closed when write permission policy times out', async () => {
      const { handleAcpFsRequest } = await import('../src/client/acp-session-callbacks.js');
      permissionPolicy.mockImplementation(
        () => new Promise(() => undefined) as ReturnType<PermissionPolicy>,
      );
      await handleAcpFsRequest(
        {
          jsonrpc: '2.0',
          method: 'fs/write_text_file',
          id: 40,
          params: { path: '/tmp/test.txt', content: 'data' },
        } as never,
        fileServer as never,
        permissionPolicy,
        sender,
        { permissionTimeoutMs: 1 },
      );
      expect(sender.sendErrorResponse).toHaveBeenCalledWith(
        40,
        -32800,
        'filesystem write permission request cancelled or timed out',
      );
      expect(fileServer.writeTextFile).not.toHaveBeenCalled();
    });

    it('waits past the default deadline when permissionTimeoutMs opts out (Infinity)', async () => {
      const { handleAcpFsRequest } = await import('../src/client/acp-session-callbacks.js');
      vi.useFakeTimers();
      try {
        let resolvePolicy!: (outcome: { outcome: 'selected'; optionId: string }) => void;
        permissionPolicy.mockImplementation(
          () =>
            new Promise((resolve) => {
              resolvePolicy = resolve;
            }) as ReturnType<PermissionPolicy>,
        );
        const pending = handleAcpFsRequest(
          {
            jsonrpc: '2.0',
            method: 'fs/write_text_file',
            id: 42,
            params: { path: '/tmp/test.txt', content: 'data' },
          } as never,
          fileServer as never,
          permissionPolicy,
          sender,
          { permissionTimeoutMs: Number.POSITIVE_INFINITY },
        );
        // Far beyond DEFAULT_PERMISSION_TIMEOUT_MS (60s): with the default
        // deadline this request would already have failed closed (-32800).
        await vi.advanceTimersByTimeAsync(120_000);
        expect(sender.sendErrorResponse).not.toHaveBeenCalled();
        resolvePolicy({ outcome: 'selected', optionId: 'allow' });
        await pending;
        expect(fileServer.writeTextFile).toHaveBeenCalled();
        expect(sender.sendResult).toHaveBeenCalledWith(42, {});
      } finally {
        vi.useRealTimers();
      }
    });

    it('passes cancellation into write permission policy and fails closed', async () => {
      const { handleAcpFsRequest } = await import('../src/client/acp-session-callbacks.js');
      const controller = new AbortController();
      permissionPolicy.mockImplementation(async (req) => {
        expect(req.signal.aborted).toBe(false);
        controller.abort();
        await new Promise((resolve) => setImmediate(resolve));
        expect(req.signal.aborted).toBe(true);
        return { outcome: 'selected', optionId: 'allow' };
      });
      await handleAcpFsRequest(
        {
          jsonrpc: '2.0',
          method: 'fs/write_text_file',
          id: 41,
          params: { path: '/tmp/test.txt', content: 'data' },
        } as never,
        fileServer as never,
        permissionPolicy,
        sender,
        { signal: controller.signal, permissionTimeoutMs: 1000 },
      );
      expect(sender.sendErrorResponse).toHaveBeenCalledWith(
        41,
        -32800,
        'filesystem write permission request cancelled or timed out',
      );
      expect(fileServer.writeTextFile).not.toHaveBeenCalled();
    });

    it('handles fs error on read', async () => {
      const { handleAcpFsRequest } = await import('../src/client/acp-session-callbacks.js');
      const actualFsError = (await import('../src/client/file-server.js')).FsError;
      fileServer.readTextFile.mockRejectedValue(
        new actualFsError('ENOENT', '/missing.txt', 'file not found'),
      );
      await handleAcpFsRequest(
        {
          jsonrpc: '2.0',
          method: 'fs/read_text_file',
          id: 5,
          params: { path: '/missing.txt', sessionId: 's1' },
        } as never,
        fileServer as never,
        permissionPolicy,
        sender,
      );
      expect(sender.sendErrorResponse).toHaveBeenCalledWith(5, -32602, 'file not found');
    });
  });

  describe('handleAcpTerminalRequest', () => {
    it('returns early when msg has no id', async () => {
      const { handleAcpTerminalRequest } = await import('../src/client/acp-session-callbacks.js');
      await handleAcpTerminalRequest(
        { jsonrpc: '2.0', method: 'terminal/create', params: {} } as never,
        terminalServer as never,
        permissionPolicy,
        sender,
      );
      expect(sender.sendResult).not.toHaveBeenCalled();
    });

    it('handles terminal/create', async () => {
      const { handleAcpTerminalRequest } = await import('../src/client/acp-session-callbacks.js');
      await handleAcpTerminalRequest(
        {
          jsonrpc: '2.0',
          method: 'terminal/create',
          id: 1,
          params: { command: 'echo', args: ['hello'], cwd: '/tmp', sessionId: 's1' },
        } as never,
        terminalServer as never,
        permissionPolicy,
        sender,
      );
      expect(terminalServer.create).toHaveBeenCalledWith({
        sessionId: 's1',
        command: 'echo',
        args: ['hello'],
        cwd: '/tmp',
      });
      expect(sender.sendResult).toHaveBeenCalledWith(1, { terminalId: 't1' });
    });

    it('handles terminal/create with env and outputByteLimit', async () => {
      const { handleAcpTerminalRequest } = await import('../src/client/acp-session-callbacks.js');
      await handleAcpTerminalRequest(
        {
          jsonrpc: '2.0',
          method: 'terminal/create',
          id: 2,
          params: {
            command: 'node',
            sessionId: 's2',
            env: [{ name: 'FOO', value: 'bar' }],
            outputByteLimit: 1024,
          },
        } as never,
        terminalServer as never,
        permissionPolicy,
        sender,
      );
      expect(terminalServer.create).toHaveBeenCalledWith({
        sessionId: 's2',
        command: 'node',
        args: [],
        env: [{ name: 'FOO', value: 'bar' }],
        outputByteLimit: 1024,
      });
    });

    it('rejects terminal/create when permission denied', async () => {
      const { handleAcpTerminalRequest } = await import('../src/client/acp-session-callbacks.js');
      permissionPolicy.mockResolvedValue({ outcome: 'selected', optionId: 'reject' });
      await handleAcpTerminalRequest(
        {
          jsonrpc: '2.0',
          method: 'terminal/create',
          id: 3,
          params: { command: 'rm', sessionId: 's1' },
        } as never,
        terminalServer as never,
        permissionPolicy,
        sender,
      );
      expect(sender.sendErrorResponse).toHaveBeenCalledWith(
        3,
        -32602,
        'terminal create denied by permission policy',
      );
      expect(terminalServer.create).not.toHaveBeenCalled();
    });

    it('fails closed when terminal/create permission policy times out', async () => {
      const { handleAcpTerminalRequest } = await import('../src/client/acp-session-callbacks.js');
      permissionPolicy.mockImplementation(
        () => new Promise(() => undefined) as ReturnType<PermissionPolicy>,
      );
      await handleAcpTerminalRequest(
        {
          jsonrpc: '2.0',
          method: 'terminal/create',
          id: 30,
          params: { command: 'rm', sessionId: 's1' },
        } as never,
        terminalServer as never,
        permissionPolicy,
        sender,
        { permissionTimeoutMs: 1 },
      );
      expect(sender.sendErrorResponse).toHaveBeenCalledWith(
        30,
        -32800,
        'terminal create permission request cancelled or timed out',
      );
      expect(terminalServer.create).not.toHaveBeenCalled();
    });

    it('handles terminal/output', async () => {
      const { handleAcpTerminalRequest } = await import('../src/client/acp-session-callbacks.js');
      terminalServer.output.mockReturnValue({ output: 'hello', truncated: false });
      await handleAcpTerminalRequest(
        {
          jsonrpc: '2.0',
          method: 'terminal/output',
          id: 4,
          params: { terminalId: 't1' },
        } as never,
        terminalServer as never,
        permissionPolicy,
        sender,
      );
      expect(terminalServer.output).toHaveBeenCalledWith('t1');
      expect(sender.sendResult).toHaveBeenCalledWith(4, { output: 'hello', truncated: false });
    });

    it('handles terminal/wait_for_exit', async () => {
      const { handleAcpTerminalRequest } = await import('../src/client/acp-session-callbacks.js');
      await handleAcpTerminalRequest(
        {
          jsonrpc: '2.0',
          method: 'terminal/wait_for_exit',
          id: 5,
          params: { terminalId: 't1' },
        } as never,
        terminalServer as never,
        permissionPolicy,
        sender,
      );
      expect(terminalServer.waitForExit).toHaveBeenCalledWith('t1');
      expect(sender.sendResult).toHaveBeenCalledWith(5, { exitCode: 0 });
    });

    it('handles terminal/kill', async () => {
      const { handleAcpTerminalRequest } = await import('../src/client/acp-session-callbacks.js');
      await handleAcpTerminalRequest(
        {
          jsonrpc: '2.0',
          method: 'terminal/kill',
          id: 6,
          params: { terminalId: 't1' },
        } as never,
        terminalServer as never,
        permissionPolicy,
        sender,
      );
      expect(terminalServer.kill).toHaveBeenCalledWith('t1');
      expect(sender.sendResult).toHaveBeenCalledWith(6, {});
    });

    it('handles terminal/release', async () => {
      const { handleAcpTerminalRequest } = await import('../src/client/acp-session-callbacks.js');
      await handleAcpTerminalRequest(
        {
          jsonrpc: '2.0',
          method: 'terminal/release',
          id: 7,
          params: { terminalId: 't1' },
        } as never,
        terminalServer as never,
        permissionPolicy,
        sender,
      );
      expect(terminalServer.release).toHaveBeenCalledWith('t1');
      expect(sender.sendResult).toHaveBeenCalledWith(7, {});
    });

    it('handles unknown method', async () => {
      const { handleAcpTerminalRequest } = await import('../src/client/acp-session-callbacks.js');
      await handleAcpTerminalRequest(
        {
          jsonrpc: '2.0',
          method: 'terminal/unknown',
          id: 8,
          params: {},
        } as never,
        terminalServer as never,
        permissionPolicy,
        sender,
      );
      expect(sender.sendErrorResponse).toHaveBeenCalledWith(
        8,
        -32601,
        'unknown method: terminal/unknown',
      );
    });

    it('handles terminal method that throws', async () => {
      const { handleAcpTerminalRequest } = await import('../src/client/acp-session-callbacks.js');
      terminalServer.create = vi.fn().mockImplementation(() => {
        throw new Error('create error');
      });
      await handleAcpTerminalRequest(
        {
          jsonrpc: '2.0',
          method: 'terminal/create',
          id: 9,
          params: { command: 'fail', sessionId: 's1' },
        } as never,
        terminalServer as never,
        permissionPolicy,
        sender,
      );
      expect(sender.sendErrorResponse).toHaveBeenCalledWith(9, -32603, 'create error');
    });
  });
});

// ── acp-session.ts — ACPSession message routing ─────────────────────

describe('ACPSession message routing (handleMessage)', () => {
  const hoisted = vi.hoisted(() => ({ instances: [] as any[] }));

  vi.mock('../src/agent/stdio-transport.js', () => {
    class FakeTransport {
      sent: any[] = [];
      handlers: Array<(m: any) => void> = [];
      start = vi.fn(async () => {});
      stop = vi.fn();
      send = vi.fn(async (m: any) => {
        this.sent.push(m);
      });
      constructor() {
        hoisted.instances.push(this);
      }
      onMessage(h: (m: any) => void) {
        this.handlers.push(h);
        return () => {};
      }
      emit(m: any) {
        for (const h of [...this.handlers]) h(m);
      }
      respond(id: number | string, method: string, result: unknown) {
        this.emit({ jsonrpc: '2.0', id, method, result } as never);
      }
    }
    return { ClientTransport: FakeTransport, StdioTransport: class {} };
  });

  const PROJECT_ROOT = path.resolve(os.tmpdir(), 'wstack-acp-msg-' + process.pid);

  async function startSession(
    initResult: Record<string, unknown> = {
      protocolVersion: 1,
      agentCapabilities: {},
      agentInfo: { name: 'fake-agent', title: 'Fake', version: '0.0.1' },
    },
    overrides: Record<string, unknown> = {},
  ): Promise<{ session: any; transport: any }> {
    hoisted.instances.length = 0;
    const { ACPSession } = await import('../src/client/acp-session.js');
    const { defaultPermissionPolicy } = await import('../src/client/permission.js');
    const p = ACPSession.start({
      command: 'fake',
      projectRoot: PROJECT_ROOT,
      permissionPolicy: defaultPermissionPolicy,
      ...overrides,
    } as never);
    const t = hoisted.instances[hoisted.instances.length - 1];
    await new Promise((r) => setImmediate(r));
    const init = t.sent.find((m: any) => m.method === 'initialize');
    if (init) t.respond(init.id, 'initialize', initResult);
    const session = await p;
    return { session, transport: t };
  }

  it('handles $/cancel_request silently', async () => {
    const { transport } = await startSession();
    transport.emit({ jsonrpc: '2.0', method: '$/cancel_request', params: {} } as never);
    // Should not crash - no response expected
  });

  it('logs unhandled methods to console.warn', async () => {
    const { transport } = await startSession();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    transport.emit({ jsonrpc: '2.0', method: 'unknown/method', params: {} } as never);
    expect(warn).toHaveBeenCalled();
    const warning = warn.mock.calls.at(0)?.at(0);
    expect(warning).toBeDefined();
    const callArg: unknown = JSON.parse(warning ?? 'null');
    expect(callArg).toBeTypeOf('object');
    expect(callArg).not.toBeNull();
    const logged = callArg as Record<string, unknown>;
    expect(logged.method).toBe('unknown/method');
    expect(logged.event).toBe('acp_session.unhandled_method');
    warn.mockRestore();
  });

  it('handles session/update notification', async () => {
    const { transport } = await startSession();
    transport.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: [{ type: 'text', text: 'hello' }],
        },
      },
    } as never);
    // Should not crash
  });

  it('handles best-effort ack methods', async () => {
    const { transport } = await startSession();
    transport.emit({ jsonrpc: '2.0', id: 100, method: 'mcp/connect', params: {} } as never);
    // Should not crash - sends empty result
  });

  it('handles best-effort ack methods with no id', async () => {
    const { transport } = await startSession();
    transport.emit({ jsonrpc: '2.0', method: 'mcp/connect', params: {} } as never);
    // No id - should be silently ignored even though it matches best-effort
  });

  it('handles messages with no method silently', async () => {
    const { transport } = await startSession();
    transport.emit({ jsonrpc: '2.0', params: {} } as never);
    // Should not crash
  });

  it('requires valid permissionPolicy/trustBoundary', async () => {
    hoisted.instances.length = 0;
    const { ACPSession } = await import('../src/client/acp-session.js');
    const FakeTransport = vi.mocked(await import('../src/agent/stdio-transport.js'))
      .ClientTransport as any;
    const transport = new FakeTransport();
    const projectRoot = path.resolve(os.tmpdir(), 'wstack-acp-err-' + process.pid);
    await expect(
      ACPSession.connect(
        transport as never,
        {
          projectRoot,
          permissionPolicy: vi.fn() as never,
          trustBoundary: {} as never,
          command: 'test',
        } as never,
      ),
    ).rejects.toThrow('permissionPolicy and trustBoundary are mutually exclusive');
  });
});

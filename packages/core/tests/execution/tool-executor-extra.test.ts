import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyToolError } from '../../src/execution/tool-executor.js';
import { FetchError, ToolValidationError, WrongStackError, ERROR_CODES } from '../../src/types/errors.js';
import type { ErrorCode, ErrorSubsystem } from '../../src/types/errors.js';
import { ToolErrorCategory } from '../../src/types/tool.js';
import type { ConfirmAwaiter } from '../../src/types/tool-executor.js';

// ---------------------------------------------------------------------------
// classifyToolError — exhaustive coverage of every branch
// ---------------------------------------------------------------------------
describe('classifyToolError', () => {
  // --- AbortError ---
  it('classifies AbortError as FATAL, not retryable', () => {
    const err = new Error('user cancelled');
    err.name = 'AbortError';
    expect(classifyToolError(err)).toEqual({
      category: ToolErrorCategory.FATAL,
      retryable: false,
      detail: 'aborted',
    });
  });

  // --- Node.js ErrnoException paths ---
  it.each([
    ['ETIMEDOUT', ToolErrorCategory.TRANSIENT, true, 'ETIMEDOUT'],
    ['ECONNRESET', ToolErrorCategory.TRANSIENT, true, 'ECONNRESET'],
    ['ECONNREFUSED', ToolErrorCategory.TRANSIENT, true, 'ECONNREFUSED'],
    ['ENETUNREACH', ToolErrorCategory.TRANSIENT, true, 'ENETUNREACH'],
    ['EHOSTUNREACH', ToolErrorCategory.TRANSIENT, true, 'EHOSTUNREACH'],
    ['ENOENT', ToolErrorCategory.NOT_FOUND, false, 'ENOENT'],
    ['ENOTDIR', ToolErrorCategory.NOT_FOUND, false, 'ENOTDIR'],
    ['EACCES', ToolErrorCategory.PERMISSION, false, 'EACCES'],
    ['EPERM', ToolErrorCategory.PERMISSION, false, 'EPERM'],
    ['EBUSY', ToolErrorCategory.TRANSIENT, true, 'EBUSY'],
    ['EMFILE', ToolErrorCategory.TRANSIENT, true, 'EMFILE'],
    ['ENFILE', ToolErrorCategory.TRANSIENT, true, 'ENFILE'],
  ])('classifies system errno %s correctly', (code, category, retryable, detail) => {
    const err = new Error(`system error: ${code}`);
    (err as NodeJS.ErrnoException).code = code;
    expect(classifyToolError(err)).toEqual({ category, retryable, detail });
  });

  it('does NOT classify an Error with a non-matching code as errno', () => {
    const err = new Error('unknown');
    (err as { code: string }).code = 'UNKNOWN_CODE';
    // Should fall through to the default branch
    const result = classifyToolError(err);
    expect(result.category).toBe(ToolErrorCategory.FATAL);
    expect(result.retryable).toBe(false);
  });

  // --- FetchError (structured) ---
  it.each([
    [429, ToolErrorCategory.TRANSIENT, true, 'HTTP 429'],
    [503, ToolErrorCategory.TRANSIENT, true, 'HTTP 503'],
    [502, ToolErrorCategory.TRANSIENT, true, 'HTTP 502'],
    [504, ToolErrorCategory.TRANSIENT, true, 'HTTP 504'],
    [404, ToolErrorCategory.NOT_FOUND, false, 'HTTP 404'],
    [410, ToolErrorCategory.NOT_FOUND, false, 'HTTP 410'],
    [401, ToolErrorCategory.PERMISSION, false, 'HTTP 401'],
    [403, ToolErrorCategory.PERMISSION, false, 'HTTP 403'],
    [400, ToolErrorCategory.VALIDATION, false, 'HTTP 400'],
    [500, ToolErrorCategory.FATAL, false, 'HTTP 500'],
    [418, ToolErrorCategory.FATAL, false, 'HTTP 418'],
  ])('classifies FetchError with status %i correctly', (status, category, retryable, detail) => {
    const err = new FetchError({ status, statusText: 'test' }, 'fetch failed');
    expect(classifyToolError(err)).toEqual({ category, retryable, detail });
  });

  // --- Duck-typed response error (fallback) ---
  it('classifies duck-typed response errors by status', () => {
    const err = new Error('upstream failed');
    (err as { response: { status: number } }).response = { status: 429 };
    expect(classifyToolError(err)).toEqual({
      category: ToolErrorCategory.TRANSIENT,
      retryable: true,
      detail: 'HTTP 429',
    });
  });

  it('classifies duck-typed response with undefined status as fatal', () => {
    const err = new Error('no status');
    (err as { response: Record<string, unknown> }).response = {};
    // Falls through default since response.status is undefined
    const result = classifyToolError(err);
    expect(result.category).toBe(ToolErrorCategory.FATAL);
    expect(result.retryable).toBe(false);
  });

  // --- ToolValidationError (structured) ---
  it('classifies ToolValidationError as VALIDATION, not retryable', () => {
    const err = new ToolValidationError({
      toolName: 'bash',
      message: 'invalid input',
      code: 'TOOL_VALIDATION',
    });
    expect(classifyToolError(err)).toEqual({
      category: ToolErrorCategory.VALIDATION,
      retryable: false,
      detail: 'validation',
    });
  });

  // --- Validation by message (legacy fallback) ---
  it('classifies Error with "validation" in message as VALIDATION', () => {
    const err = new Error('input validation failed: field x is required');
    expect(classifyToolError(err)).toEqual({
      category: ToolErrorCategory.VALIDATION,
      retryable: false,
      detail: 'validation',
    });
  });

  // --- WrongStackError catch-all ---

  function makeWSE(overrides: {
    severity?: string;
    recoverable?: boolean;
    code?: ErrorCode;
    subsystem?: ErrorSubsystem;
  }): WrongStackError {
    const err = new WrongStackError({
      message: 'wse',
      code: overrides.code ?? ERROR_CODES.UNKNOWN,
      subsystem: overrides.subsystem ?? 'general',
      severity: (overrides.severity ?? 'error') as 'fatal' | 'error' | 'warning',
      recoverable: overrides.recoverable ?? false,
    });
    return err;
  }

  it('classifies WrongStackError with severity=warning as TRANSIENT with recoverable', () => {
    const err = makeWSE({ severity: 'warning', recoverable: true });
    expect(classifyToolError(err)).toEqual({
      category: ToolErrorCategory.TRANSIENT,
      retryable: true,
      detail: `${ERROR_CODES.UNKNOWN} [general]`,
    });
  });

  it('classifies WrongStackError with severity=error as FATAL', () => {
    const err = makeWSE({ severity: 'error', recoverable: false });
    expect(classifyToolError(err)).toEqual({
      category: ToolErrorCategory.FATAL,
      retryable: false,
      detail: `${ERROR_CODES.UNKNOWN} [general]`,
    });
  });

  it('classifies WrongStackError with severity=fatal as FATAL', () => {
    const err = makeWSE({ severity: 'fatal', recoverable: false });
    expect(classifyToolError(err)).toEqual({
      category: ToolErrorCategory.FATAL,
      retryable: false,
      detail: `${ERROR_CODES.UNKNOWN} [general]`,
    });
  });

  it('includes code and subsystem in detail for WrongStackError', () => {
    const err = makeWSE({
      code: ERROR_CODES.FS_WRITE_FAILED,
      subsystem: 'fs',
      recoverable: true,
      severity: 'warning',
    });
    expect(classifyToolError(err)).toMatchObject({ detail: 'FS_WRITE_FAILED [fs]' });
  });

  // --- Default / unclassified ---
  it('classifies a bare Error as FATAL with truncated message detail', () => {
    const err = new Error('x'.repeat(200));
    const result = classifyToolError(err);
    expect(result.category).toBe(ToolErrorCategory.FATAL);
    expect(result.retryable).toBe(false);
    expect(result.detail?.length).toBeLessThanOrEqual(100);
  });

  it('classifies a primitive string error as FATAL with truncated string', () => {
    const result = classifyToolError('something went wrong');
    expect(result.category).toBe(ToolErrorCategory.FATAL);
    expect(result.retryable).toBe(false);
    expect(result.detail).toBe('something went wrong');
  });

  it('classifies null/undefined as FATAL with "null"/"undefined" detail', () => {
    expect(classifyToolError(null).detail).toBe('null');
    expect(classifyToolError(undefined).detail).toBe('undefined');
  });
});

// ---------------------------------------------------------------------------
// ToolExecutor — additional coverage for PreToolUse hooks, streaming,
// budget edge cases, and error handling scenarios
// ---------------------------------------------------------------------------
import type { Context } from '../../src/core/context.js';
import { classifyToolError as _cte, ToolExecutor } from '../../src/execution/tool-executor.js';
import { EventBus, type EventMap } from '../../src/kernel/events.js';
import type { ToolResultBlock, ToolUseBlock } from '../../src/types/blocks.js';
import type { PermissionDecision } from '../../src/types/permission.js';
import type { Tool } from '../../src/types/tool.js';

// Re-export to avoid unused import warning
void _cte;

// --- Test helpers ---

function makeTool(overrides: Partial<Tool> & { name: string }): Tool {
  return {
    description: `test tool: ${overrides.name}`,
    inputSchema: { type: 'object' },
    permission: 'auto',
    mutating: false,
    execute: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

function makeUse(name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: 'tool_use', id: `id_${name}`, name, input };
}

function makeCtx(): Context {
  return {
    messages: [],
    todos: [],
    readFiles: new Set(),
    fileMtimes: new Map(),
    systemPrompt: [],
    provider: { id: 'test', capabilities: {}, complete: vi.fn(), stream: vi.fn() } as never,
    session: { id: 'test-session', append: vi.fn(), close: vi.fn() } as never,
    signal: new AbortController().signal,
    tokenCounter: {
      account: vi.fn(),
      total: vi.fn().mockReturnValue({ input: 0, output: 0 }),
      estimateCost: vi.fn().mockReturnValue({ total: 0 }),
    } as never,
    cwd: '/test',
    projectRoot: '/test',
    model: 'test-model',
    tools: [],
    meta: {},
    registerAbortHook: vi.fn().mockReturnValue(() => {}),
    drainAbortHooks: vi.fn(),
    recordRead: vi.fn(),
    hasRead: vi.fn(),
    lastReadMtime: vi.fn(),
    usage: vi.fn().mockReturnValue({ input: 0, output: 0 }),
    agentId: undefined,
    traceId: undefined,
    contextEvidence: undefined,
    state: undefined as never,
  } as never as Context;
}

function autoPermit(): PermissionDecision {
  return { permission: 'auto', source: 'default' };
}

describe('ToolExecutor — additional coverage', () => {
  const scrubber = { scrub: (s: string) => s };
  const policy = { evaluate: vi.fn().mockResolvedValue(autoPermit()) };

  function makeExecutor(
    tools: Tool[],
    opts?: Partial<ConstructorParameters<typeof ToolExecutor>[1]>,
  ) {
    const registry = {
      get: (name: string) => tools.find((t) => t.name === name),
      list: () => tools,
    };
    return new ToolExecutor(registry, {
      permissionPolicy: policy as never,
      secretScrubber: scrubber as never,
      perIterationOutputCapBytes: 50_000,
      ...opts,
    });
  }

  beforeEach(() => {
    policy.evaluate.mockReset().mockResolvedValue(autoPermit());
  });

  describe('PreToolUse hooks', () => {
    it('blocks a tool when PreToolUse hook returns block', async () => {
      const tool = makeTool({ name: 'edit', execute: vi.fn() });
      const hookRunner = {
        has: vi.fn((name: string) => name === 'PreToolUse'),
        preToolUse: vi.fn().mockResolvedValue({ block: true, reason: 'not allowed' }),
      };
      const executor = makeExecutor([tool], { hookRunner: hookRunner as never });
      const result = await executor.executeBatch(
        [makeUse('edit', { path: 'a.ts' })],
        makeCtx(),
        'sequential',
      );
      expect((result.outputs[0]!.result as ToolResultBlock).content).toContain(
        'blocked by a PreToolUse hook',
      );
      expect(tool.execute).not.toHaveBeenCalled();
    });

    it('tells the hook what the tool declares, not just its name', async () => {
      // `path-guard` matched `write|edit|bash|exec` because a tool NAME was all
      // a PreToolUse hook could see, so `patch`, `scaffold`, plugin writers and
      // MCP filesystem servers wrote past it. The executor holds the tool
      // object; passing its declaration through is what lets a policy hook key
      // on what the call DOES.
      const tool = makeTool({
        name: 'patch',
        capabilities: ['fs.write'],
        mutating: true,
        execute: vi.fn().mockResolvedValue('ok'),
      });
      const hookRunner = {
        has: vi.fn((name: string) => name === 'PreToolUse'),
        preToolUse: vi.fn().mockResolvedValue({}),
      };
      const executor = makeExecutor([tool], { hookRunner: hookRunner as never });
      await executor.executeBatch([makeUse('patch', { path: 'a.ts' })], makeCtx(), 'sequential');

      expect(hookRunner.preToolUse).toHaveBeenCalledWith(
        'patch',
        { path: 'a.ts' },
        expect.anything(),
        { capabilities: ['fs.write'], mutating: true },
      );
    });

    it('rewrites input when PreToolUse hook returns new input', async () => {
      const tool = makeTool({
        name: 'read',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        execute: vi.fn().mockResolvedValue('content'),
      });
      const hookRunner = {
        has: vi.fn((name: string) => name === 'PreToolUse'),
        preToolUse: vi.fn().mockResolvedValue({ input: { path: '/rewritten' } }),
      };
      const executor = makeExecutor([tool], { hookRunner: hookRunner as never });
      await executor.executeBatch(
        [makeUse('read', { path: '/original' })],
        makeCtx(),
        'sequential',
      );
      expect(tool.execute).toHaveBeenCalledWith(
        { path: '/rewritten' },
        expect.anything(),
        expect.anything(),
      );
    });

    it('returns error when PreToolUse hook rewrites to invalid input', async () => {
      const tool = makeTool({
        name: 'read',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        execute: vi.fn(),
      });
      const hookRunner = {
        has: vi.fn((name: string) => name === 'PreToolUse'),
        preToolUse: vi.fn().mockResolvedValue({ input: { notPath: 42 } }),
      };
      const executor = makeExecutor([tool], { hookRunner: hookRunner as never });
      const result = await executor.executeBatch(
        [makeUse('read', { path: 'a.ts' })],
        makeCtx(),
        'sequential',
      );
      expect((result.outputs[0]!.result as ToolResultBlock).content).toContain(
        'rewrote the arguments',
      );
      expect(tool.execute).not.toHaveBeenCalled();
    });

    it('skips re-validation when PreToolUse hook returns same input (identity)', async () => {
      const tool = makeTool({
        name: 'read',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        execute: vi.fn().mockResolvedValue('content'),
      });
      const originalInput = { path: '/same' };
      const hookRunner = {
        has: vi.fn((name: string) => name === 'PreToolUse'),
        preToolUse: vi.fn().mockResolvedValue({ input: originalInput }),
      };
      const executor = makeExecutor([tool], { hookRunner: hookRunner as never });
      await executor.executeBatch([makeUse('read', originalInput)], makeCtx(), 'sequential');
      // The same reference input means isDeepStrictEqual is true → skip re-val
      expect(tool.execute).toHaveBeenCalledWith(
        originalInput,
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('PostToolUse hooks', () => {
    it('stores additionalContext on ctx.pendingPostToolContext when contextAs is "separate"', async () => {
      const tool = makeTool({
        name: 'read',
        execute: vi.fn().mockResolvedValue('file content'),
      });
      const ctx = makeCtx();
      const hookRunner = {
        has: vi.fn((name: string) => name === 'PostToolUse'),
        postToolUse: vi.fn().mockResolvedValue({
          additionalContext: 'linter note',
          contextAs: 'separate',
        }),
      };
      const executor = makeExecutor([tool], { hookRunner: hookRunner as never });
      await executor.executeBatch([makeUse('read', { path: 'a.ts' })], ctx, 'sequential');
      // Instead of appending a separate user message (which would break
      // tool-use/tool-result adjacency), the context is stored on ctx
      // so agent-tools merges it into the same user message as tool results.
      expect(ctx.pendingPostToolContext).toBe('linter note');
    });

    it('appends additionalContext inline when contextAs is not set', async () => {
      const tool = makeTool({
        name: 'read',
        execute: vi.fn().mockResolvedValue('file content'),
      });
      const ctx = makeCtx();
      ctx.state = { replaceMessages: vi.fn(), appendMessage: vi.fn() } as never;
      const hookRunner = {
        has: vi.fn((name: string) => name === 'PostToolUse'),
        postToolUse: vi.fn().mockResolvedValue({
          additionalContext: 'inline note',
        }),
      };
      const executor = makeExecutor([tool], { hookRunner: hookRunner as never });
      const result = await executor.executeBatch(
        [makeUse('read', { path: 'a.ts' })],
        ctx,
        'sequential',
      );
      const content = (result.outputs[0]!.result as ToolResultBlock).content as string;
      expect(content).toContain('inline note');
    });
  });

  describe('cross-field validation', () => {
    it('rejects input when tool.validate returns errors', async () => {
      const tool = makeTool({
        name: 'edit',
        validate: vi.fn(() => ['old_string and new_string must differ']),
        execute: vi.fn(),
      });
      const executor = makeExecutor([tool]);
      const result = await executor.executeBatch(
        [makeUse('edit', { old_string: 'foo', new_string: 'foo' })],
        makeCtx(),
        'sequential',
      );
      expect((result.outputs[0]!.result as ToolResultBlock).content).toContain(
        'old_string and new_string must differ',
      );
      expect(tool.execute).not.toHaveBeenCalled();
    });

    it('passes through when tool.validate returns empty array', async () => {
      const tool = makeTool({
        name: 'edit',
        validate: vi.fn(() => []),
        execute: vi.fn().mockResolvedValue({ ok: true }),
      });
      const executor = makeExecutor([tool]);
      const result = await executor.executeBatch(
        [makeUse('edit', { old_string: 'foo', new_string: 'bar' })],
        makeCtx(),
        'sequential',
      );
      expect((result.outputs[0]!.result as ToolResultBlock).is_error).toBe(false);
      expect(tool.execute).toHaveBeenCalled();
    });
  });

  describe('permission decision events', () => {
    it('records the effective capability downgrade without exposing raw input', async () => {
      const events = new EventBus();
      const decisions: EventMap['permission.evaluated'][] = [];
      events.on('permission.evaluated', (event) => decisions.push(event));
      const input = { command: 'echo SECRET' };
      const permissionPolicy = {
        evaluate: vi.fn().mockResolvedValue({
          permission: 'auto',
          source: 'trust',
          reason: 'matched allow pattern',
          riskTier: 'destructive',
        }),
        getYolo: () => false,
      };
      const confirmAwaiter = vi.fn().mockResolvedValue('yes');
      const tool = makeTool({
        name: 'bash',
        riskTier: 'destructive',
        capabilities: ['shell.arbitrary'],
      });
      const executor = makeExecutor([tool], {
        events,
        permissionPolicy: permissionPolicy as never,
        confirmAwaiter,
        secretScrubber: {
          scrub: (value: string) => value.replaceAll('SECRET', '[REDACTED]'),
        } as never,
      });

      await executor.executeBatch([makeUse('bash', input)], makeCtx(), 'sequential');

      const expectedHash = createHash('sha256')
        .update(JSON.stringify({ command: 'echo [REDACTED]' }), 'utf8')
        .digest('hex');
      expect(decisions).toEqual([
        expect.objectContaining({
          sessionId: 'test-session',
          name: 'bash',
          id: 'id_bash',
          inputHash: expectedHash,
          policyDecision: 'auto',
          effectiveDecision: 'confirm',
          decisionSource: 'trust',
          reason: 'matched allow pattern',
          riskTier: 'destructive',
          yoloEnabled: false,
          boundaryDecision: 'allow',
          capabilityDowngraded: true,
        }),
      ]);
      expect(JSON.stringify(decisions[0])).not.toContain('SECRET');
      expect(confirmAwaiter).toHaveBeenCalledOnce();
      expect(tool.execute).toHaveBeenCalledOnce();
    });

    it('preserves authoritative YOLO auto-approval for dangerous capabilities', async () => {
      const events = new EventBus();
      const decisions: EventMap['permission.evaluated'][] = [];
      events.on('permission.evaluated', (event) => decisions.push(event));
      const permissionPolicy = {
        evaluate: vi.fn().mockResolvedValue({
          permission: 'auto',
          source: 'yolo',
          riskTier: 'destructive',
        }),
        getYolo: () => true,
      };
      const tool = makeTool({
        name: 'bash',
        riskTier: 'destructive',
        capabilities: ['shell.arbitrary'],
      });
      const executor = makeExecutor([tool], {
        events,
        permissionPolicy: permissionPolicy as never,
      });

      await executor.executeBatch(
        [makeUse('bash', { command: 'printf safe' })],
        makeCtx(),
        'sequential',
      );

      expect(decisions[0]).toMatchObject({
        policyDecision: 'auto',
        effectiveDecision: 'auto',
        decisionSource: 'yolo',
        yoloEnabled: true,
        capabilityDowngraded: false,
      });
      expect(tool.execute).toHaveBeenCalledOnce();
    });
  });

  describe('abort signal handling', () => {
    it('returns abort result when signal aborts during confirmation', async () => {
      policy.evaluate.mockResolvedValue({ permission: 'confirm', source: 'trust' });
      const tool = makeTool({ name: 'bash', execute: vi.fn() });
      const ctrl = new AbortController();
      const ctx = makeCtx();
      ctx.signal = ctrl.signal;
      const awaiter = vi.fn<ConfirmAwaiter>().mockImplementation(
        () => new Promise(() => {}), // never resolves
      );
      const executor = makeExecutor([tool], { confirmAwaiter: awaiter });
      const promise = executor.executeBatch(
        [makeUse('bash', { command: 'echo' })],
        ctx,
        'sequential',
      );
      ctrl.abort('user interrupt');
      const result = await promise;
      expect((result.outputs[0]!.result as ToolResultBlock).content).toContain('aborted');
    });

    it('handles aborted signal before confirm awaiter starts', async () => {
      policy.evaluate.mockResolvedValue({ permission: 'confirm', source: 'trust' });
      const tool = makeTool({ name: 'bash', execute: vi.fn() });
      const ctrl = new AbortController();
      ctrl.abort('cancelled');
      const ctx = makeCtx();
      ctx.signal = ctrl.signal;
      const awaiter = vi.fn();
      const executor = makeExecutor([tool], { confirmAwaiter: awaiter });
      const result = await executor.executeBatch(
        [makeUse('bash', { command: 'echo' })],
        ctx,
        'sequential',
      );
      expect((result.outputs[0]!.result as ToolResultBlock).is_error).toBe(true);
      expect((result.outputs[0]!.result as ToolResultBlock).content).toContain('aborted');
    });
  });

  describe('budget edge cases', () => {
    it('handles zero or negative budget gracefully', async () => {
      const tool = makeTool({
        name: 'echo',
        execute: vi.fn().mockResolvedValue('hello world'),
      });
      const executor = makeExecutor([tool], { perIterationOutputCapBytes: 1 });
      const result = await executor.executeBatch([makeUse('echo')], makeCtx(), 'sequential');
      expect(result.remainingBudget).toBeGreaterThanOrEqual(0);
    });

    it('does not underflow budget for very large outputs', async () => {
      const tool = makeTool({
        name: 'big',
        execute: vi.fn().mockResolvedValue('x'.repeat(200_000)),
      });
      const executor = makeExecutor([tool], { perIterationOutputCapBytes: 10_000 });
      const result = await executor.executeBatch([makeUse('big')], makeCtx(), 'sequential');
      expect(result.remainingBudget).toBeGreaterThanOrEqual(0);
    });
  });

  describe('extractMalformedRaw edge cases', () => {
    it('extracts raw string from __raw marker', async () => {
      const tool = makeTool({ name: 'edit', execute: vi.fn() });
      const executor = makeExecutor([tool]);
      const result = await executor.executeBatch(
        [makeUse('edit', { __raw: 'path=a.ts old=foo' })],
        makeCtx(),
        'sequential',
      );
      const content = (result.outputs[0]!.result as ToolResultBlock).content as string;
      expect(content).toContain('path=a.ts old=foo');
      expect(tool.execute).not.toHaveBeenCalled();
    });

    it('stringifies non-string raw values', async () => {
      const tool = makeTool({ name: 'edit', execute: vi.fn() });
      const executor = makeExecutor([tool]);
      // A number inside __raw — JSON.parse(arr).__raw returns a number
      const result = await executor.executeBatch(
        [makeUse('edit', { __raw: 42 })],
        // { __raw: 42 } is not a valid input — the hasMalformedArguments check
        // sees keys.length===1 and markers.includes('__raw')
        makeCtx(),
        'sequential',
      );
      const content = (result.outputs[0]!.result as ToolResultBlock).content as string;
      expect(content).toContain('42');
    });
  });

  describe('deny with different sources', () => {
    it('returns denied result and records the effective decision', async () => {
      policy.evaluate.mockResolvedValue({
        permission: 'deny',
        reason: 'custom policy rule',
        source: 'deny',
      });
      const tool = makeTool({ name: 'bash' });
      const events = new EventBus();
      const decisions: EventMap['permission.evaluated'][] = [];
      events.on('permission.evaluated', (event) => decisions.push(event));
      const executor = makeExecutor([tool], { events });
      const result = await executor.executeBatch(
        [makeUse('bash', { command: 'blocked' })],
        makeCtx(),
        'sequential',
      );

      const content = (result.outputs[0]!.result as ToolResultBlock).content as string;
      expect(content).toContain('custom policy rule');
      expect(decisions[0]).toMatchObject({
        policyDecision: 'deny',
        effectiveDecision: 'deny',
        decisionSource: 'deny',
        reason: 'custom policy rule',
      });
      expect(tool.execute).not.toHaveBeenCalled();
    });
  });
});

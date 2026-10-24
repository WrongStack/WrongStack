import { createHash } from 'node:crypto';
import type { ErrorCode, ErrorSubsystem } from '@wrongstack/contracts/types/errors';
import {
  ERROR_CODES,
  FetchError,
  ToolValidationError,
  WrongStackError,
} from '@wrongstack/contracts/types/errors';
import { ToolErrorCategory } from '@wrongstack/contracts/types/tool';
import type { ConfirmAwaiter } from '@wrongstack/contracts/types/tool-executor';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyToolError } from '../../src/execution/tool-executor.js';

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
    // `detail` was the constant 'validation' — a restatement of the category
    // beside it. Ten field log lines for the `edit` tool read
    // `"errorCategory":"validation","errorDetail":"validation"` and were not
    // diagnosable. It now names the failure. See classify-tool-error-detail.
    expect(classifyToolError(err)).toEqual({
      category: ToolErrorCategory.VALIDATION,
      retryable: false,
      detail: 'invalid input',
    });
  });

  // --- Validation by message (legacy fallback) ---
  it('classifies Error with "validation" in message as VALIDATION', () => {
    const err = new Error('input validation failed: field x is required');
    expect(classifyToolError(err)).toEqual({
      category: ToolErrorCategory.VALIDATION,
      retryable: false,
      detail: 'input validation failed: field x is required',
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

import { EventBus, type EventMap } from '@wrongstack/contracts/kernel/events';
import type { ToolResultBlock, ToolUseBlock } from '@wrongstack/contracts/types/blocks';
import type { PermissionDecision } from '@wrongstack/contracts/types/permission';
import type { Tool } from '@wrongstack/contracts/types/tool';
// ---------------------------------------------------------------------------
// ToolExecutor — additional coverage for PreToolUse hooks, streaming,
// budget edge cases, and error handling scenarios
// ---------------------------------------------------------------------------
import type { Context } from '../../src/core/context.js';
import { classifyToolError as _cte, ToolExecutor } from '../../src/execution/tool-executor.js';

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

    it('keeps hook context inside perIterationOutputCapBytes', async () => {
      const cap = 1_000;
      const huge = 'H'.repeat(50_000);
      const tool = makeTool({ name: 'read', execute: vi.fn().mockResolvedValue('ok') });
      const hookRunner = {
        has: vi.fn((name: string) => name === 'PostToolUse'),
        postToolUse: vi.fn().mockResolvedValue({ additionalContext: huge }),
      };
      const executor = makeExecutor([tool], {
        hookRunner: hookRunner as never,
        perIterationOutputCapBytes: cap,
      });
      const inline = await executor.executeBatch([makeUse('read')], makeCtx(), 'sequential');
      const inlineText = (inline.outputs[0]!.result as ToolResultBlock).content as string;
      expect(Buffer.byteLength(inlineText, 'utf8')).toBeLessThanOrEqual(cap);
      expect(inlineText.startsWith('ok')).toBe(true);
      expect(inlineText).not.toContain(huge);

      const separateCtx = makeCtx();
      hookRunner.postToolUse.mockResolvedValue({ additionalContext: huge, contextAs: 'separate' });
      const separate = await executor.executeBatch([makeUse('read')], separateCtx, 'sequential');
      const separateText = (separate.outputs[0]!.result as ToolResultBlock).content as string;
      const pending = separateCtx.pendingPostToolContext ?? '';
      expect(Buffer.byteLength(separateText + pending, 'utf8')).toBeLessThanOrEqual(cap);
      expect(pending).not.toBe(huge);

      hookRunner.postToolUse.mockResolvedValue({ additionalContext: huge });
      const direct = await executor.executeTool(tool, makeUse('read'), makeCtx(), cap);
      expect(Buffer.byteLength(String(direct.block.content), 'utf8')).toBeLessThanOrEqual(cap);

      const full = 'S'.repeat(5_000);
      const skeleton = makeTool({
        name: 'codebase-skeleton',
        preserveFullOutput: true,
        execute: vi.fn().mockResolvedValue(full),
      });
      const preserved = await makeExecutor([skeleton], {
        hookRunner: hookRunner as never,
        perIterationOutputCapBytes: cap,
      }).executeBatch([makeUse('codebase-skeleton')], makeCtx(), 'sequential');
      expect((preserved.outputs[0]!.result as ToolResultBlock).content).toBe(full);

      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let arrived = 0;
      let openBoth!: () => void;
      const bothArrived = new Promise<void>((resolve) => {
        openBoth = resolve;
      });
      const left = makeTool({ name: 'left', execute: vi.fn().mockResolvedValue('ok') });
      const right = makeTool({ name: 'right', execute: vi.fn().mockResolvedValue('ok') });
      const parallel = makeExecutor([left, right], {
        perIterationOutputCapBytes: cap,
        maxParallelTools: 2,
        hookRunner: {
          has: (name: string) => name === 'PostToolUse',
          postToolUse: async () => {
            arrived += 1;
            if (arrived === 2) openBoth();
            await gate;
            return { additionalContext: huge };
          },
        } as never,
      });
      const pendingBatch = parallel.executeBatch(
        [makeUse('left'), makeUse('right')],
        makeCtx(),
        'parallel',
      );
      await bothArrived;
      release();
      const raced = await pendingBatch;
      const visible = raced.outputs.reduce((sum, output) => {
        const content = String((output.result as ToolResultBlock).content);
        return sum + Buffer.byteLength(content, 'utf8');
      }, 0);
      expect(visible).toBeLessThanOrEqual(cap);
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

    it('does not re-confirm a tool the operator granted with --allowed-tools', async () => {
      // `wstack --allowed-tools write "task"` used to prompt for write anyway,
      // and in a script — nobody to answer — the write was simply denied.
      const events = new EventBus();
      const decisions: EventMap['permission.evaluated'][] = [];
      events.on('permission.evaluated', (event) => decisions.push(event));
      const permissionPolicy = {
        evaluate: vi.fn().mockResolvedValue({
          permission: 'auto',
          source: 'trust',
          reason: 'allowed by --allowed-tools',
          launchGrant: true,
        }),
        getYolo: () => false,
      };
      const confirmAwaiter = vi.fn().mockResolvedValue('no');
      const tool = makeTool({ name: 'write', capabilities: ['fs.write'] });
      const executor = makeExecutor([tool], {
        events,
        permissionPolicy: permissionPolicy as never,
        confirmAwaiter,
      });

      await executor.executeBatch([makeUse('write', { path: 'a.txt' })], makeCtx(), 'sequential');

      expect(decisions[0]).toMatchObject({
        effectiveDecision: 'auto',
        capabilityDowngraded: false,
      });
      expect(confirmAwaiter).not.toHaveBeenCalled();
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

    it('returns complete output after the shared iteration budget is exhausted', async () => {
      const completeOutput = `${'full-skeleton-😀\n'.repeat(2_000)}tail-marker`;
      const filler = makeTool({
        name: 'filler',
        execute: vi.fn().mockResolvedValue('x'.repeat(1_000)),
      });
      const tool = makeTool({
        name: 'codebase-skeleton',
        preserveFullOutput: true,
        execute: vi.fn().mockResolvedValue(completeOutput),
      });
      const executor = makeExecutor([filler, tool], { perIterationOutputCapBytes: 1_000 });

      const result = await executor.executeBatch(
        [makeUse('filler'), makeUse('codebase-skeleton')],
        makeCtx(),
        'sequential',
      );

      expect((result.outputs[1]!.result as ToolResultBlock).content).toBe(completeOutput);
      expect(result.remainingBudget).toBe(0);
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

  describe('tool-error results honor perIterationOutputCapBytes', () => {
    it('control: a small error message passes through verbatim', async () => {
      const tool = makeTool({
        name: 'boom-small',
        execute: vi.fn().mockRejectedValue(new Error('kaboom: detailed cause')),
      });
      const executor = makeExecutor([tool], { perIterationOutputCapBytes: 1_000 });
      const result = await executor.executeBatch([makeUse('boom-small')], makeCtx(), 'sequential');
      const block = result.outputs[0]!.result as ToolResultBlock;
      expect(block.is_error).toBe(true);
      expect(block.content).toContain('kaboom: detailed cause');
    });

    it('a failing tool with a huge message cannot defeat the iteration output cap', async () => {
      const huge = 'E'.repeat(500_000);
      const tool = makeTool({ name: 'boom', execute: vi.fn().mockRejectedValue(new Error(huge)) });
      const executor = makeExecutor([tool], { perIterationOutputCapBytes: 1_000 });
      const result = await executor.executeBatch([makeUse('boom')], makeCtx(), 'sequential');
      const block = result.outputs[0]!.result as ToolResultBlock;
      expect(block.is_error).toBe(true);
      const content = (result.outputs[0]!.result as ToolResultBlock).content as string;
      const bytes = Buffer.byteLength(content, 'utf8');
      expect(
        bytes,
        `error block content is ${bytes} bytes — perIterationOutputCapBytes is not enforced on the tool-error path`,
      ).toBeLessThanOrEqual(1_000);
    });

    it('structured WrongStackError payloads are capped too', async () => {
      const structured = new WrongStackError({
        message: 'S'.repeat(400_000),
        code: ERROR_CODES.PROVIDER_OVERLOADED,
        subsystem: 'general',
      });
      const tool = makeTool({ name: 'boom-wse', execute: vi.fn().mockRejectedValue(structured) });
      const executor = makeExecutor([tool], { perIterationOutputCapBytes: 1_000 });
      const result = await executor.executeBatch([makeUse('boom-wse')], makeCtx(), 'sequential');
      const block = result.outputs[0]!.result as ToolResultBlock;
      expect(block.is_error).toBe(true);
      const content = (result.outputs[0]!.result as ToolResultBlock).content as string;
      const bytes = Buffer.byteLength(content, 'utf8');
      expect(
        bytes,
        `structured error block content is ${bytes} bytes — describe() payloads bypass the cap`,
      ).toBeLessThanOrEqual(1_000);
    });
  });

  describe('parallel dispatch with a non-finite maxParallelTools', () => {
    // The private `mapWithConcurrency` floors its limit with
    // `Number.isFinite(limit) ? … : 1`. Without that guard a non-finite limit
    // reaches `Array.from({ length: Math.min(NaN, n) })` — ZERO workers — so
    // `Promise.all([])` resolves without running a single tool and the batch
    // silently reports zero outputs. This pins the observable contract at the
    // public surface: whatever `maxParallelTools` is configured, every requested
    // tool use still produces exactly one output. The ToolExecutor constructor
    // is the first line of defense (it clamps maxParallelTools); this case pins
    // that a non-finite value cannot reduce the batch below its full width.
    it.each([
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['zero', 0],
    ])(
      'still runs every tool use when maxParallelTools is %s',
      async (_label, maxParallelTools) => {
        const executed: string[] = [];
        const tool = makeTool({
          name: 'counted',
          execute: vi.fn(async (input: Record<string, unknown>) => {
            executed.push(String(input['id']));
            return input;
          }),
        });
        const executor = makeExecutor([tool], { maxParallelTools });
        const uses = Array.from({ length: 6 }, (_, i) => ({
          type: 'tool_use' as const,
          id: `use-${i}`,
          name: 'counted',
          input: { id: i },
        }));

        const result = await executor.executeBatch(uses, makeCtx(), 'parallel');

        // Every tool use ran — no zero-worker collapse, no holes in the outputs.
        expect(executed).toEqual(['0', '1', '2', '3', '4', '5']);
        expect(result.outputs).toHaveLength(6);
      },
    );
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock deps from @wrongstack/core
const recordFileAction = vi.fn().mockResolvedValue(undefined);
let mockBridge = { append: vi.fn().mockResolvedValue(undefined), setAuditLevel: vi.fn() };
const createSessionEventBridge = vi.fn(() => mockBridge);
const resolveSessionLoggingConfig = vi.fn().mockReturnValue({
  auditLevel: 'full',
  sampling: {},
});
vi.mock('@wrongstack/core', () => ({
  recordFileAction,
  createSessionEventBridge,
  resolveSessionLoggingConfig,
}));

const { wireSessionEvents } = await import('../src/session-event-wiring.js');

// ── Helpers ───────────────────────────────────────────────────────────────

function makeDeps(overrides?: Partial<Parameters<typeof wireSessionEvents>[0]>) {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const evOn = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event)!.push(handler);
  });
  const emit = (event: string, ...args: unknown[]) => {
    for (const h of handlers.get(event) ?? []) h(...args);
  };
  return {
    deps: {
      evOn,
      config: { context: { auditLevel: 'full' } } as Record<string, unknown>,
      context: { session: { id: 'sess-ctx' } } as Record<string, unknown>,
      session: { id: 'sess-start' },
      sessionRef: { current: { id: 'sess-ref' } },
      wpaths: { globalRoot: '/tmp/root', projectSlug: 'test-proj' },
      projectRoot: '/tmp/project',
      ...overrides,
    },
    emit,
    bridge: mockBridge,
  };
}

describe('wireSessionEvents', () => {
  beforeEach(() => {
    recordFileAction.mockClear();
    mockBridge = { append: vi.fn().mockResolvedValue(undefined), setAuditLevel: vi.fn() };
    createSessionEventBridge.mockClear();
    createSessionEventBridge.mockReturnValue(mockBridge);
  });

  it('returns errorRing, sessionBridge and appendSessionEvent', () => {
    const { deps } = makeDeps();
    const result = wireSessionEvents(deps);
    expect(result).toHaveProperty('errorRing');
    expect(result).toHaveProperty('sessionBridge');
    expect(result).toHaveProperty('appendSessionEvent');
  });

  it('creates session bridge via createSessionEventBridge', () => {
    const { deps } = makeDeps();
    wireSessionEvents(deps);
    expect(createSessionEventBridge).toHaveBeenCalledTimes(1);
  });

  // ── error ring ──────────────────────────────────────────────────────────

  it('pushes error entries into the returned ring buffer', () => {
    const { deps, emit } = makeDeps();
    const { errorRing } = wireSessionEvents(deps);

    emit('error', { sessionId: 'sess-ctx', phase: 'exec', err: new Error('boom') });

    expect(errorRing).toHaveLength(1);
    expect(errorRing[0]).toMatchObject({ phase: 'exec', code: 'UNKNOWN', message: 'boom' });
  });

  it('caps the error ring at 5 entries', () => {
    const { deps, emit } = makeDeps();
    const { errorRing } = wireSessionEvents(deps);

    for (let i = 0; i < 7; i++) {
      emit('error', { sessionId: 'sess-ctx', phase: 'exec', err: new Error(`err-${i}`) });
    }

    expect(errorRing).toHaveLength(5);
    expect(errorRing[0].message).toBe('err-2');
    expect(errorRing[4].message).toBe('err-6');
  });

  it('extracts error code from Error objects with a code property', () => {
    const { deps, emit } = makeDeps();
    const { errorRing } = wireSessionEvents(deps);

    const err = new Error('boom');
    (err as { code?: string }).code = 'ECONNREFUSED';
    emit('error', { sessionId: 'sess-ctx', phase: 'exec', err });

    expect(errorRing[0].code).toBe('ECONNREFUSED');
  });

  it('appends error to session bridge on error', () => {
    const { deps, emit, bridge } = makeDeps();
    wireSessionEvents(deps);

    emit('error', { sessionId: 'sess-ctx', phase: 'exec', err: new Error('boom') });

    expect(bridge.append).toHaveBeenCalledTimes(1);
    expect(bridge.append).toHaveBeenCalledWith({
      type: 'error',
      message: 'boom',
      phase: 'exec',
      ts: expect.any(String),
    });
  });

  // ── tool.started ────────────────────────────────────────────────────────

  it('appends tool_call_start to session bridge', () => {
    const { deps, emit, bridge } = makeDeps();
    wireSessionEvents(deps);

    emit('tool.started', { sessionId: 'sess-ctx', name: 'read', id: 't1', input: 'path' });

    expect(bridge.append).toHaveBeenCalledWith({
      type: 'tool_call_start',
      name: 'read',
      id: 't1',
      input: 'path',
      ts: expect.any(String),
    });
  });

  // ── tool.executed ───────────────────────────────────────────────────────

  it('appends tool_call_end to session bridge', () => {
    const { deps, emit, bridge } = makeDeps();
    wireSessionEvents(deps);

    emit('tool.executed', {
      sessionId: 'sess-ctx',
      name: 'read',
      id: 't2',
      durationMs: 42,
      outputBytes: 100,
      ok: true,
      input: { path: '/foo' },
    });

    expect(bridge.append).toHaveBeenCalledWith({
      type: 'tool_call_end',
      name: 'read',
      id: 't2',
      durationMs: 42,
      outputSize: 100,
      ok: true,
      outputBytes: 100,
      outputTokens: undefined,
      outputLines: undefined,
      ts: expect.any(String),
    });
  });

  // ── file-author tracking ────────────────────────────────────────────────

  it.each(['write', 'edit', 'replace', 'patch'])(
    'calls recordFileAction on %s when ok',
    (tool) => {
      const { deps, emit } = makeDeps();
      wireSessionEvents(deps);

      emit('tool.executed', {
        sessionId: 'sess-ctx',
        name: tool,
        id: 't3',
        ok: true,
        input: { path: 'src/foo.ts' },
      });

      expect(recordFileAction).toHaveBeenCalledTimes(1);
      expect(recordFileAction).toHaveBeenCalledWith(
        { storageDir: '/tmp/root/projects/test-proj', projectRoot: '/tmp/project' },
        {
          filePath: 'src/foo.ts',
          action: tool === 'write' ? 'create' : 'edit',
          agentId: 'leader',
          agentName: 'Leader',
          sessionId: 'sess-ctx',
        },
      );
    },
  );

  it('does NOT call recordFileAction when tool.ok is false', () => {
    const { deps, emit } = makeDeps();
    wireSessionEvents(deps);

    emit('tool.executed', {
      sessionId: 'sess-ctx',
      name: 'write',
      id: 't4',
      ok: false,
      input: { path: 'src/foo.ts' },
    });

    expect(recordFileAction).not.toHaveBeenCalled();
  });

  it('does NOT call recordFileAction for non-file tools', () => {
    const { deps, emit } = makeDeps();
    wireSessionEvents(deps);

    emit('tool.executed', {
      sessionId: 'sess-ctx',
      name: 'grep',
      id: 't5',
      ok: true,
      input: { pattern: 'foo' },
    });

    expect(recordFileAction).not.toHaveBeenCalled();
  });
});

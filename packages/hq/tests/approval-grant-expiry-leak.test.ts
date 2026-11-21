import { describe, expect, it } from 'vitest';
import { type ApprovalChange, createApprovalRegistry } from '../src/approval-bridge.js';

function makeBus() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    on(event: string, fn: (payload: unknown) => void) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(fn);
      return () => set?.delete(fn);
    },
    emit(event: string, payload: unknown) {
      for (const fn of listeners.get(event) ?? []) fn(payload);
    },
  };
}

describe('createApprovalRegistry grantExpiries cleanup (F932)', () => {
  it('clears grantExpiries when approval.resolve throws so a later denial has no grantedUntil', () => {
    const bus = makeBus();
    const registry = createApprovalRegistry(bus as never);
    const changes: ApprovalChange[] = [];
    registry.onChange((c) => changes.push(c));

    bus.emit('tool.confirm_needed', {
      toolUseId: 'throw-1',
      tool: { name: 'bash' },
      input: { command: 'rm -rf /tmp/x' },
      suggestedPattern: 'bash:rm',
      deadlineAt: Date.now() + 60_000,
      resolve: () => {
        throw new Error('transport failed');
      },
    });

    expect(() => registry.resolve('throw-1', 'always', undefined, 60_000)).toThrow(
      'transport failed',
    );

    bus.emit('tool.confirm_resolved', {
      toolUseId: 'throw-1',
      toolName: 'bash',
      decision: 'no',
      source: 'abort',
    });

    const resolved = changes.find((c) => c.kind === 'resolved' && c.toolUseId === 'throw-1');
    expect(resolved).toBeDefined();
    expect(resolved?.kind === 'resolved' ? resolved.decision : undefined).toBe('no');
    expect(resolved?.kind === 'resolved' ? resolved.grantedUntil : 'missing').toBeUndefined();
    registry.dispose();
  });

  it('preserves grantedUntil for registered approvals that do not emit tool.confirm_resolved', () => {
    const bus = makeBus();
    const registry = createApprovalRegistry(bus as never);
    const changes: ApprovalChange[] = [];
    registry.onChange((c) => changes.push(c));

    registry.register({
      toolUseId: 'reg-1',
      toolName: 'bash',
      deadlineAt: Date.now() + 60_000,
      input: { command: 'echo ok' },
      suggestedPattern: 'bash:echo',
      destructive: false,
      resolve: () => undefined,
    });

    expect(registry.resolve('reg-1', 'always', undefined, 30_000)).toBe(true);
    const resolved = changes.find((c) => c.kind === 'resolved' && c.toolUseId === 'reg-1');
    expect(resolved?.kind).toBe('resolved');
    expect(resolved?.kind === 'resolved' ? typeof resolved.grantedUntil : undefined).toBe('number');
    registry.dispose();
  });
});

/**
 * W6 #9, HQ surface: how long an `always` answered from HQ stays good.
 *
 * The local permission-policy surface already bounds a persisted trust rule.
 * This is the second, independent half: HQ's own ApprovalRegistry records when
 * the grant it just announced lapses, so the dashboard can render the expiry and
 * an audit trail can explain why the same prompt came back tomorrow.
 *
 * The integration cases matter more than the pure ones. `resolve()` deletes the
 * pending entry BEFORE invoking the resolver, and the real resolver emits
 * `tool.confirm_resolved` synchronously — so the grant cannot travel on the
 * entry it belongs to. These tests drive that exact ordering through a fake bus,
 * which is the only way the off-by-one in that hand-off would show up.
 *
 * @module tests/hq/approval-grant-ttl
 */
import { describe, expect, it } from 'vitest';
import {
  type ApprovalChange,
  approvalGrantExpiry,
  createApprovalRegistry,
  DEFAULT_ALWAYS_APPROVAL_TTL_MS,
  type PendingApproval,
} from '../src/index.js';

/** Minimal synchronous EventBus good enough for the registry's four listeners. */
function fakeBus() {
  const handlers = new Map<string, ((payload: unknown) => void)[]>();
  return {
    on(event: string, handler: (payload: unknown) => void): () => void {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    emit(event: string, payload: unknown): void {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
  };
}

describe('approvalGrantExpiry', () => {
  it('bounds an `always` grant by the TTL it was given', () => {
    expect(approvalGrantExpiry('always', 1_000, 500)).toBe(1_500);
  });

  it('leaves an `always` grant with no TTL unbounded', () => {
    expect(approvalGrantExpiry('always', 1_000, undefined)).toBeUndefined();
  });

  it('treats a non-finite TTL as the explicit opt-out', () => {
    // `Infinity` is the documented way to ask for a permanent grant, since the
    // alternative — emitting Infinity — would serialize to null in JSON.
    expect(approvalGrantExpiry('always', 1_000, Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('honours a zero TTL as already lapsed rather than as permanent', () => {
    // The one direction that must never fail: coercing 0 to "never expires"
    // would turn a deliberately-expired grant into an eternal one.
    expect(approvalGrantExpiry('always', 1_000, 0)).toBe(1_000);
  });

  it('grants nothing for the answers that settle only the prompt in front of them', () => {
    for (const decision of ['yes', 'no', 'deny'] as const) {
      expect(approvalGrantExpiry(decision, 1_000, 500)).toBeUndefined();
    }
  });
});

describe('ApprovalRegistry `always` grant (W6 #9)', () => {
  /** Register one prompt whose resolver emits the real synchronous event. */
  function resolvedGrant(decision: 'yes' | 'always', grantTtlMs?: number) {
    const bus = fakeBus();
    const registry = createApprovalRegistry(bus as never);
    const changes: ApprovalChange[] = [];
    registry.onChange((change) => changes.push(change));

    registry.register({
      toolUseId: 'tu-1',
      toolName: 'edit',
      deadlineAt: Date.now() + 60_000,
      input: {},
      suggestedPattern: 'src/a.ts',
      destructive: false,
      // Mirrors the real resolver: emits the resolved event synchronously, so
      // the registry's own handler is what announces the resolution.
      resolve: (answer: unknown) => {
        bus.emit('tool.confirm_resolved', {
          toolUseId: 'tu-1',
          toolName: 'edit',
          decision: answer,
          source: 'user',
        });
      },
    } as unknown as PendingApproval);

    const ok = registry.resolve('tu-1', decision, undefined, grantTtlMs);
    const resolved = changes.filter(
      (change): change is Extract<ApprovalChange, { kind: 'resolved' }> =>
        change.kind === 'resolved',
    );
    registry.dispose();
    return { ok, resolved };
  }

  it('records an expiry so the dashboard can say when `always` lapses', () => {
    const before = Date.now();
    const { ok, resolved } = resolvedGrant('always');

    expect(ok).toBe(true);
    expect(resolved).toHaveLength(1);
    const grantedUntil = resolved[0]?.grantedUntil;
    expect(typeof grantedUntil).toBe('number');
    // Defaulted, not unbounded: an unbounded default is the behaviour this
    // parameter exists to remove.
    expect(grantedUntil).toBeGreaterThanOrEqual(before + DEFAULT_ALWAYS_APPROVAL_TTL_MS);
    expect(grantedUntil).toBeLessThan(before + DEFAULT_ALWAYS_APPROVAL_TTL_MS + 5_000);
  });

  it('uses an explicit TTL instead of the default', () => {
    const before = Date.now();
    const { resolved } = resolvedGrant('always', 1_000);
    const grantedUntil = resolved[0]?.grantedUntil;

    expect(grantedUntil).toBeGreaterThanOrEqual(before + 1_000);
    expect(grantedUntil).toBeLessThan(before + DEFAULT_ALWAYS_APPROVAL_TTL_MS);
  });

  it('omits the field entirely for an explicit Infinity, meaning never lapses', () => {
    const { resolved } = resolvedGrant('always', Number.POSITIVE_INFINITY);
    expect(resolved).toHaveLength(1);
    // Absent rather than Infinity: JSON would carry Infinity as null, which a
    // dashboard cannot tell apart from a grant it failed to record.
    expect(resolved[0]?.grantedUntil).toBeUndefined();
  });

  it('carries no grant for a `yes`, which settles only this call', () => {
    const { resolved } = resolvedGrant('yes');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.grantedUntil).toBeUndefined();
  });
});

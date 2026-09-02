import { describe, expect, it, vi } from 'vitest';
import { ACTION_TTL_MS, buildUndoToastEntry } from '../../src/components/toaster-helpers';

/**
 * Tests for the `toast.undoable(...)` payload builder. The store
 * is not involved — the helper returns the entry shape that
 * `useToastStore.push` consumes, and the test pins the contract:
 *
 *   - default label is "Undo"
 *   - default variant is "info"
 *   - default TTL is ACTION_TTL_MS (8s) so the user has time to
 *     notice the affordance and reach for it
 *   - the action's onClick is the exact `onUndo` callback the
 *     caller passed (no wrapping, no debouncing)
 *   - overrides for variant / ttl / label are honored
 *
 * The 8s default is a UX trade-off: long enough to be friendly,
 * short enough that the toast queue doesn't grow stale. The
 * test pins the constant so an accidental change to 30s (or 1s)
 * is caught in CI.
 */

describe('ACTION_TTL_MS', () => {
  it('is 8 seconds', () => {
    expect(ACTION_TTL_MS).toBe(8_000);
  });
});

describe('buildUndoToastEntry', () => {
  it('uses the supplied message verbatim', () => {
    const entry = buildUndoToastEntry('Allowlist cleared', vi.fn());
    expect(entry.message).toBe('Allowlist cleared');
  });

  it('defaults the variant to "info"', () => {
    const entry = buildUndoToastEntry('x', vi.fn());
    expect(entry.variant).toBe('info');
  });

  it('defaults the label to "Undo"', () => {
    const entry = buildUndoToastEntry('x', vi.fn());
    expect(entry.action?.label).toBe('Undo');
  });

  it('defaults the TTL to ACTION_TTL_MS (8s)', () => {
    const entry = buildUndoToastEntry('x', vi.fn());
    expect(entry.ttl).toBe(ACTION_TTL_MS);
    expect(entry.ttl).toBe(8_000);
  });

  it('wires the onClick to the supplied onUndo callback', () => {
    const onUndo = vi.fn();
    const entry = buildUndoToastEntry('x', onUndo);
    expect(entry.action?.onClick).toBe(onUndo);
    entry.action?.onClick();
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('honors a custom variant', () => {
    const entry = buildUndoToastEntry('x', vi.fn(), { variant: 'success' });
    expect(entry.variant).toBe('success');
  });

  it('honors a custom TTL', () => {
    const entry = buildUndoToastEntry('x', vi.fn(), { ttl: 30_000 });
    expect(entry.ttl).toBe(30_000);
  });

  it('honors a custom label', () => {
    const entry = buildUndoToastEntry('x', vi.fn(), { label: 'Restore' });
    expect(entry.action?.label).toBe('Restore');
  });

  it('does not mutate the supplied callback', () => {
    const onUndo = vi.fn();
    buildUndoToastEntry('x', onUndo);
    expect(onUndo).not.toHaveBeenCalled();
  });

  it('returns an entry with no `id` (the store assigns it at push time)', () => {
    const entry = buildUndoToastEntry('x', vi.fn());
    expect(entry).not.toHaveProperty('id');
  });
});

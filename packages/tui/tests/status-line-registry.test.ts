import { describe, expect, it } from 'vitest';
import type { StatuslineLines } from '@wrongstack/core/statusline';
import { canonicalChipKey, partitionRailEntries } from '../src/components/status-line-registry.js';
import type { RailSpanEntry } from '../src/components/powerline-rail.js';

/**
 * Unit pins for the status-line registry's partition logic (Phase 1 of the
 * per-chip line-assignment plan). Rendered-layout parity with the pre-registry
 * four-rail composition is pinned separately by the unmodified
 * status-bar-rail-order / status-bar-separators suites; this file pins the
 * NEW behavior: line overrides, composite/group key travel, unknown-id
 * fallback, and 1–4 clamping.
 */

function entry(id: string): RailSpanEntry {
  // partitionRailEntries never inspects `node`, so a placeholder suffices.
  return { id, node: null as unknown as RailSpanEntry['node'] };
}

describe('canonicalChipKey', () => {
  it('maps plain rail ids to their contract chip key', () => {
    expect(canonicalChipKey('todos')).toBe('todos');
    expect(canonicalChipKey('project')).toBe('project');
  });

  it('maps composite and detail spans to their parent chip key', () => {
    expect(canonicalChipKey('primary-0')).toBe('context');
    expect(canonicalChipKey('detail-2')).toBe('mailbox');
    expect(canonicalChipKey('memory-0')).toBe('memory_context');
  });

  it('returns null for ids outside the contract', () => {
    expect(canonicalChipKey('mystery-span')).toBeNull();
  });
});

describe('partitionRailEntries', () => {
  it('keeps every entry on its default line when no overrides exist', () => {
    const rails = partitionRailEntries(
      [
        { entries: [entry('project'), entry('model')], fallbackLine: 1 },
        { entries: [entry('state'), entry('hint')], fallbackLine: 2 },
      ],
      {},
    );
    expect(rails.map((rail) => rail.entries.map((e) => e.id))).toEqual([
      ['project', 'model'],
      ['state', 'hint'],
      [],
      [],
    ]);
    expect(rails.every((rail) => rail.rightAnchor === null)).toBe(true);
  });

  it('moves an overridden chip to its assigned line, preserving in-line order', () => {
    const rails = partitionRailEntries(
      [{ entries: [entry('state'), entry('yolo'), entry('hint')], fallbackLine: 2 }],
      { hint: 1 },
    );
    expect(rails[0]!.entries.map((e) => e.id)).toEqual(['hint']);
    expect(rails[1]!.entries.map((e) => e.id)).toEqual(['state', 'yolo']);
  });

  it('moves composite and detail spans with their parent key', () => {
    const rails = partitionRailEntries(
      [
        { entries: [entry('primary-0')], fallbackLine: 2 },
        { entries: [entry('mailbox'), entry('detail-1')], fallbackLine: 4 },
        { entries: [entry('memory-0')], fallbackLine: 4 },
      ],
      { context: 3, mailbox: 2, memory_context: 1 },
    );
    expect(rails[0]!.entries.map((e) => e.id)).toEqual(['memory-0']);
    expect(rails[1]!.entries.map((e) => e.id)).toEqual(['mailbox', 'detail-1']);
    expect(rails[2]!.entries.map((e) => e.id)).toEqual(['primary-0']);
  });

  it('falls back to the builder line for ids outside the contract (override impossible)', () => {
    const rails = partitionRailEntries(
      [{ entries: [entry('mystery-span')], fallbackLine: 4 }],
      { todos: 1 },
    );
    expect(rails[3]!.entries.map((e) => e.id)).toEqual(['mystery-span']);
  });

  it('clamps out-of-range overrides to the 1–4 line range', () => {
    // The persisted `lines` map is validated/clamped at load time (Phase 2);
    // the runtime clamp below is defense-in-depth for raw data, so the
    // out-of-range literals must bypass the StatuslineLines value type.
    const outOfRange = { todos: 9, plan: 0 } as unknown as StatuslineLines;
    const rails = partitionRailEntries(
      [{ entries: [entry('todos'), entry('plan')], fallbackLine: 3 }],
      outOfRange,
    );
    expect(rails[3]!.entries.map((e) => e.id)).toEqual(['todos']);
    expect(rails[0]!.entries.map((e) => e.id)).toEqual(['plan']);
  });
});

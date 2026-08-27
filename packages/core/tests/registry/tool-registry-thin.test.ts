/**
 * Tests for `ToolRegistry.thinUnderused()`, `enableAutoThinned()`,
 * `applyDisabledMeta()`, and the audit-trail `listDisabled()` shape.
 *
 * The auto-thinning pipeline relies on the registry distinguishing
 * user-authored disables from auto-thinned ones — a misclassification
 * would either orphan operator intent (`undo` re-enabling a tool the
 * user had disabled) or fail to thin on the next boot (`undo` would
 * silently skip the auto-thinned names).
 */

import { describe, expect, it } from 'vitest';
import { EventBus } from '../../src/kernel/events.js';
import { ToolRegistry } from '../../src/registry/tool-registry.js';
import type { Tool } from '../../src/types/tool.js';

const makeTool = (name: string, description = `${name} tool`): Tool => ({
  name,
  description,
  mutating: false,
  inputSchema: { type: 'object', properties: {} },
  execute: async () => ({ output: `${name} ok` }),
  permission: 'auto',
  category: 'test',
});

function makeRegistry(names: string[]): { registry: ToolRegistry; events: EventBus } {
  const registry = new ToolRegistry();
  const events = new EventBus();
  registry.setEventBus(events);
  for (const name of names) registry.register(makeTool(name));
  return { registry, events };
}

describe('ToolRegistry.thinUnderused', () => {
  it('disables candidates with reason "auto-thinned" and skips unknown/already-disabled', () => {
    const { registry } = makeRegistry(['read', 'bash', 'grep']);
    registry.disable('bash', 'user', { caller: 'manual' }); // pre-existing user disable
    const result = registry.thinUnderused(['read', 'bash', 'grep', 'missing'], 'test');
    expect(result.thinned).toEqual(['read', 'grep']);
    expect(result.skipped).toEqual(['bash', 'missing']);
    expect(registry.isDisabled('read')).toBe(true);
    expect(registry.isDisabled('grep')).toBe(true);
    expect(registry.isDisabled('bash')).toBe(true); // user-disabled, still disabled
    expect(registry.disabledMeta('read')?.reason).toBe('auto-thinned');
    expect(registry.disabledMeta('read')?.caller).toBe('test');
    // user disable reason must NOT be downgraded
    expect(registry.disabledMeta('bash')?.reason).toBe('user');
  });

  it('emits tool.thinned exactly once with the names that flipped', () => {
    const { registry, events } = makeRegistry(['read', 'grep']);
    const received: { names: string[]; reason: string }[] = [];
    events.on('tool.thinned', (e) => received.push(e));
    registry.thinUnderused(['read', 'grep'], 'pipeline');
    expect(received).toHaveLength(1);
    expect(received[0]?.names).toEqual(['read', 'grep']);
    expect(received[0]?.reason).toBe('pipeline');
  });

  it('emits no event when nothing was thinned', () => {
    const { registry, events } = makeRegistry(['read']);
    let count = 0;
    events.on('tool.thinned', () => count++);
    registry.thinUnderused(['missing'], 'pipeline');
    expect(count).toBe(0);
  });

  it('does not throw when registry has no event bus', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('read'));
    // intentionally no setEventBus call
    expect(() => registry.thinUnderused(['read'], 'pipeline')).not.toThrow();
    expect(registry.isDisabled('read')).toBe(true);
  });
});

describe('ToolRegistry.enableAutoThinned', () => {
  it('re-enables only the auto-thinned subset, leaves user disables alone', () => {
    const { registry } = makeRegistry(['read', 'bash']);
    registry.disable('read', 'user');
    registry.thinUnderused(['bash'], 'test');
    const restored = registry.enableAutoThinned();
    expect(restored).toEqual(['bash']);
    expect(registry.isDisabled('read')).toBe(true);
    expect(registry.isDisabled('bash')).toBe(false);
  });

  it('returns an empty array when nothing was auto-thinned', () => {
    const { registry } = makeRegistry(['read']);
    registry.disable('read', 'user');
    expect(registry.enableAutoThinned()).toEqual([]);
    expect(registry.isDisabled('read')).toBe(true);
  });
});

describe('ToolRegistry.applyDisabledMeta', () => {
  it('restores audit-trail metadata for previously-disabled tools', () => {
    const { registry } = makeRegistry(['read', 'bash']);
    registry.applyDisabled(['read', 'bash']);
    registry.applyDisabledMeta({
      read: { reason: 'auto-thinned', at: 1234, caller: 'previous-boot' },
      bash: { reason: 'user', at: 5678 },
    });
    expect(registry.disabledMeta('read')?.reason).toBe('auto-thinned');
    expect(registry.disabledMeta('read')?.caller).toBe('previous-boot');
    expect(registry.disabledMeta('bash')?.reason).toBe('user');
  });

  it('ignores entries whose names are not currently disabled', () => {
    const { registry } = makeRegistry(['read']);
    // Disable 'read' first so it exists in the map; 'ghost' is never registered.
    registry.applyDisabled(['read']);
    const count = registry.applyDisabledMeta({
      read: { reason: 'user', at: 1 },
      ghost: { reason: 'auto-thinned', at: 2, caller: 'pipeline' },
    });
    expect(count).toBe(1);
  });
});

describe('ToolRegistry.listDisabled with audit trail', () => {
  it('returns reason + at + caller for every disabled tool', () => {
    const { registry } = makeRegistry(['read', 'bash', 'grep']);
    registry.disable('read', 'user');
    registry.thinUnderused(['bash'], 'pipeline');
    const list = registry.listDisabled();
    const byName = new Map(list.map((entry) => [entry.tool.name, entry]));
    expect(byName.get('read')?.meta.reason).toBe('user');
    expect(byName.get('bash')?.meta.reason).toBe('auto-thinned');
    expect(byName.get('bash')?.meta.caller).toBe('pipeline');
  });
});

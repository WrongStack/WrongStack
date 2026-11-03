import type { Tool } from '@wrongstack/contracts/types/tool';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../src/registry/tool-registry.js';

const tool = (name: string, extra: Partial<Tool> = {}): Tool => ({
  name,
  description: `Run ${name}`,
  permission: 'auto',
  mutating: false,
  inputSchema: { type: 'object' },
  async execute() {
    return name;
  },
  ...extra,
});

describe('tool aliases and catalog governance', () => {
  it('removes a scoped wrapper applied through an alias', () => {
    const registry = new ToolRegistry();
    registry.register(tool('canonical', { aliases: ['old'] }));
    const remove = registry.wrapScoped('old', (t) => ({ ...t, permission: 'confirm' }));
    expect(registry.get('old')?.permission).toBe('confirm');
    remove();
    expect(registry.get('old')?.permission).toBe('auto');
  });
  it('preserves legacy canonical names while checking new aliases', () => {
    const registry = new ToolRegistry();
    registry.register(tool('legacy.provider'));
    expect(registry.get('legacy.provider')?.name).toBe('legacy.provider');
  });
  it('silently skips alias conflicts through the non-throwing registration API', () => {
    const registry = new ToolRegistry();
    registry.register(tool('first', { aliases: ['old'] }));
    expect(registry.tryRegister(tool('second', { aliases: ['old'] }))).toBe(false);
    expect(registry.list().map((t) => t.name)).toEqual(['first']);
  });
  it('updates alias ownership across overrides, scoped registration, clones and clear', () => {
    const registry = new ToolRegistry();
    const remove = registry.registerScoped(tool('canonical', { aliases: ['old'] }));
    registry.override('canonical', tool('canonical', { aliases: ['new_old'] }));
    remove();
    expect(registry.get('old')).toBeUndefined();
    expect(registry.get('new_old')?.name).toBe('canonical');
    const clone = registry.clone();
    registry.clear();
    expect(registry.get('new_old')).toBeUndefined();
    expect(clone.get('new_old')?.name).toBe('canonical');
    clone.unregister('new_old');
    expect(clone.get('new_old')).toBeUndefined();
  });
  it('keeps internal tools off cached provider surfaces while exporting their declared scope', () => {
    const registry = new ToolRegistry();
    registry.register(tool('internal', { exposure: 'internal' }));
    const first = registry.listForProvider();
    expect(first).toEqual([]);
    expect(registry.listForProvider()).toBe(first);
    registry.setProviderToolNames(['internal']);
    expect(registry.listForProvider()).toEqual([]);
    expect(registry.isExposedToProvider('internal')).toBe(false);
    expect(registry.exportCatalog().tools[0]?.exposure).toBe('internal');
  });
  it('resolves an alias to the canonical contract without adding provider schemas', () => {
    const registry = new ToolRegistry();
    registry.register(
      tool('new_name', { aliases: ['old_name'], permission: 'confirm', mutating: true }),
    );
    expect(registry.get('old_name')).toBe(registry.get('new_name'));
    expect(registry.get('old_name')?.name).toBe('new_name');
    expect(registry.listForProvider().map((t) => t.name)).toEqual(['new_name']);
  });

  it.each(['old_name', 'new_name'])('cannot bypass a denied name through %s', (denied) => {
    const registry = new ToolRegistry();
    registry.register(tool('new_name', { aliases: ['old_name'] }));
    registry.setSessionRestriction({ deny: [denied] });
    expect(registry.get('old_name')).toBeUndefined();
    expect(registry.get('new_name')).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  it('requires the canonical name in a launch allowlist and preserves disabled state in clones', () => {
    const registry = new ToolRegistry();
    registry.register(tool('new_name', { aliases: ['old_name'] }));
    registry.setSessionRestriction({ only: ['old_name'] });
    expect(registry.get('old_name')).toBeUndefined();
    registry.setSessionRestriction({ only: ['new_name'] });
    expect(registry.get('old_name')?.name).toBe('new_name');
    registry.disable('old_name');
    expect(registry.clone().get('new_name')).toBeUndefined();
    registry.enable('old_name');
    expect(registry.get('new_name')).toBeDefined();
  });

  it('rejects alias collisions atomically, including overrides and wrappers', () => {
    const registry = new ToolRegistry();
    registry.register(tool('first', { aliases: ['legacy'] }));
    registry.register(tool('second'));
    expect(() => registry.register(tool('legacy'))).toThrow(/alias|registered/i);
    expect(() => registry.override('second', tool('second', { aliases: ['legacy'] }))).toThrow(
      /alias/i,
    );
    expect(() => registry.wrap('second', (t) => ({ ...t, aliases: ['first'] }))).toThrow(/alias/i);
    expect(registry.get('legacy')?.name).toBe('first');
    expect(registry.get('second')?.aliases).toBeUndefined();
    registry.unregister('first');
    registry.register(tool('legacy'));
    expect(registry.get('legacy')?.name).toBe('legacy');
  });

  it('exports a stable executable catalog including late registrations and exposure', () => {
    const registry = new ToolRegistry();
    registry.register(tool('direct'));
    registry.setProviderToolNames(['direct']);
    registry.register(
      tool('late', { aliases: ['old'], deprecated: { since: '1.4', replacedBy: 'direct' } }),
      'plugin:fixture',
    );
    const catalog = registry.exportCatalog();
    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.tools.find((t) => t.name === 'late')).toMatchObject({
      owner: 'plugin:fixture',
      exposure: 'on-demand',
      aliases: ['old'],
      deprecated: { since: '1.4', replacedBy: 'direct' },
    });
    for (const entry of catalog.tools) {
      expect(entry).not.toHaveProperty('execute');
      expect(entry).not.toHaveProperty('_estDefTokens');
      expect(entry).not.toHaveProperty('previous');
    }
    registry.disable('late');
    expect(registry.exportCatalog().tools.map((t) => t.name)).toEqual(['direct']);
  });
});

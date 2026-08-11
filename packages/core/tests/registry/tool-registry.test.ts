import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../src/registry/tool-registry.js';
import type { Tool } from '../../src/types/tool.js';

const t = (name: string, category?: string): Tool => ({
  name,
  description: name,
  inputSchema: { type: 'object' },
  permission: 'auto',
  mutating: false,
  async execute() {
    return '';
  },
  ...(category ? { category } : {}),
});

describe('ToolRegistry', () => {
  it('register / get / list', () => {
    const r = new ToolRegistry();
    r.register(t('a'));
    r.register(t('b'));
    expect(
      r
        .list()
        .map((x) => x.name)
        .sort(),
    ).toEqual(['a', 'b']);
    expect(r.get('a')?.name).toBe('a');
  });

  it('keeps lazy tools executable while bounding the provider surface', () => {
    const r = new ToolRegistry();
    r.register(t('read'));
    r.register(t('rare-plugin-tool'), 'plugin:rare');
    r.setProviderToolNames(['read']);

    expect(r.list().map((tool) => tool.name)).toEqual(['read', 'rare-plugin-tool']);
    expect(r.get('rare-plugin-tool')?.name).toBe('rare-plugin-tool');
    expect(r.listForProvider().map((tool) => tool.name)).toEqual(['read']);
    expect(r.isExposedToProvider('read')).toBe(true);
    expect(r.isExposedToProvider('rare-plugin-tool')).toBe(false);
    expect(r.isExposedToProvider('missing')).toBe(false);

    r.exposeToProvider('rare-plugin-tool');
    expect(r.listForProvider().map((tool) => tool.name)).toEqual(['read', 'rare-plugin-tool']);
    expect(r.isExposedToProvider('rare-plugin-tool')).toBe(true);
    r.disable('read');
    expect(r.isExposedToProvider('read')).toBe(false);
  });

  it('preserves provider exposure when cloning', () => {
    const r = new ToolRegistry();
    r.register(t('read'));
    r.register(t('lazy'));
    r.setProviderToolNames(['read']);

    const clone = r.clone();
    expect(clone.list().map((tool) => tool.name)).toEqual(['read', 'lazy']);
    expect(clone.listForProvider().map((tool) => tool.name)).toEqual(['read']);
  });

  it('rejects duplicate register', () => {
    const r = new ToolRegistry();
    r.register(t('a'));
    expect(() => r.register(t('a'))).toThrow(/already/);
  });

  it('override requires existing', () => {
    const r = new ToolRegistry();
    expect(() => r.override('a', t('a'))).toThrow(/not registered/);
  });

  it('override works and tracks owner', () => {
    const r = new ToolRegistry();
    r.register(t('a'), 'core');
    r.override('a', t('a'), 'plug');
    expect(r.ownerOf('a')).toBe('plug');
  });

  it('registerDefault skips if already registered', () => {
    const r = new ToolRegistry();
    r.register(t('a'), 'core');
    r.registerDefault(t('a'), 'plug');
    expect(r.ownerOf('a')).toBe('core');
  });

  it('registerDefault registers when empty', () => {
    const r = new ToolRegistry();
    r.registerDefault(t('a'), 'core');
    expect(r.list().map((x) => x.name)).toEqual(['a']);
  });

  it('unregister', () => {
    const r = new ToolRegistry();
    r.register(t('a'));
    expect(r.unregister('a')).toBe(true);
    expect(r.unregister('a')).toBe(false);
  });

  // ─── Additional coverage tests ─────────────────────────────────────

  it('tryRegister returns false when tool already exists', () => {
    const r = new ToolRegistry();
    r.register(t('a'), 'core');
    const result = r.tryRegister(t('a'), 'plug');
    expect(result).toBe(false);
    expect(r.ownerOf('a')).toBe('core');
  });

  it('tryRegister returns true when slot is free', () => {
    const r = new ToolRegistry();
    const result = r.tryRegister(t('a'), 'core');
    expect(result).toBe(true);
    expect(r.ownerOf('a')).toBe('core');
  });

  it('registerAll silently skips duplicates', () => {
    const r = new ToolRegistry();
    r.register(t('a'), 'core');
    r.registerAll([t('a'), t('b'), t('a')], 'plug');
    expect(
      r
        .list()
        .map((x) => x.name)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  it('registerAllOrThrow throws on first conflict', () => {
    const r = new ToolRegistry();
    r.register(t('a'), 'core');
    expect(() => r.registerAllOrThrow([t('a'), t('b')], 'plug')).toThrow(/already/);
  });

  it('registerAllOrThrow registers all when no conflicts', () => {
    const r = new ToolRegistry();
    r.registerAllOrThrow([t('a'), t('b')], 'core');
    expect(
      r
        .list()
        .map((x) => x.name)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  it('wrap throws when tool not registered', () => {
    const r = new ToolRegistry();
    expect(() => r.wrap('nonexistent', (tool) => tool)).toThrow(/not registered/);
  });

  it('wrap modifies tool and tracks combined owner', () => {
    const r = new ToolRegistry();
    r.register(t('a'), 'core');
    r.wrap('a', (tool) => ({ ...tool, description: 'wrapped' }), 'plug');
    expect(r.get('a')?.description).toBe('wrapped');
    expect(r.ownerOf('a')).toBe('core+plug');
  });

  it('wrap stacks multiple wrappers', () => {
    const r = new ToolRegistry();
    r.register(t('a'), 'core');
    r.wrap('a', (tool) => ({ ...tool, description: 'first' }), 'p1');
    r.wrap('a', (tool) => ({ ...tool, description: tool.description + ' second' }), 'p2');
    expect(r.get('a')?.description).toBe('first second');
    expect(r.ownerOf('a')).toBe('core+p1+p2');
  });

  it('listByCategory groups tools by category', () => {
    const r = new ToolRegistry();
    r.register(t('read', 'Filesystem'));
    r.register(t('write', 'Filesystem'));
    r.register(t('grep', 'Search'));
    r.register(t('custom'));

    const byCat = r.listByCategory();
    expect(byCat.get('Filesystem')?.map((x) => x.name)).toEqual(['read', 'write']);
    expect(byCat.get('Search')?.map((x) => x.name)).toEqual(['grep']);
    expect(byCat.get('')?.map((x) => x.name)).toEqual(['custom']);
  });

  it('listByCategory maintains registration order', () => {
    const r = new ToolRegistry();
    r.register(t('c', 'Filesystem'));
    r.register(t('a', 'Filesystem'));
    r.register(t('b', 'Filesystem'));

    const byCat = r.listByCategory();
    const names = byCat.get('Filesystem')!.map((x) => x.name);
    expect(names).toEqual(['c', 'a', 'b']);
  });

  it('listWithOwner returns tool+owner pairs', () => {
    const r = new ToolRegistry();
    r.register(t('a'), 'core');
    r.register(t('b'), 'plug');

    const list = r.listWithOwner();
    expect(list).toHaveLength(2);
    expect(list.find((x) => x.tool.name === 'a')?.owner).toBe('core');
    expect(list.find((x) => x.tool.name === 'b')?.owner).toBe('plug');
  });

  it('clear removes all tools', () => {
    const r = new ToolRegistry();
    r.register(t('a'));
    r.register(t('b'));
    r.clear();
    expect(r.list()).toEqual([]);
    expect(r.get('a')).toBeUndefined();
    expect(r.get('b')).toBeUndefined();
  });

  it('get returns undefined for unregistered tool', () => {
    const r = new ToolRegistry();
    expect(r.get('nonexistent')).toBeUndefined();
  });

  it('ownerOf returns undefined for unregistered tool', () => {
    const r = new ToolRegistry();
    expect(r.ownerOf('nonexistent')).toBeUndefined();
  });

  it('register tracks owner', () => {
    const r = new ToolRegistry();
    r.register(t('a'), 'my-owner');
    expect(r.ownerOf('a')).toBe('my-owner');
  });

  it('registerDefault tracks owner', () => {
    const r = new ToolRegistry();
    r.registerDefault(t('a'), 'default-owner');
    expect(r.ownerOf('a')).toBe('default-owner');
  });

  it('can switch a tool description between simple and extend', () => {
    const r = new ToolRegistry();
    const full =
      'Read a file from disk and return its contents with optional line ranges. Use this for inspecting source code, configuration files, documentation, and generated output before making edits.';
    r.register({ ...t('read'), description: full, usageHint: `${full} Prefer narrow ranges.` });

    expect(r.setDescriptionMode('read', 'simple')).toBe(true);
    expect(r.getDescriptionMode('read')).toBe('simple');
    expect(r.get('read')?.description.length).toBeLessThan(full.length);

    expect(r.setDescriptionMode('read', 'extend')).toBe(true);
    expect(r.getDescriptionMode('read')).toBe('extend');
    expect(r.get('read')?.description).toBe(full);
    expect(r.get('read')?.usageHint).toBe(`${full} Prefer narrow ranges.`);
  });

  it('wrap receives the extended tool while a simple mode is active', () => {
    const r = new ToolRegistry();
    const full =
      'Execute a command through the project shell with configured permission checks. Use this when a shell command is the clearest way to inspect, build, test, or run project code. Prefer explicit commands with bounded timeouts and visible output.';
    const wrappedFull =
      'Execute a vetted command through the project shell and return stdout, stderr, and exit code. Use this for build, test, and diagnostic commands that need normal shell behavior. Prefer explicit commands with bounded timeouts and visible output.';
    r.register({ ...t('bash'), description: full });
    r.setDescriptionMode('bash', 'simple');

    let seenByWrapper = '';
    r.wrap(
      'bash',
      (tool) => {
        seenByWrapper = tool.description;
        return { ...tool, description: wrappedFull };
      },
      'plug',
    );

    expect(seenByWrapper).toBe(full);
    expect(r.get('bash')?.description.length).toBeLessThan(wrappedFull.length);

    r.setDescriptionMode('bash', 'extend');
    expect(r.get('bash')?.description).toBe(wrappedFull);
  });

  it('applies stored description modes to later registrations and clones', () => {
    const r = new ToolRegistry();
    expect(r.applyDescriptionModes({ read: 'simple' })).toEqual({
      applied: 0,
      missing: ['read'],
    });

    const full =
      'Read project files with optional offsets and limits. Use this before editing so changes are based on the current file contents rather than assumptions. Prefer narrow line ranges when a file is large or generated.';
    r.register({ ...t('read'), description: full });
    expect(r.getDescriptionMode('read')).toBe('simple');
    expect(r.get('read')?.description.length).toBeLessThan(full.length);

    const clone = r.clone();
    expect(clone.getDescriptionMode('read')).toBe('simple');
    expect(clone.get('read')?.description.length).toBeLessThan(full.length);
  });
});

// ── Disable / enable API + remaining branches ─────────────────────────

describe('ToolRegistry disable/enable', () => {
  it('disable hides a tool from get/list/listByCategory/listWithOwner', () => {
    const r = new ToolRegistry();
    r.register(t('a'));
    r.register(t('b'));
    expect(r.disable('a')).toBe(true);
    expect(r.isDisabled('a')).toBe(true);
    expect(r.get('a')).toBeUndefined();
    expect(r.list().map((x) => x.name)).toEqual(['b']);
    expect(
      r
        .listByCategory()
        .get('')
        ?.map((x) => x.name),
    ).toEqual(['b']);
    expect(r.listWithOwner().map((x) => x.tool.name)).toEqual(['b']);
  });

  it('disable returns false for unknown / already-disabled tools', () => {
    const r = new ToolRegistry();
    r.register(t('a'));
    expect(r.disable('ghost')).toBe(false);
    expect(r.disable('a')).toBe(true);
    expect(r.disable('a')).toBe(false); // already disabled
  });

  it('enable restores a disabled tool; returns false if not disabled', () => {
    const r = new ToolRegistry();
    r.register(t('a'));
    expect(r.enable('a')).toBe(false); // not disabled
    r.disable('a');
    expect(r.enable('a')).toBe(true);
    expect(r.get('a')?.name).toBe('a');
    expect(r.isDisabled('a')).toBe(false);
  });

  it('enableAll re-enables every disabled tool and returns the count', () => {
    const r = new ToolRegistry();
    r.register(t('a'));
    r.register(t('b'));
    expect(r.enableAll()).toBe(0); // none disabled
    r.disable('a');
    r.disable('b');
    expect(r.enableAll()).toBe(2);
    expect(
      r
        .list()
        .map((x) => x.name)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  it('applyDisabled ignores unknown names and returns the count disabled', () => {
    const r = new ToolRegistry();
    r.register(t('a'));
    r.register(t('b'));
    expect(r.applyDisabled(['a', 'ghost', 'b'])).toBe(2);
    expect(r.list()).toHaveLength(0);
  });

  it('listDisabled returns tool+owner for disabled entries', () => {
    const r = new ToolRegistry();
    r.register(t('a'), 'plugin-x');
    r.disable('a');
    const disabled = r.listDisabled();
    expect(disabled).toHaveLength(1);
    expect(disabled[0]!.tool.name).toBe('a');
    expect(disabled[0]!.owner).toBe('plugin-x');
  });

  it('clone preserves the disabled set', () => {
    const r = new ToolRegistry();
    r.register(t('a'));
    r.disable('a');
    const clone = r.clone();
    expect(clone.isDisabled('a')).toBe(true);
    expect(clone.get('a')).toBeUndefined();
    clone.enable('a');
    expect(clone.get('a')?.name).toBe('a');
  });
});

describe('ToolRegistry registration + mode branches', () => {
  it('register throws on an invalid inputSchema', () => {
    const r = new ToolRegistry();
    expect(() => r.register({ name: 'x', inputSchema: null } as never)).toThrow(/inputSchema/);
  });

  it('tryRegister returns false on duplicate and on invalid schema', () => {
    const r = new ToolRegistry();
    expect(r.tryRegister({ name: 'x', inputSchema: null } as never)).toBe(false);
    expect(r.tryRegister(t('x'))).toBe(true);
    expect(r.tryRegister(t('x'))).toBe(false); // duplicate
  });

  it('setDescriptionMode returns false for an invalid mode or a missing tool', () => {
    const r = new ToolRegistry();
    r.register(t('a'));
    expect(r.setDescriptionMode('a', 'garbage')).toBe(false);
    expect(r.setDescriptionMode('ghost', 'simple')).toBe(false);
    expect(r.setDescriptionMode('a', 'simple')).toBe(true);
  });

  it('applyDescriptionModes: invalid skip + applied (registered) + extend-on-missing', () => {
    const r = new ToolRegistry();
    r.register(t('a'));
    expect(r.applyDescriptionModes({ a: 'garbage' })).toEqual({ applied: 0, missing: [] }); // 223 skip
    expect(r.applyDescriptionModes({ a: 'simple' })).toEqual({ applied: 1, missing: [] }); // 225 applied
    expect(r.applyDescriptionModes({ ghost: 'extend' })).toEqual({
      applied: 0,
      missing: ['ghost'],
    }); // 228 else-delete
  });

  it('list() returns a cached snapshot when unchanged', () => {
    const r = new ToolRegistry();
    r.register(t('a'));
    const first = r.list();
    const second = r.list();
    expect(second).toBe(first); // same cached ref (no mutation between)
  });
});

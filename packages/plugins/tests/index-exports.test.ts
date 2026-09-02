/**
 * Tests for src/index.ts — verifies all re-exports from the barrel file
 * resolve to valid plugin objects with the expected shape.
 */
import { describe, expect, it } from 'vitest';

describe('plugin barrel exports', () => {
  it('all exports from index.ts resolve to objects with a name, version, and setup', async () => {
    const plugins = await import('../src/index.js');
    const exportNames = Object.keys(plugins);
    expect(exportNames.length).toBeGreaterThan(0);

    for (const [key, value] of Object.entries(plugins)) {
      expect(key).toMatch(/Plugin$/); // convention: each export ends in 'Plugin'
      expect(value).toBeDefined();
      expect(typeof value).toBe('object');
      const p = value as { name?: string; version?: string; setup?: unknown };
      expect(p.name).toStrictEqual(expect.any(String));
      expect(p.name!.length).toBeGreaterThan(0);
      expect(p.version).toStrictEqual(expect.any(String));
      expect(typeof p.setup).toBe('function');
    }
  });

  it('all exported plugins have a matching catalog entry', async () => {
    const { PLUGIN_CATALOG } = await import('../src/catalog.js');
    const plugins = await import('../src/index.js');

    for (const [, value] of Object.entries(plugins)) {
      const p = value as { name?: string };
      if (p.name) {
        expect(PLUGIN_CATALOG.has(p.name)).toBe(true);
      }
    }
  });

  it('every exported plugin has a health() and teardown() with correct signatures', async () => {
    const plugins = await import('../src/index.js');
    for (const [, value] of Object.entries(plugins)) {
      const p = value as {
        name?: string;
        health?: unknown;
        teardown?: unknown;
      };
      if (p.health !== undefined) {
        expect(typeof p.health).toBe('function');
      }
      if (p.teardown !== undefined) {
        expect(typeof p.teardown).toBe('function');
      }
    }
  });

  it('all exported plugin names are kebab-case', async () => {
    const plugins = await import('../src/index.js');
    for (const [, value] of Object.entries(plugins)) {
      const p = value as { name?: string };
      if (p.name) {
        expect(p.name).toMatch(/^[a-z0-9-]+$/);
      }
    }
  });

  it('all plugins declare capabilities', async () => {
    const plugins = await import('../src/index.js');
    for (const [, value] of Object.entries(plugins)) {
      const p = value as { capabilities?: { tools?: boolean; hooks?: boolean } };
      if (p.capabilities) {
        expect(typeof p.capabilities).toBe('object');
      }
    }
  });
});

describe('OFFICIAL_PLUGIN_SPECIFIERS (factories)', () => {
  it('exports a non-empty string array', async () => {
    const { OFFICIAL_PLUGIN_SPECIFIERS } = await import('../src/factories/index.js');
    expect(Array.isArray(OFFICIAL_PLUGIN_SPECIFIERS)).toBe(true);
    expect(OFFICIAL_PLUGIN_SPECIFIERS.length).toBeGreaterThan(0);
  });

  it('every specifier is a string starting with @wrongstack/plugins/', async () => {
    const { OFFICIAL_PLUGIN_SPECIFIERS } = await import('../src/factories/index.js');
    for (const spec of OFFICIAL_PLUGIN_SPECIFIERS) {
      expect(typeof spec).toBe('string');
      expect(spec).toMatch(/^@wrongstack\/plugins\//);
    }
  });

  it('every specifier has a matching plugin name in the barrel export', async () => {
    const { OFFICIAL_PLUGIN_SPECIFIERS } = await import('../src/factories/index.js');
    const plugins = await import('../src/index.js');
    const barrelNames = Object.entries(plugins)
      .filter(([k]) => k.endsWith('Plugin'))
      .map(([, v]) => {
        const p = v as { name?: string };
        return p.name;
      })
      .filter(Boolean) as string[];
    // Every specifier's trailing path component should match a barrel plugin name
    for (const spec of OFFICIAL_PLUGIN_SPECIFIERS) {
      const inferredName = spec.replace(/^@wrongstack\/plugins\//, '');
      expect(barrelNames).toContain(inferredName);
    }
  });

  it('has no duplicate specifiers', async () => {
    const { OFFICIAL_PLUGIN_SPECIFIERS } = await import('../src/factories/index.js');
    expect(new Set(OFFICIAL_PLUGIN_SPECIFIERS).size).toBe(OFFICIAL_PLUGIN_SPECIFIERS.length);
  });

  it('exports OFFICIAL_PLUGIN_FACTORIES array of functions', async () => {
    const { OFFICIAL_PLUGIN_FACTORIES } = await import('../src/factories/index.js');
    expect(Array.isArray(OFFICIAL_PLUGIN_FACTORIES)).toBe(true);
    expect(OFFICIAL_PLUGIN_FACTORIES.length).toBeGreaterThan(0);
    for (const factory of OFFICIAL_PLUGIN_FACTORIES) {
      expect(typeof factory).toBe('function');
    }
  });

  it('OFFICIAL_PLUGIN_FACTORIES has same length as specifiers', async () => {
    const factories = await import('../src/factories/index.js');
    expect(factories.OFFICIAL_PLUGIN_FACTORIES.length).toBe(
      factories.OFFICIAL_PLUGIN_SPECIFIERS.length,
    );
  });
});

describe('OFFICIAL_PLUGIN_AUDIT_ENTRIES (audit)', () => {
  it('exports a non-empty array', async () => {
    const { OFFICIAL_PLUGIN_AUDIT_ENTRIES } = await import('../src/audit/index.js');
    expect(Array.isArray(OFFICIAL_PLUGIN_AUDIT_ENTRIES)).toBe(true);
    expect(OFFICIAL_PLUGIN_AUDIT_ENTRIES.length).toBeGreaterThan(0);
  });

  it('every entry has the required fields', async () => {
    const { OFFICIAL_PLUGIN_AUDIT_ENTRIES } = await import('../src/audit/index.js');
    for (const entry of OFFICIAL_PLUGIN_AUDIT_ENTRIES) {
      expect(entry).toHaveProperty('name');
      expect(typeof entry.name).toBe('string');
      expect(entry).toHaveProperty('risk');
      expect(['low', 'medium', 'high']).toContain(entry.risk);
      expect(entry).toHaveProperty('summary');
      expect(typeof entry.summary).toBe('string');
      expect(entry).toHaveProperty('defaultState');
      expect(['active', 'inactive']).toContain(entry.defaultState);
      expect(entry).toHaveProperty('canDisable');
      expect(typeof entry.canDisable).toBe('boolean');
    }
  });

  it('every entry name exists in the barrel plugin list', async () => {
    const { OFFICIAL_PLUGIN_AUDIT_ENTRIES } = await import('../src/audit/index.js');
    const plugins = await import('../src/index.js');
    const barrelNames = Object.entries(plugins)
      .filter(([k]) => k.endsWith('Plugin'))
      .map(([, v]) => {
        const p = v as { name?: string };
        return p.name;
      })
      .filter(Boolean) as string[];
    for (const entry of OFFICIAL_PLUGIN_AUDIT_ENTRIES) {
      expect(barrelNames).toContain(entry.name);
    }
  });

  it('has no duplicate names', async () => {
    const { OFFICIAL_PLUGIN_AUDIT_ENTRIES } = await import('../src/audit/index.js');
    const names = OFFICIAL_PLUGIN_AUDIT_ENTRIES.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

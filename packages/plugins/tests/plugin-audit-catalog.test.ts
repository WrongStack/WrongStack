/**
 * @wrongstack/plugins — plugin-audit-catalog test
 *
 * Verifies the combined host + official audit catalog is well-formed and
 * stays the single source of truth shared by the CLI plugin manager and
 * the WebUI settings panel.
 */
import { describe, expect, it } from 'vitest';
import { OFFICIAL_PLUGIN_AUDIT_ENTRIES } from '../src/audit/index.js';
import {
  HOST_PLUGIN_AUDIT_ENTRIES,
  PLUGIN_AUDIT_ENTRIES,
} from '../src/plugin-audit-catalog/index.js';

describe('plugin audit catalog', () => {
  it('exports a non-empty frozen catalog', () => {
    expect(Array.isArray(PLUGIN_AUDIT_ENTRIES)).toBe(true);
    expect(PLUGIN_AUDIT_ENTRIES.length).toBeGreaterThan(0);
    expect(Object.isFrozen(PLUGIN_AUDIT_ENTRIES)).toBe(true);
  });

  it('joins every host entry and every official entry, host-first', () => {
    expect(PLUGIN_AUDIT_ENTRIES.length).toBe(
      HOST_PLUGIN_AUDIT_ENTRIES.length + OFFICIAL_PLUGIN_AUDIT_ENTRIES.length,
    );
    // Host entries come first, in declared order.
    for (let i = 0; i < HOST_PLUGIN_AUDIT_ENTRIES.length; i++) {
      expect(PLUGIN_AUDIT_ENTRIES[i]?.name).toBe(HOST_PLUGIN_AUDIT_ENTRIES[i]?.name);
    }
    // Official entries follow, in declared order.
    for (let i = 0; i < OFFICIAL_PLUGIN_AUDIT_ENTRIES.length; i++) {
      expect(PLUGIN_AUDIT_ENTRIES[HOST_PLUGIN_AUDIT_ENTRIES.length + i]?.name).toBe(
        OFFICIAL_PLUGIN_AUDIT_ENTRIES[i]?.name,
      );
    }
  });

  it('has no duplicate names across host and official entries', () => {
    const names = PLUGIN_AUDIT_ENTRIES.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every entry has the required audit fields', () => {
    for (const entry of PLUGIN_AUDIT_ENTRIES) {
      expect(typeof entry.name).toBe('string');
      expect(entry.name.length).toBeGreaterThan(0);
      expect(['low', 'medium', 'high']).toContain(entry.risk);
      expect(typeof entry.summary).toBe('string');
      expect(entry.summary.length).toBeGreaterThan(0);
      expect(['active', 'inactive']).toContain(entry.defaultState);
      expect(typeof entry.canDisable).toBe('boolean');
    }
  });

  it('includes the host-owned plugins the WebUI settings panel must show', () => {
    const names = new Set(PLUGIN_AUDIT_ENTRIES.map((e) => e.name));
    for (const host of [
      'wstack-chimera',
      'wstack-auto-review',
      'wstack-skills',
      'wstack-prompts',
      'telegram',
    ]) {
      expect(names.has(host), `catalog is missing host plugin ${host}`).toBe(true);
    }
  });
});

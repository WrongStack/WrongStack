import { describe, expect, it } from 'vitest';
import {
  formatPlanTemplates,
  getPlanTemplate,
  listPlanTemplates,
} from '../../src/storage/plan-templates.js';

describe('plan-templates', () => {
  it('lists all templates', () => {
    const templates = listPlanTemplates();
    expect(templates.length).toBeGreaterThan(0);
    expect(templates.some((t) => t.name === 'new-feature')).toBe(true);
    expect(templates.some((t) => t.name === 'bug-fix')).toBe(true);
  });

  it('gets a template by name', () => {
    const tpl = getPlanTemplate('new-feature');
    expect(tpl).toBeDefined();
    expect(tpl!.name).toBe('new-feature');
    expect(tpl!.items.length).toBeGreaterThan(0);
    expect(tpl!.items[0]!.title).toBeDefined();
  });

  it('returns undefined for unknown template', () => {
    const tpl = getPlanTemplate('nonexistent');
    expect(tpl).toBeUndefined();
  });

  it('returns undefined for names inherited from Object.prototype (F1174)', () => {
    // `/plan template use constructor` skipped the "Unknown template" guard and
    // crashed iterating `Object.items`.
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(getPlanTemplate(name)).toBeUndefined();
    }
  });

  it('formatPlanTemplates renders categories', () => {
    const out = formatPlanTemplates();
    expect(out).toContain('new-feature');
    expect(out).toContain('bug-fix');
    expect(out).toContain('development');
  });

  it('each template has valid items', () => {
    for (const tpl of listPlanTemplates()) {
      expect(tpl.name).toBeDefined();
      expect(tpl.description).toBeDefined();
      expect(tpl.category).toBeDefined();
      expect(tpl.items.length).toBeGreaterThan(0);
      for (const item of tpl.items) {
        expect(item.title).toBeDefined();
        expect(item.title.length).toBeGreaterThan(0);
      }
    }
  });
});

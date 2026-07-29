import { describe, expect, it } from 'vitest';
import * as nav from '../../src/components/activity-bar/nav';
import * as viewNavigation from '../../src/lib/view-navigation';

/**
 * `components/activity-bar/nav.ts` exists so navigation helpers are reachable
 * without pulling the 569-line ActivityBar component in as a transitive
 * dependency. These tests pin that contract: the surface must stay complete
 * (nothing silently dropped from the re-export list) and must stay *identical*
 * to the definition site rather than becoming a second implementation.
 */
describe('activity-bar/nav re-export surface', () => {
  const EXPECTED = [
    'ACTIVITY_SHORTCUT_BY_KEY',
    'ACTIVITY_SHORTCUT_LABEL_BY_ACTIVITY',
    'navigateToView',
    'openMainView',
    'openPanel',
    'pairedViewForActivity',
    'shortcutLabelForActivity',
    'showPanel',
  ] as const;

  // Namespace objects are copied into plain records once, so the per-name
  // assertions below index a record rather than the live namespace (biome's
  // noDynamicNamespaceImportAccess).
  const navExports = { ...nav } as Record<string, unknown>;
  const sourceExports = { ...viewNavigation } as Record<string, unknown>;

  it('re-exports exactly the documented helper set', () => {
    expect(Object.keys(navExports).sort()).toEqual([...EXPECTED].sort());
  });

  it.each(EXPECTED)('%s is the same binding as @/lib/view-navigation', (name) => {
    expect(navExports[name]).toBe(sourceExports[name]);
  });

  it('exports callables for the four navigation actions', () => {
    expect(typeof nav.navigateToView).toBe('function');
    expect(typeof nav.openMainView).toBe('function');
    expect(typeof nav.openPanel).toBe('function');
    expect(typeof nav.showPanel).toBe('function');
  });

  it('exports the shortcut lookup tables as objects', () => {
    expect(nav.ACTIVITY_SHORTCUT_BY_KEY).toBeTypeOf('object');
    expect(nav.ACTIVITY_SHORTCUT_LABEL_BY_ACTIVITY).toBeTypeOf('object');
  });

  it('does not leak the ActivityBar component through this module', () => {
    expect(Object.keys(navExports)).not.toContain('ActivityBar');
    expect(Object.keys(navExports)).not.toContain('default');
  });
});

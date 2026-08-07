import { describe, expect, it } from 'vitest';
import { SIDEBAR_TWIN_HEIGHT_BY_PANEL, sumSidebarTwinRowCount } from '../src/sidebar-sizing.js';
import { PANEL_IDS, SIDEBAR_TWIN_MAX_WRAP_LINES } from '../src/ui-contracts.js';

/**
 * `sidebar-sizing.ts` is the canonical scroll-clamp budget table for routed
 * sidebar panels. The shared constants must:
 *
 *   - cover every PanelId (so a new panel cannot silently bypass sizing),
 *   - grow with the shared wrap ceiling, so a future wrap-ceiling change
 *     propagates to every worklist panel,
 *   - expose a summing helper that future routed panels reuse rather than
 *     re-implementing the freeze.
 */
describe('sidebar-sizing shared budgets', () => {
  it('exposes a budget for every PanelId', () => {
    for (const id of PANEL_IDS) {
      expect(SIDEBAR_TWIN_HEIGHT_BY_PANEL[id]).toBeTypeOf('number');
      expect(SIDEBAR_TWIN_HEIGHT_BY_PANEL[id]).toBeGreaterThan(0);
    }
  });

  it('scales worklist budgets by the shared wrap ceiling', () => {
    const worklistIds: Array<keyof typeof SIDEBAR_TWIN_HEIGHT_BY_PANEL> = [
      'todos',
      'plan',
      'queue',
      'goal',
      'kanban',
    ];
    for (const id of worklistIds) {
      expect(SIDEBAR_TWIN_HEIGHT_BY_PANEL[id] % SIDEBAR_TWIN_MAX_WRAP_LINES).toBeGreaterThan(0);
    }
  });

  it('sums budgets across routed panels', () => {
    const total = sumSidebarTwinRowCount(['todos', 'connections']);
    expect(total).toBe(
      SIDEBAR_TWIN_HEIGHT_BY_PANEL.todos + SIDEBAR_TWIN_HEIGHT_BY_PANEL.connections,
    );
  });

  it('returns zero for an empty panel set', () => {
    expect(sumSidebarTwinRowCount([])).toBe(0);
  });
});

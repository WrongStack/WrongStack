import { describe, expect, it } from 'vitest';
import { createPinDraft, togglePin } from '../src/components/activity-bar/activity-bar-pins';

describe('togglePin known-id validation', () => {
  it('ignores unknown panel and view ids', () => {
    const draft = createPinDraft(null, { panels: [], views: [] });
    expect(togglePin(draft, 'panels', 'nonexistent-panel-id')).toBe(draft);
    expect(togglePin(draft, 'views', 'nonexistent-view-id')).toBe(draft);
  });
});

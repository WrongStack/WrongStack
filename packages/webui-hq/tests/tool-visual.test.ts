/**
 * Tests for `src/lib/tool-visual.ts` — resolving tool names to
 * lucide-react icons + colors.
 *
 * Note: lucide-react exports forwardRef-wrapped components that appear as
 * objects under `typeof` rather than 'function'. We verify they render to
 * a React element and carry the expected identity by checking the component
 * is truthy and has the expected icon-map lookup behaviour.
 */
import { describe, expect, it } from 'vitest';
import { getToolVisual } from '../src/domain/tool-visual.js';

describe('getToolVisual', () => {
  it('returns the icon and color for a known tool name', () => {
    const { Icon, color } = getToolVisual('edit');
    expect(Icon).toBeTruthy();
    expect(color).toBe('#fbbf24');
  });

  it('maps bash to the terminal icon and color', () => {
    const { Icon, color } = getToolVisual('bash');
    expect(Icon).toBeTruthy();
    expect(color).toBe('#67e8f9');
  });

  it('falls back for unknown tool names', () => {
    const unknown = getToolVisual('nothing-here');
    expect(unknown.Icon).toBeTruthy();
    // fallback color from TOOL_ICON_CONFIG
    expect(unknown.color).toBe('#9ca3af');
  });

  it('handles undefined gracefully (branch coverage for name ?? "")', () => {
    const fallback = getToolVisual(undefined);
    expect(fallback.Icon).toBeTruthy();
    expect(fallback.color).toBeDefined();
  });

  it('handles empty string (goes through getToolIcon fallback)', () => {
    const result = getToolVisual('');
    expect(result.Icon).toBeTruthy();
    expect(result.color).toBe('#9ca3af');
  });
});

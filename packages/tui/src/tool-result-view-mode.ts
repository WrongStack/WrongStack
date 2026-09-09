export const TOOL_RESULT_VIEW_MODES = ['minimal', 'normal', 'full'] as const;

export type ToolResultViewMode = (typeof TOOL_RESULT_VIEW_MODES)[number];

export const DEFAULT_TOOL_RESULT_VIEW_MODE: ToolResultViewMode = 'normal';

export const TOOL_RESULT_VIEW_MODE_DESCS: Record<ToolResultViewMode, string> = {
  minimal: 'Header only (one line)',
  normal: 'Bounded semantic preview (default)',
  full: 'Expanded result, capped at 40 lines / 16 KiB',
};

export function normalizeToolResultViewMode(value: unknown): ToolResultViewMode {
  return value === 'minimal' || value === 'full' ? value : 'normal';
}

export function shiftToolResultViewMode(
  mode: ToolResultViewMode,
  delta: -1 | 1,
): ToolResultViewMode {
  const index = TOOL_RESULT_VIEW_MODES.indexOf(mode);
  const next = Math.max(0, Math.min(TOOL_RESULT_VIEW_MODES.length - 1, index + delta));
  return TOOL_RESULT_VIEW_MODES[next] ?? DEFAULT_TOOL_RESULT_VIEW_MODE;
}

export function cycleToolResultViewMode(
  mode: ToolResultViewMode,
  delta: number,
): ToolResultViewMode {
  const index = TOOL_RESULT_VIEW_MODES.indexOf(mode);
  const base = index < 0 ? 0 : index;
  return (
    TOOL_RESULT_VIEW_MODES[
      (base + delta + TOOL_RESULT_VIEW_MODES.length) % TOOL_RESULT_VIEW_MODES.length
    ] ?? DEFAULT_TOOL_RESULT_VIEW_MODE
  );
}

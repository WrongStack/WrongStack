import type { ToolResultRenderMode, ToolResultRenderModeConfig } from '../types/config.js';
import type { Tool } from '../types/tool.js';

export const DEFAULT_TOOL_RESULT_RENDER_MODE: ToolResultRenderMode = 'extend';

/**
 * Normalize a raw value to a {@link ToolResultRenderMode}. Accepts the
 * canonical strings (`'extend' | 'simple'`) plus a few synonyms so the
 * slash command feels forgiving (`extended`/`full` → `extend`,
 * `short`/`brief` → `simple`). Returns `undefined` for anything else so
 * the caller can reject unknown input without throwing.
 */
export function normalizeToolResultRenderMode(value: unknown): ToolResultRenderMode | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim().toLowerCase();
  if (raw === 'extend' || raw === 'extended' || raw === 'full') return 'extend';
  if (raw === 'simple' || raw === 'short' || raw === 'brief') return 'simple';
  return undefined;
}

/**
 * Look up the result-render mode for `toolName` from a config map. Falls
 * back to the default `'extend'` when the map is missing the entry.
 */
export function resolveToolResultRenderMode(
  modes: ToolResultRenderModeConfig | undefined,
  toolName: string,
): ToolResultRenderMode {
  return normalizeToolResultRenderMode(modes?.[toolName]) ?? DEFAULT_TOOL_RESULT_RENDER_MODE;
}

/**
 * Subset of {@link import('../registry/tool-registry.js').ToolRegistry}
 * the result-render-mode setters need. Decouples this module from the
 * concrete registry class so it can be reused by tests and by tools
 * that wrap their own registry.
 */
export interface ToolResultRenderModeRegistryLike {
  get(name: string): Tool | undefined;
  setResultRenderMode?(name: string, mode: ToolResultRenderMode): boolean;
  applyResultRenderModes?(modes?: ToolResultRenderModeConfig): {
    applied: number;
    missing: string[];
  };
  getResultRenderMode?(name: string): ToolResultRenderMode;
}

/**
 * Set a single tool's result-render mode on a registry. Prefers the
 * registry's native accessor (so it can update any internal state, e.g.
 * usage caches); falls back to a no-op so callers stay decoupled from
 * the registry implementation.
 */
export function setToolResultRenderMode(
  registry: ToolResultRenderModeRegistryLike,
  name: string,
  mode: ToolResultRenderMode,
): boolean {
  if (typeof registry.setResultRenderMode === 'function') {
    return registry.setResultRenderMode(name, mode);
  }
  return false;
}

/**
 * Look up the current result-render mode for a single tool. Returns the
 * registry's view if it has one, otherwise the default. This is what the
 * tool-executor calls on each tool invocation to decide whether the next
 * `writeToolResult` should be `simple` or `extend`.
 */
export function getToolResultRenderMode(
  registry: ToolResultRenderModeRegistryLike,
  name: string,
): ToolResultRenderMode {
  return registry.getResultRenderMode?.(name) ?? DEFAULT_TOOL_RESULT_RENDER_MODE;
}

/**
 * Bulk-apply a config map (`tools.resultRenderMode`) to a registry.
 * Mirrors {@link import('./tool-description-mode.js').applyToolDescriptionModes}
 * for symmetry with the LLM-side description mode.
 */
export function applyToolResultRenderModes(
  registry: ToolResultRenderModeRegistryLike,
  modes?: ToolResultRenderModeConfig,
): { applied: number; missing: string[] } {
  if (typeof registry.applyResultRenderModes === 'function') {
    return registry.applyResultRenderModes(modes);
  }

  const entries = Object.entries(modes ?? {});
  const missing: string[] = [];
  let applied = 0;
  for (const [name, rawMode] of entries) {
    const mode = normalizeToolResultRenderMode(rawMode);
    if (!mode) continue;
    if (setToolResultRenderMode(registry, name, mode)) applied++;
    else missing.push(name);
  }
  return { applied, missing };
}

import type { ToolDescriptionMode, ToolDescriptionModeConfig } from '../types/config.js';
import type { Tool } from '../types/tool.js';

export const DEFAULT_TOOL_DESCRIPTION_MODE: ToolDescriptionMode = 'extend';

const ORIGINAL_TOOL_DESCRIPTION = Symbol.for('wrongstack.tool.originalDescription');

interface OriginalToolDescription {
  description: string;
  usageHint?: string | undefined;
}

type ToolWithOriginalDescription = Tool & {
  [ORIGINAL_TOOL_DESCRIPTION]?: OriginalToolDescription | undefined;
};

export interface ToolDescriptionRegistryLike {
  get(name: string): Tool | undefined;
  list(): Tool[];
  wrap?(name: string, wrapper: (tool: Tool) => Tool, owner?: string): void;
  setDescriptionMode?(name: string, mode: ToolDescriptionMode): boolean;
  applyDescriptionModes?(modes?: ToolDescriptionModeConfig): { applied: number; missing: string[] };
  getDescriptionMode?(name: string): ToolDescriptionMode;
}

export function normalizeToolDescriptionMode(value: unknown): ToolDescriptionMode | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim().toLowerCase();
  if (raw === 'extend' || raw === 'extended' || raw === 'full') return 'extend';
  if (raw === 'simple' || raw === 'short' || raw === 'brief') return 'simple';
  return undefined;
}

export function resolveToolDescriptionMode(
  modes: ToolDescriptionModeConfig | undefined,
  toolName: string,
): ToolDescriptionMode {
  return normalizeToolDescriptionMode(modes?.[toolName]) ?? DEFAULT_TOOL_DESCRIPTION_MODE;
}

export function simplifyToolDescription(
  text: string,
  opts: { maxSentences?: number | undefined; maxChars?: number | undefined } = {},
): string {
  const maxSentences = Math.max(1, opts.maxSentences ?? 2);
  const maxChars = Math.max(40, opts.maxChars ?? 180);
  const normalized = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (normalized.length <= maxChars) return normalized;

  const sentences = normalized.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [normalized];
  const selected: string[] = [];
  for (const sentence of sentences) {
    selected.push(sentence.trim());
    const candidate = selected.join(' ');
    if (selected.length >= maxSentences || candidate.length >= maxChars) break;
  }

  /* v8 ignore next -- defensive: selected always has ≥1 non-empty sentence so summary is never falsy */
  const summary = selected.join(' ').trim() || normalized;
  if (summary.length <= maxChars) return summary;

  const hardLimit = maxChars - 4;
  const boundary = findWordBoundary(summary, hardLimit);
  /* v8 ignore next -- findWordBoundary always returns >0 (semantic/space/limit floor), so the hardLimit fallback is dead */
  return `${summary.slice(0, boundary > 0 ? boundary : hardLimit).trimEnd()} ...`;
}

export function applyToolDescriptionModeToTool(tool: Tool, mode: ToolDescriptionMode): Tool {
  const existingOriginal = getOriginalDescription(tool);
  if (mode === 'extend' && !existingOriginal) return tool;

  const original = existingOriginal ?? {
    description: tool.description,
    usageHint: tool.usageHint,
  };

  const next =
    mode === 'simple'
      ? withDescription(tool, {
          description: simplifyToolDescription(original.description),
          usageHint:
            original.usageHint === undefined
              ? undefined
              : simplifyToolDescription(original.usageHint),
        })
      : withDescription(tool, original);

  return attachOriginalDescription(next, original);
}

export function setToolDescriptionMode(
  registry: ToolDescriptionRegistryLike,
  name: string,
  mode: ToolDescriptionMode,
): boolean {
  if (typeof registry.setDescriptionMode === 'function') {
    return registry.setDescriptionMode(name, mode);
  }
  if (!registry.get(name) || typeof registry.wrap !== 'function') return false;
  registry.wrap(
    name,
    (tool) => applyToolDescriptionModeToTool(tool, mode),
    'tool-description-mode',
  );
  return true;
}

export function getToolDescriptionMode(
  registry: ToolDescriptionRegistryLike,
  name: string,
): ToolDescriptionMode {
  return registry.getDescriptionMode?.(name) ?? DEFAULT_TOOL_DESCRIPTION_MODE;
}

export function applyToolDescriptionModes(
  registry: ToolDescriptionRegistryLike,
  modes?: ToolDescriptionModeConfig,
): { applied: number; missing: string[] } {
  if (typeof registry.applyDescriptionModes === 'function') {
    return registry.applyDescriptionModes(modes);
  }

  const entries = Object.entries(modes ?? {});
  const missing: string[] = [];
  let applied = 0;
  for (const [name, rawMode] of entries) {
    const mode = normalizeToolDescriptionMode(rawMode);
    if (!mode) continue;
    if (setToolDescriptionMode(registry, name, mode)) applied++;
    else missing.push(name);
  }
  return { applied, missing };
}

function getOriginalDescription(tool: Tool): OriginalToolDescription | undefined {
  return (tool as ToolWithOriginalDescription)[ORIGINAL_TOOL_DESCRIPTION];
}

function attachOriginalDescription(tool: Tool, original: OriginalToolDescription): Tool {
  Object.defineProperty(tool, ORIGINAL_TOOL_DESCRIPTION, {
    configurable: true,
    enumerable: false,
    value: original,
    writable: true,
  });
  return tool;
}

function withDescription(tool: Tool, next: OriginalToolDescription): Tool {
  const copy: Tool = {
    ...tool,
    description: next.description,
    usageHint: next.usageHint,
  };
  if (next.usageHint === undefined) {
    delete (copy as { usageHint?: string | undefined }).usageHint;
  }
  return copy;
}

function findWordBoundary(text: string, limit: number): number {
  const semantic = Math.max(
    text.lastIndexOf('. ', limit),
    text.lastIndexOf('; ', limit),
    text.lastIndexOf(', ', limit),
  );
  if (semantic > 40) return semantic + 1;
  const space = text.lastIndexOf(' ', limit);
  return space > 40 ? space : limit;
}

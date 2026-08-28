import type { ContentBlock, TextBlock } from './blocks.js';
// `ToolResultRenderMode` is defined in config.ts (the canonical config-side
// name). Import it for local use in the interface below AND re-export so
// renderer-only consumers can import a single type without pulling in the
// whole config module. A bare ` from` re-export does NOT
// create a local binding, so the `setResultRenderMode` reference needs this
// explicit import.
import type { ToolResultRenderMode } from './config.js';
export type { ToolResultRenderMode };

export interface Renderer {
  write(text: string | TextBlock): void;
  writeLine(text?: string): void;
  writeBlock(block: ContentBlock): void;
  writeToolCall(name: string, input: unknown): void;
  writeToolResult(name: string, content: unknown, isError: boolean): void;
  writeDiff(unifiedDiff: string): void;
  writeWarning(text: string): void;
  writeError(text: string): void;
  writeInfo(text: string): void;
  clear(): void;
  /**
   * Hint the renderer how to display the next {@link writeToolResult} for
   * `name`. The renderer stores the mode and applies it on the next
   * `writeToolResult` call. A no-op for renderers that do not implement
   * per-tool on-screen rendering (the default).
   */
  setResultRenderMode?(name: string, mode: ToolResultRenderMode): void;
}

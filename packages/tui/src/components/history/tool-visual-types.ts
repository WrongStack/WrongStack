export type ToolVisualLineKind =
  | 'ok'
  | 'warn'
  | 'error'
  | 'meta'
  | 'path'
  | 'match'
  | 'code'
  | 'stdout'
  | 'stderr';

export interface ToolVisualLine {
  kind: ToolVisualLineKind;
  text: string;
  marker?: string | undefined;
  lineNo?: string | undefined;
  path?: string | undefined;
}

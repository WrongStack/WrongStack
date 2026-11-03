import type { ComponentType, ReactNode } from 'react';
import type { CodeMapGraphResponse, CodeMapScope, GraphNodeData } from './codemap-model';

/** What the user is looking at in the atlas, for an "ask about this code" panel. */
export interface CodeAssistTarget {
  filePath: string;
  symbol?: string | undefined;
  line?: number | undefined;
}

/** The atlas as an application's own panels see it. */
export interface AtlasContext {
  scope: CodeMapScope;
  /** The scope's graph, after the relation filter. */
  graph: CodeMapGraphResponse;
  selectedId: string | null;
  /** Selects a node of the current scope. */
  select(id: string): void;
  /** Opens a package's files or a file's symbols; other nodes are selected. */
  open(id: string): void;
}

/** A view an application adds next to the map; it replaces the canvas while it is chosen. */
export interface AtlasView {
  id: string;
  label: string;
  hint?: string | undefined;
  Icon: ComponentType<{ className?: string }>;
  render(context: AtlasContext): ReactNode;
}

/** What an application adds to the shared Code Atlas. Every member is optional. */
export interface AtlasHost {
  /** The panel under the relation inspector that asks an agent about the selected code. */
  CodeAssist?:
    | ComponentType<{ target: CodeAssistTarget | null; className?: string | undefined }>
    | undefined;
  /** Controls at the end of the atlas header (the desktop's index button and tour). */
  HeaderActions?: ComponentType<{ context: AtlasContext }> | undefined;
  /** Views beside the map (the desktop's subsystems, dependency matrix and change impact). */
  views?: readonly AtlasView[] | undefined;
  /** Evidence about the selected node, shown in the relation inspector. */
  NodeExtras?: ComponentType<{ node: GraphNodeData; context: AtlasContext }> | undefined;
}

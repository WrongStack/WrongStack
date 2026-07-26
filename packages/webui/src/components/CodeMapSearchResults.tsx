import type { GraphNodeData } from './codemap-model';
import { NODE_STYLE } from './CodeMapVisuals';
import { cn } from '@/lib/utils';

interface CodeMapSearchResultRowProps {
  node: GraphNodeData;
  onSelect: (node: GraphNodeData) => void;
  virtual?: {
    index: number;
    start: number;
    measureElement: (element: Element | null) => void;
  };
}

export function CodeMapSearchResultRow({
  node,
  onSelect,
  virtual,
}: CodeMapSearchResultRowProps): React.ReactElement {
  const Icon = NODE_STYLE[node.kind].icon;
  return (
    <button
      type="button"
      key={node.id}
      data-index={virtual?.index}
      ref={virtual ? (element) => virtual.measureElement(element) : undefined}
      className={cn(
        'min-h-8 items-center gap-2 px-3 py-1 text-left hover:bg-muted',
        virtual ? 'absolute left-0 flex w-full' : 'flex w-full',
      )}
      style={virtual ? { transform: `translateY(${virtual.start}px)` } : undefined}
      onClick={() => onSelect(node)}
    >
      <Icon
        className={cn(
          'h-3.5 w-3.5 shrink-0',
          node.kind === 'package'
            ? 'text-primary'
            : node.kind === 'file'
              ? 'text-info'
              : 'text-success',
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[10px]">{node.label}</span>
        <span className="block truncate text-[8px] text-muted-foreground">
          {node.file ?? node.package ?? node.symbolKind}
        </span>
      </span>
      <span className="text-[8px] uppercase text-muted-foreground">{node.kind.slice(0, 3)}</span>
    </button>
  );
}

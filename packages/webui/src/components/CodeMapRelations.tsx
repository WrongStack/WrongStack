import { ChevronDown, ChevronRight, GitBranch } from 'lucide-react';
import type { CodeMapGraphResponse, GraphNodeData, RelationItem } from './codemap-model';
import { relationItems } from './codemap-model';

interface RelationSectionProps {
  title: string;
  subtitle: string;
  items: RelationItem[];
  graph: CodeMapGraphResponse;
  selectedId: string;
  expanded: Set<string>;
  onToggle: (key: string) => void;
  onSelect: (node: GraphNodeData) => void;
}

export function RelationSection(props: RelationSectionProps): React.ReactElement {
  const { title, subtitle, items, graph, selectedId, expanded, onToggle, onSelect } = props;
  return (
    <section className="border-b py-3">
      <div className="mb-2 flex items-end justify-between px-3">
        <div>
          <h3 className="text-[10px] font-bold uppercase tracking-[0.16em]">{title}</h3>
          <p className="mt-0.5 text-[9px] text-muted-foreground">{subtitle}</p>
        </div>
        <span className="border bg-muted px-1.5 py-0.5 font-mono text-[9px]">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className="px-3 py-2 text-[10px] text-muted-foreground">
          No relationships in this view.
        </p>
      ) : (
        items.map((item) => {
          const key = `${title}:${item.node.id}`;
          const isExpanded = expanded.has(key);
          const nested = [
            ...relationItems(graph, item.node.id, 'incoming'),
            ...relationItems(graph, item.node.id, 'outgoing'),
          ]
            .filter(
              (relation, index, all) =>
                relation.node.id !== selectedId &&
                all.findIndex((candidate) => candidate.node.id === relation.node.id) === index,
            )
            .slice(0, 8);
          return (
            <div key={key}>
              <div className="group flex min-h-9 items-center gap-1 px-2 hover:bg-muted/70">
                <button
                  type="button"
                  className="flex h-6 w-5 shrink-0 items-center justify-center text-muted-foreground"
                  onClick={() => nested.length > 0 && onToggle(key)}
                  aria-label={`${isExpanded ? 'Collapse' : 'Expand'} relation ${item.node.label}`}
                >
                  {nested.length > 0 ? (
                    isExpanded ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )
                  ) : (
                    <span className="h-px w-2 bg-border" />
                  )}
                </button>
                <button
                  type="button"
                  className="min-w-0 flex-1 py-1 text-left"
                  onClick={() => onSelect(item.node)}
                >
                  <span
                    className="block truncate font-mono text-[10px] font-semibold"
                    title={item.node.label}
                  >
                    {item.node.label}
                  </span>
                  <span className="block truncate text-[9px] text-muted-foreground">
                    {item.node.package ?? item.node.symbolKind ?? item.node.kind}
                  </span>
                </button>
                <span className="border px-1 py-0.5 font-mono text-[8px] text-muted-foreground">
                  {item.edge.refType}
                </span>
                <span className="w-5 text-right font-mono text-[9px] text-muted-foreground">
                  ×{item.edge.weight}
                </span>
              </div>
              {isExpanded &&
                nested.map((relation) => (
                  <button
                    type="button"
                    key={`${key}:${relation.node.id}`}
                    className="relative flex h-7 w-full items-center gap-2 border-l border-border pl-11 pr-3 text-left text-[9px] text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={() => onSelect(relation.node)}
                  >
                    <span className="absolute left-7 top-1/2 h-px w-3 bg-border" />
                    <GitBranch className="h-3 w-3 shrink-0" />
                    <span className="truncate font-mono">{relation.node.label}</span>
                    <span className="ml-auto font-mono opacity-70">{relation.edge.refType}</span>
                  </button>
                ))}
            </div>
          );
        })
      )}
    </section>
  );
}

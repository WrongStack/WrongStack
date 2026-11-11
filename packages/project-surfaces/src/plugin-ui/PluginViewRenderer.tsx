import type {
  PluginStatusChipSpec,
  PluginUiTone,
  PluginViewNode,
} from '@wrongstack/contracts/types/plugin';
import type React from 'react';

function toneTextClass(tone?: PluginUiTone): string {
  switch (tone) {
    case 'info':
      return 'text-sky-600 dark:text-sky-400';
    case 'accent':
      return 'text-primary';
    case 'success':
      return 'text-emerald-600 dark:text-emerald-400';
    case 'warning':
      return 'text-amber-600 dark:text-amber-400';
    case 'danger':
      return 'text-destructive';
    case 'neutral':
      return 'text-muted-foreground';
    default:
      return 'text-foreground';
  }
}

function toneBadgeClass(tone?: PluginUiTone): string {
  switch (tone) {
    case 'info':
      return 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300';
    case 'accent':
      return 'border-primary/30 bg-primary/10 text-primary';
    case 'success':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
    case 'warning':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300';
    case 'danger':
      return 'border-destructive/30 bg-destructive/10 text-destructive';
    default:
      return 'border-border/70 bg-muted/40 text-muted-foreground';
  }
}

export interface PluginViewNodeRendererProps {
  node: PluginViewNode;
  depth?: number | undefined;
}

export function PluginViewNodeRenderer({
  node,
  depth = 0,
}: PluginViewNodeRendererProps): React.ReactElement {
  if (depth > 8) {
    return <span className="text-xs text-muted-foreground">[view depth limit exceeded]</span>;
  }

  switch (node.kind) {
    case 'text':
      return (
        <p
          className={[
            'text-xs leading-relaxed break-words',
            node.dim ? 'text-muted-foreground' : toneTextClass(node.tone),
            node.bold ? 'font-semibold' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {node.text}
        </p>
      );

    case 'kv':
      return (
        <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 gap-y-1.5 text-xs">
          {node.items.map((item, idx) => (
            <div key={`${item.label}-${idx}`} className="contents">
              <dt className="font-medium text-muted-foreground truncate">{item.label}</dt>
              <dd className={`font-mono break-words ${toneTextClass(item.tone)}`}>{item.value}</dd>
            </div>
          ))}
        </dl>
      );

    case 'table': {
      const rows = node.rows.slice(0, node.maxRows ?? 50);
      return (
        <div className="overflow-x-auto rounded-md border border-border/70">
          <table className="w-full border-collapse text-left text-xs">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                {node.columns.map((col, idx) => (
                  <th
                    key={`${col}-${idx}`}
                    className="border-b border-border/70 px-2.5 py-1.5 font-semibold"
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIdx) => (
                <tr key={rowIdx} className="border-b border-border/40 last:border-b-0">
                  {node.columns.map((_, colIdx) => (
                    <td key={colIdx} className="px-2.5 py-1.5 font-mono">
                      {row[colIdx] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    case 'badges':
      return (
        <div className="flex flex-wrap gap-1.5">
          {node.badges.map((b, idx) => (
            <span
              key={`${b.label}-${idx}`}
              className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium ${toneBadgeClass(b.tone)}`}
            >
              {b.label}
            </span>
          ))}
        </div>
      );

    case 'progress': {
      const ratio =
        node.total > 0 && Number.isFinite(node.current)
          ? Math.max(0, Math.min(1, node.current / node.total))
          : 0;
      const pct = Math.round(ratio * 100);
      return (
        <div className="space-y-1 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{node.label}</span>
            <span className="font-mono text-muted-foreground tabular-nums">
              {pct}% ({node.current}/{node.total})
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted/60">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      );
    }

    case 'code': {
      const lines = node.content.split('\n').slice(0, node.maxLines ?? 120);
      return (
        <div className="rounded-md border border-border/70 bg-muted/30">
          {node.language ? (
            <div className="border-b border-border/50 px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
              {node.language}
            </div>
          ) : null}
          <pre className="overflow-x-auto p-2.5 font-mono text-[11px] leading-relaxed">
            <code>{lines.join('\n')}</code>
          </pre>
        </div>
      );
    }

    case 'markdown':
      return (
        <div className="whitespace-pre-wrap text-xs leading-relaxed text-foreground">
          {node.content}
        </div>
      );

    case 'log':
      return (
        <div className="max-h-60 overflow-y-auto rounded-md border border-border/70 bg-muted/25 p-2 font-mono text-[11px] space-y-0.5">
          {node.lines.map((line, idx) => (
            <div key={idx} className="flex gap-2 break-words">
              {line.ts ? <span className="shrink-0 text-muted-foreground">{line.ts}</span> : null}
              <span className={toneTextClass(line.level)}>{line.text}</span>
            </div>
          ))}
        </div>
      );

    case 'stack': {
      const isRow = node.direction === 'horizontal';
      const gapClass =
        node.gap === 0 ? 'gap-0' : node.gap === 1 ? 'gap-1.5' : node.gap === 3 ? 'gap-3' : 'gap-2';
      return (
        <div
          className={[
            'flex',
            isRow ? 'flex-row flex-wrap items-center' : 'flex-col',
            gapClass,
          ].join(' ')}
        >
          {node.children.map((child, idx) => (
            <PluginViewNodeRenderer key={idx} node={child} depth={depth + 1} />
          ))}
        </div>
      );
    }
  }
}

export interface PluginStatusChipItem extends PluginStatusChipSpec {
  qualifiedId: string;
  owner: string;
}

export interface PluginStatusChipsBarProps {
  chips: readonly PluginStatusChipItem[];
  maxVisible?: number | undefined;
  onSelectChip?: ((chip: PluginStatusChipItem) => void) | undefined;
}

export function PluginStatusChipsBar({
  chips,
  maxVisible = 4,
  onSelectChip,
}: PluginStatusChipsBarProps): React.ReactElement | null {
  if (chips.length === 0) return null;
  const visible = chips.slice(0, maxVisible);
  const overflow = Math.max(0, chips.length - visible.length);

  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="plugin-status-chips-bar">
      {visible.map((chip) => {
        const label = `${chip.icon ? `${chip.icon} ` : ''}${chip.text}`;
        return (
          <button
            key={chip.qualifiedId}
            type="button"
            onClick={() => onSelectChip?.(chip)}
            title={chip.tooltip ?? `${chip.owner}: ${chip.text}`}
            className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium transition-opacity hover:opacity-85 ${toneBadgeClass(chip.tone)}`}
          >
            <span className="truncate max-w-[12rem]">{label}</span>
          </button>
        );
      })}
      {overflow > 0 ? (
        <span className="rounded border border-border/70 bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground tabular-nums">
          +{overflow}
        </span>
      ) : null}
    </div>
  );
}

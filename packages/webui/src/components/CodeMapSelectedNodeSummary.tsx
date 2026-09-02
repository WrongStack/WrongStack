import { Activity as ActivityIcon, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type GraphNodeData, relativeFilePath } from './codemap-model';
import { NODE_STYLE } from './CodeMapVisuals';
import { useAppTranslation } from '@/i18n';

type CodeMapSelectedNodeSummaryProps = {
  node: GraphNodeData;
  incomingCount: number;
  outgoingCount: number;
  onOpenNode: (node: GraphNodeData) => void;
  onOpenActivity: (filePath: string) => void;
};

export function CodeMapSelectedNodeSummary({
  node,
  incomingCount,
  outgoingCount,
  onOpenNode,
  onOpenActivity,
}: CodeMapSelectedNodeSummaryProps) {
  const { t } = useAppTranslation();
  const Icon = NODE_STYLE[node.kind].icon;
  return (
    <div className="border-b bg-muted/25 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span
          className={cn(
            'flex h-8 w-8 items-center justify-center border',
            NODE_STYLE[node.kind].iconStyle,
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[8px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
            {node.external ? 'external ' : ''}
            {node.kind}
          </div>
          <div className="truncate font-mono text-xs font-semibold" title={node.label}>
            {node.label}
          </div>
        </div>
      </div>
      <div className="break-all font-mono text-[9px] leading-relaxed text-muted-foreground">
        {node.file ? relativeFilePath(node) : node.package}
      </div>
      {node.signature && (
        <pre className="mt-3 overflow-x-auto border bg-background p-2 font-mono text-[9px] leading-relaxed text-foreground">
          {node.signature}
        </pre>
      )}
      <div className="mt-3 grid grid-cols-3 border">
        <Metric
          value={incomingCount}
          label={t('activity:codeMap.incoming')}
          className="border-r text-info"
        />
        <Metric
          value={outgoingCount}
          label={t('activity:codeMap.outgoing')}
          className="border-r text-primary"
        />
        <Metric
          value={node.symbolCount ?? node.fileCount ?? node.line ?? '—'}
          label={node.kind === 'package' ? 'files' : node.kind === 'file' ? 'symbols' : 'line'}
        />
      </div>
      <div className="mt-2 flex gap-2">
        {node.kind !== 'symbol' && (
          <button
            type="button"
            className="flex h-7 flex-1 items-center justify-center gap-1.5 border bg-foreground text-[9px] font-semibold uppercase tracking-wider text-background hover:opacity-90"
            onClick={() => onOpenNode(node)}
          >
            <ExternalLink className="h-3 w-3" /> Open{' '}
            {node.kind === 'package' ? 'files' : 'symbols'}
          </button>
        )}
        {node.file && (
          <button
            type="button"
            className="flex h-7 items-center justify-center gap-1.5 border px-2 text-[9px] uppercase text-muted-foreground hover:bg-muted"
            onClick={() => onOpenActivity(node.file!)}
          >
            <ActivityIcon className="h-3 w-3" /> {t('activity:codeMap.activity')}
          </button>
        )}
      </div>
    </div>
  );
}

function Metric({
  value,
  label,
  className,
}: {
  value: string | number;
  label: string;
  className?: string | undefined;
}) {
  return (
    <div className={cn('p-2 text-center', className)}>
      <div className="font-mono text-sm font-semibold">{value}</div>
      <div className="text-[8px] uppercase text-muted-foreground">{label}</div>
    </div>
  );
}

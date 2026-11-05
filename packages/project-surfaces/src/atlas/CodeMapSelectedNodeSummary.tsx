import { Activity as ActivityIcon, ExternalLink } from 'lucide-react';
import { useAppTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';
import { NODE_STYLE } from './CodeMapVisuals';
import { type GraphNodeData, relativeFilePath } from './codemap-model';

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
      {node.subsystem && (
        <div className="mt-2 inline-flex items-center gap-1 border border-border px-1.5 py-0.5 text-[8px] uppercase tracking-wider text-muted-foreground">
          {node.subsystem}
        </div>
      )}
      {node.concept && (
        <p className="mt-2 text-[11px] leading-relaxed text-foreground">{node.concept}</p>
      )}
      {node.crux && (
        // The summary is a model's paraphrase and can drift from the code; the
        // span it was drawn from cannot. Naming the lines lets the reader check.
        <div className="mt-1 font-mono text-[9px] text-muted-foreground">
          {t('activity:codeMap.crux')} L{node.crux.start}–L{node.crux.end}
        </div>
      )}
      {node.signature && (
        <pre className="mt-3 overflow-x-auto border bg-background p-2 font-mono text-[9px] leading-relaxed text-foreground">
          {node.signature}
        </pre>
      )}
      {(node.isFragile || node.lockOwner || (node.thrashingCount ?? 0) > 0) && (
        <div className="mt-3 space-y-1 border border-destructive/40 bg-destructive/5 p-2">
          <div className="font-mono text-[8px] font-bold uppercase tracking-wider text-destructive">
            {t('activity:codeMapText.telemetryAlert')}
          </div>
          {node.isFragile && (
            <div className="text-[10px] leading-snug text-foreground">
              <span className="font-mono font-semibold text-destructive">[FRAGILE]</span>{' '}
              {t('activity:codeMapText.healthScore', {
                score: node.healthScore ?? t('activity:codeMapText.scoreLow'),
              })}
              {node.thrashingCount
                ? ` · ${t('activity:codeMapText.thrashing', { count: node.thrashingCount })}`
                : ''}
            </div>
          )}
          {node.lockOwner && (
            <div className="text-[10px] leading-snug text-foreground">
              <span className="font-mono font-semibold text-warning">[LOCKED]</span>{' '}
              {t('activity:codeMapText.heldBy', { owner: node.lockOwner })}
            </div>
          )}
        </div>
      )}
      {node.memories && node.memories.length > 0 && (
        <div className="mt-3 space-y-1 border border-success/40 bg-success/5 p-2">
          <div className="font-mono text-[8px] font-bold uppercase tracking-wider text-success">
            {t('activity:codeMapText.sageMemories', { count: node.memories.length })}
          </div>
          {node.memories.map((mem) => (
            <div key={mem.id} className="text-[10px] leading-snug text-foreground">
              <span className="font-mono font-semibold uppercase text-success">[{mem.kind}]</span>{' '}
              {mem.text}
            </div>
          ))}
        </div>
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
      <div className="mt-2 grid grid-cols-1 border">
        <Metric
          value={node.rank === undefined ? '—' : `${Math.round(node.rank * 100)}%`}
          label={t('activity:codeMap.centralityLabel')}
        />
      </div>
      <div className="mt-2 flex gap-2">
        {node.kind !== 'symbol' && (
          <button
            type="button"
            className="flex h-7 flex-1 items-center justify-center gap-1.5 border bg-foreground text-[9px] font-semibold uppercase tracking-wider text-background hover:opacity-90"
            onClick={() => onOpenNode(node)}
          >
            <ExternalLink className="h-3 w-3" />{' '}
            {node.kind === 'package'
              ? t('activity:codeMapText.openFiles')
              : t('activity:codeMapText.openSymbols')}
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

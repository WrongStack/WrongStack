import { useAppTranslation } from '@/i18n';
import type { LucideIcon } from 'lucide-react';
import {
  Archive,
  ArrowLeft,
  BookMarked,
  BrainCircuit,
  ChevronRight,
  CircleDot,
  Clipboard,
  FileCode2,
  GitBranch,
  Network,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Tag,
  TerminalSquare,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { SageEntry, SageGraphEdge } from '@/types';
import { MemoryGraph } from './MemoryGraph';
import {
  formatAudienceText,
  formatDate,
  KIND_LABELS,
  kindClasses,
  memoryPreview,
  StatusBadge,
} from './shared';

interface MemoryDetailProps {
  memory: SageEntry;
  allMemories: SageEntry[];
  relatedMemories: Array<{ relation: string; id: string }>;
  graphEdges: SageGraphEdge[];
  graphLoading: boolean;
  graphError: string | null;
  onClose: () => void;
  onOpenMemory: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: () => void;
  onTagSelect: (tag: string) => void;
  onNotice: (message: string) => void;
}

export function MemoryDetail({
  memory,
  allMemories,
  relatedMemories,
  graphEdges,
  graphLoading,
  graphError,
  onClose,
  onOpenMemory,
  onEdit,
  onDelete,
  onTagSelect,
  onNotice,
}: MemoryDetailProps) {
  const { t } = useAppTranslation();
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-border/70 bg-card/65 px-4 py-3 backdrop-blur-xl">
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          onClick={onClose}
          aria-label={t('activity:memoryManager.backToList')}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <span
          className={cn(
            'text-[10px] font-bold uppercase tracking-[0.14em]',
            kindClasses(memory.kind),
          )}
        >
          {KIND_LABELS[memory.kind] ?? memory.kind}
        </span>
        <StatusBadge status={memory.status} />
        <span className="border border-border/70 px-2 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">
          {memory.scope}
        </span>
        {memory.audience && (
          <span
            className="flex items-center gap-1 border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[9px] text-primary"
            title={formatAudienceText(memory.audience)}
          >
            <BrainCircuit className="size-3" />
            {formatAudienceText(memory.audience)}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('activity:memoryManager.copyId')}
            title={t('activity:memoryManager.copyId')}
            onClick={() => {
              void navigator.clipboard?.writeText(memory.id);
              onNotice(t('activity:memoryManager.copiedNotice'));
            }}
          >
            <Clipboard className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onEdit(memory.id)}
            disabled={memory.status === 'deleted'}
          >
            <Pencil className="size-3.5" /> {t('common:action.edit')}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={onDelete}
            disabled={memory.status === 'deleted'}
          >
            <Trash2 className="size-3.5" /> {t('common:action.delete')}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 md:p-5">
        <div className="mx-auto max-w-5xl space-y-5">
          <MemoryBody memory={memory} />
          <MemoryScoreRow memory={memory} />
          {memory.tags.length > 0 && <MemoryTags tags={memory.tags} onTagSelect={onTagSelect} />}
          {memory.anchors.length > 0 && <MemoryAnchors anchors={memory.anchors} />}
          {relatedMemories.length > 0 && (
            <MemoryRelationships
              relatedMemories={relatedMemories}
              allMemories={allMemories}
              onOpenMemory={onOpenMemory}
            />
          )}
          <MemoryGraph
            centerMemory={memory}
            allMemories={allMemories}
            graphEdges={graphEdges}
            loading={graphLoading}
            error={graphError}
          />
          <MemoryMeta memory={memory} />
          {memory.status === 'deleted' && (
            <DeletedMemoryNotice contextPolicy={memory.contextPolicy} />
          )}
        </div>
      </div>
    </>
  );
}

function MemoryBody({ memory }: { memory: SageEntry }) {
  const { t } = useAppTranslation();
  return (
    <div className="relative overflow-hidden border border-border/75 bg-card/55 p-5 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.04)]">
      <div className="pointer-events-none absolute -right-10 -top-10 size-36 bg-[radial-gradient(circle,hsl(var(--info)/0.13),transparent_68%)]" />
      <p className="relative whitespace-pre-wrap text-sm leading-7 text-foreground md:text-[15px]">
        {memory.text}
      </p>
      {memory.summary && (
        <p className="relative mt-4 border-l-2 border-info/50 pl-3 text-xs italic leading-5 text-muted-foreground">
          {memory.summary}
        </p>
      )}
      <div className="relative mt-5 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
        <code className="min-w-0 break-all font-mono text-[10px] text-muted-foreground">
          {memory.id}
        </code>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {t('activity:memoryManager.revisionSuffix', { n: memory.revision })}
        </span>
      </div>
    </div>
  );
}

function MemoryScoreRow({ memory }: { memory: SageEntry }) {
  const { t } = useAppTranslation();
  const scores: Array<[string, number, LucideIcon]> = [
    [t('activity:memoryManager.editorImportance'), memory.importance, ShieldCheck],
    [t('activity:memoryManager.editorConfidence'), memory.confidence, CircleDot],
    [t('activity:memoryManager.editorFreshness'), memory.freshness, RefreshCw],
  ];
  return (
    <div className="grid gap-px bg-border/60 sm:grid-cols-3">
      {scores.map(([label, value, Icon]) => {
        const MetricIcon = Icon;
        return (
          <div key={label} className="bg-card/60 p-3">
            <div className="flex items-center gap-2">
              <MetricIcon className="size-3.5 text-info" />
              <span className="text-[10px] font-bold uppercase tracking-[0.13em] text-muted-foreground">
                {label}
              </span>
              <span className="ml-auto font-mono text-xs font-bold tabular-nums">
                {Math.round(value * 100)}%
              </span>
            </div>
            <div className="mt-2 h-1 bg-muted">
              <div
                className="h-full bg-info shadow-[0_0_8px_hsl(var(--info)/0.45)]"
                style={{ width: `${Math.round(value * 100)}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MemoryTags({ tags, onTagSelect }: { tags: string[]; onTagSelect: (tag: string) => void }) {
  const { t } = useAppTranslation();
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
        <Tag className="size-3.5 text-info" /> {t('activity:memoryManager.tagsLabel')}
      </h3>
      <div className="flex flex-wrap gap-1.5">
        {tags.map((tagName) => (
          <button
            key={tagName}
            type="button"
            onClick={() => onTagSelect(tagName)}
            className="border border-info/25 bg-info/5 px-2 py-1 font-mono text-[10px] text-info hover:border-info/55 hover:bg-info/10"
          >
            #{tagName}
          </button>
        ))}
      </div>
    </section>
  );
}

function MemoryAnchors({ anchors }: { anchors: SageEntry['anchors'] }) {
  const { t } = useAppTranslation();
  return (
    <section className="border border-border/75 bg-card/40">
      <div className="flex items-center justify-between border-b border-border/65 px-3 py-2.5">
        <h3 className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
          <FileCode2 className="size-3.5 text-info" /> {t('activity:memoryManager.editorAnchors')}
        </h3>
        <span className="font-mono text-[10px] text-muted-foreground">{anchors.length}</span>
      </div>
      <ul className="divide-y divide-border/55">
        {anchors.map((anchor, index) => (
          <li
            key={`${anchor.type}:${anchor.path ?? anchor.command ?? anchor.symbol ?? anchor.role}:${index}`}
            className="flex min-w-0 items-start gap-3 px-3 py-2.5"
          >
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center border border-info/25 bg-info/5 text-info">
              {anchor.type === 'command' ? (
                <TerminalSquare className="size-3.5" />
              ) : (
                <FileCode2 className="size-3.5" />
              )}
            </span>
            <div className="min-w-0">
              <p className="text-[9px] font-bold uppercase text-muted-foreground">{anchor.type}</p>
              <p className="mt-0.5 break-all font-mono text-[10px] leading-4 text-foreground/85">
                {anchor.path ?? anchor.command ?? anchor.role ?? '—'}
                {anchor.symbol ? `#${anchor.symbol}` : ''}
              </p>
            </div>
            {(anchor.lineStart || anchor.lineEnd) && (
              <span className="ml-auto shrink-0 font-mono text-[9px] text-muted-foreground">
                L{anchor.lineStart ?? '?'}–{anchor.lineEnd ?? '?'}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function MemoryRelationships({
  relatedMemories,
  allMemories,
  onOpenMemory,
}: {
  relatedMemories: Array<{ relation: string; id: string }>;
  allMemories: SageEntry[];
  onOpenMemory: (id: string) => void;
}) {
  const { t } = useAppTranslation();
  return (
    <section className="border border-border/75 bg-card/40">
      <div className="flex items-center justify-between border-b border-border/65 px-3 py-2.5">
        <h3 className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
          <GitBranch className="size-3.5 text-info" />{' '}
          {t('activity:memoryManager.memoryRelationships')}
        </h3>
        <span className="font-mono text-[10px] text-muted-foreground">
          {relatedMemories.length}
        </span>
      </div>
      <ul className="divide-y divide-border/55">
        {relatedMemories.map((relationship) => {
          const target = allMemories.find((mem) => mem.id === relationship.id);
          return (
            <li key={`${relationship.relation}:${relationship.id}`}>
              <button
                type="button"
                disabled={!target}
                onClick={() => target && onOpenMemory(target.id)}
                className="group flex w-full min-w-0 items-center gap-3 px-3 py-2.5 text-left hover:bg-info/5 disabled:cursor-not-allowed disabled:opacity-55"
              >
                <span
                  className={cn(
                    'w-24 shrink-0 text-[9px] font-bold uppercase',
                    relationship.relation === 'Contradicts' ? 'text-destructive' : 'text-info',
                  )}
                >
                  {relationship.relation}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs">
                  {target
                    ? memoryPreview(target.text, 95)
                    : t('activity:memoryManager.referencedUnavailable')}
                </span>
                <code className="hidden max-w-32 truncate font-mono text-[9px] text-muted-foreground sm:block">
                  {relationship.id}
                </code>
                {target && (
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground group-hover:text-info" />
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function MemoryMeta({ memory }: { memory: SageEntry }) {
  const { t } = useAppTranslation();
  const rows: Array<[string, string, LucideIcon]> = [
    [t('activity:memoryManager.metaCreated'), formatDate(memory.createdAt), BookMarked],
    [t('activity:memoryManager.metaUpdated'), formatDate(memory.updatedAt), RefreshCw],
    [t('activity:memoryManager.metaLastAccessed'), formatDate(memory.lastAccessedAt), Network],
    [t('activity:memoryManager.metaLastVerified'), formatDate(memory.lastVerifiedAt), ShieldCheck],
  ];
  return (
    <section className="grid gap-px bg-border/60 sm:grid-cols-2 lg:grid-cols-4">
      {rows.map(([label, value, Icon]) => {
        const MetaIcon = Icon;
        return (
          <div key={label} className="bg-card/50 p-3">
            <MetaIcon className="size-3.5 text-muted-foreground" />
            <p className="mt-2 text-[9px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
              {label}
            </p>
            <p className="mt-1 text-[10px] leading-4 text-foreground/85">{value}</p>
          </div>
        );
      })}
    </section>
  );
}

function DeletedMemoryNotice({ contextPolicy }: { contextPolicy?: 'eligible' | 'never' }) {
  const { t } = useAppTranslation();
  return (
    <div className="flex items-start gap-3 border border-border bg-muted/50 p-4 text-xs text-muted-foreground">
      <Archive className="mt-0.5 size-4 shrink-0" />
      <div>
        <p className="font-bold text-foreground">{t('activity:memoryManager.deletedMemory')}</p>
        <p className="mt-1 leading-5">
          {contextPolicy === 'never'
            ? t('activity:memoryManager.deletedNeverPolicy')
            : t('activity:memoryManager.deletedEligiblePolicy')}
        </p>
      </div>
    </div>
  );
}

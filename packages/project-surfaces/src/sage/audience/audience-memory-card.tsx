import { Plus, ShieldOff, Tag, Trash2 } from 'lucide-react';
import { useAppTranslation } from '../../lib/i18n';
import { Button } from '../../ui/button';
import type { SageEntry } from '../model-types';
import { KIND_LABELS, memoryPreview } from '../shared';

export type MemoryAudience = NonNullable<SageEntry['audience']>;

export function AudienceStat({ value, label }: { value: number; label: string }) {
  return (
    <div className="bg-card/95 px-1.5 py-2 text-center">
      <p className="text-sm font-semibold tabular-nums">{value}</p>
      <p className="truncate text-[9px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}

export function AudienceMemoryCard({
  memory,
  onFilter,
  onClearScope,
  onDelete,
}: {
  memory: SageEntry;
  onFilter: (value: string) => void;
  onClearScope: () => void;
  onDelete: () => void;
}) {
  const { t } = useAppTranslation();
  return (
    <li className="group rounded-md border border-border/65 bg-card/55 p-2.5 transition-colors hover:border-border hover:bg-card/85">
      <p className="break-words text-xs leading-5">{memory.text}</p>
      {memory.audience && <AudienceBadges audience={memory.audience} onFilter={onFilter} />}
      <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/45 pt-2">
        <div className="flex min-w-0 items-center gap-1.5 text-[9px] uppercase tracking-wide text-muted-foreground">
          <span className="truncate">{KIND_LABELS[memory.kind] ?? memory.kind}</span>
          <span aria-hidden="true">·</span>
          <span>{memory.status}</span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={onClearScope}
            aria-label={t('activity:sageText.removeScope', {
              memory: memoryPreview(memory.text, 42),
            })}
            title={t('activity:audienceMem.makeGeneralMemory')}
          >
            <ShieldOff className="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-destructive hover:text-destructive"
            onClick={onDelete}
            aria-label={t('activity:sageText.deleteNamed', {
              memory: memoryPreview(memory.text, 42),
            })}
            title={t('activity:audienceMem.delete')}
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      </div>
    </li>
  );
}

export function AudienceBadges({
  audience,
  onFilter,
}: {
  audience: MemoryAudience;
  onFilter: (value: string) => void;
}) {
  const { t } = useAppTranslation();
  const badges = [
    ...(audience.roles ?? []).map((value) => ({ label: 'role', value })),
    ...(audience.taskTypes ?? []).map((value) => ({ label: 'task', value })),
    ...(audience.modes ?? []).map((value) => ({ label: 'mode', value })),
  ];
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {badges.map(({ label, value }) => (
        <button
          key={`${label}:${value}`}
          type="button"
          className="max-w-full truncate rounded border border-primary/15 bg-primary/7 px-1.5 py-0.5 font-mono text-[9px] text-foreground transition-colors hover:border-primary/35 hover:bg-primary/12"
          onClick={() => onFilter(value)}
          title={t('activity:sageText.filterBy', { label, value })}
        >
          {label}:{value}
        </button>
      ))}
    </div>
  );
}

export function AudienceMemorySkeleton() {
  const { t } = useAppTranslation();
  return (
    <div
      className="space-y-2 pt-3"
      role="status"
      aria-label={t('activity:audienceMem.loadingAudienceMemories')}
    >
      {[0, 1, 2].map((item) => (
        <div key={item} className="animate-pulse rounded-md border border-border/50 p-3">
          <div className="h-2.5 w-full rounded bg-muted" />
          <div className="mt-2 h-2.5 w-2/3 rounded bg-muted" />
          <div className="mt-3 h-4 w-24 rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

export function EmptyAudienceMemory({ onAdd }: { onAdd: () => void }) {
  const { t } = useAppTranslation();
  return (
    <div className="flex h-full min-h-44 flex-col items-center justify-center px-5 text-center">
      <span className="mb-3 flex size-10 items-center justify-center rounded-full border border-dashed border-primary/35 bg-primary/5 text-primary">
        <Tag className="size-4" />
      </span>
      <p className="text-xs font-medium">{t('activity:audienceMem.emptyTitle')}</p>
      <p className="mt-1 max-w-52 text-[10px] leading-4 text-muted-foreground">
        {t('activity:audienceMem.emptyBody')}
      </p>
      <Button variant="outline" size="sm" className="mt-3 h-7 gap-1 text-xs" onClick={onAdd}>
        <Plus className="size-3" />
        {t('activity:audienceMem.addScoped')}
      </Button>
    </div>
  );
}

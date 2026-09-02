/**
 * DesignStudioPanel — visual browser for curated UI design kits.
 *
 * Lists every bundled/project/user kit with light + dark token swatches and a
 * "Use" button that pins the kit on the live agent (via the `design.use` WS
 * message), so the model adheres to it on the next turn. Mirrors SkillsList's
 * WS pattern (client.on / client.send / client.off).
 *
 * Every frame names its tab. The kit lives on `meta.designStudio`, which
 * shapes THAT session's system prompt — an untagged `design.use` from a
 * background tab restyled whichever session the runtime was pointing at, and
 * an untagged `design.list` showed this tab another tab's active kit. The
 * gallery view (`DesignGalleryView`) has stamped since the four-tab work;
 * this second surface had not.
 */

import { Check, LayoutGrid, Loader2, Palette } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { usePagination } from '@/hooks/usePagination';
import { cn } from '@/lib/utils';
import { useActiveSessionId } from '@/stores';
import { useAppTranslation } from '@/i18n';
import { showPanel } from '@/lib/view-navigation';
import { Pagination } from '@/components/ui/pagination';

interface KitSummary {
  id: string;
  name: string;
  aesthetic: string;
  bestFor: string;
  stacks: string[];
  tags: string[];
  light: Record<string, string>;
  dark: Record<string, string>;
}

const STACKS = ['web', 'react-native', 'flutter', 'swiftui', 'compose'] as const;
const SWATCH_KEYS = ['bg', 'surface', 'primary', 'accent', 'fg', 'border'];

function Swatches({ tokens, label }: { tokens: Record<string, string>; label: string }) {
  const keys = SWATCH_KEYS.filter((k) => tokens[k]);
  if (keys.length === 0) return null;
  return (
    <div className="flex items-center gap-1">
      <span className="text-[9px] uppercase tracking-wide text-muted-foreground w-7">{label}</span>
      <div className="flex gap-0.5">
        {keys.map((k) => (
          <div
            key={k}
            className="w-4 h-4 rounded-sm border border-black/10 dark:border-white/10"
            style={{ backgroundColor: tokens[k] }}
            title={`${k}: ${tokens[k]}`}
          />
        ))}
      </div>
    </div>
  );
}

export function DesignStudioPanel({ className }: { className?: string }) {
  const { client } = useWebSocket();
  const { t } = useAppTranslation();
  const [kits, setKits] = useState<KitSummary[]>([]);
  const [activeKit, setActiveKit] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [stack, setStack] = useState<string>('web');
  const [busyKit, setBusyKit] = useState<string | null>(null);
  const sessionId = useActiveSessionId();

  useEffect(() => {
    if (!client) return;
    /** Drop a reply that names a different tab; untagged stays accepted. */
    const isOurs = (payload: { sessionId?: string | undefined } | undefined): boolean =>
      !payload?.sessionId || !sessionId || payload.sessionId === sessionId;
    const onList = (msg: unknown) => {
      const p = (
        msg as {
          payload?: { kits?: KitSummary[]; activeKit?: string | null; sessionId?: string };
        }
      ).payload;
      if (!isOurs(p)) return;
      setKits(p?.kits ?? []);
      setActiveKit(p?.activeKit ?? null);
      setLoading(false);
    };
    const onUse = (msg: unknown) => {
      const p = (msg as { payload?: { ok?: boolean; kit?: string; sessionId?: string } }).payload;
      if (!isOurs(p)) return;
      setBusyKit(null);
      if (p?.ok && p.kit) setActiveKit(p.kit);
    };
    client.on('design.list', onList);
    client.on('design.use', onUse);
    // Re-asked on every tab change: the panel is parked, not unmounted, so
    // otherwise it keeps showing the previous tab's active kit.
    setLoading(true);
    client.send({ type: 'design.list', payload: client.withSession({}) });
    return () => {
      client.off('design.list', onList);
      client.off('design.use', onUse);
    };
  }, [client, sessionId]);

  const useKit = useCallback(
    (id: string) => {
      if (!client) return;
      setBusyKit(id);
      client.send({ type: 'design.use', payload: client.withSession({ kit: id, stack }) });
    },
    [client, stack],
  );

  const sortedKits = useMemo(() => [...kits].sort((a, b) => a.name.localeCompare(b.name)), [kits]);
  const kitPage = usePagination(sortedKits, 10, stack);

  return (
    <div className={cn('flex h-full min-h-0 min-w-0 flex-col', className)}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50">
        <Palette className="w-4 h-4 text-muted-foreground" />
        <span className="text-xs text-muted-foreground flex-1">
          {t('activity:designStudio.pickHint')}
        </span>
        <button
          type="button"
          onClick={() => showPanel('design')}
          className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border border-border/60 hover:bg-muted"
          title={t('activity:designStudio.galleryTitle')}
        >
          <LayoutGrid className="w-3 h-3" /> {t('activity:designStudio.gallery')}
        </button>
        <select
          value={stack}
          onChange={(e) => setStack(e.target.value)}
          className="text-[11px] bg-transparent border border-border/60 rounded px-1 py-0.5"
          title={t('activity:designStudio.stackTitle')}
        >
          {STACKS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-2 space-y-2">
        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground p-3">
            <Loader2 className="w-4 h-4 animate-spin" /> {t('activity:designStudio.loading')}
          </div>
        )}
        {!loading && sortedKits.length === 0 && (
          <p className="text-sm text-muted-foreground p-3">{t('activity:designStudio.notFound')}</p>
        )}
        {kitPage.pageItems.map((kit) => {
          const isActive = activeKit === kit.id;
          return (
            <div
              key={kit.id}
              className={cn(
                'rounded-lg border p-3 transition-colors',
                isActive
                  ? 'border-primary/60 bg-primary/5'
                  : 'border-border/60 hover:border-border',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <h3 className="text-sm font-semibold truncate">{kit.name}</h3>
                    {isActive && (
                      <span className="inline-flex items-center gap-0.5 text-[9px] font-semibold uppercase text-primary">
                        <Check className="w-3 h-3" /> {t('activity:design.active')}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">
                    {kit.aesthetic}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => useKit(kit.id)}
                  disabled={busyKit === kit.id}
                  className={cn(
                    'shrink-0 text-[11px] px-2 py-1 rounded font-medium',
                    isActive
                      ? 'bg-primary/10 text-primary'
                      : 'bg-primary text-primary-foreground hover:opacity-90',
                  )}
                >
                  {busyKit === kit.id
                    ? '…'
                    : isActive
                      ? t('activity:design.reapply')
                      : t('activity:design.use')}
                </button>
              </div>

              <div className="mt-2 space-y-1">
                <Swatches tokens={kit.light} label={t('activity:designStudio.light')} />
                <Swatches tokens={kit.dark} label={t('activity:designStudio.dark')} />
              </div>

              {kit.bestFor && (
                <p className="text-[10px] text-muted-foreground mt-2 leading-snug">
                  <span className="font-medium">{t('activity:designStudio.bestFor')}</span>{' '}
                  {kit.bestFor}
                </p>
              )}
              <div className="flex flex-wrap gap-1 mt-1.5">
                {kit.stacks.map((s) => (
                  <span
                    key={s}
                    className="text-[9px] px-1 py-0.5 rounded bg-muted text-muted-foreground"
                  >
                    {s}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <Pagination
        page={kitPage.page}
        pageSize={kitPage.pageSize}
        totalItems={kitPage.totalItems}
        onPageChange={kitPage.setPage}
        compact
        itemLabel="design kits"
      />
    </div>
  );
}

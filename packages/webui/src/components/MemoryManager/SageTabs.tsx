/**
 * SageTabs — tabbed shell that hosts the three SAGE lenses under a single set
 * of tab triggers.
 *
 * Previously the SAGE memory area rendered `MemoryManager` (full store) and
 * `AudienceMemoryPanel` (audience-scoped subset) as two side-by-side panes
 * inside `App.tsx`. That layout forced both panes to share one column of
 * vertical space and gave users no signal that the left pane showed a *strict
 * subset* of the store. Splitting the same data into lenses behind a top
 * tab bar:
 *   - reclaims the full viewport width for whichever lens is active,
 *   - removes the duplicated chrome (each panel still owns its own header
 *     and stat strip — they are not lifted here, to keep this a pure
 *     layout migration),
 *   - makes the subset relationship explicit (Audience-scoped is a curated
 *     slice of All memories).
 *
 * The third lens, `VectorMemoryPanel`, used to render as a separate in-flow
 * panel below the tab shell. Hosting it as a tab gives the embedding store
 * the same full-viewport treatment and stops it from competing with the
 * SAGE lenses for vertical space. It stays strictly opt-in: when the
 * webui-server host wires no vector store the panel renders its own
 * "disabled" placeholder inside the tab.
 *
 * All three panels keep their own data fetching, list state, and modal flows.
 * Nothing in this file reaches into their internals.
 */
import { useAppTranslation } from '@/i18n';
import { type BrainCircuit, ListFilter, Network, Users2 } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

const MemoryManager = lazy(() =>
  import('./index.js').then((module) => ({ default: module.MemoryManager })),
);
const AudienceMemoryPanel = lazy(() =>
  import('../AudienceMemoryPanel.js').then((module) => ({
    default: module.AudienceMemoryPanel,
  })),
);
const VectorMemoryPanel = lazy(() =>
  import('../vector-memory-panel/index.js').then((module) => ({
    default: module.VectorMemoryPanel,
  })),
);

function TabFallback({ label }: { label: string }) {
  return (
    <div
      className="flex h-full min-h-0 items-center justify-center bg-background text-xs text-muted-foreground"
      aria-busy="true"
    >
      <span className="font-mono uppercase tracking-wide">{label}…</span>
    </div>
  );
}

type SageTabValue = 'all' | 'audience' | 'vector';

const SAGE_TABS: ReadonlyArray<{
  value: SageTabValue;
  label: string;
  hint: string;
  Icon: typeof BrainCircuit;
}> = [
  {
    value: 'all',
    label: 'activity:memoryManager.tabAllMemories',
    hint: 'activity:memoryManager.tabAllMemoriesHint',
    Icon: ListFilter,
  },
  {
    value: 'audience',
    label: 'activity:memoryManager.tabAudience',
    hint: 'activity:memoryManager.tabAudienceHint',
    Icon: Users2,
  },
  {
    value: 'vector',
    label: 'activity:memoryManager.tabVectorMemory',
    hint: 'activity:memoryManager.tabVectorMemoryHint',
    Icon: Network,
  },
];

export function SageTabs({ defaultValue = 'all' }: { defaultValue?: SageTabValue } = {}) {
  const { t } = useAppTranslation();
  return (
    <Tabs defaultValue={defaultValue} className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div
        className="flex shrink-0 items-center justify-between gap-3 border-b border-border/70 bg-card/55 px-4 py-2 sm:px-5"
        role="presentation"
      >
        <TabsList
          aria-label={t('activity:memoryManager.lensesAria')}
          className="h-9 bg-muted/40 p-1 shadow-none"
        >
          {SAGE_TABS.map(({ value, label, hint, Icon }) => (
            <TabsTrigger
              key={value}
              value={value}
              className={cn(
                'h-7 gap-2 px-3 text-[11px] font-semibold uppercase tracking-wide',
                'data-[state=active]:bg-background data-[state=active]:text-foreground',
                'data-[state=active]:shadow-[0_0_0_1px_hsl(var(--border)/0.7)]',
              )}
            >
              <Icon className="size-3.5" />
              <span>{t(label)}</span>
              <span className="hidden font-mono text-[9px] font-normal normal-case text-muted-foreground sm:inline">
                {t(hint)}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      <TabsContent
        value="all"
        className="mt-0 flex-1 overflow-hidden ring-offset-0 focus-visible:ring-0"
      >
        <Suspense fallback={<TabFallback label={t('activity:memoryManager.loadingSage')} />}>
          <MemoryManager />
        </Suspense>
      </TabsContent>

      <TabsContent
        value="audience"
        className="mt-0 flex-1 overflow-hidden ring-offset-0 focus-visible:ring-0"
      >
        <Suspense fallback={<TabFallback label={t('activity:memoryManager.loadingAudience')} />}>
          <AudienceMemoryPanel />
        </Suspense>
      </TabsContent>

      {/* The vector lens is a plain in-flow column (no internal scrolling),
          so this content area owns the scroll instead of hiding it. */}
      <TabsContent
        value="vector"
        className="mt-0 flex-1 overflow-y-auto px-4 pb-6 pt-4 ring-offset-0 focus-visible:ring-0 sm:px-5"
      >
        <Suspense
          fallback={<TabFallback label={t('activity:memoryManager.loadingVectorMemory')} />}
        >
          <VectorMemoryPanel />
        </Suspense>
      </TabsContent>
    </Tabs>
  );
}

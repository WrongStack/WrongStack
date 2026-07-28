/**
 * SageTabs — tabbed shell that hosts the two SAGE lenses under a single set of
 * tab triggers.
 *
 * Previously the SAGE memory area rendered `MemoryManager` (full store) and
 * `AudienceMemoryPanel` (audience-scoped subset) as two side-by-side panes
 * inside `App.tsx`. That layout forced both panes to share one column of
 * vertical space and gave users no signal that the left pane showed a *strict
 * subset* of the store. Splitting the same data into two lenses behind a top
 * tab bar:
 *   - reclaims the full viewport width for whichever lens is active,
 *   - removes the duplicated chrome (each panel still owns its own header
 *     and stat strip — they are not lifted here, to keep this change a pure
 *     layout migration),
 *   - makes the subset relationship explicit (Audience-scoped is a curated
 *     slice of All memories).
 *
 * Both panels keep their own data fetching, list state, and modal flows.
 * Nothing in this file reaches into their internals.
 */
import { BrainCircuit, ListFilter, Users2 } from 'lucide-react';
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

export type SageTabValue = 'all' | 'audience';

const SAGE_TABS: ReadonlyArray<{
  value: SageTabValue;
  label: string;
  hint: string;
  Icon: typeof BrainCircuit;
}> = [
  { value: 'all', label: 'All memories', hint: 'Inspect, curate, retire', Icon: ListFilter },
  { value: 'audience', label: 'Audience-scoped', hint: 'Guidance routed to agents', Icon: Users2 },
];

export function SageTabs({ defaultValue = 'all' }: { defaultValue?: SageTabValue } = {}) {
  return (
    <Tabs
      defaultValue={defaultValue}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
    >
      <div
        className="flex shrink-0 items-center justify-between gap-3 border-b border-border/70 bg-card/55 px-4 py-2 sm:px-5"
        role="presentation"
      >
        <TabsList
          aria-label="SAGE memory lenses"
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
              <span>{label}</span>
              <span className="hidden font-mono text-[9px] font-normal normal-case text-muted-foreground sm:inline">
                {hint}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      <TabsContent
        value="all"
        className="mt-0 flex-1 overflow-hidden ring-offset-0 focus-visible:ring-0"
      >
        <Suspense fallback={<TabFallback label="Loading SAGE" />}>
          <MemoryManager />
        </Suspense>
      </TabsContent>

      <TabsContent
        value="audience"
        className="mt-0 flex-1 overflow-hidden ring-offset-0 focus-visible:ring-0"
      >
        <Suspense fallback={<TabFallback label="Loading audience memories" />}>
          <AudienceMemoryPanel />
        </Suspense>
      </TabsContent>
    </Tabs>
  );
}

import {
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  ChevronRight,
  FileCode2,
  PackageOpen,
  Plus,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { PageMotif } from '@/components/PageMotif';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { navigateToView } from '@/lib/view-navigation';
import { useUIStore } from '@/stores/ui-store';
import { Button } from '../ui/button';
import type { KitDetail, KitSchema } from './types';
import { useProjectKit } from './use-project-kit';

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-72 overflow-auto rounded-lg border border-border/60 bg-muted/30 p-3 font-mono text-xs leading-relaxed">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function ProjectKitView() {
  const { t } = useAppTranslation();
  const state = useProjectKit();
  const [query, setQuery] = useState('');
  const filtered = useMemo(
    () =>
      state.catalog?.tools.filter((kit) =>
        `${kit.name} ${kit.description}`.toLowerCase().includes(query.toLowerCase()),
      ) ?? [],
    [state.catalog, query],
  );
  const prepare = (text: string) => {
    useUIStore.getState().requestPromptInsert(text);
    navigateToView('chat');
  };
  return (
    <section className="flex h-full min-h-0 flex-col bg-background" aria-label="Project Kit">
      <header className="ws-page-header flex flex-wrap items-center justify-between gap-3 border-b border-border">
        <PageMotif kind="system" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <PackageOpen className="h-5 w-5 text-primary" />
            <h1 className="">Project Kit</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{t('activity:projectKit.subtitle')}</p>
          {state.catalog && (
            <p
              className="mt-2 break-all font-mono text-[11px] text-muted-foreground"
              title={state.catalog.projectRoot}
            >
              {state.catalog.projectRoot}
            </p>
          )}
        </div>
        <div className="flex min-w-0 flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={state.refresh}
            aria-label={t('activity:projectKit.refresh')}
          >
            <RefreshCw className="h-4 w-4" />
            <span className="ml-2">{t('activity:projectKit.refresh')}</span>
          </Button>
          <Button
            size="sm"
            disabled={!state.catalog}
            onClick={() =>
              prepare(
                `Create a reusable Project Kit capability for this project (${state.catalog?.projectRoot}). First discover existing kits with project_kit and prefer extending a suitable one. Use the template contract, add meaningful verification cases, and verify the exact revision. The capability I need is: `,
              )
            }
          >
            <Plus className="mr-2 h-4 w-4" />
            {t('activity:projectKit.create')}
          </Button>
        </div>
      </header>
      {state.error ? (
        <div
          role="alert"
          className="m-6 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"
        >
          {t('activity:projectKit.loadFailed')}
          <p className="mt-2 break-words text-muted-foreground">{state.error}</p>
        </div>
      ) : !state.catalog ? (
        <p role="status" className="p-6 text-sm text-muted-foreground">
          {t('activity:projectKit.loading')}
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <aside
            className={cn(
              'min-h-0 w-full shrink-0 flex-col border-border md:flex md:w-72 md:border-r lg:w-80',
              state.selected ? 'hidden' : 'flex flex-1 md:flex-none',
            )}
            aria-label={t('activity:projectKit.catalog')}
          >
            <div className="border-b border-border/60 p-4">
              <div className="mb-3 flex items-center justify-between text-xs font-medium text-muted-foreground">
                <span>{t('activity:projectKit.catalog')}</span>
                <span>{state.catalog.tools.length}</span>
              </div>
              <label className="flex items-center gap-2 rounded-lg border border-input bg-background px-3 py-2">
                <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                <input
                  aria-label={t('activity:projectKit.search')}
                  placeholder={t('activity:projectKit.search')}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="w-full min-w-0 bg-transparent text-sm outline-none"
                />
              </label>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {filtered.map((kit) => (
                <button
                  key={kit.name}
                  type="button"
                  aria-pressed={state.selected === kit.name}
                  onClick={() => state.setSelected(kit.name)}
                  className={cn(
                    'mb-1 w-full rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    state.selected === kit.name
                      ? 'border-primary/30 bg-primary/10'
                      : 'border-transparent hover:bg-muted/50',
                  )}
                >
                  <span className="flex items-start justify-between gap-2">
                    <span className="break-all text-sm font-semibold">{kit.name}</span>
                    <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  </span>
                  <span className="mt-1 block line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                    {kit.description}
                  </span>
                  <span className="mt-2 inline-block rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {t(`activity:projectKit.effects.${kit.effects}`)}
                  </span>
                </button>
              ))}
              {!filtered.length && (
                <p className="p-3 text-sm text-muted-foreground">
                  {t(
                    state.catalog.tools.length
                      ? 'activity:projectKit.noMatches'
                      : 'activity:projectKit.emptyList',
                  )}
                </p>
              )}
              {state.catalog.invalid.map((entry) => (
                <div
                  key={entry.name}
                  role="alert"
                  className="m-1 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs"
                >
                  <p className="font-semibold">{entry.name}</p>
                  <p className="mt-1">{t('activity:projectKit.invalid')}</p>
                  <p className="mt-1 break-words text-muted-foreground">{entry.error}</p>
                </div>
              ))}
            </div>
          </aside>
          <div
            className={cn(
              'min-h-0 min-w-0 flex-1 overflow-y-auto',
              !state.selected && 'hidden md:block',
            )}
          >
            {!state.selected ? (
              <div className="mx-auto flex max-w-lg flex-col items-center px-6 py-16 text-center">
                <div className="mb-5 rounded-2xl border border-primary/20 bg-primary/5 p-5">
                  <PackageOpen className="h-9 w-9 text-primary" />
                </div>
                <h2 className="text-lg font-semibold">
                  {t(
                    state.catalog.tools.length
                      ? 'activity:projectKit.selectTitle'
                      : 'activity:projectKit.emptyTitle',
                  )}
                </h2>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                  {t('activity:projectKit.emptyHint')}
                </p>
                <p className="mt-4 rounded-lg bg-muted/40 px-3 py-2 font-mono text-xs">
                  .wrongstack/project-kit/
                </p>
              </div>
            ) : (
              <div className="p-4 md:p-6">
                <Button
                  variant="ghost"
                  size="sm"
                  className="mb-4 md:hidden"
                  onClick={() => state.setSelected('')}
                >
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  {t('activity:projectKit.catalog')}
                </Button>
                {state.detailError ? (
                  <p role="alert" className="text-sm text-destructive">
                    {state.detailError}
                  </p>
                ) : state.detail ? (
                  <KitContent
                    key={`${state.sessionId}:${state.detail.name}:${state.detail.revision}`}
                    kit={state.detail}
                    prepare={prepare}
                    projectRoot={state.catalog.projectRoot}
                  />
                ) : (
                  <p role="status" className="text-sm text-muted-foreground">
                    {t('activity:projectKit.loading')}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function KitContent({
  kit,
  prepare,
  projectRoot,
}: {
  kit: KitDetail;
  prepare: (text: string) => void;
  projectRoot: string;
}) {
  const { t } = useAppTranslation();
  const [input, setInput] = useState(() => {
    const defaults = Object.fromEntries(
      Object.entries(kit.inputSchema.properties ?? {})
        .filter(([, schema]) => Object.hasOwn(schema, 'default'))
        .map(([name, schema]) => [name, schema.default]),
    );
    return JSON.stringify(defaults, null, 2);
  });
  const [inputError, setInputError] = useState(false);
  const useInChat = (action: 'run' | 'verify') => {
    let params: unknown = {};
    if (action === 'run') {
      try {
        params = JSON.parse(input);
        if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error();
      } catch {
        setInputError(true);
        return;
      }
    }
    setInputError(false);
    prepare(
      `For project ${JSON.stringify(projectRoot)}, inspect Project Kit ${JSON.stringify(kit.name)} and ${action === 'verify' ? 'verify its declared cases' : 'run it with the parameters below'}. The revision shown in the UI was ${kit.revision}; if it changed, inspect the current contract before proceeding. Use project_kit_run through the normal permission flow. ${action === 'run' ? `Verify the current revision first if needed. Parameters: ${JSON.stringify(params)}` : 'Verification executes real code; inspect the effects and fixture inputs first.'}`,
    );
  };
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="break-all text-xl font-semibold">{kit.name}</h2>
          <span
            className={cn(
              'rounded-full border px-2 py-0.5 text-xs',
              kit.verified
                ? 'border-success/30 bg-success/10 text-success'
                : 'border-warning/30 bg-warning/10 text-warning',
            )}
          >
            {kit.verified && <CheckCircle2 className="mr-1 inline h-3 w-3" />}
            {t(kit.verified ? 'activity:projectKit.verified' : 'activity:projectKit.unverified')}
          </span>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{kit.description}</p>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
          <span>{t(`activity:projectKit.effects.${kit.effects}`)}</span>
          <span>{kit.timeoutMs / 1000}s</span>
          <span>
            {kit.tests.length} {t('activity:projectKit.cases')}
          </span>
          <code title={kit.revision}>{kit.revision.slice(0, 12)}</code>
        </div>
      </div>
      <section className="rounded-xl border border-border p-4">
        <h3 className="mb-3 text-sm font-semibold">{t('activity:projectKit.guide')}</h3>
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">
          {kit.guide}
        </p>
      </section>
      <section className="rounded-xl border border-border p-4">
        <h3 className="mb-3 text-sm font-semibold">{t('activity:projectKit.parameters')}</h3>
        <div className="space-y-3">
          {Object.entries(kit.inputSchema.properties ?? {}).map(
            ([name, schema]: [string, KitSchema]) => (
              <div key={name} className="border-b border-border/50 pb-3 last:border-0">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="text-xs font-semibold">{name}</code>
                  <span className="text-xs text-muted-foreground">{schema.type}</span>
                  {kit.inputSchema.required?.includes(name) && (
                    <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-foreground">
                      {t('activity:projectKit.required')}
                    </span>
                  )}
                </div>
                {schema.description && (
                  <p className="mt-1 text-xs text-muted-foreground">{schema.description}</p>
                )}
                {Object.hasOwn(schema, 'default') && (
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                    {t('activity:projectKit.default')}: {JSON.stringify(schema.default)}
                  </p>
                )}
              </div>
            ),
          )}
        </div>
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer py-2 text-muted-foreground">
            {t('activity:projectKit.schemas')}
          </summary>
          <div className="space-y-3">
            <JsonBlock value={kit.inputSchema} />
            <JsonBlock value={kit.outputSchema} />
          </div>
        </details>
        <label htmlFor="kit-input" className="mb-2 mt-4 block text-xs font-medium">
          {t('activity:projectKit.input')}
        </label>
        <textarea
          id="kit-input"
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            setInputError(false);
          }}
          spellCheck={false}
          className="min-h-28 w-full rounded-lg border border-input bg-muted/20 p-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {inputError && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {t('activity:projectKit.inputError')}
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => useInChat('run')}>
            <ArrowUpRight className="mr-2 h-4 w-4" />
            {t('activity:projectKit.use')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => useInChat('verify')}>
            {t('activity:projectKit.verify')}
          </Button>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          {t('activity:projectKit.draftHint')}
        </p>
      </section>
      <section className="rounded-xl border border-border p-4">
        <h3 className="mb-3 text-sm font-semibold">{t('activity:projectKit.history')}</h3>
        {!kit.history.length ? (
          <p className="text-sm text-muted-foreground">{t('activity:projectKit.noHistory')}</p>
        ) : (
          <ul className="divide-y divide-border/50">
            {kit.history.map((run) => (
              <li key={run.runId} className="py-3 first:pt-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    {t(`activity:projectKit.actions.${run.action}`)}
                  </span>
                  <span
                    className={cn(
                      'text-xs',
                      run.status === 'passed'
                        ? 'text-success'
                        : run.status === 'failed'
                          ? 'text-destructive'
                          : 'text-warning',
                    )}
                  >
                    {t(`activity:projectKit.status.${run.status}`)}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <time dateTime={run.startedAt}>{new Date(run.startedAt).toLocaleString()}</time>
                  {run.durationMs !== undefined && (
                    <span>{(run.durationMs / 1000).toFixed(2)}s</span>
                  )}
                  <code title={run.revision}>{run.revision.slice(0, 12)}</code>
                </div>
                {run.error && (
                  <p className="mt-2 break-words text-xs text-muted-foreground">{run.error}</p>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-muted-foreground">{t('activity:projectKit.historyHint')}</p>
      </section>
      <details className="rounded-xl border border-border p-4 text-sm">
        <summary className="cursor-pointer font-semibold">{t('activity:projectKit.files')}</summary>
        <ul className="mt-3 space-y-2">
          {kit.files.map((file) => (
            <li key={file} className="flex gap-2 break-all font-mono text-xs text-muted-foreground">
              <FileCode2 className="h-4 w-4 shrink-0" />
              {file}
            </li>
          ))}
        </ul>
      </details>
      <details className="rounded-xl border border-border p-4 text-sm">
        <summary className="cursor-pointer font-semibold">
          {t('activity:projectKit.examples')}
        </summary>
        <div className="mt-3 space-y-4">
          {kit.tests.map((test, i) => (
            <div key={`${test.name}-${i}`}>
              <p className="mb-2 text-xs font-medium">{test.name}</p>
              <JsonBlock value={{ input: test.input, expected: test.expected }} />
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

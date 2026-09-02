import {
  ChevronDown,
  ChevronRight,
  FileText,
  RefreshCw,
  ScrollText,
  TriangleAlert,
} from 'lucide-react';
import type { TFunction } from 'i18next';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import type { WSPromptJournalEntry, WSPromptsJournalPayload } from '@/types/server-message';

/**
 * PromptJournalView — a readable page over the project's hierarchical prompt
 * journal (`<projectRoot>/.wrongstack/prompts/`, written by the core
 * `recordPromptJournalEntry` helper). Entries arrive over the WS
 * `prompts.journal` round-trip, newest first, grouped by day.
 *
 * The journal only exists once a prompt has been recorded for the project, so
 * the page leads with a friendly empty state instead of an error when the
 * backend reports `enabled: false` or zero entries.
 */

interface JournalFilters {
  /** '' = all categories */
  category: string;
  /** Case-insensitive substring against session id. */
  session: string;
  limit: number;
}

const DEFAULT_LIMIT = 200;
/**
 * Categories the WebUI Prompt Journal surfaces. Per product scope, the page
 * is intentionally narrowed to ONLY the manually-entered user prompt
 * (`raw_user`) and its refined copy (`refined_user`, which carries the
 * original-language text and preserves the raw input as `rawContent` for the
 * English comparison). Every other category the recorder may write into the
 * on-disk journal — system prompts, autonomous next steps, self-healing
 * retries, clarify interactions, subagent delegations — is filtered out here
 * so the page stays strictly a record of what the user actually submitted.
 */
const TRACKED_CATEGORIES: ReadonlySet<string> = new Set(['raw_user', 'refined_user']);
const CATEGORY_ORDER = ['raw_user', 'refined_user'] as const;

function categoryLabel(t: TFunction, category: string): string {
  return t(`activity:promptJournal.cat.${category}`, category);
}

export function PromptJournalView() {
  const { t } = useAppTranslation();
  const client = getWSClient();
  const [entries, setEntries] = useState<WSPromptJournalEntry[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<JournalFilters>({
    category: '',
    session: '',
    limit: DEFAULT_LIMIT,
  });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    if (!client.isConnected) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    client.send({
      type: 'prompts.journal',
      payload: {
        filter: {
          ...(filters.category ? { category: filters.category } : {}),
          limit: filters.limit,
        },
      },
    });
  }, [client, filters.category, filters.limit]);

  useEffect(() => {
    const onJournal = (msg: unknown) => {
      const payload = (msg as { payload: WSPromptsJournalPayload }).payload;
      setEnabled(payload.enabled);
      // Narrow the journal to the manually-entered user prompts and their
      // refined copies only; ignore every other category the recorder writes
      // so the page is strictly a record of what the user submitted.
      const entries = (payload.entries ?? []).filter((e) => TRACKED_CATEGORIES.has(e.category));
      setEntries(entries);
      setError(payload.error ?? null);
      setLoading(false);
    };
    client.on('prompts.journal', onJournal as (m: unknown) => void);
    load();
    return () => client.off('prompts.journal', onJournal as (m: unknown) => void);
  }, [client, load]);

  // Newest first (the store returns chronological ascending).
  const grouped = useMemo(() => {
    const sessionFilter = filters.session.trim().toLowerCase();
    const visible = entries.filter(
      (e) => !sessionFilter || e.sessionId.toLowerCase().includes(sessionFilter),
    );
    const byDay = new Map<string, WSPromptJournalEntry[]>();
    for (const entry of [...visible].reverse()) {
      const day = entry.timestamp.slice(0, 10);
      const list = byDay.get(day) ?? [];
      list.push(entry);
      byDay.set(day, list);
    }
    return [...byDay.entries()];
  }, [entries, filters.session]);

  const stats = useMemo(() => {
    let tokens = 0;
    for (const entry of entries) tokens += entry.metadata.tokenEstimate ?? 0;
    return { count: entries.length, tokens };
  }, [entries]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const categories = useMemo(
    () => CATEGORY_ORDER.filter((c) => entries.some((e) => e.category === c)),
    [entries],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      {/* ── Header ── */}
      <div className="border-b border-border/70 px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ScrollText className="h-5 w-5 text-primary" />
            <h1 className="text-base font-semibold">{t('activity:promptJournal.title')}</h1>
          </div>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            {t('activity:promptJournal.refresh')}
          </button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{t('activity:promptJournal.subtitle')}</p>
        {enabled && stats.count > 0 && (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{t('activity:promptJournal.statEntries', { count: stats.count })}</span>
            <span>
              {t('activity:promptJournal.statTokens', { count: stats.tokens.toLocaleString() })}
            </span>
          </div>
        )}
      </div>

      {/* ── Filters ── */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border/70 px-4 py-2 sm:px-6">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>{t('activity:promptJournal.filterCategory')}</span>
          <select
            value={filters.category}
            onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value }))}
            className="rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="">{t('activity:promptJournal.filterAll')}</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {categoryLabel(t, c)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>{t('activity:promptJournal.filterSession')}</span>
          <input
            type="text"
            value={filters.session}
            onChange={(e) => setFilters((f) => ({ ...f, session: e.target.value }))}
            placeholder="sess_…"
            className="w-40 rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>{t('activity:promptJournal.filterLimit')}</span>
          <select
            value={filters.limit}
            onChange={(e) => setFilters((f) => ({ ...f, limit: Number(e.target.value) }))}
            className="rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
          >
            <option value={50}>50</option>
            <option value={200}>200</option>
            <option value={1000}>1000</option>
          </select>
        </label>
      </div>

      {/* ── Body ── */}
      <div className="min-h-0 flex-1 px-4 py-3 sm:px-6">
        {loading && (
          <div className="py-10 text-center text-sm text-muted-foreground">
            {t('activity:promptJournal.loading')}
          </div>
        )}
        {!loading && error && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-destructive">
            <TriangleAlert className="h-4 w-4" />
            {error}
          </div>
        )}
        {!loading && !error && !enabled && (
          <div className="py-10 text-center text-sm text-muted-foreground">
            {t('activity:promptJournal.disabled')}
          </div>
        )}
        {!loading && !error && enabled && grouped.length === 0 && (
          <div className="py-10 text-center">
            <FileText className="mx-auto h-8 w-8 text-muted-foreground/50" />
            <div className="mt-2 text-sm font-medium text-foreground">
              {t('activity:promptJournal.emptyTitle')}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {t('activity:promptJournal.emptyHint')}
            </div>
          </div>
        )}
        {!loading && !error && enabled && grouped.length > 0 && (
          <div className="space-y-5">
            {grouped.map(([day, dayEntries]) => (
              <section key={day}>
                <h2 className="sticky top-0 z-10 border-b border-border/60 bg-background/90 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur">
                  {day}
                  <span className="ml-2 font-normal normal-case text-muted-foreground/60">
                    {dayEntries.length}
                  </span>
                </h2>
                <ul className="mt-2 space-y-2">
                  {dayEntries.map((entry) => (
                    <JournalEntryCard
                      key={entry.id}
                      entry={entry}
                      expanded={expanded.has(entry.id)}
                      onToggle={() => toggle(entry.id)}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function JournalEntryCard({
  entry,
  expanded,
  onToggle,
}: {
  entry: WSPromptJournalEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useAppTranslation();
  const time = entry.timestamp.slice(11, 19);
  const meta = entry.metadata;
  const preview = entry.content.trim().slice(0, 240);
  // The page only tracks manually-entered prompts and their refined copies,
  // so the expanded detail intentionally stops at the prompt text itself:
  // the refined body is `entry.content`, and the English/raw counterpart is
  // `entry.rawContent` whenever the refiner rewrote the original. No model,
  // provider, iteration, duration, tool list, context file, or rationale —
  // those are out of scope for this view.
  const hasRefinedDiff = entry.rawContent !== undefined && entry.rawContent !== entry.content;

  return (
    <li className="rounded-lg border border-border/70 bg-card/60">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left hover:bg-accent/40"
      >
        {expanded ? (
          <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className="tabular text-muted-foreground">{time}</span>
            <span className="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary">
              {categoryLabel(t, entry.category)}
            </span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
              {entry.role}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">{entry.sessionId}</span>
          </div>
          {!expanded && preview && (
            <div className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-xs text-foreground/80">
              {preview}
            </div>
          )}
        </div>
        <span className="shrink-0 text-[11px] tabular text-muted-foreground">
          ~{meta.tokenEstimate} {t('activity:promptJournal.tokens')}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border/60 px-3 py-2 pl-9">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t('activity:promptJournal.refinedBody')}
          </div>
          <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 text-xs text-foreground">
            {entry.content}
          </pre>
          {hasRefinedDiff && (
            <div className="mt-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t('activity:promptJournal.rawInput')}
              </div>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/30 p-2 text-xs text-muted-foreground">
                {entry.rawContent}
              </pre>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

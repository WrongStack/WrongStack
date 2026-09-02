import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Prompts are bounded (user-defined templates), show all without pagination.
import { useWebSocket } from '@/hooks/useWebSocket';
import { i18n, useAppTranslation } from '@/i18n';
import { useUIStore } from '@/stores';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/dialog';

interface PromptVar {
  name: string;
  description?: string;
  default?: string;
  required?: boolean;
  enum?: string[];
  multiline?: boolean;
}
interface PromptMeta {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  source: string;
  favorite: boolean;
  variables: PromptVar[];
}
interface CategoryCount {
  id: string;
  label: string;
  count: number;
}

const SOURCE_GLYPH: Record<string, string> = {
  builtin: '📦',
  user: '👤',
  project: '📁',
  synced: '☁',
};

/** A variable row in the authoring form (enum kept as a CSV string for editing). */
interface VarDraft {
  name: string;
  description: string;
  required: boolean;
  multiline: boolean;
  enumCsv: string;
}
interface PromptDraft {
  title: string;
  description: string;
  category: string;
  tagsCsv: string;
  content: string;
  vars: VarDraft[];
}
const emptyDraft: PromptDraft = {
  title: '',
  description: '',
  category: '',
  tagsCsv: '',
  content: '',
  vars: [],
};

/** Fill {{name}} placeholders locally; leave unknown placeholders intact. */
function render(content: string, values: Record<string, string>): string {
  return content.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, raw: string) =>
    Object.hasOwn(values, raw.trim()) && values[raw.trim()]
      ? (values[raw.trim()] as string)
      : whole,
  );
}

/**
 * Prompt library modal — browse / search / filter-by-category / preview /
 * fill {{variables}} / insert into the chat input. Opened from the `/prompt`
 * slash command (ui-store `promptLibraryOpen`).
 */
export function PromptLibraryModal() {
  const { t } = useAppTranslation();
  const { client } = useWebSocket();
  const open = useUIStore((s) => s.promptLibraryOpen);
  const setOpen = useUIStore((s) => s.setPromptLibraryOpen);
  const requestPromptInsert = useUIStore((s) => s.requestPromptInsert);

  const [prompts, setPrompts] = useState<PromptMeta[]>([]);
  const [categories, setCategories] = useState<CategoryCount[]>([]);
  const [query, setQuery] = useState('');
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [recentOnly, setRecentOnly] = useState(false);
  const [recentSlugs, setRecentSlugs] = useState<string[]>([]);
  const [selected, setSelected] = useState<PromptMeta | null>(null);
  const [content, setContent] = useState('');
  const [varValues, setVarValues] = useState<Record<string, string>>({});
  const searchRef = useRef<HTMLInputElement>(null);

  // ── Authoring ("＋ New prompt") ──────────────────────────────────────────
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<PromptDraft>(emptyDraft);
  const [createError, setCreateError] = useState<string | null>(null);

  // Load list on open.
  useEffect(() => {
    if (!open || !client) return;
    const onList = (msg: unknown) => {
      const p = (msg as { payload: { prompts?: PromptMeta[]; categories?: CategoryCount[] } })
        .payload;
      setPrompts(p.prompts ?? []);
      setCategories(p.categories ?? []);
    };
    client.on('prompts.list', onList as (m: unknown) => void);
    client.send({ type: 'prompts.list' });
    setTimeout(() => searchRef.current?.focus(), 50);
    return () => client.off('prompts.list', onList as (m: unknown) => void);
  }, [open, client]);

  // Fetch full content when a prompt is selected.
  useEffect(() => {
    if (!selected || !client) return;
    setContent('');
    setVarValues(
      Object.fromEntries((selected.variables ?? []).map((v) => [v.name, v.default ?? ''])),
    );
    const onContent = (msg: unknown) => {
      const p = (msg as { payload: { slug: string; content: string; found: boolean } }).payload;
      if (p.slug === selected.slug && p.found) setContent(p.content);
    };
    client.on('prompts.content', onContent as (m: unknown) => void);
    client.send({ type: 'prompts.content', payload: { slug: selected.slug } });
    return () => client.off('prompts.content', onContent as (m: unknown) => void);
  }, [selected, client]);

  // Esc closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  // When Recent is active, fetch recently-used slugs and order by them.
  useEffect(() => {
    if (!open || !client || !recentOnly) return;
    const onRecent = (msg: unknown) => {
      const slugs = (msg as { payload: { slugs?: string[] } }).payload.slugs ?? [];
      setRecentSlugs(slugs);
    };
    client.on('prompts.recent', onRecent as (m: unknown) => void);
    client.send({ type: 'prompts.recent' });
    return () => client.off('prompts.recent', onRecent as (m: unknown) => void);
  }, [open, client, recentOnly]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matchesQuery = (p: PromptMeta) =>
      !q ||
      p.title.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q) ||
      p.slug.includes(q) ||
      p.tags.some((t) => t.toLowerCase().includes(q));

    if (recentOnly) {
      const bySlug = new Map(prompts.map((p) => [p.slug, p]));
      return recentSlugs
        .map((s) => bySlug.get(s))
        .filter((p): p is PromptMeta => Boolean(p))
        .filter(matchesQuery);
    }
    return prompts.filter((p) => {
      if (favoritesOnly && !p.favorite) return false;
      if (activeCat && p.category !== activeCat) return false;
      return matchesQuery(p);
    });
  }, [prompts, query, activeCat, favoritesOnly, recentOnly, recentSlugs]);

  const missing = useMemo(
    () =>
      (selected?.variables ?? [])
        .filter((v) => v.required && !varValues[v.name])
        .map((v) => v.name),
    [selected, varValues],
  );

  const doInsert = useCallback(() => {
    if (!selected || !content) return;
    client?.send({ type: 'prompts.used', payload: { slug: selected.slug } });
    requestPromptInsert(render(content, varValues));
  }, [selected, content, varValues, requestPromptInsert, client]);

  const toggleFavorite = useCallback(
    (p: PromptMeta) => {
      if (!client) return;
      client.send({ type: 'prompts.favorite', payload: { slug: p.slug, favorite: !p.favorite } });
      setPrompts((prev) =>
        prev.map((x) => (x.slug === p.slug ? { ...x, favorite: !x.favorite } : x)),
      );
    },
    [client],
  );

  // Submit a new user prompt; refresh the list and return to browse on success.
  useEffect(() => {
    if (!open || !client) return;
    const onCreated = (msg: unknown) => {
      const p = (msg as { payload: { success: boolean; slug?: string; error?: string } }).payload;
      if (p.success) {
        setCreating(false);
        setDraft(emptyDraft);
        setCreateError(null);
        client.send({ type: 'prompts.list' });
      } else {
        setCreateError(p.error ?? i18n.t('activity:promptLib.saveFailed'));
      }
    };
    client.on('prompts.created', onCreated as (m: unknown) => void);
    return () => client.off('prompts.created', onCreated as (m: unknown) => void);
  }, [open, client]);

  const submitCreate = useCallback(() => {
    if (!client) return;
    if (!draft.title.trim() || !draft.content.trim()) {
      setCreateError(i18n.t('activity:promptLib.titleContentRequired'));
      return;
    }
    const variables = draft.vars
      .filter((v) => v.name.trim())
      .map((v) => {
        const enumVals = v.enumCsv
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        return {
          name: v.name.trim(),
          ...(v.description.trim() ? { description: v.description.trim() } : {}),
          required: v.required,
          ...(v.multiline ? { multiline: true } : {}),
          ...(enumVals.length > 0 ? { enum: enumVals } : {}),
        };
      });
    client.send({
      type: 'prompts.create',
      payload: {
        title: draft.title.trim(),
        content: draft.content,
        description: draft.description.trim(),
        category: draft.category.trim() || undefined,
        tags: draft.tagsCsv
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        ...(variables.length > 0 ? { variables } : {}),
      },
    });
  }, [client, draft]);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) setOpen(false);
      }}
    >
      <DialogContent
        className="max-w-4xl h-[80dvh] p-0 gap-0 overflow-hidden"
        showCloseButton={false}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          searchRef.current?.focus();
        }}
      >
        <DialogTitle className="sr-only">{t('activity:promptLib.heading')}</DialogTitle>
        <DialogDescription className="sr-only">
          {t('activity:promptLib.searchPlaceholder')}
        </DialogDescription>
        <div className="flex h-full min-h-0 min-w-0 w-full overflow-hidden">
          {/* Left: search + categories + results */}
          <div className="flex min-h-0 min-w-0 w-1/2 flex-col border-r border-border">
            <div className="border-b border-border p-3">
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('activity:promptLib.searchPlaceholder')}
                className="w-full rounded border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
              />
              <button
                type="button"
                onClick={() => {
                  setCreating(true);
                  setSelected(null);
                  setCreateError(null);
                  setDraft(emptyDraft);
                }}
                className="mt-2 w-full rounded border border-dashed border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {t('activity:promptLib.newPrompt')}
              </button>
              <div className="mt-2 flex flex-wrap gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setActiveCat(null);
                    setFavoritesOnly(false);
                    setRecentOnly(false);
                  }}
                  className={`rounded px-2 py-0.5 text-xs ${activeCat === null && !favoritesOnly && !recentOnly ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent'}`}
                >
                  {t('activity:promptLib.all')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRecentOnly((v) => !v);
                    setFavoritesOnly(false);
                    setActiveCat(null);
                  }}
                  className={`rounded px-2 py-0.5 text-xs ${recentOnly ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent'}`}
                >
                  {t('activity:promptLib.recent')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setFavoritesOnly((v) => !v);
                    setRecentOnly(false);
                    setActiveCat(null);
                  }}
                  className={`rounded px-2 py-0.5 text-xs ${favoritesOnly ? 'bg-warning text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent'}`}
                >
                  {t('activity:promptLib.favorites')}
                </button>
                {categories.map((c) => (
                  <button
                    type="button"
                    key={c.id}
                    onClick={() => {
                      setActiveCat(c.id);
                      setRecentOnly(false);
                      setFavoritesOnly(false);
                    }}
                    className={`rounded px-2 py-0.5 text-xs ${activeCat === c.id ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent'}`}
                  >
                    {c.label} ({c.count})
                  </button>
                ))}
              </div>
            </div>
            <div className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain">
              {filtered.map((p) => (
                <button
                  type="button"
                  key={p.slug}
                  onClick={() => setSelected(p)}
                  className={`flex w-full flex-col items-start gap-0.5 border-b border-border/50 px-3 py-2 text-left hover:bg-accent ${selected?.slug === p.slug ? 'bg-accent' : ''}`}
                >
                  <div className="flex w-full items-center gap-1 text-sm">
                    <span>{SOURCE_GLYPH[p.source] ?? '•'}</span>
                    <span className="font-medium">{p.title}</span>
                    {p.favorite && <span className="text-warning">★</span>}
                  </div>
                  <div className="line-clamp-1 text-xs text-muted-foreground">{p.description}</div>
                </button>
              ))}
              {filtered.length === 0 && (
                <div className="p-4 text-sm text-muted-foreground">
                  {t('activity:promptLib.noMatch')}
                </div>
              )}
            </div>
          </div>

          {/* Right: preview + variables + insert, OR the authoring form */}
          <div className="flex min-h-0 min-w-0 w-1/2 flex-col">
            {creating ? (
              <>
                <div className="flex items-center justify-between border-b border-border p-3">
                  <div className="text-sm font-semibold">
                    {t('activity:promptLib.newPromptHeading')}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setCreating(false);
                      setCreateError(null);
                    }}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    {t('common:action.cancel')}
                  </button>
                </div>
                <div className="min-h-0 min-w-0 flex-1 space-y-2 overflow-auto overscroll-contain p-3 text-xs">
                  <input
                    value={draft.title}
                    onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                    placeholder={t('activity:promptLib.titlePlaceholder')}
                    className="w-full rounded border border-border bg-background px-2 py-1 outline-none focus:ring-1 focus:ring-primary"
                  />
                  <input
                    value={draft.description}
                    onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                    placeholder={t('activity:promptLib.descPlaceholder')}
                    className="w-full rounded border border-border bg-background px-2 py-1 outline-none focus:ring-1 focus:ring-primary"
                  />
                  <div className="flex gap-2">
                    <input
                      list="prompt-category-list"
                      value={draft.category}
                      onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}
                      placeholder={t('activity:promptLib.categoryPlaceholder')}
                      className="w-1/2 rounded border border-border bg-background px-2 py-1 outline-none focus:ring-1 focus:ring-primary"
                    />
                    <datalist id="prompt-category-list">
                      {categories.map((c) => (
                        <option key={c.id} value={c.id} />
                      ))}
                    </datalist>
                    <input
                      value={draft.tagsCsv}
                      onChange={(e) => setDraft((d) => ({ ...d, tagsCsv: e.target.value }))}
                      placeholder={t('activity:promptLib.tagsPlaceholder')}
                      className="w-1/2 rounded border border-border bg-background px-2 py-1 outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                  <textarea
                    value={draft.content}
                    onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))}
                    placeholder={t('activity:promptLib.contentPlaceholder')}
                    rows={6}
                    className="w-full resize-y rounded border border-border bg-background px-2 py-1 font-mono outline-none focus:ring-1 focus:ring-primary"
                  />
                  <div className="flex items-center justify-between pt-1">
                    <span className="font-semibold text-muted-foreground">
                      {t('activity:promptLib.variables')}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setDraft((d) => ({
                          ...d,
                          vars: [
                            ...d.vars,
                            {
                              name: '',
                              description: '',
                              required: true,
                              multiline: false,
                              enumCsv: '',
                            },
                          ],
                        }))
                      }
                      className="rounded border border-border px-1.5 py-0.5 hover:bg-accent"
                    >
                      {t('activity:promptLib.addVar')}
                    </button>
                  </div>
                  {draft.vars.map((v, i) => (
                    <div
                      key={v.name || `var-${i}`}
                      className="space-y-1 rounded border border-border/60 p-1.5"
                    >
                      <div className="flex gap-1">
                        <input
                          value={v.name}
                          onChange={(e) =>
                            setDraft((d) => ({
                              ...d,
                              vars: d.vars.map((x, j) =>
                                j === i ? { ...x, name: e.target.value } : x,
                              ),
                            }))
                          }
                          placeholder={t('activity:promptLib.varNamePlaceholder')}
                          className="w-1/3 rounded border border-border bg-background px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-primary"
                        />
                        <input
                          value={v.description}
                          onChange={(e) =>
                            setDraft((d) => ({
                              ...d,
                              vars: d.vars.map((x, j) =>
                                j === i ? { ...x, description: e.target.value } : x,
                              ),
                            }))
                          }
                          placeholder={t('activity:promptLib.varDescPlaceholder')}
                          className="flex-1 rounded border border-border bg-background px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-primary"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setDraft((d) => ({ ...d, vars: d.vars.filter((_, j) => j !== i) }))
                          }
                          className="rounded border border-border px-1.5 text-muted-foreground hover:bg-accent"
                          title={t('activity:promptLib.removeVarTitle')}
                        >
                          ✕
                        </button>
                      </div>
                      <div className="flex items-center gap-3">
                        <label className="flex items-center gap-1 text-muted-foreground">
                          <input
                            type="checkbox"
                            checked={v.required}
                            onChange={(e) =>
                              setDraft((d) => ({
                                ...d,
                                vars: d.vars.map((x, j) =>
                                  j === i ? { ...x, required: e.target.checked } : x,
                                ),
                              }))
                            }
                          />
                          {t('activity:promptLib.required')}
                        </label>
                        <label className="flex items-center gap-1 text-muted-foreground">
                          <input
                            type="checkbox"
                            checked={v.multiline}
                            onChange={(e) =>
                              setDraft((d) => ({
                                ...d,
                                vars: d.vars.map((x, j) =>
                                  j === i ? { ...x, multiline: e.target.checked } : x,
                                ),
                              }))
                            }
                          />
                          {t('activity:promptLib.multiline')}
                        </label>
                        <input
                          value={v.enumCsv}
                          onChange={(e) =>
                            setDraft((d) => ({
                              ...d,
                              vars: d.vars.map((x, j) =>
                                j === i ? { ...x, enumCsv: e.target.value } : x,
                              ),
                            }))
                          }
                          placeholder={t('activity:promptLib.enumPlaceholder')}
                          className="flex-1 rounded border border-border bg-background px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-primary"
                        />
                      </div>
                    </div>
                  ))}
                </div>
                <div className="border-t border-border p-3">
                  {createError && (
                    <div className="mb-2 text-xs text-destructive">{createError}</div>
                  )}
                  <button
                    type="button"
                    onClick={submitCreate}
                    disabled={!draft.title.trim() || !draft.content.trim()}
                    className="w-full rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
                  >
                    {t('activity:promptLib.savePrompt')}
                  </button>
                </div>
              </>
            ) : selected ? (
              <>
                <div className="flex items-start justify-between border-b border-border p-3">
                  <div>
                    <div className="text-sm font-semibold">{selected.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {selected.category} · {selected.slug}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleFavorite(selected)}
                    className="text-lg"
                    title={t('activity:promptLib.toggleFavoriteTitle')}
                  >
                    {selected.favorite ? '★' : '☆'}
                  </button>
                </div>
                <div className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain p-3">
                  <pre className="whitespace-pre-wrap break-words text-xs text-foreground">
                    {content || '…'}
                  </pre>
                  {(selected.variables ?? []).length > 0 && (
                    <div className="mt-3 space-y-2">
                      <div className="text-xs font-semibold text-muted-foreground">
                        {t('activity:promptLib.variables')}
                      </div>
                      {selected.variables.map((v) => {
                        const label = (
                          <span className="text-xs text-muted-foreground">
                            {v.name}
                            {v.required ? ' *' : ''}
                            {v.description ? ` — ${v.description}` : ''}
                          </span>
                        );
                        const set = (val: string) =>
                          setVarValues((prev) => ({ ...prev, [v.name]: val }));
                        const fieldClass =
                          'mt-0.5 w-full rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary';
                        if (v.enum && v.enum.length > 0) {
                          return (
                            <div key={v.name}>
                              {label}
                              <select
                                value={varValues[v.name] ?? ''}
                                onChange={(e) => set(e.target.value)}
                                className={fieldClass}
                              >
                                <option value="">{t('activity:promptLib.selectOption')}</option>
                                {v.enum.map((opt) => (
                                  <option key={opt} value={opt}>
                                    {opt}
                                  </option>
                                ))}
                              </select>
                            </div>
                          );
                        }
                        if (v.multiline) {
                          return (
                            <div key={v.name}>
                              {label}
                              <textarea
                                value={varValues[v.name] ?? ''}
                                onChange={(e) => set(e.target.value)}
                                rows={4}
                                className={`${fieldClass} resize-y font-mono`}
                              />
                            </div>
                          );
                        }
                        return (
                          <div key={v.name}>
                            {label}
                            <input
                              value={varValues[v.name] ?? ''}
                              onChange={(e) => set(e.target.value)}
                              className={fieldClass}
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div className="border-t border-border p-3">
                  <button
                    type="button"
                    onClick={doInsert}
                    disabled={!content || missing.length > 0}
                    className="w-full rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
                  >
                    {missing.length > 0
                      ? t('activity:promptLib.fillMissing', { missing: missing.join(', ') })
                      : t('activity:promptLib.insertIntoChat')}
                  </button>
                </div>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
                {t('activity:promptLib.selectPromptHint')}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

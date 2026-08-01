import {
  AlertTriangle,
  Link2,
  Loader2,
  Pencil,
  Plus,
  Save,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { sendRosterMessage } from '@/lib/roster-ws';
import { cn } from '@/lib/utils';
import type { SageAnchor, SageScope, SageStatus } from '@/types';
import type { MemoryDraft } from './shared';
import {
  ANCHOR_TYPES,
  anchorValue,
  EDITABLE_STATUSES,
  KIND_LABELS,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  RangeField,
  updateAnchorValue,
} from './shared';

export interface MemoryEditorProps {
  mode: 'create' | 'edit';
  draft: MemoryDraft;
  busy: boolean;
  error: string | null;
  onChange: (draft: MemoryDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

export function MemoryEditor({
  mode,
  draft,
  busy,
  error,
  onChange,
  onCancel,
  onSubmit,
}: MemoryEditorProps) {
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [agentRoles, setAgentRoles] = useState<string[]>([]);
  useEffect(() => {
    textRef.current?.focus();
    const controller = new AbortController();
    void sendRosterMessage('agent-roster.list', {}, controller.signal)
      .then((value) => {
        const roles = (value as { roles?: unknown }).roles;
        if (Array.isArray(roles)) {
          setAgentRoles(roles.filter((role): role is string => typeof role === 'string'));
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const set = <K extends keyof MemoryDraft>(key: K, value: MemoryDraft[K]) => {
    onChange({ ...draft, [key]: value });
  };

  const addAnchor = () => {
    set('anchors', [...draft.anchors, { type: 'file', path: '' }]);
  };

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      aria-busy={busy}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border/70 bg-card/70 px-4 py-3 backdrop-blur-xl">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-8 items-center justify-center border border-info/35 bg-info/10 text-info">
            {mode === 'create' ? <Sparkles className="size-4" /> : <Pencil className="size-4" />}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-bold">
              {mode === 'create' ? 'Capture a memory' : 'Edit memory'}
            </p>
            <p className="text-[10px] text-muted-foreground">
              {mode === 'create'
                ? 'Add durable knowledge with retrieval metadata.'
                : 'Update content without losing provenance.'}
            </p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            <X className="size-3.5" /> Cancel
          </Button>
          <Button type="submit" size="sm" disabled={busy || !draft.text.trim()}>
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : mode === 'create' ? (
              <Plus className="size-3.5" />
            ) : (
              <Save className="size-3.5" />
            )}
            {busy ? 'Saving…' : mode === 'create' ? 'Create memory' : 'Save changes'}
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 md:p-5">
        <div className="mx-auto max-w-4xl space-y-5">
          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <section className="border border-border/75 bg-card/45 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-[0.14em]">Knowledge</h3>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Write the durable fact or decision in complete, searchable language.
                </p>
              </div>
              <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                {draft.text.length} chars
              </span>
            </div>
            <label htmlFor="memory-text" className="sr-only">
              Memory content
            </label>
            <textarea
              ref={textRef}
              id="memory-text"
              value={draft.text}
              onChange={(event) => set('text', event.target.value)}
              rows={7}
              required
              placeholder="Example: WebUI state is owned by Zustand stores; server messages update those stores through singleton WebSocket handlers."
              className="min-h-36 w-full resize-y border border-input bg-background/75 px-3 py-3 text-sm leading-6 text-foreground shadow-inner placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </section>

          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="min-w-0">
              <label
                htmlFor="memory-kind"
                className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground"
              >
                Kind
              </label>
              <select
                id="memory-kind"
                value={draft.kind}
                onChange={(event) => set('kind', event.target.value)}
                className="h-10 w-full border border-input bg-background px-3 text-sm"
              >
                {MEMORY_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
            </div>
            {mode === 'create' ? (
              <div className="min-w-0">
                <label
                  htmlFor="memory-scope"
                  className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground"
                >
                  Scope
                </label>
                <select
                  id="memory-scope"
                  value={draft.scope}
                  onChange={(event) => set('scope', event.target.value as SageScope)}
                  className="h-10 w-full border border-input bg-background px-3 text-sm"
                >
                  {MEMORY_SCOPES.map((scope) => (
                    <option key={scope} value={scope}>
                      {scope}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="min-w-0">
                <label
                  htmlFor="memory-status"
                  className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground"
                >
                  Lifecycle status
                </label>
                <select
                  id="memory-status"
                  value={draft.status}
                  onChange={(event) => set('status', event.target.value as SageStatus)}
                  className="h-10 w-full border border-input bg-background px-3 text-sm"
                >
                  {EDITABLE_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className={cn('min-w-0', mode === 'create' ? 'sm:col-span-2 lg:col-span-1' : '')}>
              <label
                htmlFor="memory-tags"
                className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground"
              >
                Tags
              </label>
              <Input
                id="memory-tags"
                value={draft.tags}
                onChange={(event) => set('tags', event.target.value)}
                placeholder="architecture, webui, workflow"
                className="h-10 bg-background"
              />
            </div>
          </section>

          <section className="grid gap-3 sm:grid-cols-3">
            <RangeField
              id="memory-importance"
              label="Importance"
              value={draft.importance}
              onChange={(value) => set('importance', value)}
            />
            <RangeField
              id="memory-confidence"
              label="Confidence"
              value={draft.confidence}
              onChange={(value) => set('confidence', value)}
            />
            <RangeField
              id="memory-freshness"
              label="Freshness"
              value={draft.freshness}
              onChange={(value) => set('freshness', value)}
            />
          </section>

          <section className="border border-border/75 bg-card/45 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-[0.14em]">Anchors</h3>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Bind knowledge to files, symbols, packages, tests, Git paths, or commands.
                </p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={addAnchor}>
                <Plus className="size-3.5" /> Add anchor
              </Button>
            </div>
            {draft.anchors.length === 0 ? (
              <button
                type="button"
                onClick={addAnchor}
                className="mt-4 flex w-full items-center justify-center gap-2 border border-dashed border-border px-4 py-7 text-xs text-muted-foreground transition-colors hover:border-info/50 hover:bg-info/5 hover:text-info"
              >
                <Link2 className="size-4" /> No anchors yet — add one to improve retrieval precision
              </button>
            ) : (
              <div className="mt-4 space-y-2">
                {draft.anchors.map((anchor, index) => (
                  <div
                    key={`${anchor.type}:${index}`}
                    className="grid gap-2 border border-border/65 bg-background/40 p-2 sm:grid-cols-[9rem_minmax(0,1fr)_auto]"
                  >
                    <label className="sr-only" htmlFor={`anchor-type-${index}`}>
                      Anchor {index + 1} type
                    </label>
                    <select
                      id={`anchor-type-${index}`}
                      value={anchor.type}
                      onChange={(event) => {
                        const type = event.target.value as SageAnchor['type'];
                        const replacement: SageAnchor =
                          type === 'command'
                            ? { type, command: '' }
                            : type === 'agent'
                              ? { type, role: '' }
                              : { type, path: '' };
                        const anchors = draft.anchors.map((item, itemIndex) =>
                          itemIndex === index ? replacement : item,
                        );
                        set('anchors', anchors);
                      }}
                      className="h-10 border border-input bg-background px-2 text-xs"
                    >
                      {ANCHOR_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {type}
                        </option>
                      ))}
                    </select>
                    <div
                      className={cn(
                        'grid min-w-0 gap-2',
                        anchor.type === 'symbol' && 'sm:grid-cols-[minmax(0,1fr)_11rem]',
                      )}
                    >
                      <label className="sr-only" htmlFor={`anchor-value-${index}`}>
                        Anchor {index + 1} value
                      </label>
                      <Input
                        id={`anchor-value-${index}`}
                        list={anchor.type === 'agent' ? 'memory-agent-role-options' : undefined}
                        value={anchorValue(anchor)}
                        onChange={(event) => {
                          const anchors = draft.anchors.map((item, itemIndex) =>
                            itemIndex === index
                              ? updateAnchorValue(item, event.target.value)
                              : item,
                          );
                          set('anchors', anchors);
                        }}
                        placeholder={
                          anchor.type === 'command'
                            ? 'pnpm test --filter webui'
                            : anchor.type === 'agent'
                              ? 'reviewer'
                              : 'packages/webui/src/App.tsx'
                        }
                        className="h-10 min-w-0 bg-background font-mono text-xs"
                      />
                      {anchor.type === 'symbol' && (
                        <>
                          <label className="sr-only" htmlFor={`anchor-symbol-${index}`}>
                            Anchor {index + 1} symbol
                          </label>
                          <Input
                            id={`anchor-symbol-${index}`}
                            value={anchor.symbol ?? ''}
                            onChange={(event) => {
                              const anchors = draft.anchors.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, symbol: event.target.value }
                                  : item,
                              );
                              set('anchors', anchors);
                            }}
                            placeholder="Symbol name"
                            className="h-10 bg-background font-mono text-xs"
                          />
                        </>
                      )}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove anchor ${index + 1}`}
                      onClick={() =>
                        set(
                          'anchors',
                          draft.anchors.filter((_, itemIndex) => itemIndex !== index),
                        )
                      }
                    >
                      <Trash2 className="size-4 text-destructive" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <datalist id="memory-agent-role-options">
              {agentRoles.map((role) => (
                <option key={role} value={role} />
              ))}
            </datalist>
          </section>

          <section className="grid gap-3 border border-border/75 bg-card/45 p-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <h3 className="text-xs font-bold uppercase tracking-[0.14em]">Relationships</h3>
              <p className="mt-1 text-[10px] text-muted-foreground">
                Reference exact memory IDs. Relationships are validated and graph edges are rebuilt
                by SAGE.
              </p>
            </div>
            <div>
              <label
                htmlFor="memory-supersedes"
                className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground"
              >
                Supersedes
              </label>
              <Input
                id="memory-supersedes"
                value={draft.supersedes}
                onChange={(event) => set('supersedes', event.target.value)}
                placeholder="mem_id, mem_id"
                className="h-10 bg-background font-mono text-xs"
              />
            </div>
            <div>
              <label
                htmlFor="memory-contradicts"
                className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground"
              >
                Contradicts
              </label>
              <Input
                id="memory-contradicts"
                value={draft.contradicts}
                onChange={(event) => set('contradicts', event.target.value)}
                placeholder="mem_id, mem_id"
                className="h-10 bg-background font-mono text-xs"
              />
            </div>
          </section>
          <section className="space-y-2">
            <h3 className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Audience (Optional)
            </h3>
            <p className="text-[10px] text-muted-foreground/70">
              Target this memory to specific agent types. Leave empty for general project memory.
            </p>
            <div>
              <label
                htmlFor="memory-audience-roles"
                className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground"
              >
                Roles
              </label>
              <Input
                id="memory-audience-roles"
                value={draft.audienceRoles}
                onChange={(event) => set('audienceRoles', event.target.value)}
                placeholder="reviewer, refactor-planner"
                className="h-9 bg-background font-mono text-xs"
              />
            </div>
            <div>
              <label
                htmlFor="memory-audience-task-types"
                className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground"
              >
                Task types
              </label>
              <Input
                id="memory-audience-task-types"
                value={draft.audienceTaskTypes}
                onChange={(event) => set('audienceTaskTypes', event.target.value)}
                placeholder="review, refactor, bugfix"
                className="h-9 bg-background font-mono text-xs"
              />
            </div>
            <div>
              <label
                htmlFor="memory-audience-modes"
                className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground"
              >
                Modes
              </label>
              <Input
                id="memory-audience-modes"
                value={draft.audienceModes}
                onChange={(event) => set('audienceModes', event.target.value)}
                placeholder="teach, code-review"
                className="h-9 bg-background font-mono text-xs"
              />
            </div>
          </section>
        </div>
      </div>
    </form>
  );
}

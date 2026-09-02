import {
  Activity,
  Braces,
  Check,
  Gauge,
  Layers3,
  Search,
  ShieldCheck,
  Terminal,
  Wrench,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  ExternalDoc,
  PageHero,
  PageNext,
  SectionIntro,
  heroTitleFontSize,
} from '@/components/site/primitives';
import {
  PLUGIN_COUNT,
  TOOL_COUNT,
  toolCatalog,
  toolCategories,
  toolSlug,
} from '@/data/runtime-catalog';
import { Link } from '@/lib/router';
import { cn } from '@/lib/utils';

/** Derived permission/mutability counts — always match the catalog. */
const AUTO_COUNT = toolCatalog.filter((t) => t.permission === 'auto').length;
const CONFIRM_COUNT = toolCatalog.filter((t) => t.permission === 'confirm').length;
const READONLY_COUNT = toolCatalog.filter((t) => !t.mutating).length;
const MUTATING_COUNT = toolCatalog.filter((t) => t.mutating).length;

/**
 * Tool count exposed to the provider for each token-saving tier. These values
 * mirror `packages/tools/src/tool-tier.ts` (`BUILTIN_TIER_COUNTS`) exactly so
 * the marketing page never disagrees with the runtime. Update both together if
 * the tier sets change — regenerate the numbers by importing
 * `BUILTIN_TIER_COUNTS` from packages/tools/src/tool-tier.ts and reading its
 * values (current: off=70, minimal/light/aggressive=23, medium=43).
 *
 *   off       → every registered tool
 *   minimal   → TIER1 only (23)
 *   light     → TIER1 only (23) — same membership as minimal, different guidance
 *   medium    → TIER1 ∪ TIER2 (23 + 20 = 43)
 *   aggressive → TIER1 only (23) — narrowest surface
 */
const TOOL_TIER_COUNTS = {
  off: TOOL_COUNT,
  minimal: 23,
  light: 23,
  medium: 43,
  aggressive: 23,
} as const;

type ToolScope = 'all' | 'auto' | 'confirm' | 'read-only' | 'mutating';

const scopeOptions: Array<{ value: ToolScope; label: string }> = [
  { value: 'all', label: `All ${TOOL_COUNT}` },
  { value: 'auto', label: 'Auto' },
  { value: 'confirm', label: 'Confirm' },
  { value: 'read-only', label: 'Read-only' },
  { value: 'mutating', label: 'Mutating' },
];

const categoryIcons = [Activity, Braces, Terminal, Layers3, Check, Gauge, Wrench, Search] as const;

export function ToolsPage() {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<ToolScope>('all');
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      toolCatalog.filter((tool) => {
        const matchesQuery =
          !normalizedQuery ||
          tool.name.toLowerCase().includes(normalizedQuery) ||
          tool.summary.toLowerCase().includes(normalizedQuery) ||
          tool.category.toLowerCase().includes(normalizedQuery);
        const matchesScope =
          scope === 'all' ||
          tool.permission === scope ||
          (scope === 'read-only' && !tool.mutating) ||
          (scope === 'mutating' && tool.mutating);
        return matchesQuery && matchesScope;
      }),
    [normalizedQuery, scope],
  );

  return (
    <>
      <PageHero
        index="20"
        eyebrow="Built-in tool atlas"
        titleFontSize={heroTitleFontSize('One safety contract.')}
        title={
          <>
            {`${TOOL_COUNT} tools.`}
            <br />
            <span className="text-brand">One safety contract.</span>
          </>
        }
        description={`WrongStack does more than generate text. Its ${TOOL_COUNT} built-in tools read repositories, edit files, run quality gates, control a first-party browser and coordinate work — all through the same schema, permission and cancellation boundary.`}
        aside={
          <div className="flex flex-col gap-3">
            <ExternalDoc path="packages/tools/src/builtin.ts">
              Inspect the live registry
            </ExternalDoc>
            <Link href="/commands/tools" className="text-sm font-bold text-brand-2 hover:underline">
              Learn the /tools command →
            </Link>
          </div>
        }
      />

      <section className="border-b border-line bg-surface">
        <div className="mx-auto grid max-w-[1380px] grid-cols-2 gap-px bg-line px-4 sm:grid-cols-3 sm:px-6 lg:grid-cols-6 lg:px-10">
          {[
            [String(TOOL_COUNT), 'built-in tools'],
            [String(AUTO_COUNT), 'auto permission'],
            [String(CONFIRM_COUNT), 'confirm first'],
            [String(READONLY_COUNT), 'read-only'],
            [String(MUTATING_COUNT), 'mutating'],
            [String(toolCategories.length), 'tool families'],
          ].map(([value, label], index) => (
            <div key={label} className="bg-surface px-4 py-7 text-center">
              <strong
                className={cn(
                  'font-mono text-3xl font-black',
                  index % 2 ? 'text-brand-2' : 'text-brand',
                )}
              >
                {value}
              </strong>
              <span className="mt-1 block text-xs font-black uppercase tracking-[0.16em] text-faint">
                {label}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="01"
          eyebrow="Execution contract"
          title="A tool call is a controlled transaction, not an unchecked shell escape."
          description="Every built-in follows the same lifecycle. The model proposes structured input; WrongStack decides whether and how that proposal may become an action."
        />
        <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-4">
          {[
            [
              '01',
              'Parse & validate',
              'Streamed JSON is repaired conservatively, coerced once against JSON Schema and rejected when it cannot be made lossless.',
            ],
            [
              '02',
              'Authorize',
              'The tool declaration, user policy, hook decisions and YOLO deny rules resolve before execution starts.',
            ],
            [
              '03',
              'Execute & cancel',
              'Abort signals reach subprocesses, file walks, browser operations and MCP proxies. Mutators check again before atomic writes.',
            ],
            [
              '04',
              'Observe & persist',
              'Progress events stream live. Final output passes the tool-call pipeline and joins the reconstructable session record.',
            ],
          ].map(([index, title, body]) => (
            <article key={title} className="bg-card p-6 sm:p-7">
              <span className="font-mono text-xs font-black text-brand-2">{index}</span>
              <h2 className="mt-8 text-xl font-black text-fg">{title}</h2>
              <p className="mt-3 text-sm leading-7 text-muted">{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="02"
            eyebrow="Complete inventory"
            title="Search every tool that ships in the runtime."
            description="This catalog is derived from packages/tools/src/builtin.ts. Filter by what a tool does, whether it can mutate state and whether it needs an explicit confirmation."
          />

          <div className="mt-10 rounded-2xl border border-line bg-card p-3 sm:p-4">
            <label className="flex items-center gap-3 rounded-xl border border-line bg-bg px-4 py-3">
              <Search className="size-4 text-brand-2" />
              <span className="sr-only">Search tools</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search tools, capabilities or families…"
                className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-faint"
              />
              <span className="font-mono text-xs font-black text-faint">
                {filtered.length} / {TOOL_COUNT}
              </span>
            </label>
            <div className="mt-3 flex flex-wrap gap-2">
              {scopeOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setScope(option.value)}
                  className={cn(
                    'rounded-full border px-3.5 py-2 text-xs font-black transition-colors',
                    scope === option.value
                      ? 'border-brand-2 bg-brand-2 text-ink'
                      : 'border-line bg-bg text-muted hover:border-line-strong hover:text-fg',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-12 space-y-14">
            {toolCategories.map((category, categoryIndex) => {
              const tools = filtered.filter((tool) => tool.category === category);
              if (tools.length === 0) return null;
              const Icon = categoryIcons[categoryIndex] ?? Wrench;
              return (
                <div key={category}>
                  <div className="mb-5 flex items-center justify-between border-b border-line pb-4">
                    <div className="flex items-center gap-3">
                      <span className="grid size-9 place-items-center rounded-lg border border-line bg-bg text-brand">
                        <Icon className="size-4" />
                      </span>
                      <h2 className="text-xl font-black text-fg">{category}</h2>
                    </div>
                    <span className="font-mono text-xs font-black text-faint">{tools.length}</span>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {tools.map((tool) => (
                      <Link
                        key={tool.name}
                        href={`/tools/${toolSlug(tool.name)}`}
                        className="group block rounded-xl border border-line bg-card p-5 transition-all hover:-translate-y-0.5 hover:border-line-strong hover:shadow-lg"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <code className="break-all font-mono text-sm font-black text-fg group-hover:text-brand">
                            {tool.name}
                          </code>
                          <span
                            className={cn(
                              'shrink-0 rounded-full px-2 py-1 font-mono text-xs font-black uppercase tracking-[0.08em]',
                              tool.permission === 'auto'
                                ? 'bg-emerald-500/10 text-emerald-500'
                                : 'bg-amber-500/10 text-amber-500',
                            )}
                          >
                            {tool.permission}
                          </span>
                        </div>
                        <p className="mt-3 text-sm leading-6 text-muted">{tool.summary}</p>
                        <div className="mt-5 flex items-center gap-2 font-mono text-xs font-black uppercase tracking-[0.1em] text-faint">
                          <span className={tool.mutating ? 'text-brand' : 'text-brand-2'}>
                            {tool.mutating ? 'mutating' : 'read-only'}
                          </span>
                          <span>·</span>
                          <span>JSON Schema</span>
                          {tool.name === 'document' && (
                            <>
                              <span>·</span>
                              <span className="text-amber-500">deprecated preview</span>
                            </>
                          )}
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          {filtered.length === 0 && (
            <div className="mt-10 rounded-2xl border border-dashed border-line p-12 text-center text-sm text-muted">
              No tool matches this filter. Try a name such as <code>browser</code>, <code>git</code>{' '}
              or <code>codebase</code>.
            </div>
          )}
        </div>
      </section>

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="03"
          eyebrow="Context economics"
          title="Register less when the model window matters more."
          description="Token-saving tiers reduce the tool schema sent to the model. The runtime still keeps the full open-source registry available when the tier is off."
        />
        <div className="mt-12 overflow-hidden rounded-2xl border border-line">
          {[
            [
              'off',
              String(TOOL_TIER_COUNTS.off),
              'The complete built-in registry, including browser and E2E tools.',
            ],
            [
              'minimal / light',
              String(TOOL_TIER_COUNTS.minimal),
              'Core read, edit, search, shell and patch primitives. Light changes guidance, not membership.',
            ],
            [
              'medium',
              String(TOOL_TIER_COUNTS.medium),
              'Adds project state, Git, quality, language, dependency and design operations.',
            ],
            [
              'aggressive',
              String(TOOL_TIER_COUNTS.aggressive),
              'Narrowest surface — tier-1 only — for maximum token savings.',
            ],
          ].map(([tier, count, body], index) => (
            <div
              key={tier}
              className="grid gap-3 border-b border-line bg-card p-5 last:border-b-0 sm:grid-cols-[180px_70px_1fr] sm:items-center"
            >
              <code className="font-mono text-sm font-black text-fg">{tier}</code>
              <strong className={index % 2 ? 'text-brand-2' : 'text-brand'}>{count} tools</strong>
              <p className="text-sm leading-6 text-muted">{body}</p>
            </div>
          ))}
        </div>
        <div className="mt-8 grid gap-5 lg:grid-cols-2">
          <article className="rounded-2xl border border-line bg-card p-6">
            <ShieldCheck className="size-5 text-brand" />
            <h2 className="mt-7 text-2xl font-black text-fg">
              Permission is not the same as mutability.
            </h2>
            <p className="mt-3 text-sm leading-7 text-muted">
              A read-only command may still require confirmation when it starts a process or touches
              an external system. A plugin hook may deny or rewrite input, but it cannot bypass the
              final permission policy.
            </p>
          </article>
          <article className="rounded-2xl border border-line bg-ink p-6 text-white">
            <Gauge className="size-5 text-brand-2" />
            <h2 className="mt-7 text-2xl font-black">Tune descriptions without hiding tools.</h2>
            <p className="mt-3 text-sm leading-7 text-zinc-400">
              Use <code className="text-brand">/tool &lt;name&gt; simple|extend</code> to change
              description detail, or <code className="text-brand-2">tools.disabledTools</code> to
              remove specific registrations from a session.
            </p>
          </article>
        </div>
      </section>

      <section className="border-y border-line bg-ink text-white">
        <div className="mx-auto grid max-w-[1380px] gap-8 px-4 py-16 sm:px-6 lg:grid-cols-[1fr_auto] lg:items-center lg:px-10">
          <div>
            <span className="font-mono text-xs font-black uppercase tracking-[0.2em] text-brand-2">
              OPEN SOURCE · FREE · MIT
            </span>
            <h2 className="mt-4 text-4xl font-black tracking-[-0.025em] sm:text-5xl">
              Read the implementation. Change the rules.
            </h2>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-400">
              WrongStack itself is free and open source. Bring your own provider credentials; any
              model API charges remain between you and that provider.
            </p>
          </div>
          <ExternalDoc path="packages/tools/src">Browse tool source</ExternalDoc>
        </div>
      </section>

      <PageNext
        label="Plugins"
        title="Extend the runtime without forking the kernel"
        body={`Explore all ${PLUGIN_COUNT} managed first-party plugins, their risk levels and explicit activation state.`}
        href="/plugins"
      />
    </>
  );
}

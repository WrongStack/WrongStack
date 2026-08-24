import {
  Blocks,
  Check,
  CircleDot,
  GitBranch,
  PackageCheck,
  PlugZap,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  ExternalDoc,
  PageHero,
  PageNext,
  SectionIntro,
  heroTitleFontSize,
} from '@/components/site/primitives';
import { pluginDetails } from '@/data/plugin-details';
import { pluginLlmProfile, pluginSearchTerms } from '@/data/plugin-operational';
import { PLUGIN_COUNT, pluginCatalog, pluginSlug, pluginSources } from '@/data/runtime-catalog';
import { Link } from '@/lib/router';
import { cn } from '@/lib/utils';

type PluginFilter =
  | 'all'
  | 'active'
  | 'inactive'
  | 'low'
  | 'medium'
  | 'high'
  | 'llm'
  | 'mutating'
  | 'hooks';

const filterOptions: Array<{ value: PluginFilter; label: string }> = [
  { value: 'all', label: `All ${pluginCatalog.length}` },
  { value: 'active', label: 'Active by default' },
  { value: 'inactive', label: 'Opt-in' },
  { value: 'low', label: 'Low risk' },
  { value: 'medium', label: 'Medium risk' },
  { value: 'high', label: 'High risk' },
  { value: 'llm', label: 'LLM / provider aware' },
  { value: 'mutating', label: 'Mutating tools' },
  { value: 'hooks', label: 'Lifecycle hooks' },
];

const catalogStats = {
  total: pluginCatalog.length,
  suite: pluginCatalog.filter((plugin) => plugin.source === 'Suite').length,
  core: pluginCatalog.filter((plugin) => plugin.source === 'Core').length,
  bridges: pluginCatalog.filter((plugin) => plugin.source === 'Bridge').length,
  active: pluginCatalog.filter((plugin) => plugin.defaultState === 'active').length,
  inactive: pluginCatalog.filter((plugin) => plugin.defaultState === 'inactive').length,
  llmAware: pluginCatalog.filter((plugin) => pluginLlmProfile(plugin.name).mode !== 'deterministic')
    .length,
  mutating: pluginCatalog.filter((plugin) =>
    pluginDetails[plugin.name]?.tools.some((tool) => tool.mutating),
  ).length,
};

const sourceDetails = {
  Core: {
    title: 'Core first-party plugins',
    body: 'Six host-level feature plugins composed by WrongStack itself: prompts, sync, cloud config sync, Chimera, skills and mid-session auto-review.',
  },
  Suite: {
    title: '@wrongstack/plugins suite',
    body: 'Sixty-five focused workflow, quality, security, provider-wire and developer-experience plugins available from one package.',
  },
  Bridge: {
    title: 'Interface bridges',
    body: 'Two explicitly installed integrations connect Language Server Protocol capabilities and Telegram operations to the same lifecycle.',
  },
} as const;

export function PluginsPage() {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<PluginFilter>('all');
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      pluginCatalog.filter((plugin) => {
        const detail = pluginDetails[plugin.name];
        const llm = pluginLlmProfile(plugin.name);
        const searchableDetail = [
          detail?.longDescription,
          ...(detail?.tools.map((tool) => `${tool.name} ${tool.summary ?? ''}`) ?? []),
          ...(detail?.hooks ?? []),
          ...(detail?.configOptions.map((option) => option.name) ?? []),
          pluginSearchTerms(plugin.name),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        const matchesQuery =
          !normalizedQuery ||
          plugin.name.toLowerCase().includes(normalizedQuery) ||
          plugin.summary.toLowerCase().includes(normalizedQuery) ||
          plugin.source.toLowerCase().includes(normalizedQuery) ||
          searchableDetail.includes(normalizedQuery);
        const matchesFilter =
          filter === 'all' ||
          plugin.defaultState === filter ||
          plugin.risk === filter ||
          (filter === 'llm' && llm.mode !== 'deterministic') ||
          (filter === 'mutating' && detail?.tools.some((tool) => tool.mutating) === true) ||
          (filter === 'hooks' && (detail?.hooks.length ?? 0) > 0);
        return matchesQuery && matchesFilter;
      }),
    [filter, normalizedQuery],
  );

  return (
    <>
      <PageHero
        index="21"
        eyebrow="Plugin field guide"
        titleFontSize={heroTitleFontSize(`${PLUGIN_COUNT} plugins.`)}
        title={
          <>
            {`${PLUGIN_COUNT} plugins.`}
            <br />
            <span className="text-brand-2">Explicit activation.</span>
          </>
        }
        description="Plugins add tools, commands, hooks, pipelines, providers, MCP connections and background behavior through a declared contract. WrongStack reports every managed first-party row with its effective state and risk before you switch it on."
        aside={
          <div className="flex flex-col gap-3">
            <ExternalDoc path="docs/plugin-author-guide.md">Read the author guide</ExternalDoc>
            <Link href="/commands/plugin" className="text-sm font-bold text-brand hover:underline">
              Learn the /plugin command →
            </Link>
          </div>
        }
      />

      <section className="border-b border-line bg-surface">
        <div className="mx-auto grid max-w-[1380px] grid-cols-2 gap-px bg-line px-4 sm:grid-cols-4 sm:px-6 lg:grid-cols-8 lg:px-10">
          {[
            [String(catalogStats.total), 'managed plugins'],
            [String(catalogStats.suite), 'suite plugins'],
            [String(catalogStats.core), 'core plugins'],
            [String(catalogStats.bridges), 'bridges'],
            [String(catalogStats.active), 'active defaults'],
            [String(catalogStats.inactive), 'explicit opt-in'],
            [String(catalogStats.llmAware), 'LLM / provider aware'],
            [String(catalogStats.mutating), 'mutating plugins'],
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
          eyebrow="Lifecycle"
          title="A plugin declares its reach before it gets a scoped API."
          description="The host validates identity, compatibility, dependencies, conflicts, configuration and capabilities before setup. Teardown is part of the contract, not a process-exit afterthought."
        />
        <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line md:grid-cols-2 xl:grid-cols-4">
          {[
            [
              PackageCheck,
              '01',
              'Declare',
              'Name, version, host compatibility, dependencies, conflicts and capability flags form the manifest boundary.',
            ],
            [
              ShieldAlert,
              '02',
              'Assess',
              'Risk and default state stay visible. High-impact Git, security and schema behaviors are opt-in or explicitly governed.',
            ],
            [
              PlugZap,
              '03',
              'Register',
              'The scoped API can add tools, providers, commands, hooks, prompt contributors, events, metrics and pipeline middleware.',
            ],
            [
              CircleDot,
              '04',
              'Operate',
              'Runtime health, config changes and per-plugin model routing remain inspectable; teardown removes owned registrations.',
            ],
          ].map(([Icon, index, title, body]) => {
            const ItemIcon = Icon as typeof PlugZap;
            return (
              <article key={String(title)} className="bg-card p-6 sm:p-7">
                <div className="flex items-center justify-between">
                  <ItemIcon className="size-5 text-brand" />
                  <span className="font-mono text-xs font-black text-brand-2">{String(index)}</span>
                </div>
                <h2 className="mt-8 text-xl font-black text-fg">{String(title)}</h2>
                <p className="mt-3 text-sm leading-7 text-muted">{String(body)}</p>
              </article>
            );
          })}
        </div>
        <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          {[
            ['Tools', 'Register or wrap executable capabilities.'],
            ['Pipelines', 'Observe or transform six agent stages.'],
            ['Commands', 'Add first-class slash workflows.'],
            ['Providers & MCP', 'Extend model and remote-tool transports.'],
            ['Hooks & events', 'Steer lifecycle decisions and publish state.'],
          ].map(([title, body], index) => (
            <div key={title} className="rounded-xl border border-line bg-surface p-5">
              <span
                className={cn(
                  'font-mono text-xs font-black',
                  index % 2 ? 'text-brand-2' : 'text-brand',
                )}
              >
                CAP 0{index + 1}
              </span>
              <h3 className="mt-5 font-black text-fg">{title}</h3>
              <p className="mt-2 text-xs leading-5 text-muted">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="02"
            eyebrow="Complete inventory"
            title="Every managed first-party plugin, in one searchable catalog."
            description="The inventory comes from the CLI plugin audit registry. Default state tells you what is active at boot; risk describes operational reach, not code quality."
          />
          <div className="mt-10 rounded-2xl border border-line bg-card p-3 sm:p-4">
            <label className="flex items-center gap-3 rounded-xl border border-line bg-bg px-4 py-3">
              <Search className="size-4 text-brand-2" />
              <span className="sr-only">Search plugins</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search plugins, behavior or source…"
                className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-faint"
              />
              <span className="font-mono text-xs font-black text-faint">
                {filtered.length} / {PLUGIN_COUNT}
              </span>
            </label>
            <div className="mt-3 flex flex-wrap gap-2">
              {filterOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setFilter(option.value)}
                  className={cn(
                    'rounded-full border px-3.5 py-2 text-xs font-black transition-colors',
                    filter === option.value
                      ? 'border-brand bg-brand text-white'
                      : 'border-line bg-bg text-muted hover:border-line-strong hover:text-fg',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-12 space-y-14">
            {pluginSources.map((source) => {
              const plugins = filtered.filter((plugin) => plugin.source === source);
              if (plugins.length === 0) return null;
              const details = sourceDetails[source];
              return (
                <div key={source}>
                  <div className="mb-6 grid gap-4 border-b border-line pb-5 lg:grid-cols-[.45fr_1fr] lg:items-end">
                    <div>
                      <span className="font-mono text-xs font-black uppercase tracking-[0.18em] text-brand-2">
                        {source} / {plugins.length}
                      </span>
                      <h2 className="mt-2 text-2xl font-black text-fg">{details.title}</h2>
                    </div>
                    <p className="max-w-3xl text-sm leading-6 text-muted">{details.body}</p>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {plugins.map((plugin) => {
                      const detail = pluginDetails[plugin.name];
                      const llm = pluginLlmProfile(plugin.name);
                      const mutating = detail?.tools.filter((tool) => tool.mutating).length ?? 0;
                      return (
                        <Link
                          key={plugin.name}
                          href={`/plugins/${pluginSlug(plugin.name)}`}
                          className="group block rounded-xl border border-line bg-card p-5 transition-all hover:-translate-y-0.5 hover:border-line-strong hover:shadow-lg"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <code className="break-all font-mono text-sm font-black text-fg group-hover:text-brand-2">
                              {plugin.name}
                            </code>
                            <span
                              className={cn(
                                'shrink-0 rounded-full px-2 py-1 font-mono text-xs font-black uppercase tracking-[0.08em]',
                                plugin.risk === 'high'
                                  ? 'bg-red-500/10 text-red-500'
                                  : plugin.risk === 'medium'
                                    ? 'bg-amber-500/10 text-amber-500'
                                    : 'bg-emerald-500/10 text-emerald-500',
                              )}
                            >
                              {plugin.risk} risk
                            </span>
                          </div>
                          <p className="mt-3 text-sm leading-6 text-muted">{plugin.summary}</p>
                          <div className="mt-4 flex flex-wrap gap-2 font-mono text-xs font-black uppercase tracking-[0.08em] text-faint">
                            <span className="rounded-full border border-line bg-bg px-2.5 py-1">
                              {detail?.tools.length ?? 0} tools
                            </span>
                            <span className="rounded-full border border-line bg-bg px-2.5 py-1">
                              {detail?.hooks.length ?? 0} hooks
                            </span>
                            {mutating > 0 && (
                              <span className="rounded-full border border-brand-2/20 bg-brand-2/10 px-2.5 py-1 text-brand-2">
                                {mutating} mutating
                              </span>
                            )}
                            {llm.mode !== 'deterministic' && (
                              <span className="rounded-full border border-brand/20 bg-brand/10 px-2.5 py-1 text-brand">
                                {llm.label}
                              </span>
                            )}
                          </div>
                          <div className="mt-5 flex items-center justify-between border-t border-line pt-4 font-mono text-xs font-black uppercase tracking-[0.1em]">
                            <span
                              className={
                                plugin.defaultState === 'active' ? 'text-emerald-500' : 'text-faint'
                              }
                            >
                              {plugin.defaultState === 'active'
                                ? 'active default'
                                : 'explicit opt-in'}
                            </span>
                            <span className="text-faint">{plugin.source}</span>
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          {filtered.length === 0 && (
            <div className="mt-10 rounded-2xl border border-dashed border-line p-12 text-center text-sm text-muted">
              No plugin matches this filter. Try <code>security</code>, <code>test</code>,{' '}
              <code>provider</code> or <code>mailbox</code>.
            </div>
          )}
        </div>
      </section>

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="03"
          eyebrow="Provider wire"
          title="Plugins can shape an LLM call without owning your keys."
          description="Each plugin follows the session provider by default and can receive its own provider/model override. Credentials stay in the host vault; the scoped api.llm surface resolves routing for every call."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-[1.1fr_.9fr]">
          <div className="overflow-hidden rounded-2xl border border-line bg-ink p-6 text-white sm:p-8">
            <div className="flex items-center gap-2 border-b border-white/10 pb-5 font-mono text-xs font-black uppercase tracking-[0.15em] text-zinc-500">
              <GitBranch className="size-4 text-brand-2" /> Provider wrapper order
            </div>
            {[
              ['01', 'llm-cache', 'Return a safe cached match before transport work.'],
              ['02', 'model-router', 'Choose a provider/model by request size and tool use.'],
              ['03', 'prompt-firewall', 'Inspect and redact provider-bound secrets.'],
              ['04', 'auto-escalate', 'Move through a bounded recovery ladder.'],
              ['05', 'token-throttle', 'Delay calls against a rolling token window.'],
            ].map(([index, name, body]) => (
              <div
                key={name}
                className="grid gap-2 border-b border-white/10 py-4 last:border-b-0 sm:grid-cols-[40px_150px_1fr] sm:items-center"
              >
                <span className="font-mono text-xs font-black text-brand">{index}</span>
                <code className="font-mono text-xs font-black text-white">{name}</code>
                <p className="text-xs leading-5 text-zinc-400">{body}</p>
              </div>
            ))}
          </div>
          <div className="rounded-2xl border border-line bg-card p-6 sm:p-8">
            <SlidersHorizontal className="size-5 text-brand" />
            <h2 className="mt-7 text-2xl font-black text-fg">
              Route one plugin, not the whole session.
            </h2>
            <div className="mt-6 overflow-hidden rounded-xl border border-line bg-bg font-mono text-xs text-muted">
              {[
                'wstack plugin report',
                'wstack plugin enable secret-scanner',
                'wstack plugin llm auto-doc anthropic <model>',
                'wstack plugin llm auto-doc --clear',
              ].map((command) => (
                <code
                  key={command}
                  className="block border-b border-line px-4 py-3 last:border-b-0"
                >
                  <span className="mr-3 text-brand-2">❯</span>
                  {command}
                </code>
              ))}
            </div>
            <p className="mt-5 text-xs leading-6 text-muted">
              The chat leader remains the fallback. Per-call overrides can narrow routing further
              when a plugin needs a specialist model.
            </p>
          </div>
        </div>
      </section>

      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 lg:px-10">
          <SectionIntro
            index="04"
            eyebrow="Build your own"
            title="A small setup function can enter the whole runtime."
            description="Declare only the capabilities you need. The host scopes ownership so registrations can be audited and removed cleanly."
          />
          <div className="mt-10 grid gap-6 lg:grid-cols-[1fr_.75fr]">
            <pre className="overflow-x-auto rounded-2xl border border-white/10 bg-ink p-6 font-mono text-xs leading-7 text-zinc-300">
              <code>{`export default {
  name: 'my-plugin',
  version: '1.0.0',
  capabilities: {
    tools: true,
    slashCommands: true,
    pipelines: true,
  },
  async setup(api) {
    api.tools.register(myTool);
    api.slashCommands.register(myCommand);
    api.onEvent('tool.executed', observe);
  },
  async teardown() {
    // close plugin-owned resources
  },
};`}</code>
            </pre>
            <div className="rounded-2xl border border-line bg-card p-6">
              <Sparkles className="size-5 text-brand-2" />
              <h2 className="mt-7 text-2xl font-black text-fg">No private extension tax.</h2>
              <p className="mt-3 text-sm leading-7 text-muted">
                The plugin API, examples and all first-party plugin implementations are open. Start
                with one command or hook, then grow only when the contract demands it.
              </p>
              <ul className="mt-6 space-y-3 text-sm text-muted">
                {[
                  'JSON Schema config validation',
                  'Automatic ownership and cleanup',
                  'Scoped logs, metrics and session events',
                  'Runtime configuration change callbacks',
                ].map((item) => (
                  <li key={item} className="flex gap-3">
                    <Check className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                    {item}
                  </li>
                ))}
              </ul>
              <div className="mt-7">
                <ExternalDoc path="packages/plugins/src">Browse plugin source</ExternalDoc>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="bg-ink text-white">
        <div className="mx-auto grid max-w-[1380px] gap-8 px-4 py-16 sm:px-6 lg:grid-cols-[1fr_auto] lg:items-center lg:px-10">
          <div>
            <span className="font-mono text-xs font-black uppercase tracking-[0.2em] text-brand">
              OPEN SOURCE · FREE · MIT LICENSED
            </span>
            <h2 className="mt-4 text-4xl font-black tracking-[-0.025em] sm:text-5xl">
              Fork the plugin. Fork the product. Keep shipping.
            </h2>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-400">
              WrongStack has no paid runtime tier and no proprietary plugin gate. External model
              APIs or third-party services may charge their own fees.
            </p>
          </div>
          <a
            href="https://github.com/WrongStack/WrongStack"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-full bg-brand-2 px-5 py-3 text-sm font-black text-ink transition-transform hover:-translate-y-0.5"
          >
            <Blocks className="size-4" /> Explore on GitHub
          </a>
        </div>
      </section>

      <PageNext
        label="Ecosystem"
        title="Connect plugins, skills, MCP and lifecycle hooks"
        body="See where each extension system fits and which trust boundary it crosses."
        href="/ecosystem"
      />
    </>
  );
}

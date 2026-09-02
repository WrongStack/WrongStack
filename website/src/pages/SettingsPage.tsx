import {
  ArrowDown,
  BrainCircuit,
  Check,
  LockKeyhole,
  PackageOpen,
  Settings2,
  ShieldAlert,
  Sparkles,
  X,
} from 'lucide-react';
import { ExternalDoc, PageHero, PageNext, SectionIntro } from '@/components/site/primitives';
import { settingGroups } from '@/data/content';
import { Link } from '@/lib/router';

const precedence = [
  ['01', 'CLI flags', 'Session-only override'],
  ['02', 'Extra config sources', 'Explicit additional layers'],
  ['03', 'Environment', 'Process and deployment'],
  ['04', 'In-project', 'Safe preferences only'],
  ['05', 'Project-private', 'Sensitive project overrides'],
  ['06', 'Global config', 'Developer defaults'],
  ['07', 'Built-in defaults', 'Stable fallback'],
] as const;

const sample = `{
  "version": 1,
  "provider": "openai-codex",
  "model": "configured-model",
  "fallbackModels": ["anthropic/backup-model"],
  "context": {
    "mode": "balanced",
    "strategy": "hybrid",
    "autoCompact": true
  },
  "tools": {
    "defaultExecutionStrategy": "smart",
    "loopDetection": { "mode": "steer-then-cut" }
  }
}`;

export function SettingsPage() {
  return (
    <>
      <PageHero
        index="05"
        eyebrow="Settings"
        title={
          <>
            Your defaults.
            <br />
            <span className="text-brand">Your boundaries.</span>
          </>
        }
        description="WrongStack configuration is layered so you can set durable personal defaults, private project behavior and temporary session overrides without putting secrets in a repository."
        aside={
          <ExternalDoc path="docs/configuration.md">Open full configuration reference</ExternalDoc>
        }
      />

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="01"
          eyebrow="Precedence"
          title="The closest explicit choice wins."
          description="When multiple layers define the same field, WrongStack resolves them in a stable order. Sensitive project-specific values belong outside the repository."
        />
        <div className="mt-14 grid gap-6 lg:grid-cols-[1fr_.8fr]">
          <div className="space-y-2">
            {precedence.map(([number, name, description], index) => (
              <div key={name}>
                <div className="grid grid-cols-[42px_1fr_auto] items-center gap-3 rounded-xl border border-line bg-card p-4 sm:p-5">
                  <span className="font-mono text-xs font-black text-brand-2">{number}</span>
                  <strong className="text-sm text-fg">{name}</strong>
                  <span className="text-right text-xs text-muted">{description}</span>
                </div>
                {index < precedence.length - 1 && (
                  <ArrowDown className="mx-auto my-1 size-4 text-faint" />
                )}
              </div>
            ))}
          </div>
          <div className="rounded-2xl border border-line bg-ink p-5 text-zinc-300 sm:p-7">
            <div className="flex items-center justify-between border-b border-white/10 pb-4">
              <span className="font-mono text-xs font-black uppercase tracking-[0.16em] text-zinc-500">
                ~/.wrongstack/profiles/&lt;name&gt;/config.json
              </span>
              <span className="size-2 rounded-full bg-emerald-400" />
            </div>
            <pre className="mt-5 overflow-x-auto font-mono text-xs leading-6 text-zinc-400">
              <code>{sample}</code>
            </pre>
          </div>
        </div>
      </section>

      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="02"
            eyebrow="Reference"
            title="The settings that shape daily work."
            description="This is the practical map. The source configuration reference contains the complete schema and every nested field."
          />
          <div className="mt-12 grid gap-5 lg:grid-cols-2">
            {settingGroups.map((group) => (
              <article
                key={group.name}
                className="overflow-hidden rounded-2xl border border-line bg-card"
              >
                <header className="flex gap-4 border-b border-line p-6">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-line bg-bg text-brand">
                    <group.icon className="size-4.5" />
                  </span>
                  <div>
                    <h2 className="text-lg font-black tracking-[-0.025em] text-fg">{group.name}</h2>
                    <p className="mt-1 text-sm leading-6 text-muted">{group.description}</p>
                  </div>
                </header>
                <div>
                  {group.fields.map((field) => (
                    <div
                      key={field.key}
                      className="grid gap-2 border-b border-line px-5 py-4 last:border-b-0 sm:grid-cols-[1fr_110px] sm:px-6"
                    >
                      <div>
                        <code className="font-mono text-xs font-bold text-brand">{field.key}</code>
                        <p className="mt-1 text-xs leading-5 text-muted">{field.explanation}</p>
                      </div>
                      <code className="h-fit w-fit rounded-md bg-bg px-2 py-1 font-mono text-xs text-faint sm:justify-self-end">
                        {field.defaultValue}
                      </code>
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="03"
          eyebrow="Customization map"
          title="Customize the model, the knowledge, the actions and the guardrails."
          description="WrongStack treats customization as typed runtime composition. Teams can build a house style without maintaining a private fork."
        />
        <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line md:grid-cols-2 lg:grid-cols-4">
          {[
            [
              Sparkles,
              'Thinking',
              'Providers, model routes, reasoning controls and fallback profiles.',
            ],
            [PackageOpen, 'Knowledge', 'AGENTS.md, skills, prompts, memory and repository index.'],
            [
              Settings2,
              'Execution',
              'Tools, MCP, hooks, plugins, permissions and interface preferences.',
            ],
            [
              BrainCircuit,
              'Governance',
              'Brain risk ceiling, Council voters, budgets and fleet supervision.',
            ],
          ].map(([Icon, title, body]) => {
            const ItemIcon = Icon as typeof Sparkles;
            return (
              <article key={String(title)} className="bg-card p-6">
                <ItemIcon className="size-5 text-brand" />
                <h2 className="mt-8 font-black text-fg">{String(title)}</h2>
                <p className="mt-3 text-sm leading-6 text-muted">{String(body)}</p>
              </article>
            );
          })}
        </div>
        <Link
          href="/features/customization"
          className="mt-8 inline-flex items-center gap-2 text-sm font-black text-brand"
        >
          Open the complete customization deep dive →
        </Link>
      </section>

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="04"
          eyebrow="Trust boundary"
          title="A checked-in config file is input from someone else."
          description="A cloned repository can control benign preferences, but it cannot silently install an MCP server, run a hook, redirect your provider traffic or turn on YOLO."
        />
        <div className="mt-12 grid gap-5 lg:grid-cols-2">
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-6 sm:p-8">
            <div className="flex items-center gap-3">
              <Check className="size-5 text-emerald-500" />
              <h2 className="font-black text-fg">Allowed in the repository</h2>
            </div>
            <p className="mt-4 text-sm leading-7 text-muted">
              Benign preferences such as model choice, context behavior, normal tool settings,
              feature flags, autonomy preferences, indexing, session, log and launch settings—after
              nested safety guards.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              {['context', 'features', 'indexing', 'session', 'log', 'launch'].map((key) => (
                <code
                  key={key}
                  className="rounded-full border border-emerald-500/15 bg-card px-3 py-1.5 font-mono text-xs text-emerald-600 dark:text-emerald-400"
                >
                  {key}
                </code>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border border-brand/20 bg-brand/5 p-6 sm:p-8">
            <div className="flex items-center gap-3">
              <X className="size-5 text-brand" />
              <h2 className="font-black text-fg">Always stripped from the repository</h2>
            </div>
            <p className="mt-4 text-sm leading-7 text-muted">
              Provider credentials and endpoints, MCP servers, hooks, plugins, sync, YOLO,
              extensions, HQ, ACP and fleet configuration. New top-level fields are denied until
              classified explicitly.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              {['apiKey', 'baseUrl', 'mcpServers', 'hooks', 'plugins', 'yolo', 'fleet'].map(
                (key) => (
                  <code
                    key={key}
                    className="rounded-full border border-brand/15 bg-card px-3 py-1.5 font-mono text-xs text-brand"
                  >
                    {key}
                  </code>
                ),
              )}
            </div>
          </div>
        </div>
        <div className="mt-5 flex items-start gap-4 rounded-2xl border border-line bg-card p-6">
          <LockKeyhole className="mt-0.5 size-5 shrink-0 text-brand" />
          <div>
            <h3 className="font-black text-fg">Where private project settings go</h3>
            <code className="mt-2 block font-mono text-xs text-brand">
              ~/.wrongstack/projects/&lt;slug&gt;/config.local.json
            </code>
            <p className="mt-2 text-sm leading-6 text-muted">
              This file is project-specific but lives outside the repository, so it can safely
              contain MCP, hooks, provider endpoints and fleet policy.
            </p>
          </div>
        </div>
      </section>

      <section className="border-t border-line bg-ink text-white">
        <div className="mx-auto grid max-w-[1380px] gap-8 px-4 py-16 sm:px-6 lg:grid-cols-[80px_1fr_auto] lg:items-center lg:px-10 lg:py-20">
          <span className="grid size-14 place-items-center rounded-full bg-brand/10 text-brand">
            <ShieldAlert className="size-6" />
          </span>
          <div>
            <h2 className="text-2xl font-black tracking-[-0.035em]">
              Secrets never need to live as plaintext.
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
              API keys written to the user config are auto-migrated into the per-machine secret
              vault. Subscription tokens use the same encrypted-at-rest boundary.
            </p>
          </div>
          <ExternalDoc path="docs/configuration.md#secrets">Read secrets guide</ExternalDoc>
        </div>
      </section>
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
        <SectionIntro index="08" eyebrow="Related" title="Explore more configuration options." />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            {
              href: '/telegram',
              label: 'Telegram',
              desc: 'Push notifications, approval prompts, and remote commands.',
            },
            {
              href: '/sync',
              label: 'GitHub Sync',
              desc: 'Sync settings, skills, prompts, and memory across machines.',
            },
            {
              href: '/checkpoints',
              label: 'Checkpoints',
              desc: 'File state snapshots. Roll back after risky edits.',
            },
          ].map(({ href, label, desc }) => (
            <Link
              key={href}
              href={href}
              className="group rounded-xl border border-line bg-card p-5 hover:border-brand/40 transition-colors"
            >
              <h3 className="font-black text-base text-fg group-hover:text-brand transition-colors">
                {label}
              </h3>
              <p className="mt-2 text-xs leading-5 text-muted">{desc}</p>
              <span className="mt-3 inline-block text-xs font-bold text-brand">Explore →</span>
            </Link>
          ))}
        </div>
      </section>
      <PageNext
        label="Architecture"
        title="See the boundaries in code"
        body="Explore the package layers, kernel primitives and the dependency direction that keeps surfaces out of core."
        href="/architecture"
      />
    </>
  );
}

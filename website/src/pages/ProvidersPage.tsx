import {
  ArrowDown,
  ArrowUpRight,
  Check,
  HardDrive,
  KeyRound,
  LogIn,
  Radio,
  RefreshCw,
  Route,
  Sparkles,
} from 'lucide-react';
import { useState } from 'react';
import { ExternalDoc, PageHero, PageNext, SectionIntro } from '@/components/site/primitives';
import {
  type CuratedProvider,
  curatedProviders,
  familyLabels,
  localProviders,
  oauthProviders,
} from '@/data/providers';
import { Link } from '@/lib/router';

/** Real vendor logo with a monogram fallback when the asset cannot load. */
function ProviderLogo({ provider }: { provider: CuratedProvider }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="grid size-11 shrink-0 place-items-center overflow-hidden rounded-xl border border-line bg-white p-2 shadow-sm">
      {failed ? (
        <span className="font-mono text-xs font-black uppercase tracking-[-0.06em] text-ink">
          {provider.vendor.slice(0, 2)}
        </span>
      ) : (
        <img
          src={provider.logoUrl}
          alt={provider.logoAlt}
          className="size-full object-contain"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

const familyBadge: Record<string, string> = {
  anthropic: 'border-amber-500/25 bg-amber-500/10 text-amber-500',
  openai: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-500',
  'openai-compatible': 'border-brand/25 bg-brand/10 text-brand',
  google: 'border-blue-500/25 bg-blue-500/10 text-blue-500',
};

const families = [
  ['Anthropic', 'Native Messages API + SSE', 'Anthropic, MiniMax, Kimi, Vertex Anthropic'],
  [
    'OpenAI',
    'Chat Completions / Responses-style streaming',
    'OpenAI and compatible first-party surfaces',
  ],
  [
    'OpenAI-compatible',
    'OpenAI-spec endpoints + SSE',
    'Groq, Mistral, DeepSeek, OpenRouter, Ollama and many more',
  ],
  ['Google', 'Gemini streamGenerateContent', 'Google AI Studio and Gemini-family endpoints'],
] as const;

const matrixExample = `"modelMatrix": {
  "security-scanner": {
    "provider": "anthropic",
    "model": "review-model",
    "fallbackProfile": "careful"
  },
  "implement": {
    "modelRuntime": {
      "reasoning": { "effort": "high" }
    }
  },
  "*": { "model": "fast-worker" }
}`;

export function ProvidersPage() {
  return (
    <>
      <PageHero
        index="14"
        eyebrow="Providers & models"
        title={
          <>
            One contract.
            <br />
            <span className="text-brand-2">Many model paths.</span>
          </>
        }
        description="Provider adapters translate wire formats into the same streaming, tool, usage and error contract. Model routing decides which path handles each role; fallback handles temporary capacity failure."
        aside={
          <ExternalDoc path="docs/provider-author-guide.md">Open provider author guide</ExternalDoc>
        }
      />
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="01"
          eyebrow="Wire families"
          title="The catalog is large; the protocol surface stays small."
          description="Models and prices refresh from models.dev. Four adapter families cover native and compatible transports without hardcoding every model into the agent."
        />
        <div className="mt-12 overflow-hidden rounded-2xl border border-line bg-card">
          {families.map(([name, transport, examples], index) => (
            <div
              key={name}
              className="grid gap-3 border-b border-line p-5 last:border-b-0 sm:grid-cols-[44px_170px_280px_1fr] sm:items-center"
            >
              <span className="font-mono text-xs font-black text-brand-2">0{index + 1}</span>
              <strong className="text-sm text-fg">{name}</strong>
              <code className="font-mono text-xs text-brand">{transport}</code>
              <p className="text-sm leading-6 text-muted">{examples}</p>
            </div>
          ))}
        </div>
      </section>
      <section className="border-t border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-32">
          <SectionIntro
            index="02"
            eyebrow="Provider gallery"
            title="Named providers, ready to connect."
            description="Quick-start providers surfaced in setup, plus first-class subscription sign-ins and local runtimes. Beyond these, any models.dev provider on a matching wire family works with a key."
          />
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {curatedProviders.map((provider) => (
              <article
                key={provider.id}
                className="flex flex-col rounded-2xl border border-line bg-card p-6"
              >
                <div className="flex items-start justify-between gap-3">
                  <ProviderLogo provider={provider} />
                  <span
                    className={`rounded-full border px-2.5 py-1 font-mono text-xs font-black uppercase tracking-[0.08em] ${familyBadge[provider.family]}`}
                  >
                    {familyLabels[provider.family]}
                  </span>
                </div>
                <h3 className="mt-5 text-lg font-black text-fg">{provider.name}</h3>
                <p className="mt-2 flex-1 text-sm leading-6 text-muted">{provider.description}</p>
                <div className="mt-5 flex items-center justify-between border-t border-line pt-4">
                  <code className="font-mono text-xs text-faint">{provider.keyPlaceholder}</code>
                  {provider.signupUrl && (
                    <a
                      href={provider.signupUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="group inline-flex items-center gap-1 font-mono text-xs font-black uppercase tracking-[0.1em] text-brand hover:underline"
                    >
                      Get key
                      <ArrowUpRight className="size-3 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                    </a>
                  )}
                </div>
              </article>
            ))}
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.04] p-6 sm:p-8">
              <div className="flex items-center gap-3">
                <LogIn className="size-5 text-emerald-500" />
                <h3 className="text-lg font-black text-fg">Subscription sign-in</h3>
              </div>
              <div className="mt-5 space-y-4">
                {oauthProviders.map((provider) => (
                  <div
                    key={provider.id}
                    className="border-t border-line pt-4 first:border-t-0 first:pt-0"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <strong className="text-sm font-black text-fg">{provider.name}</strong>
                      <code className="font-mono text-xs text-brand">{provider.command}</code>
                    </div>
                    <p className="mt-1.5 text-sm leading-6 text-muted">{provider.description}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-2xl border border-line bg-card p-6 sm:p-8">
              <div className="flex items-center gap-3">
                <HardDrive className="size-5 text-brand" />
                <h3 className="text-lg font-black text-fg">Local &amp; self-hosted runtimes</h3>
              </div>
              <div className="mt-5 space-y-4">
                {localProviders.map((provider) => (
                  <div
                    key={provider.id}
                    className="border-t border-line pt-4 first:border-t-0 first:pt-0"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <strong className="text-sm font-black text-fg">{provider.name}</strong>
                      <span className="font-mono text-xs font-black uppercase tracking-[0.08em] text-faint">
                        {provider.noAuth ? 'no auth' : 'optional bearer'}
                      </span>
                    </div>
                    <code className="mt-1.5 block font-mono text-xs text-brand">
                      {provider.baseUrl}
                    </code>
                    <p className="mt-1.5 text-sm leading-6 text-muted">{provider.hint}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="03"
            eyebrow="Credentials"
            title="ChatGPT login first. Provider keys when you want another route."
          />
          <div className="mt-12 grid gap-6 overflow-hidden rounded-2xl border border-emerald-500/30 bg-ink p-6 text-white sm:p-8 lg:grid-cols-[.8fr_1.2fr_auto] lg:items-center">
            <LogIn className="size-10 text-emerald-300" />
            <div>
              <span className="font-mono text-xs font-black uppercase tracking-[0.17em] text-emerald-300">
                Connect with ChatGPT
              </span>
              <h2 className="mt-2 text-3xl font-black tracking-[-0.035em]">
                Use Codex subscription access in one browser sign-in.
              </h2>
              <p className="mt-3 text-sm leading-7 text-zinc-400">
                Run <code className="font-mono text-emerald-300">wstack auth login chatgpt</code>,
                finish the browser flow, then select{' '}
                <code className="font-mono text-emerald-300">openai-codex</code> like any other
                provider.
              </p>
            </div>
            <Link
              href="/coding-plans"
              className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2.5 text-sm font-black text-ink"
            >
              Connect step by step →
            </Link>
          </div>
          <div className="mt-5 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
            {[
              [
                KeyRound,
                'API key',
                'Encrypted in the per-machine vault or supplied through an environment variable.',
                'wstack auth <provider>',
              ],
              [
                Sparkles,
                'Coding plan keys',
                'OpenCode, MiniMax, Z.AI and Kimi each keep their subscription key on the correct endpoint.',
                'wstack auth <plan-provider>',
              ],
              [
                Sparkles,
                'Claude Pro / Max',
                'Vendor OAuth flow with encrypted refresh token storage.',
                'wstack auth login claude',
              ],
              [
                Sparkles,
                'GitHub Copilot',
                'GitHub device flow and self-refreshing access.',
                'wstack auth login copilot',
              ],
            ].map(([Icon, title, body, command]) => {
              const ItemIcon = Icon as typeof KeyRound;
              return (
                <article key={String(title)} className="bg-card p-6">
                  <ItemIcon className="size-5 text-brand" />
                  <h2 className="mt-8 font-black text-fg">{String(title)}</h2>
                  <p className="mt-3 text-sm leading-6 text-muted">{String(body)}</p>
                  <code className="mt-6 block overflow-x-auto font-mono text-xs text-brand">
                    {String(command)}
                  </code>
                </article>
              );
            })}
          </div>
          <div className="mt-8">
            <div className="flex flex-wrap gap-6">
              <Link href="/coding-plans" className="text-sm font-black text-brand">
                Compare coding plans and setup →
              </Link>
              <ExternalDoc path="docs/oauth-signin.md">
                Read OAuth token storage and refresh details
              </ExternalDoc>
            </div>
          </div>
        </div>
      </section>
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="04"
          eyebrow="Model matrix"
          title="Route by exact role, then phase, then wildcard."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-[.75fr_1fr]">
          <div className="rounded-2xl border border-line bg-ink p-6 text-zinc-300">
            <pre className="overflow-x-auto font-mono text-xs leading-6">
              <code>{matrixExample}</code>
            </pre>
          </div>
          <div className="space-y-2">
            {[
              ['01', 'Exact role', 'A named specialist route wins first.'],
              ['02', 'Role phase', 'Workflow phase can supply a route or only runtime reasoning.'],
              ['03', 'Wildcard', 'Fleet-wide default without changing the leader.'],
              ['04', 'Leader', 'Final inherited provider, model and runtime controls.'],
            ].map(([number, title, body], index) => (
              <div key={title}>
                <div className="grid grid-cols-[36px_120px_1fr] gap-3 rounded-xl border border-line bg-card p-4">
                  <span className="font-mono text-xs font-black text-brand-2">{number}</span>
                  <strong className="text-sm text-fg">{title}</strong>
                  <p className="text-sm text-muted">{body}</p>
                </div>
                {index < 3 && <ArrowDown className="mx-auto my-1 size-4 text-faint" />}
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="05"
            eyebrow="One session, many models"
            title="Different providers can work on the same objective at the same time."
            description="The leader, specialist roles, fallback paths and Brain Council resolve credentials independently, then communicate through shared tasks and the project mailbox."
          />
          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['Leader', 'Anthropic', 'Plans the objective and verifies the final result.'],
              [
                'Implementer',
                'OpenAI',
                'Executes a bounded code task with a high reasoning profile.',
              ],
              [
                'Researcher',
                'Google',
                'Explores an independent question with its own context budget.',
              ],
              [
                'Council',
                'Mixed providers',
                'Votes independently so one provider family is not the only judgment source.',
              ],
            ].map(([role, route, body]) => (
              <article key={role} className="bg-card p-6">
                <span className="font-mono text-xs font-black uppercase tracking-[0.18em] text-faint">
                  {role}
                </span>
                <h2 className="mt-5 text-xl font-black text-fg">{route}</h2>
                <p className="mt-3 text-sm leading-6 text-muted">{body}</p>
              </article>
            ))}
          </div>
          <div className="mt-8 flex flex-wrap gap-5">
            <Link href="/features/model-routing" className="text-sm font-black text-brand">
              Model routing deep dive →
            </Link>
            <Link href="/features/brain-council" className="text-sm font-black text-brand">
              Multi-model Council →
            </Link>
          </div>
        </div>
      </section>
      <section className="border-y border-line bg-ink text-white">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="06"
            eyebrow="Failure path"
            title="Retry, fallback, recovery—in that order."
          />
          <div className="mt-12 grid gap-5 lg:grid-cols-3">
            {[
              [
                RefreshCw,
                'In-place retry',
                'Same provider and model. Kind-specific attempt count with Retry-After or exponential jitter.',
              ],
              [
                Route,
                'Cross-provider fallback',
                'Only capacity and transport kinds hop after the current provider exhausts retries.',
              ],
              [
                Radio,
                'Recovery strategy',
                'Overflow compaction, cheaper-model downgrade or close-cost sibling reroute, capped at two.',
              ],
            ].map(([Icon, title, body]) => {
              const ItemIcon = Icon as typeof Route;
              return (
                <article
                  key={String(title)}
                  className="rounded-2xl border border-white/10 bg-white/[0.035] p-6"
                >
                  <ItemIcon className="size-5 text-brand" />
                  <h2 className="mt-8 text-xl font-black">{String(title)}</h2>
                  <p className="mt-3 text-sm leading-7 text-zinc-500">{String(body)}</p>
                </article>
              );
            })}
          </div>
          <div className="mt-8 flex items-center gap-3 text-sm text-emerald-400">
            <Check className="size-4" /> Invalid requests, authentication failures and content shape
            errors do not hop providers.
          </div>
          <div className="mt-6 flex gap-5">
            <Link href="/commands/setmodel" className="text-sm font-bold text-brand">
              Learn /setmodel →
            </Link>
            <Link href="/commands/fallback" className="text-sm font-bold text-brand">
              Learn /fallback →
            </Link>
          </div>
        </div>
      </section>
      <PageNext
        label="Memory & sessions"
        title="Preserve continuity across model windows"
        body="Understand session logs, verified project memory, checkpoints and compaction."
        href="/memory"
      />
    </>
  );
}

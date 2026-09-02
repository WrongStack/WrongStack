import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CircleDollarSign,
  KeyRound,
  Link2,
  LockKeyhole,
  LogIn,
  Radio,
  Route,
  ShieldAlert,
  SquareTerminal,
} from 'lucide-react';
import { useEffect } from 'react';
import { ConnectionLogo } from '@/components/site/ConnectionLogo';
import { CopyCommand, PageHero, PageNext, SectionIntro } from '@/components/site/primitives';
import {
  apiKeyConnections,
  type CodingConnection,
  chatGptConnection,
  codingConnections,
  connectionUrl,
} from '@/data/coding-plans';

const multiProviderExample = `"modelMatrix": {
  "implement": {
    "provider": "minimax-coding-plan",
    "model": "MiniMax-M3"
  },
  "review": {
    "provider": "zai-coding-plan",
    "model": "glm-5.2"
  },
  "*": {
    "provider": "opencode-go",
    "model": "glm-5.2"
  }
}`;

const planQuestions = [
  {
    index: '01',
    question: 'Already have ChatGPT with Codex?',
    answer: 'Use browser sign-in. No Platform API key is needed for this route.',
    href: '#chatgpt-codex',
    link: 'Connect ChatGPT',
  },
  {
    index: '02',
    question: 'Want a fixed coding subscription?',
    answer: 'Compare Go, MiniMax, GLM and Kimi plan quotas, then create the dedicated plan key.',
    href: '#api-key-plans',
    link: 'Compare plan keys',
  },
  {
    index: '03',
    question: 'Want many models behind one balance?',
    answer: 'OpenCode Zen is the broad curated gateway; Go is the focused subscription catalog.',
    href: '#opencode-zen',
    link: 'See OpenCode routes',
  },
] as const;

const connectionFaq = [
  [
    'Can I connect more than one plan?',
    'Yes. Every credential is stored as a separate provider entry. The leader, fleet roles, Brain Council and fallback paths can resolve different providers in the same project.',
  ],
  [
    'Where are plan keys and OAuth tokens stored?',
    'WrongStack stores them in the per-machine config and encrypts secrets with the local vault. Provider credentials do not belong in the committed project config.',
  ],
  [
    'Why does a valid vendor key sometimes fail?',
    'Coding-plan keys and general pay-as-you-go keys are often separate products. Match the key to the provider id shown here so WrongStack targets the corresponding coding endpoint.',
  ],
  [
    'What happens when a subscription quota is exhausted?',
    'The provider returns its quota or rate-limit failure. A configured fallback can move eligible capacity failures to another provider; authentication and invalid-request failures never hop silently.',
  ],
  [
    'Are the prices shown by WrongStack authoritative?',
    'No static website should be the final authority for a live subscription. The provider checkout controls current price, tax, region, quota, renewal and eligibility details.',
  ],
  [
    'Does a referral link change the technical setup?',
    'No. Referral status only changes the outbound plan URL. Provider ids, endpoints, auth commands and model routing stay exactly the same.',
  ],
] as const;

function PlanLink({ connection, label }: { connection: CodingConnection; label: string }) {
  return (
    <a
      href={connectionUrl(connection)}
      target="_blank"
      rel={connection.affiliateUrl ? 'sponsored noreferrer' : 'noreferrer'}
      className="inline-flex items-center gap-2 rounded-full bg-fg px-4 py-2.5 text-sm font-black text-bg transition-transform hover:-translate-y-0.5"
    >
      {label} <ArrowUpRight className="size-4" />
    </a>
  );
}

export function CodingPlansPage() {
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!id) return;
    window.requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ block: 'start' });
    });
  }, []);

  return (
    <>
      <PageHero
        index="23"
        eyebrow="Connect with"
        title={
          <>
            Your plan.
            <br />
            <span className="text-brand">Your provider.</span>
            <br />
            <span className="text-brand-2">One agent.</span>
          </>
        }
        description="Connect WrongStack with ChatGPT Codex through browser sign-in, or bring a dedicated coding-plan API key from OpenCode, MiniMax, Z.AI or Kimi. This is the practical map from subscription to first request."
        aside={
          <div className="flex flex-wrap gap-2">
            <span className="rounded-full border border-line bg-card px-3 py-1.5 font-mono text-xs font-black uppercase tracking-[0.12em] text-brand">
              1 OAuth path
            </span>
            <span className="rounded-full border border-line bg-card px-3 py-1.5 font-mono text-xs font-black uppercase tracking-[0.12em] text-brand-2">
              5 API-key paths
            </span>
          </div>
        }
      />

      <section className="border-b border-line bg-card">
        <div className="mx-auto max-w-[1380px] px-4 py-10 sm:px-6 lg:px-10 lg:py-14">
          <div className="grid gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-3">
            {planQuestions.map((item) => (
              <a
                key={item.index}
                href={item.href}
                className="group bg-card p-6 transition-colors hover:bg-surface"
              >
                <span className="font-mono text-xs font-black text-brand-2">{item.index}</span>
                <h2 className="mt-5 text-xl font-black tracking-[-0.03em] text-fg">
                  {item.question}
                </h2>
                <p className="mt-3 text-sm leading-6 text-muted">{item.answer}</p>
                <span className="mt-6 inline-flex items-center gap-2 text-xs font-black text-brand">
                  {item.link}{' '}
                  <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-1" />
                </span>
              </a>
            ))}
          </div>
        </div>
      </section>

      <section
        id="chatgpt-codex"
        className="scroll-mt-24 mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36"
      >
        <SectionIntro
          index="01"
          eyebrow="Start here"
          title="Have ChatGPT with Codex? Sign in—do not hunt for an API key."
          description="WrongStack exposes ChatGPT subscription access as the openai-codex provider. The local command starts a browser OAuth flow, then the provider appears in the same model picker as every API-key connection."
        />
        <div className="relative mt-12 overflow-hidden rounded-[28px] border border-emerald-500/30 bg-ink text-white shadow-2xl shadow-emerald-950/10">
          <div
            className="absolute -right-20 -top-32 size-[430px] rounded-full border border-emerald-300/10 bg-emerald-400/[0.06]"
            aria-hidden="true"
          />
          <div className="relative grid gap-10 p-6 sm:p-8 lg:grid-cols-[.85fr_1.15fr] lg:p-12">
            <div>
              <div className="flex items-center gap-4">
                <ConnectionLogo connection={chatGptConnection} className="size-16 p-3" />
                <div>
                  <span className="font-mono text-xs font-black uppercase tracking-[0.18em] text-emerald-300">
                    {chatGptConnection.badge}
                  </span>
                  <h2 className="mt-1 text-3xl font-black tracking-[-0.035em] sm:text-4xl">
                    Connect with ChatGPT
                  </h2>
                </div>
              </div>
              <p className="mt-7 max-w-xl text-base leading-8 text-zinc-400">
                {chatGptConnection.summary}
              </p>
              <div className="mt-7 grid gap-3 sm:grid-cols-2">
                {[
                  [LogIn, 'Authentication', 'Browser OAuth'],
                  [Radio, 'Provider id', chatGptConnection.providerId],
                  [KeyRound, 'API key', 'Not required'],
                  [LockKeyhole, 'Storage', 'Encrypted locally'],
                ].map(([Icon, label, value]) => {
                  const ItemIcon = Icon as typeof LogIn;
                  return (
                    <div
                      key={String(label)}
                      className="rounded-xl border border-white/10 bg-white/[0.035] p-4"
                    >
                      <ItemIcon className="size-4 text-emerald-300" />
                      <div className="mt-4 font-mono text-xs uppercase tracking-[0.14em] text-zinc-600">
                        {String(label)}
                      </div>
                      <strong className="mt-1 block text-sm text-zinc-200">{String(value)}</strong>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/25 p-5 sm:p-7">
              <ol className="space-y-6">
                {chatGptConnection.steps.map((step, index) => (
                  <li key={step} className="grid grid-cols-[32px_1fr] gap-4">
                    <span className="grid size-8 place-items-center rounded-full border border-emerald-400/20 bg-emerald-400/10 font-mono text-xs font-black text-emerald-300">
                      {index + 1}
                    </span>
                    <p className="pt-1 text-sm leading-6 text-zinc-300">{step}</p>
                  </li>
                ))}
              </ol>
              <div className="mt-8 space-y-3 border-t border-white/10 pt-6">
                <CopyCommand command={chatGptConnection.authCommand} />
                <CopyCommand command={chatGptConnection.runCommand} />
              </div>
              <div className="mt-7 flex flex-wrap gap-3">
                <PlanLink connection={chatGptConnection} label="Check ChatGPT plans" />
              </div>
            </div>
          </div>
          <div className="relative flex gap-3 border-t border-amber-300/15 bg-amber-300/[0.055] px-6 py-4 text-xs leading-6 text-amber-100/70 sm:px-8 lg:px-12">
            <ShieldAlert className="mt-1 size-4 shrink-0 text-amber-300" />
            <p>{chatGptConnection.note}</p>
          </div>
        </div>
      </section>

      <section id="api-key-plans" className="scroll-mt-24 border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="02"
            eyebrow="Connect with an API key"
            title="Subscribe there. Create the plan key there. Use it here."
            description="These are dedicated coding routes, not interchangeable generic API credentials. WrongStack’s provider id selects the correct protocol and endpoint after the key is saved."
          />
          <div className="mt-12 grid gap-5">
            {apiKeyConnections.map((connection) => (
              <article
                key={connection.id}
                id={connection.id}
                className="scroll-mt-28 overflow-hidden rounded-2xl border border-line bg-card"
              >
                <div className="grid lg:grid-cols-[.9fr_1.1fr]">
                  <div className="border-b border-line p-6 sm:p-8 lg:border-b-0 lg:border-r">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-center gap-4">
                        <ConnectionLogo connection={connection} className="size-14 p-3" />
                        <div>
                          <span className="font-mono text-xs font-black uppercase tracking-[0.17em] text-brand-2">
                            {connection.vendor} / {connection.badge}
                          </span>
                          <h2 className="mt-1 text-2xl font-black tracking-[-0.035em] text-fg sm:text-3xl">
                            {connection.name}
                          </h2>
                        </div>
                      </div>
                      {connection.affiliateUrl && (
                        <span className="rounded-full border border-brand/20 bg-brand/5 px-2.5 py-1 font-mono text-[8px] font-black uppercase tracking-[0.12em] text-brand">
                          Referral
                        </span>
                      )}
                    </div>
                    <h3 className="mt-8 max-w-xl text-2xl font-black tracking-[-0.03em] text-fg">
                      {connection.headline}
                    </h3>
                    <p className="mt-4 max-w-2xl text-sm leading-7 text-muted">
                      {connection.summary}
                    </p>
                    <div className="mt-7 grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2">
                      {[
                        ['Provider id', connection.providerId],
                        ['Billing', connection.billing],
                        ['Get the key', connection.keySource],
                        ['Models', connection.modelHint],
                      ].map(([label, value]) => (
                        <div key={label} className="bg-bg p-4">
                          <span className="font-mono text-[8px] font-black uppercase tracking-[0.14em] text-faint">
                            {label}
                          </span>
                          <p className="mt-1.5 text-xs font-bold leading-5 text-fg">{value}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-col p-6 sm:p-8">
                    <div className="flex items-center gap-3">
                      <span className="grid size-9 place-items-center rounded-full bg-brand-2/10 text-brand-2">
                        <KeyRound className="size-4" />
                      </span>
                      <div>
                        <span className="font-mono text-xs font-black uppercase tracking-[0.15em] text-faint">
                          Connection recipe
                        </span>
                        <h3 className="mt-0.5 text-lg font-black text-fg">Subscribe → key → run</h3>
                      </div>
                    </div>
                    <ol className="mt-7 space-y-5">
                      {connection.steps.map((step, index) => (
                        <li
                          key={step}
                          className="grid grid-cols-[30px_1fr] gap-3 text-sm leading-6 text-muted"
                        >
                          <span className="grid size-7 place-items-center rounded-full border border-line bg-bg font-mono text-xs font-black text-brand-2">
                            {index + 1}
                          </span>
                          {step}
                        </li>
                      ))}
                    </ol>
                    <div className="mt-7 space-y-2 border-t border-line pt-6">
                      <code className="block overflow-x-auto rounded-lg bg-bg px-4 py-3 font-mono text-xs text-brand">
                        {connection.authCommand}
                      </code>
                      <code className="block overflow-x-auto rounded-lg bg-bg px-4 py-3 font-mono text-xs text-fg">
                        {connection.runCommand}
                      </code>
                      <div className="flex items-start gap-2 px-1 pt-2 text-xs leading-5 text-faint">
                        <Link2 className="mt-0.5 size-3 shrink-0" />
                        <span className="break-all">{connection.endpoint}</span>
                      </div>
                    </div>
                    <div className="mt-auto flex flex-wrap items-center gap-3 pt-7">
                      <PlanLink
                        connection={connection}
                        label={
                          connection.affiliateUrl ? 'Open plan with referral' : 'Open official plan'
                        }
                      />
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="03"
          eyebrow="Verify the connection"
          title="A saved key is not the finish line. Prove the route before real work."
          description="Check that the provider entry exists, make one explicit request, then select it interactively. This catches the most common mix-up: a valid key saved under the wrong provider family."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-[.8fr_1.2fr]">
          <div className="rounded-2xl border border-line bg-card p-6 sm:p-8">
            <div className="flex items-center gap-3">
              <SquareTerminal className="size-5 text-brand" />
              <h2 className="text-xl font-black text-fg">Three checks after saving</h2>
            </div>
            <div className="mt-7 space-y-6">
              {[
                [
                  '01',
                  'Credential exists',
                  'Status should name the provider and show a masked credential, never the raw key.',
                  'wstack auth status opencode-go',
                ],
                [
                  '02',
                  'The wire answers',
                  'Force one provider and model so fallback cannot hide a bad endpoint or mismatched plan key.',
                  'wstack --provider opencode-go --model glm-5.2 "report active provider and model"',
                ],
                [
                  '03',
                  'The picker sees it',
                  'Inside an active session, select the saved route and confirm the visible provider/model pair.',
                  '/setmodel',
                ],
              ].map(([number, title, body, command]) => (
                <div key={number} className="border-t border-line pt-5 first:border-t-0 first:pt-0">
                  <div className="flex items-start gap-4">
                    <span className="font-mono text-xs font-black text-brand-2">{number}</span>
                    <div>
                      <h3 className="font-black text-fg">{title}</h3>
                      <p className="mt-2 text-sm leading-6 text-muted">{body}</p>
                    </div>
                  </div>
                  <div className="mt-4 pl-8">
                    <CopyCommand command={command} />
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="overflow-hidden rounded-2xl border border-line bg-ink text-white">
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
              <div className="flex items-center gap-2 font-mono text-xs font-black uppercase tracking-[0.15em] text-zinc-500">
                <Route className="size-3.5 text-brand-2" /> Multi-provider routing
              </div>
              <span className="font-mono text-xs text-zinc-600">
                ~/.wrongstack/profiles/&lt;name&gt;/config.json
              </span>
            </div>
            <div className="p-6 sm:p-8">
              <h2 className="text-3xl font-black tracking-[-0.035em]">
                Connect several. Route each one deliberately.
              </h2>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-400">
                A plan becomes one route in the model matrix. Keep implementation, review and the
                default worker on different provider credentials without changing the shared tool,
                mailbox or permission system.
              </p>
              <pre className="mt-7 overflow-x-auto rounded-xl border border-white/10 bg-black/30 p-5 font-mono text-xs leading-6 text-zinc-300">
                <code>{multiProviderExample}</code>
              </pre>
              <div className="mt-6 flex gap-3 text-xs leading-6 text-zinc-500">
                <LockKeyhole className="mt-1 size-4 shrink-0 text-emerald-400" />
                Provider credentials stay in the machine-local vault; the matrix references provider
                ids, not raw secrets.
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="04"
            eyebrow="Connection map"
            title="The provider id is what keeps the right key on the right wire."
            description="The model picker can refresh, but the billing identity and protocol route stay explicit. A coding-plan key should never silently fall through to a vendor’s general pay-as-you-go endpoint."
          />
          <div className="mt-12 overflow-x-auto rounded-2xl border border-line bg-card">
            <table className="w-full min-w-[880px] border-collapse text-left">
              <thead>
                <tr className="border-b border-line bg-surface">
                  {['Connection', 'Auth', 'Provider id', 'Billing route', 'Best fit'].map(
                    (heading) => (
                      <th
                        key={heading}
                        className="px-5 py-4 font-mono text-xs font-black uppercase tracking-[0.16em] text-faint"
                      >
                        {heading}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {codingConnections.map((connection) => (
                  <tr key={connection.id} className="border-b border-line last:border-b-0">
                    <td className="px-5 py-4 text-sm font-black text-fg">{connection.name}</td>
                    <td className="px-5 py-4 font-mono text-xs text-brand">
                      {connection.kind === 'oauth' ? 'ChatGPT OAuth' : 'Plan API key'}
                    </td>
                    <td className="px-5 py-4 font-mono text-xs text-fg">{connection.providerId}</td>
                    <td className="px-5 py-4 text-sm text-muted">{connection.billing}</td>
                    <td className="max-w-sm px-5 py-4 text-sm leading-6 text-muted">
                      {connection.bestFor}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="border-y border-line bg-ink text-white">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="05"
            eyebrow="After connection"
            title="One key does not lock the whole fleet to one model."
            description="Connected providers become routes. You can keep ChatGPT Codex on the leader, send implementation to MiniMax, review with GLM and retain Kimi or OpenCode in a fallback profile."
          />
          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 sm:grid-cols-2 lg:grid-cols-4">
            {[
              [
                Check,
                'Select',
                'Pick the new provider and model with /setmodel or the startup picker.',
              ],
              [Radio, 'Route', 'Map exact fleet roles or whole phases through modelMatrix.'],
              [
                ArrowRight,
                'Fallback',
                'Keep a second provider ready for capacity and transport failures.',
              ],
              [
                CircleDollarSign,
                'Observe',
                'Track provider usage, cost and quota signals per session in HQ.',
              ],
            ].map(([Icon, title, body]) => {
              const ItemIcon = Icon as typeof Check;
              return (
                <article key={String(title)} className="bg-ink p-6">
                  <ItemIcon className="size-5 text-brand-2" />
                  <h2 className="mt-8 text-xl font-black">{String(title)}</h2>
                  <p className="mt-3 text-sm leading-7 text-zinc-500">{String(body)}</p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="06"
          eyebrow="Affiliate disclosure"
          title="The recommendation stays useful even when a link earns something."
          description="Referral status is data, not hidden page behavior. A referral link is marked, uses the sponsored relationship attribute and never changes the provider configuration instructions."
        />
        <div className="mt-12 grid gap-5 lg:grid-cols-3">
          {[
            [
              'What may happen',
              'WrongStack or its creator may receive credit, commission or account benefits when you subscribe through a marked referral link.',
            ],
            [
              'What does not change',
              'The software stays free and open source. Referral status does not change feature access, model routing or our technical explanation.',
            ],
            [
              'What is authoritative',
              'The provider checkout and terms control the current price, region, quota, renewal, refund and eligibility details.',
            ],
          ].map(([title, body]) => (
            <article key={title} className="rounded-2xl border border-line bg-card p-6">
              <h2 className="text-xl font-black text-fg">{title}</h2>
              <p className="mt-3 text-sm leading-7 text-muted">{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="border-t border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="07"
            eyebrow="Connection FAQ"
            title="The questions that usually appear after the first key."
            description="Short answers about multiple subscriptions, storage, quotas, provider ids and referral links."
          />
          <div className="mt-12 overflow-hidden rounded-2xl border border-line bg-card">
            {connectionFaq.map(([question, answer], index) => (
              <details
                key={question}
                className="group border-b border-line last:border-b-0 open:bg-bg"
                open={index === 0}
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-5 px-5 py-5 font-black text-fg marker:hidden sm:px-7">
                  <span>{question}</span>
                  <span className="grid size-7 shrink-0 place-items-center rounded-full border border-line font-mono text-sm text-brand transition-transform group-open:rotate-45">
                    +
                  </span>
                </summary>
                <p className="max-w-4xl px-5 pb-6 text-sm leading-7 text-muted sm:px-7">{answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <PageNext
        label="Providers & models"
        title="Route the connections you just added"
        body="Learn provider families, role-based model routing, fallback order and runtime reasoning controls."
        href="/providers"
      />
    </>
  );
}

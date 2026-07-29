import {
  ArrowDown,
  Check,
  Clock3,
  Inbox,
  Mail,
  MessageSquareMore,
  Network,
  Radio,
  Reply,
  ShieldCheck,
  Terminal,
  Users,
} from 'lucide-react';
import {
  ExternalDoc,
  PageHero,
  PageNext,
  SectionIntro,
  heroTitleFontSize,
} from '@/components/site/primitives';
import { Link } from '@/lib/router';

const messageTypes = [
  ['note', 'Informational context with no action implied.'],
  ['ask', 'A blocking question that expects a reply.'],
  ['assign', 'A task assignment the recipient should act on.'],
  ['steer', 'A high-priority direction change for work already in progress.'],
  ['btw', 'Useful non-urgent context that should not derail the current step.'],
  ['broadcast', 'Project-wide information addressed to every agent.'],
  ['status', 'Compact liveness, progress or capacity information.'],
  ['result', 'A completion notice carrying the outcome of delegated work.'],
  ['review', 'A passive request to inspect code, documents or a proposal.'],
  ['control', 'An out-of-band runtime signal handled outside conversation content.'],
] as const;

const commandExamples = [
  ['/mailbox', 'Read unread mail for the current leader identity.'],
  ['/mailbox agents', 'List every registered project agent and its current state.'],
  ['/mailbox online', 'Show only agents with a live heartbeat.'],
  ['/mailbox send worker@b2c3d4e5 type=ask are the tests green?', 'Send typed direct mail.'],
  ['/mailbox broadcast type=steer pause all deploy work', 'Steer every live recipient.'],
  ['/mailbox history 50 from leader grep auth', 'Filter durable project history.'],
  ['/mailbox purge', 'Remove stale and orphaned messages using retention rules.'],
] as const;

export function MailboxPage() {
  return (
    <>
      <PageHero
        index="12"
        eyebrow="Global Mailbox"
        titleFontSize={heroTitleFontSize('Agents need a channel.')}
        title={
          <>
            Agents need a channel.
            <br />
            <span className="text-brand-2">Not shared thoughts.</span>
          </>
        }
        description="Global Mailbox is WrongStack’s durable, project-scoped communication fabric. Leaders, fleet workers and every local interface exchange typed messages while keeping their model contexts isolated."
        aside={<ExternalDoc path="docs/slash/mailbox.md">Open the operator reference</ExternalDoc>}
      />

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="01"
          eyebrow="System model"
          title="One project mailbox. Many independent contexts."
          description="The mailbox moves intent and evidence between agents. It never merges their private message histories or mutable Context objects."
        />
        <div className="mt-12 overflow-hidden rounded-[26px] border border-line bg-ink p-5 text-zinc-200 sm:p-8">
          <div className="grid gap-4 lg:grid-cols-[1fr_180px_1fr] lg:items-center">
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                [Terminal, 'leader@a1b2c3d4', 'CLI · planning release'],
                [Users, 'bug-hunter@a1b2c3d4', 'worker · running'],
              ].map(([Icon, title, body]) => {
                const ItemIcon = Icon as typeof Terminal;
                return (
                  <div
                    key={String(title)}
                    className="rounded-xl border border-cyan-400/25 bg-white/[.035] p-4"
                  >
                    <div className="flex items-center gap-3">
                      <ItemIcon className="size-4 text-cyan-300" />
                      <code className="font-mono text-xs font-bold">{String(title)}</code>
                      <span className="ml-auto size-2 rounded-full bg-emerald-300 shadow-[0_0_10px_#6ee7b7]" />
                    </div>
                    <p className="mt-3 text-xs text-zinc-500">{String(body)}</p>
                  </div>
                );
              })}
            </div>
            <div className="relative mx-auto grid size-36 place-items-center rounded-full border border-brand-2/30 bg-brand-2/[.06] text-center shadow-[0_0_60px_-30px_rgba(253,159,2,.8)]">
              <div>
                <Mail className="mx-auto size-6 text-brand-2" />
                <strong className="mt-3 block text-sm">Mailbox hub</strong>
                <span className="mt-1 block font-mono text-[8px] text-zinc-600">
                  SQLite · IPC owner
                </span>
              </div>
              <span className="absolute -left-12 top-1/2 hidden w-12 border-t border-dashed border-brand-2/40 lg:block" />
              <span className="absolute -right-12 top-1/2 hidden w-12 border-t border-dashed border-brand-2/40 lg:block" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                [Network, 'reviewer@e5f6a7b8', 'TUI · waiting'],
                [Radio, 'leader@e5f6a7b8', 'WebUI · streaming'],
              ].map(([Icon, title, body]) => {
                const ItemIcon = Icon as typeof Network;
                return (
                  <div
                    key={String(title)}
                    className="rounded-xl border border-emerald-400/20 bg-white/[.035] p-4"
                  >
                    <div className="flex items-center gap-3">
                      <ItemIcon className="size-4 text-emerald-300" />
                      <code className="font-mono text-xs font-bold">{String(title)}</code>
                      <span className="ml-auto size-2 rounded-full bg-emerald-300 shadow-[0_0_10px_#6ee7b7]" />
                    </div>
                    <p className="mt-3 text-xs text-zinc-500">{String(body)}</p>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-7 gap-y-3 border-t border-white/[.08] pt-5 font-mono text-xs uppercase tracking-wider text-zinc-600">
            <span>typed intent</span>
            <span className="text-brand-2">durable delivery</span>
            <span>isolated context</span>
            <span className="text-emerald-300">cross-session presence</span>
          </div>
        </div>
      </section>

      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="02"
            eyebrow="Identity & addressing"
            title="Address one process, one role or everyone."
            description="Session tags prevent two simultaneous leaders from collapsing into the same identity. Aliases keep the operator experience simple."
          />
          <div className="mt-12 overflow-hidden rounded-2xl border border-line bg-card">
            {[
              [
                'Exact identity',
                'leader@a1b2c3d4',
                'Deliver to one registered agent in one specific session.',
              ],
              [
                'Base alias',
                'leader',
                'Fan out to every live leader identity on the project, then deduplicate by message id.',
              ],
              [
                'Broadcast',
                '*  or  all',
                'Deliver project-wide; “all” is normalized to the reserved * address.',
              ],
            ].map(([kind, address, body], index) => (
              <article
                key={kind}
                className="grid gap-3 border-b border-line p-5 last:border-b-0 sm:grid-cols-[44px_150px_210px_1fr] sm:items-center sm:p-6"
              >
                <span className="font-mono text-xs font-black text-brand-2">0{index + 1}</span>
                <strong className="text-sm text-fg">{kind}</strong>
                <code className="font-mono text-xs text-brand">{address}</code>
                <p className="text-sm leading-6 text-muted">{body}</p>
              </article>
            ))}
          </div>
          <div className="mt-5 flex items-start gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-5">
            <Check className="mt-1 size-4 shrink-0 text-emerald-500" />
            <p className="text-sm leading-7 text-muted">
              Agents register with role, surface, process id, current task, iteration and tool-call
              state. Heartbeats refresh presence; stale registry entries are pruned automatically.
            </p>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="03"
          eyebrow="Message language"
          title="The type tells the receiver what the message means."
          description="A mailbox entry is more than text: it carries sender, recipient, priority, lifecycle state, reply linkage and optional task context."
        />
        <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-5">
          {messageTypes.map(([type, description], index) => (
            <article key={type} className="min-h-40 bg-card p-5">
              <span className="font-mono text-xs font-black text-faint">
                {String(index + 1).padStart(2, '0')}
              </span>
              <code className="mt-7 block font-mono text-sm font-black text-brand">{type}</code>
              <p className="mt-3 text-xs leading-5 text-muted">{description}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="border-y border-line bg-ink text-white">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="04"
            eyebrow="Message lifecycle"
            title="From intent to acknowledged outcome."
          />
          <div className="mt-12 space-y-2">
            {[
              [
                Mail,
                'Send',
                'Send over local IPC; the elected owner commits one SQLite transaction and emits an event.',
                'RemoteMailbox → owner',
              ],
              [
                Inbox,
                'Deliver',
                'Query indexed exact-id, base-alias and broadcast recipients from the authoritative store.',
                'exact + alias + *',
              ],
              [
                Clock3,
                'Surface',
                'Push server events to connected surfaces and fold urgent mail into the agent iteration loop.',
                'IPC event + bounded poll',
              ],
              [
                Reply,
                'Acknowledge',
                'Record actor-scoped read, completion and optional outcome receipts transactionally.',
                'message_receipts',
              ],
              [
                ShieldCheck,
                'Retain',
                'Let the single owner expire, purge, compact, soft-delete or restore without competing writers.',
                'TTL + owner maintenance',
              ],
            ].map(([Icon, title, body, code], index) => {
              const ItemIcon = Icon as typeof Mail;
              return (
                <div key={String(title)}>
                  <article className="grid gap-5 rounded-2xl border border-white/10 bg-white/[.035] p-5 sm:grid-cols-[46px_150px_1fr_190px] sm:items-center sm:p-6">
                    <span className="grid size-10 place-items-center rounded-full border border-white/10 bg-white/[.04] text-brand">
                      <ItemIcon className="size-4" />
                    </span>
                    <h2 className="font-black">{String(title)}</h2>
                    <p className="text-sm leading-6 text-zinc-500">{String(body)}</p>
                    <code className="font-mono text-xs text-brand-2">{String(code)}</code>
                  </article>
                  {index < 4 && <ArrowDown className="mx-auto my-1 size-4 text-zinc-700" />}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="05"
          eyebrow="Human controls"
          title="The operator gets the same communication fabric."
          description="The slash command acts as the current session’s leader identity, so replies return to the agent loop you are already using."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-[1.15fr_.65fr]">
          <div className="overflow-hidden rounded-2xl border border-line bg-ink">
            {commandExamples.map(([command, body]) => (
              <div
                key={command}
                className="grid gap-2 border-b border-white/10 px-5 py-4 last:border-b-0 sm:grid-cols-[minmax(0,1.2fr)_minmax(220px,.8fr)] sm:px-6"
              >
                <code className="overflow-x-auto font-mono text-xs text-zinc-200">
                  <span className="mr-2 text-brand">❯</span>
                  {command}
                </code>
                <p className="text-xs leading-5 text-zinc-500">{body}</p>
              </div>
            ))}
          </div>
          <div className="space-y-4">
            {[
              ['mail_send', 'High-affordance agent tool for direct or aliased delivery.'],
              ['mail_inbox', 'Read unread mail, optionally mark read and complete it.'],
              [
                'mailbox',
                'Low-level power tool for query, status, online and acknowledgement actions.',
              ],
              [
                'mailbox serve',
                'Token-protected HTTP bridge for approved external agents and scripts.',
              ],
            ].map(([name, body]) => (
              <article key={name} className="rounded-xl border border-line bg-card p-5">
                <code className="font-mono text-xs font-black text-brand">{name}</code>
                <p className="mt-2 text-sm leading-6 text-muted">{body}</p>
              </article>
            ))}
          </div>
        </div>
        <div className="mt-8 flex flex-wrap gap-5">
          <Link href="/commands/mailbox" className="text-sm font-black text-brand">
            Read /mailbox command guide →
          </Link>
          <Link href="/commands/mailbox-serve" className="text-sm font-black text-brand">
            Read bridge command guide →
          </Link>
          <Link href="/features/global-mailbox" className="text-sm font-black text-brand">
            Runtime deep dive →
          </Link>
        </div>
      </section>

      <section className="border-t border-line bg-surface">
        <div className="mx-auto grid max-w-[1380px] gap-7 px-4 py-20 sm:px-6 lg:grid-cols-[.7fr_1fr] lg:items-start lg:px-10">
          <div>
            <MessageSquareMore className="size-7 text-brand" />
            <h2 className="mt-7 text-3xl font-black tracking-[-0.045em] text-fg">
              Local by default. Observable by design.
            </h2>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              'A deterministic local endpoint makes every surface converge on one project owner.',
              'Only the elected owner opens SQLite; clients fail closed instead of writing a fallback file.',
              'Messages, per-actor receipts, credentials and presence commit through one transactional store.',
              'Legacy JSONL state imports once and remains untouched for manual recovery.',
            ].map((item) => (
              <div
                key={item}
                className="flex items-start gap-3 rounded-xl border border-line bg-card p-5"
              >
                <Check className="mt-1 size-3.5 shrink-0 text-emerald-500" />
                <p className="text-sm leading-6 text-muted">{item}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <PageNext
        label="Kanban work queue"
        title="Turn communication into durable, dependency-aware work"
        body="See how cards carry ownership, model routing, acceptance criteria and Director dispatch across sessions."
        href="/features/kanban-work-queue"
      />
    </>
  );
}

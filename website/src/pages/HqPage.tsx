import {
  Activity,
  AlertTriangle,
  ArrowRightLeft,
  Bell,
  BrainCircuit,
  Cable,
  Check,
  Code2,
  DoorOpen,
  Fingerprint,
  Globe,
  KeyRound,
  Layers3,
  Monitor,
  Network,
  Radio,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import { ExternalDoc, PageHero, PageNext, SectionIntro } from '@/components/site/primitives';

export function HqPage() {
  return (
    <>
      <PageHero
        index="24"
        eyebrow="HQ Command Center"
        title={
          <>
            Orchestrate your fleet
            <br />
            <span className="text-brand">from a browser.</span>
          </>
        }
        description="HQ is a web-based control panel that connects to every WrongStack session on your machines. Monitor fleet status, stream agent transcripts, track costs, view Brain decisions, and send steer commands — all through a browser dashboard."
        aside={<ExternalDoc path="docs/hq/README.md">Open HQ docs</ExternalDoc>}
      />

      {/* ── Architecture ────────────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="01"
          eyebrow="Architecture"
          title="One server, many clients, real-time WebSocket channels."
          description="HQ runs as a standalone web server (`wstack --hq`). Every WrongStack session on every machine connects as a client over a single WebSocket. The dashboard opens in a browser on another WebSocket channel."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {[
            {
              icon: Monitor,
              title: 'HQ Server',
              body: 'Launched with `wstack --hq`. Binds to a configurable port (default OS-assigned), serves the dashboard SPA, and manages client + browser WebSocket connections on separate channels.',
              badge: '--hq',
            },
            {
              icon: Cable,
              title: 'Client machines',
              body: 'Every WrongStack session connects via `/hq connect <url>`. Clients authenticate with a unique token, publish telemetry, and receive commands on a dedicated WebSocket path.',
              badge: '/hq connect',
            },
            {
              icon: Globe,
              title: 'Browser dashboard',
              body: 'Operators open the HQ URL in any browser. The dashboard authenticates with a separate browser token and subscribes to real-time fleet, agent, cost, brain, and alert streams.',
              badge: 'https://...',
            },
          ].map(({ icon: Icon, title, body, badge }) => (
            <article key={title} className="rounded-2xl border border-line bg-card p-7">
              <Icon className="size-5 text-brand" />
              <div className="mt-8 flex items-center gap-2">
                <h2 className="text-lg font-black text-fg">{title}</h2>
                <span className="rounded-full border border-line bg-bg px-2 py-0.5 font-mono text-xs font-black uppercase text-faint">
                  {badge}
                </span>
              </div>
              <p className="mt-4 text-sm leading-7 text-muted">{body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* ── Connection flow ─────────────────────────────────────────────── */}
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="02"
            eyebrow="Connection flow"
            title="Discover, handshake, stream."
            description="When a client connects, it sends a Hello message with its identity, project metadata, and capabilities. The server responds with a Welcome and opens the telemetry channel."
          />
          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-4">
            {[
              {
                step: '01',
                icon: Radio,
                title: 'Discover',
                body: 'On the same machine, clients auto-discover the HQ endpoint from `runtime.json` in the HQ data directory. No URL needed when HQ runs locally.',
              },
              {
                step: '02',
                icon: ArrowRightLeft,
                title: 'Handshake',
                body: 'The client sends a `client.hello` with protocol version, machine identity, project metadata, capabilities, and redaction policy.',
              },
              {
                step: '03',
                icon: Layers3,
                title: 'Welcome',
                body: 'HQ responds with `hq.welcome` — accepted capabilities, negotiated redaction policy, and server timestamp. The channel is open.',
              },
              {
                step: '04',
                icon: Network,
                title: 'Stream',
                body: 'The client publishes telemetry on the WebSocket. HQ time-buckets cost data, maintains per-client ring buffers, and pushes snapshots to browser dashboards.',
              },
            ].map(({ step, icon: Icon, title, body }) => (
              <article key={step} className="bg-card p-7">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs font-black text-brand-2">{step}</span>
                  <Icon className="size-5 text-brand" />
                </div>
                <h2 className="mt-6 text-xl font-black text-fg">{title}</h2>
                <p className="mt-3 text-sm leading-7 text-muted">{body}</p>
              </article>
            ))}
          </div>
          <div className="mt-8 overflow-hidden rounded-2xl border border-line bg-ink">
            <div className="border-b border-white/10 px-6 py-4">
              <span className="font-mono text-xs font-black uppercase tracking-[0.16em] text-zinc-500">
                Client Hello payload
              </span>
            </div>
            <div className="p-6 font-mono text-sm leading-7 text-zinc-300">
              <span className="text-zinc-500">protocolVersion</span>
              <span className="text-zinc-600">: </span>
              <span className="text-amber-300">1</span>
              <br />
              <span className="text-zinc-500">client.kind</span>
              <span className="text-zinc-600">: </span>
              <span className="text-amber-300">cli</span>
              <br />
              <span className="text-zinc-500">client.machineId</span>
              <span className="text-zinc-600">: </span>
              <span className="text-zinc-300">a1b2c3d4</span>
              <br />
              <span className="text-zinc-500">project.projectRoot</span>
              <span className="text-zinc-600">: </span>
              <span className="text-zinc-300">~/code/my-project</span>
              <br />
              <span className="text-zinc-500">capabilities</span>
              <span className="text-zinc-600">: </span>
              <span className="text-zinc-300">
                [telemetry.publish, fleet.summary, control.receive]
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ── Dashboard panels ────────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="03"
          eyebrow="Dashboard panels"
          title="Six real-time views into your fleet."
          description="Each dashboard panel subscribes to a dedicated telemetry stream. No polling — every update pushes to the browser as it arrives from connected machines."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-2">
          {[
            {
              icon: Network,
              title: 'Fleet overview',
              body: 'Global roll-up across all connected machines: active subagents, queued/completed/failed tasks, per-subagent status. Hash-dedup prevents redundant updates — identical fleet state is not republished.',
              source: 'fleet-bridge.ts',
            },
            {
              icon: Activity,
              title: 'Agent transcripts',
              body: 'Per-agent timeline: messages, tool calls, status changes. Ring-buffered per (sessionId, subagentId) so two leaders with default id "leader" never collide into one stream.',
              source: 'agent-bridge.ts',
            },
            {
              icon: Wallet,
              title: 'Cost trends',
              body: 'Granular per-call token and cost accounting. Input/output tokens plus USD breakdown after every provider call. HQ time-buckets into trend series for burn-rate charts.',
              source: 'cost-bridge.ts',
            },
            {
              icon: BrainCircuit,
              title: 'Brain decisions',
              body: 'Every Brain decision request, answer, denial, and ask-human escalation. See risk assessments, rationale text, and which decision path was taken — in real time.',
              source: 'brain-bridge.ts',
            },
            {
              icon: Bell,
              title: 'Mailbox events',
              body: 'Cross-machine mailbox snapshots and message lifecycle events. See when a message is sent, delivered, read, or completed — across every connected session.',
              source: 'publisher.ts',
            },
            {
              icon: AlertTriangle,
              title: 'Alert engine',
              body: 'Configurable alert rules evaluated on a periodic tick (default 15s). Built-in rules: fleet cost threshold (default $50), stale machine detection (120s silence), max agent concurrency.',
              source: 'alerts.ts',
            },
          ].map(({ icon: Icon, title, body, source }) => (
            <article key={title} className="rounded-2xl border border-line bg-card p-7">
              <Icon className="size-5 text-brand" />
              <h2 className="mt-8 text-xl font-black text-fg">{title}</h2>
              <p className="mt-3 text-sm leading-7 text-muted">{body}</p>
              <code className="mt-4 block font-mono text-xs text-faint">{source}</code>
            </article>
          ))}
        </div>
      </section>

      {/* ── Command types ───────────────────────────────────────────────── */}
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="04"
            eyebrow="Control plane"
            title="Seven command types the dashboard can send."
            description="HQ operators can steer, inform, queue, abort, spawn, broadcast, and execute shell commands on connected machines. Each command type has its own security gate."
          />
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {(
              [
                {
                  cmd: 'steer',
                  desc: "Inject a directive into a target agent's conversation. The agent changes course immediately.",
                  gate: 'routes through mailbox',
                },
                {
                  cmd: 'btw',
                  desc: "Post a non-urgent FYI to an agent's mailbox. Absorbed as context — no course change demanded.",
                  gate: 'routes through mailbox',
                },
                {
                  cmd: 'queue',
                  desc: 'Queue a prompt for the agent to pick up before its next step. Waits its turn behind current work.',
                  gate: 'routes through mailbox',
                },
                {
                  cmd: 'abort',
                  desc: 'Abort a running session leader, a specific subagent, or the entire fleet immediately.',
                  gate: 'routes through mailbox',
                },
                {
                  cmd: 'spawn',
                  desc: 'Spawn a subagent of a given role with an optional task description for dispatch routing.',
                  gate: 'routes through mailbox',
                },
                {
                  cmd: 'broadcast',
                  desc: 'Send a mailbox broadcast to every agent on the target project.',
                  gate: 'routes through mailbox',
                },
                {
                  cmd: 'run-command',
                  desc: 'Execute a raw shell command on the target machine. Double-gated by capability + operator opt-in.',
                  gate: 'control.execute + opt-in',
                },
              ] as { cmd: string; desc: string; gate: string }[]
            ).map(({ cmd, desc, gate }) => (
              <div key={cmd} className="rounded-xl border border-line bg-card p-5">
                <code className="font-mono text-sm font-black text-brand">{cmd}</code>
                <p className="mt-2 text-xs leading-5 text-muted">{desc}</p>
                <div className="mt-3 flex items-center gap-1.5">
                  <ShieldCheck className="size-3 text-faint" />
                  <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-faint">
                    {gate}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Security model ──────────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="05"
          eyebrow="Security model"
          title="Separate tokens, scoped capabilities, redacted telemetry."
          description="HQ authenticates every connection. Browser tokens and client tokens are stored in separate lists — a browser-only token cannot replay against the client channel and vice versa."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {[
            {
              icon: KeyRound,
              title: 'auth.json',
              body: 'Persistent credential store at `~/.wrongstack/hq/auth.json` (mode 0600, atomic write). Contains separate lists for browser tokens and client tokens, plus an operator-configurable redaction policy.',
              items: [
                'Schema versioned (v1)',
                'Atomic tmp+rename writes',
                'Missing file = empty (recoverable)',
                'Live-reload watcher for runtime changes',
              ],
            },
            {
              icon: Fingerprint,
              title: 'Two token classes',
              body: 'Browser tokens authenticate dashboard sessions on `/ws/browser`. Client tokens authenticate agent sessions on `/ws/client`. Neither can cross channels — a stolen browser token cannot send commands.',
              items: [
                'Browser tokens: dashboard only',
                'Client tokens: telemetry + commands',
                'Both support capability scoping',
                'Tokens hashed with scrypt for storage',
              ],
            },
            {
              icon: DoorOpen,
              title: 'Capability gates',
              body: 'Each token carries an optional capability list. When present, only the listed capabilities are granted. The `run-command` type requires both `control.execute` capability AND operator opt-in.',
              items: [
                'control.enqueue — send commands',
                'control.execute — run shell commands',
                'telemetry.publish — stream telemetry',
                'session/fleet/mailbox.summary',
              ],
            },
          ].map(({ icon: Icon, title, body, items }) => (
            <article key={title} className="rounded-2xl border border-line bg-card p-7">
              <Icon className="size-5 text-brand" />
              <h2 className="mt-8 text-xl font-black text-fg">{title}</h2>
              <p className="mt-3 text-sm leading-7 text-muted">{body}</p>
              <ul className="mt-5 space-y-2">
                {items.map((item) => (
                  <li key={item} className="flex items-start gap-2 text-xs leading-5 text-muted">
                    <Check className="mt-0.5 size-3 shrink-0 text-brand-2" />
                    {item}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
        <div className="mt-8 rounded-2xl border border-line bg-card p-7">
          <h2 className="text-xl font-black text-fg">Redaction policy</h2>
          <p className="mt-3 text-sm leading-7 text-muted">
            Every client declares a publisher-side redaction policy in its Hello. The server also
            applies a server-side policy as a second pass. Together they control what leaves your
            machine.
          </p>
          <div className="mt-5 grid gap-4 sm:grid-cols-3">
            {[
              {
                label: 'Tool arguments',
                levels: [
                  'none — never send',
                  'summary — tool name only',
                  'redacted — scrubbed args',
                  'full — all arguments',
                ],
              },
              {
                label: 'File paths',
                levels: [
                  'none — never send',
                  'project-relative — strip prefix',
                  'redacted — path segments only',
                  'full — absolute paths',
                ],
              },
              {
                label: 'Raw content',
                levels: [
                  'false — redact everything',
                  'true — send full content (default)',
                  '',
                  'Transcript text capped at 16 000 chars',
                ],
              },
            ].map(({ label, levels }) => (
              <div key={label} className="rounded-lg border border-line bg-bg p-4">
                <h3 className="font-black text-sm text-fg">{label}</h3>
                <ul className="mt-2 space-y-1">
                  {levels.filter(Boolean).map((lvl) => (
                    <li key={lvl} className="text-xs leading-5 text-muted">
                      {lvl}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Telemetry bridges ───────────────────────────────────────────── */}
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="06"
            eyebrow="Telemetry bridges"
            title="Five EventBus → WebSocket bridges feed the dashboard."
            description="Each bridge subscribes to a local EventBus stream and forwards structured envelopes to HQ. Hash-dedup prevents redundant updates. All bridges are best-effort — a failure never breaks the host."
          />
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {[
              {
                icon: Network,
                label: 'Fleet',
                event: 'coordinator.stats',
                desc: 'Active subagents, queued/completed/failed tasks, per-agent status.',
              },
              {
                icon: Activity,
                label: 'Agent',
                event: 'agent.timeline.*',
                desc: 'Messages, tool calls, status changes with iteration and cost metadata.',
              },
              {
                icon: Code2,
                label: 'Session',
                event: 'session.*',
                desc: 'Session lifecycle, transcript appends, snapshot updates, session end events.',
              },
              {
                icon: Wallet,
                label: 'Cost',
                event: 'token.accounted',
                desc: 'Per-call token counts and USD cost. Time-bucketed into trend series.',
              },
              {
                icon: BrainCircuit,
                label: 'Brain',
                event: 'brain.*',
                desc: 'Decision requests, answers, denials, ask-human escalations.',
              },
            ].map(({ icon: Icon, label, event, desc }) => (
              <div key={label} className="rounded-xl border border-line bg-card p-5">
                <Icon className="size-4 text-brand" />
                <h3 className="mt-4 font-black text-sm text-fg">{label}</h3>
                <code className="mt-2 block font-mono text-[10px] text-faint">{event}</code>
                <p className="mt-2 text-xs leading-5 text-muted">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Setup & commands ────────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="07"
          eyebrow="Setup"
          title="Start the server, connect agents, open the dashboard."
          description="HQ runs on a single machine. Every WrongStack session — local or remote — connects to it. The dashboard opens in a browser pointed at the same URL."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-line bg-card p-7">
            <h2 className="text-xl font-black text-fg">Server commands</h2>
            <div className="mt-5 space-y-3">
              {[
                {
                  cmd: 'wstack --hq',
                  desc: 'Start the HQ server. Prints the bind URL and dashboard address. Token is written to auth.json.',
                },
                {
                  cmd: 'wstack --hq --port 8080',
                  desc: 'Bind to a specific port instead of OS-assigned. Use with --strict-port to fail if occupied.',
                },
                {
                  cmd: 'wstack --hq --data-dir /path',
                  desc: 'Override the default HQ data directory (~/.wrongstack/hq). Useful for sandboxed runs.',
                },
                {
                  cmd: 'wstack --hq --host 0.0.0.0',
                  desc: 'Expose on all interfaces. Requires a reverse proxy with its own auth and rate limiting.',
                },
              ].map(({ cmd, desc }) => (
                <div key={cmd} className="rounded-lg border border-line bg-bg p-4">
                  <code className="font-mono text-sm font-black text-brand">{cmd}</code>
                  <p className="mt-1.5 text-xs leading-5 text-muted">{desc}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border border-line bg-card p-7">
            <h2 className="text-xl font-black text-fg">Client commands</h2>
            <div className="mt-5 space-y-3">
              {[
                {
                  cmd: '/hq connect <url>',
                  desc: 'Link this session to an HQ server. The client sends its Hello and begins publishing telemetry.',
                },
                {
                  cmd: '/hq status',
                  desc: 'Detailed view: connection state, active sessions, event throughput, uptime, and pending commands.',
                },
                {
                  cmd: '/hq disconnect',
                  desc: 'Sever the HQ connection. Telemetry stops and the session continues locally. Reconnect later.',
                },
                {
                  cmd: '/hq',
                  desc: 'Quick status: connection URL, session count, and whether the client channel is open.',
                },
              ].map(({ cmd, desc }) => (
                <div key={cmd} className="rounded-lg border border-line bg-bg p-4">
                  <code className="font-mono text-sm font-black text-brand">{cmd}</code>
                  <p className="mt-1.5 text-xs leading-5 text-muted">{desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <PageNext
        label="Telegram"
        title="Notifications and approvals in chat"
        body="Get agent alerts, request approvals, and send commands through Telegram."
        href="/telegram"
      />
    </>
  );
}

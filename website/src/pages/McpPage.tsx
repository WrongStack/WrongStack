import {
  ArrowDown,
  Check,
  Cloud,
  Filter,
  Network,
  Power,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import { ExternalDoc, PageHero, PageNext, SectionIntro } from '@/components/site/primitives';
import { Link } from '@/lib/router';

export function McpPage() {
  return (
    <>
      <PageHero
        index="15"
        eyebrow="MCP guide"
        title={
          <>
            External tools.
            <br />
            <span className="text-brand">Internal policy.</span>
          </>
        }
        description="MCP extends the tool inventory over JSON-RPC 2.0. WrongStack keeps those tools namespaced, permissioned, cancellable and operationally visible like built-ins."
        aside={
          <ExternalDoc path="docs/subcommands/mcp.md">Open MCP lifecycle reference</ExternalDoc>
        }
      />
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="01"
          eyebrow="Transports"
          title="Local process, event stream or streaming HTTP."
        />
        <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-3">
          {[
            [
              Terminal,
              'stdio',
              'Spawn a local child process and exchange JSON-RPC through stdin/stdout.',
              'Best for local development tools',
            ],
            [
              Network,
              'SSE',
              'Connect to a remote event stream with request responses delivered over HTTP.',
              'Useful for existing remote servers',
            ],
            [
              Cloud,
              'streamable-http',
              'Use the modern MCP HTTP transport with streaming response support.',
              'Best default for new remote services',
            ],
          ].map(([Icon, name, body, best]) => {
            const ItemIcon = Icon as typeof Terminal;
            return (
              <article key={String(name)} className="bg-card p-7">
                <ItemIcon className="size-5 text-brand" />
                <h2 className="mt-8 font-mono text-xl font-black text-fg">{String(name)}</h2>
                <p className="mt-3 text-sm leading-7 text-muted">{String(body)}</p>
                <p className="mt-6 text-xs font-semibold text-faint">{String(best)}</p>
              </article>
            );
          })}
        </div>
      </section>
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="02"
            eyebrow="Connection lifecycle"
            title="Lazy when possible. Bounded when broken."
          />
          <div className="mt-12 space-y-2">
            {[
              ['Configured', 'Management core validates and persists the server definition.'],
              ['Dormant', 'A lazy server exposes cached tool wrappers without spawning at boot.'],
              ['Connecting', 'The first tool call enters a single-flight ensureConnected path.'],
              ['Connected', 'Tool discovery refreshes wrappers and resets the reconnect cycle.'],
              [
                'Sleeping or failed',
                'Idle lazy servers sleep; five failed reconnect cycles mark a hard failed slot until restart.',
              ],
            ].map(([title, body], index) => (
              <div key={title}>
                <div className="grid gap-4 rounded-xl border border-line bg-card p-5 sm:grid-cols-[44px_160px_1fr] sm:items-center">
                  <span className="font-mono text-xs font-black text-brand-2">0{index + 1}</span>
                  <strong className="text-sm text-fg">{title}</strong>
                  <p className="text-sm leading-6 text-muted">{body}</p>
                </div>
                {index < 4 && <ArrowDown className="mx-auto my-1 size-4 text-faint" />}
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="03"
          eyebrow="Operate"
          title="One management core across CLI, TUI and WebUI."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-[.72fr_1fr]">
          <div className="overflow-hidden rounded-2xl border border-line bg-ink">
            {[
              'wstack mcp list',
              'wstack mcp add <name> --enable',
              '/mcp discover <server>',
              '/mcp restart <server>',
              '/mcp disable <server>',
            ].map((command) => (
              <code
                key={command}
                className="block border-b border-white/10 px-5 py-4 font-mono text-xs text-zinc-300 last:border-b-0"
              >
                <span className="mr-3 text-brand">❯</span>
                {command}
              </code>
            ))}
          </div>
          <div className="grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2">
            {[
              [Filter, 'Tool filtering', 'allowedTools limits what is registered from one server.'],
              [ShieldCheck, 'Permission', 'MCP wrappers still resolve auto, confirm or deny.'],
              [Power, 'Cancellation', 'Dropped calls also send notifications/cancelled upstream.'],
              [Network, 'Namespacing', 'mcp__<server>__<tool> prevents collisions.'],
            ].map(([Icon, title, body]) => {
              const ItemIcon = Icon as typeof Filter;
              return (
                <article key={String(title)} className="bg-card p-5">
                  <ItemIcon className="size-4 text-brand" />
                  <h3 className="mt-5 font-black text-fg">{String(title)}</h3>
                  <p className="mt-2 text-xs leading-5 text-muted">{String(body)}</p>
                </article>
              );
            })}
          </div>
        </div>
      </section>
      <section className="border-y border-line bg-ink text-white">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 lg:px-10">
          <SectionIntro
            index="04"
            eyebrow="Security"
            title="Remote capability needs a remote boundary."
          />
          <div className="mt-12 grid gap-5 lg:grid-cols-3">
            {[
              [
                'In-project config',
                'mcpServers is stripped entirely because a cloned repo must not spawn arbitrary commands.',
              ],
              [
                'HTTP protection',
                'Remote URLs pass SSRF checks; TLS verification stays enabled unless the operator explicitly changes it.',
              ],
              [
                'Server mode',
                'wstack mcp serve exposes read-only built-ins by default; --yolo is required for write and exec tools.',
              ],
            ].map(([title, body], index) => (
              <article
                key={title}
                className="rounded-2xl border border-white/10 bg-white/[0.035] p-6"
              >
                <span className="font-mono text-xs font-black text-brand-2">0{index + 1}</span>
                <h2 className="mt-8 text-xl font-black">{title}</h2>
                <p className="mt-3 text-sm leading-7 text-zinc-500">{body}</p>
              </article>
            ))}
          </div>
          <div className="mt-8 flex items-center gap-3 text-sm text-emerald-400">
            <Check className="size-4" /> Sensitive per-project MCP config belongs in
            config.local.json outside the repository.
          </div>
          <div className="mt-6 flex flex-wrap gap-5">
            <Link href="/commands/mcp" className="text-sm font-bold text-brand">
              Learn /mcp →
            </Link>
            <ExternalDoc path="docs/mcp-server.md">Run WrongStack as an MCP server</ExternalDoc>
          </div>
        </div>
      </section>
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="04"
          eyebrow="Transports"
          title="Stdio today. SSE and streamable HTTP on the roadmap."
          description="WrongStack supports three MCP transport types. Each has different latency, security, and setup characteristics."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {[
            {
              title: 'Stdio',
              body: 'Child process over stdin/stdout. Zero network — the MCP server runs as a local subprocess. Lowest latency, simplest security model.',
              tag: 'default',
            },
            {
              title: 'SSE',
              body: 'Server-Sent Events over HTTP. The server pushes tool results to the client. Supports remote servers behind a reverse proxy.',
              tag: 'remote',
            },
            {
              title: 'Streamable HTTP',
              body: 'Bidirectional HTTP streaming. The most flexible transport. Supports both local and remote servers with full-duplex communication.',
              tag: 'roadmap',
            },
          ].map(({ title, body, tag }) => (
            <article key={title} className="rounded-2xl border border-line bg-card p-7">
              <h2 className="text-xl font-black text-fg">{title}</h2>
              <span className="mt-2 inline-block rounded-full border border-line bg-bg px-2 py-0.5 font-mono text-xs text-brand">
                {tag}
              </span>
              <p className="mt-4 text-sm leading-7 text-muted">{body}</p>
            </article>
          ))}
        </div>
      </section>
      <PageNext
        label="Troubleshooting"
        title="Diagnose connections and runtime failures"
        body="Start with one diagnostic command, then narrow the failing layer."
        href="/troubleshooting"
      />
    </>
  );
}

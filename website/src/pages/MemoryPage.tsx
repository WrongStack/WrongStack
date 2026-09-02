import {
  ArrowDown,
  Check,
  Database,
  FileClock,
  GitCommitHorizontal,
  MemoryStick,
} from 'lucide-react';
import { ExternalDoc, PageHero, PageNext, SectionIntro } from '@/components/site/primitives';
import { Link } from '@/lib/router';

export function MemoryPage() {
  return (
    <>
      <PageHero
        index="13"
        eyebrow="Memory & sessions"
        title={
          <>
            Continuity without
            <br />
            <span className="text-brand">context bloat.</span>
          </>
        }
        description="Sessions reconstruct what happened. SAGE preserves verified project knowledge. Checkpoints capture reversible file state. Compaction keeps the model window healthy without deleting history."
        aside={
          <ExternalDoc path="docs/plans/sage-architecture.md">Open SAGE architecture</ExternalDoc>
        }
      />
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro index="01" eyebrow="Four stores" title="Use the right kind of continuity." />
        <div className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-4">
          {[
            [
              FileClock,
              'Session log',
              'Reconstruct conversation, tools, usage, failures and lifecycle.',
              'date-sharded JSONL',
            ],
            [
              MemoryStick,
              'SAGE',
              'Retrieve stable facts, anchors and project relationships.',
              '.wrongstack/memories',
            ],
            [
              GitCommitHorizontal,
              'Checkpoints',
              'Restore file state around risky or multi-step edits.',
              'snapshots + rewind',
            ],
            [
              Database,
              'Live context',
              'Feed the current provider request under a bounded token window.',
              'messages + injected memory',
            ],
          ].map(([Icon, title, body, storage]) => {
            const ItemIcon = Icon as typeof Database;
            return (
              <article key={String(title)} className="bg-card p-6">
                <ItemIcon className="size-5 text-brand" />
                <h2 className="mt-8 text-xl font-black text-fg">{String(title)}</h2>
                <p className="mt-3 text-sm leading-6 text-muted">{String(body)}</p>
                <code className="mt-6 block font-mono text-xs text-faint">{String(storage)}</code>
              </article>
            );
          })}
        </div>
      </section>
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="02"
            eyebrow="Session lifecycle"
            title="One live writer, serialized from start to close."
          />
          <div className="mt-12 space-y-2">
            {[
              [
                'Start or resume',
                'Create the live writer, append session lifecycle state and point active recovery metadata at it.',
              ],
              [
                'Record the reconstruct set',
                'Always write user input, model response, tool result, checkpoint and in-flight markers.',
              ],
              [
                'Flush safely',
                'All appends pass through one FIFO write chain; /save flushes without ending the session.',
              ],
              [
                'Switch deliberately',
                'TUI, WebUI and Desktop finalize and close the old writer before replacing ctx.session.',
              ],
              [
                'Recover',
                'Only a trailing session_end counts as clean. Interrupted tool adjacency is repaired on resume.',
              ],
            ].map(([title, body], index) => (
              <div key={title}>
                <div className="grid gap-4 rounded-xl border border-line bg-card p-5 sm:grid-cols-[44px_190px_1fr] sm:items-center">
                  <span className="font-mono text-xs font-black text-brand-2">0{index + 1}</span>
                  <strong className="text-sm text-fg">{title}</strong>
                  <p className="text-sm leading-6 text-muted">{body}</p>
                </div>
                {index < 4 && <ArrowDown className="mx-auto my-1 size-4 text-faint" />}
              </div>
            ))}
          </div>
          <div className="mt-8">
            <ExternalDoc path="docs/session-logging-events.md">
              Browse every recorded event type
            </ExternalDoc>
          </div>
        </div>
      </section>
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="03"
          eyebrow="SAGE graph"
          title="Facts connect to the code they describe."
          description="Memory is not one markdown blob. Graph edges make retrieval aware of symbols, files, directories, packages, commands, sessions and sources."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-[.72fr_1fr]">
          <div className="rounded-2xl border border-line bg-ink p-7 text-zinc-300">
            <div className="font-mono text-xs font-black uppercase tracking-[0.16em] text-zinc-600">
              Graph example
            </div>
            <div className="mt-8 space-y-4 font-mono text-xs">
              <div className="rounded-lg border border-brand/30 bg-brand/10 p-3 text-brand">
                memory: provider errors classify once
              </div>
              <div className="pl-6 text-zinc-600">├─ symbol: classifyProviderError</div>
              <div className="pl-6 text-zinc-600">├─ file: core/src/types/provider.ts</div>
              <div className="pl-6 text-zinc-600">├─ package: @wrongstack/core</div>
              <div className="pl-6 text-zinc-600">└─ source: session / tool / manual</div>
            </div>
          </div>
          <div className="space-y-3">
            {[
              [
                'Retrieval',
                'Query, scope, graph proximity, anchors, quality and novelty determine what is injected.',
              ],
              [
                'Noise control',
                'Results already present in the system prompt or tool output are suppressed.',
              ],
              [
                'Hygiene',
                'File mutations re-verify affected anchors and mark stale knowledge instead of silently trusting it.',
              ],
              [
                'Concurrency',
                'Readers and writers share the project lock so partial JSONL lines are never quarantined as corruption.',
              ],
            ].map(([title, body]) => (
              <div key={title} className="rounded-xl border border-line bg-card p-5">
                <h2 className="font-black text-fg">{title}</h2>
                <p className="mt-2 text-sm leading-6 text-muted">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="border-t border-line bg-ink text-white">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 lg:px-10">
          <SectionIntro
            index="04"
            eyebrow="Compaction"
            title="Shrink the window, not the evidence."
          />
          <div className="mt-12 grid gap-5 lg:grid-cols-3">
            {[
              [
                'Hybrid',
                'Default lossless rule-based strategy. Elides oversized old tool results and collapses ancient turns into a digest.',
              ],
              [
                'Intelligent',
                'Adds model summarization, then falls back to the lossless hybrid digest if no provider or a failure occurs.',
              ],
              [
                'Selective',
                'Uses a model to choose what to keep or collapse before summarizing the selected regions.',
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
            <Check className="size-4" /> Raw tool I/O remains available in the session log.
          </div>
          <div className="mt-6 flex gap-5">
            <Link href="/commands/memory" className="text-sm font-bold text-brand">
              Learn /memory →
            </Link>
            <Link href="/commands/context" className="text-sm font-bold text-brand">
              Learn /context →
            </Link>
          </div>
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {[
              {
                href: '/checkpoints',
                label: 'Checkpoints',
                desc: 'File state snapshots before risky edits. Roll back to the last known-good state.',
              },
              {
                href: '/commit-workflow',
                label: 'Commit workflow',
                desc: 'Auto-generated conventional commits from your diff. Stage, review, commit.',
              },
            ].map(({ href, label, desc }) => (
              <Link
                key={href}
                href={href}
                className="group rounded-xl border border-white/10 bg-white/[0.035] p-5 hover:border-brand/40 transition-colors"
              >
                <h3 className="font-black text-base group-hover:text-brand transition-colors">
                  {label}
                </h3>
                <p className="mt-2 text-xs leading-5 text-zinc-500">{desc}</p>
                <span className="mt-3 inline-block text-xs font-bold text-brand">Explore →</span>
              </Link>
            ))}
          </div>
        </div>
      </section>
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="05"
          eyebrow="Session reconstruction"
          title="Replay an entire session from JSONL."
          description="Session logs are date-sharded JSONL files under `~/.wrongstack/sessions/`. Every event — message, tool call, tool result, error — is an append-only immutable line. The session writer guarantees clean finalization."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {[
            {
              title: 'Event types',
              body: 'message, thinking, tool_use, tool_result, error, status, system. Each carries timestamp, iteration, and optional cost metadata.',
            },
            {
              title: 'Replay',
              body: '/session replay <id> reconstructs the full conversation. Useful for debugging past runs, auditing decisions, or continuing from a checkpoint.',
            },
            {
              title: 'Retention',
              body: 'Configurable. Sessions auto-prune based on age and count. Critical sessions can be pinned to prevent deletion.',
            },
          ].map(({ title, body }) => (
            <div key={title} className="rounded-xl border border-line bg-card p-5">
              <h3 className="font-black text-sm text-fg">{title}</h3>
              <p className="mt-2 text-xs leading-5 text-muted">{body}</p>
            </div>
          ))}
        </div>
      </section>
      <PageNext
        label="MCP"
        title="Add external tools without losing the boundary"
        body="Connect servers lazily, filter their tools and govern every remote call."
        href="/mcp"
      />
    </>
  );
}

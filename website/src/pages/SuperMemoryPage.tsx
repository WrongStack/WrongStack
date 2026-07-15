import {
  BrainCircuit,
  Check,
  FileSearch,
  GitGraph,
  Layers3,
  MemoryStick,
  ScanSearch,
  Tag,
  Telescope,
  Zap,
} from 'lucide-react';
import { Link } from '@/lib/router';
import { ExternalDoc, PageHero, PageNext, SectionIntro } from '@/components/site/primitives';

export function SuperMemoryPage() {
  return (
    <>
      <PageHero
        index="14"
        eyebrow="Super Memory"
        title={
          <>
            The agent remembers
            <br />
            <span className="text-brand">across sessions.</span>
          </>
        }
        description="Super Memory is WrongStack's persistent, structured knowledge system. It remembers facts, conventions, decisions, and anti-patterns — then scores and injects the most relevant ones into every agent turn."
        aside={
          <ExternalDoc path="docs/plans/super-memory-architecture.md">
            Open Super Memory architecture
          </ExternalDoc>
        }
      />

      {/* ── Three scopes ──────────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="01"
          eyebrow="Three scopes"
          title="Store the right fact in the right place."
          description="Every memory lives in one of three isolation layers. The agent picks the right scope based on who needs the fact and how long it should live."
        />
        <div className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-3">
          {[
            {
              icon: Layers3,
              label: 'Project agents',
              path: '.wrongstack/AGENTS.md',
              body: 'Shared agent instructions committed to the repository. Every agent working on this project sees these facts. Use for build commands, repo conventions, and team-wide rules.',
              tag: 'committed',
            },
            {
              icon: MemoryStick,
              label: 'Project memory',
              path: '~/.wrongstack/projects/<hash>/memory.md',
              body: 'Per-project agent notes that stay local to your machine. The agent discovers and remembers project-specific patterns, file paths, and workflow preferences automatically.',
              tag: 'local',
            },
            {
              icon: BrainCircuit,
              label: 'User memory',
              path: '~/.wrongstack/memory.md',
              body: 'Global personal memory shared across all your projects. Store your coding style, tool preferences, and personal conventions once — every project benefits.',
              tag: 'global',
            },
          ].map(({ icon: Icon, label, path, body, tag }) => (
            <article key={label} className="bg-card p-7">
              <Icon className="size-5 text-brand" />
              <div className="mt-8 flex items-center gap-2">
                <h2 className="text-lg font-black text-fg">{label}</h2>
                <span className="rounded-full border border-line bg-bg px-2 py-0.5 font-mono text-xs font-black uppercase text-faint">
                  {tag}
                </span>
              </div>
              <p className="mt-4 text-sm leading-7 text-muted">{body}</p>
              <code className="mt-6 block font-mono text-xs text-faint break-all">
                {path}
              </code>
            </article>
          ))}
        </div>
      </section>

      {/* ── Entry anatomy ─────────────────────────────────────────────── */}
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="02"
            eyebrow="Entry anatomy"
            title="Every memory is typed, tagged, and prioritized."
            description="The agent doesn't dump raw text. Each entry carries structured metadata that the scoring engine uses to decide what gets injected."
          />
          <div className="mt-12 overflow-hidden rounded-2xl border border-line bg-ink">
            <div className="border-b border-white/10 px-6 py-4">
              <span className="font-mono text-xs font-black uppercase tracking-[0.16em] text-zinc-500">
                Memory entry format
              </span>
            </div>
            <div className="p-6 font-mono text-sm">
              <div className="space-y-3 text-zinc-300">
                <div className="flex flex-wrap gap-2">
                  <span className="rounded bg-brand/20 px-2 py-0.5 text-xs text-brand">type</span>
                  <span className="text-zinc-500">fact · decision · convention · preference · reference · anti_pattern</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <span className="rounded bg-brand/20 px-2 py-0.5 text-xs text-brand">priority</span>
                  <span className="text-zinc-500">critical ⚡ · high ▲ · medium · low</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <span className="rounded bg-brand/20 px-2 py-0.5 text-xs text-brand">tags</span>
                  <span className="text-zinc-500">#path · #build · #convention · #bug · #architecture</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <span className="rounded bg-brand/20 px-2 py-0.5 text-xs text-brand">source</span>
                  <span className="text-zinc-500">session ID or agent that created the entry</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <span className="rounded bg-brand/20 px-2 py-0.5 text-xs text-brand">confidence</span>
                  <span className="text-zinc-500">0.0–1.0 — low-confidence entries are injected less often</span>
                </div>
              </div>
              <div className="mt-8 rounded-lg border border-white/10 bg-white/[0.03] p-5">
                <span className="text-xs font-black uppercase tracking-[0.16em] text-zinc-600">
                  Serialized on disk
                </span>
                <code className="mt-3 block text-xs leading-6 text-zinc-400">
                  - [2026-07-13T10:30:00.000Z] [convention|high] mem_1720_a3f2b1c4 Use conventional commits for all changes #git #commit
                </code>
              </div>
            </div>
          </div>
          <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                title: 'Critical priority',
                body: 'Always injected into context, regardless of relevance score. Use for security constraints and build commands.',
              },
              {
                title: 'Anti-patterns',
                body: 'Highest type boost (+3) in scoring. The agent actively avoids repeating documented mistakes.',
              },
              {
                title: 'Confidence gate',
                body: 'Entries below 0.5 confidence get a score penalty. The agent prefers verified facts over speculation.',
              },
            ].map(({ title, body }) => (
              <div key={title} className="rounded-xl border border-line bg-card p-5">
                <h3 className="font-black text-fg text-sm">{title}</h3>
                <p className="mt-2 text-xs leading-6 text-muted">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Relevance scoring ──────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="03"
          eyebrow="Relevance engine"
          title="Not every memory belongs in every turn."
          description="Before each agent request, the scoring engine ranks all entries against the current task, active skills, available tools, and session mode. Only the top 8 make the cut."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-[1fr_.72fr]">
          <div className="space-y-3">
            {[
              {
                icon: Telescope,
                title: 'Task word overlap',
                body: 'Primary signal. Words from the current task are matched against entry text (+2) and tags (+3 per tag hit).',
              },
              {
                icon: Zap,
                title: 'Skill and tool relevance',
                body: 'Active skill names and available tool names boost entries that mention them. Keeps domain-specific knowledge surfaced at the right time.',
              },
              {
                icon: Tag,
                title: 'Priority and type boosts',
                body: 'Critical entries get +5. Anti-patterns get +3. Low priority entries get a -2 penalty. Decisions and conventions are weighted above plain facts.',
              },
              {
                icon: FileSearch,
                title: 'Recency and repetition',
                body: 'Entries younger than 1 day get +1; older than 30 days get -1. Recently accessed entries get a slight penalty to avoid repetition.',
              },
            ].map(({ icon: Icon, title, body }) => (
              <div key={title} className="rounded-xl border border-line bg-card p-5">
                <div className="flex items-start gap-3">
                  <Icon className="mt-0.5 size-4 shrink-0 text-brand" />
                  <div>
                    <h3 className="font-black text-fg text-sm">{title}</h3>
                    <p className="mt-1.5 text-xs leading-6 text-muted">{body}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <aside className="rounded-2xl border border-line bg-ink p-7 text-zinc-300">
            <div className="font-mono text-xs font-black uppercase tracking-[0.16em] text-zinc-600">
              Injection example
            </div>
            <div className="mt-6 space-y-4 font-mono text-xs">
              <p className="text-zinc-500">
                You type: <span className="text-zinc-300">"fix the login timeout bug"</span>
              </p>
              <div className="rounded-lg border border-white/10 p-3">
                <p className="text-xs font-black uppercase tracking-[0.16em] text-zinc-600">
                  Injected into system prompt
                </p>
                <div className="mt-3 space-y-2">
                  <div className="flex items-start gap-2">
                    <span className="shrink-0 text-emerald-500">+7</span>
                    <span className="text-zinc-300">
                      [<span className="text-brand">anti_pattern</span>]
                      {' '}Auth token refresh races with concurrent requests #auth #bug
                    </span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="shrink-0 text-emerald-500">+5</span>
                    <span className="text-zinc-300">
                      [<span className="text-brand">fact</span>]
                      {' '}Login timeout defaults to 30s in production config #auth #timeout
                    </span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="shrink-0 text-zinc-500">+3</span>
                    <span className="text-zinc-400">
                      [<span className="text-brand">reference</span>]
                      {' '}auth module lives in packages/auth/src #path #auth
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </section>

      {/* ── Storage backends ───────────────────────────────────────────── */}
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="04"
            eyebrow="Storage backends"
            title="File system first, graph when you need it."
            description="Every WrongStack installation gets fast file-based memory with an inverted index. Enable the graph backend for relationship-aware traversal."
          />
          <div className="mt-12 grid gap-6 lg:grid-cols-2">
            {[
              {
                icon: FileSearch,
                title: 'File backend',
                badge: 'default',
                items: [
                  'Markdown bullet files with atomic writes and file locking',
                  'Inverted word/tag index for O(1) exact-match search',
                  'Bounded substring fallback for partial-match recall',
                  'mtime-based cache invalidation — no stale reads',
                  'Automatic consolidation at 32 KB per scope',
                ],
              },
              {
                icon: GitGraph,
                title: 'Graph backend',
                badge: 'opt-in',
                items: [
                  'Co-occurrence edges: entries from the same remember() batch',
                  'Similarity edges: Jaccard overlap on word sets',
                  'Turn-based edges: entries created in the same LLM turn',
                  'findRelated() traversal for "what else should I know?" queries',
                  'Graph metadata persisted to memory-graph.json alongside entries',
                ],
              },
            ].map(({ icon: Icon, title, badge, items }) => (
              <article key={title} className="rounded-2xl border border-line bg-card p-7">
                <div className="flex items-center gap-3">
                  <Icon className="size-5 text-brand" />
                  <h2 className="text-xl font-black text-fg">{title}</h2>
                  <span className="rounded-full border border-line bg-bg px-2 py-0.5 font-mono text-xs font-black uppercase text-faint">
                    {badge}
                  </span>
                </div>
                <ul className="mt-6 space-y-3">
                  {items.map((item) => (
                    <li key={item} className="flex items-start gap-2 text-sm leading-6 text-muted">
                      <Check className="mt-1 size-3.5 shrink-0 text-brand" />
                      {item}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── Consolidation ──────────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="05"
          eyebrow="Consolidation"
          title="Clean up without losing knowledge."
          description="Deduplication runs automatically when a scope exceeds 32 KB. An optional post-session LLM pass proposes smarter add, edit, and delete operations."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-line bg-card p-7">
            <ScanSearch className="size-5 text-brand" />
            <h2 className="mt-8 text-xl font-black text-fg">Automatic dedup</h2>
            <p className="mt-3 text-sm leading-7 text-muted">
              When a scope's total byte size crosses 32 KB (~8K tokens), the store runs a
              normalization pass: timestamps, IDs, type/priority badges, and tags are stripped, and
              duplicate normalized lines are removed. The original file is backed up before mutation.
            </p>
            <div className="mt-5 flex items-center gap-2 text-xs text-faint">
              <Check className="size-3.5 text-emerald-500" />
              Up to 5 consolidation backups are kept per scope
            </div>
          </div>
          <div className="rounded-2xl border border-line bg-card p-7">
            <BrainCircuit className="size-5 text-brand" />
            <h2 className="mt-8 text-xl font-black text-fg">LLM consolidation</h2>
            <p className="mt-3 text-sm leading-7 text-muted">
              After sessions with enough iterations, an optional lightweight model pass reviews the
              conversation and proposes edit/delete operations on existing entries plus new facts to
              remember. The consolidator uses a fast model — it summarizes, does not generate code.
            </p>
            <div className="mt-5 flex items-center gap-2 text-xs text-faint">
              <Check className="size-3.5 text-emerald-500" />
              Min 2 iterations before consolidation fires; skips trivial sessions
            </div>
          </div>
        </div>
      </section>

      {/* ── Auto-injection ─────────────────────────────────────────────── */}
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="06"
            eyebrow="Injection points"
            title="Memory reaches the agent at two critical moments."
          />
          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2">
            {[
              {
                title: 'Turn context',
                body: 'Before every agent request, the top 8 scored entries from project-memory are injected into the system prompt as a "Relevant Memory" block. The agent sees them alongside its tools, mode, and instructions.',
                detail: 'Configurable: superMemory.inject.turnContext (default true)',
              },
              {
                title: 'Tool results',
                body: 'After file reads, grep results, and directory trees return, up to 4 relevant memory hints are appended to the output. The agent gets file-path-aware context without you having to remind it.',
                detail: 'Configurable: superMemory.inject.toolResults and maxHintsPerTool (default 4)',
              },
            ].map(({ title, body, detail }) => (
              <article key={title} className="bg-card p-7">
                <h2 className="text-xl font-black text-fg">{title}</h2>
                <p className="mt-3 text-sm leading-7 text-muted">{body}</p>
                <code className="mt-5 block font-mono text-xs text-faint">{detail}</code>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── Tool integration ───────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="07"
          eyebrow="Operator surface"
          title="Commands and tools for memory work."
          description="You do not edit markdown files by hand. The agent and its tools manage memory automatically — but you can inspect and control it."
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              label: '/memory search',
              body: 'Find entries by keyword or phrase across any scope. The inverted index returns O(1) exact matches with substring fallback.',
            },
            {
              label: '/memory graph',
              body: 'Open the graph explorer when the graph backend is active. Traverse co-occurrence and similarity edges.',
            },
            {
              label: '/memory verify',
              body: 'Check memory file integrity. Detect and report parse errors, duplicate IDs, and corrupted lines.',
            },
            {
              label: '/memory hygiene',
              body: 'Clean stale or low-confidence entries. Runs consolidation and reports what was removed.',
            },
          ].map(({ label, body }) => (
            <div key={label} className="rounded-xl border border-line bg-card p-5">
              <code className="font-mono text-sm font-black text-brand">{label}</code>
              <p className="mt-2 text-xs leading-5 text-muted">{body}</p>
            </div>
          ))}
        </div>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              label: '/memory import',
              body: 'Load memories from external markdown files or JSON exports into any scope.',
            },
            {
              label: 'remember tool',
              body: 'The agent calls this automatically after discovering a new fact, convention, or decision.',
            },
            {
              label: 'forget tool',
              body: 'Remove entries by content substring or exact memory ID. The agent uses it during hygiene.',
            },
            {
              label: 'find_related_memories',
              body: 'Graph traversal for "what else is relevant?" queries. Falls back to content search without the graph backend.',
            },
          ].map(({ label, body }) => (
            <div key={label} className="rounded-xl border border-line bg-card p-5">
              <code className="font-mono text-sm font-black text-brand">{label}</code>
              <p className="mt-2 text-xs leading-5 text-muted">{body}</p>
            </div>
          ))}
        </div>
        <div className="mt-8 flex flex-wrap gap-5">
          <Link href="/commands/memory" className="text-sm font-bold text-brand">
            /memory command reference →
          </Link>
          <ExternalDoc path="docs/slash/memory.md">
            Memory slash command docs
          </ExternalDoc>
        </div>
      </section>

      {/* ── Configuration ──────────────────────────────────────────────── */}
      <section className="border-t border-line bg-ink text-white">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 lg:px-10">
          <SectionIntro
            index="08"
            eyebrow="Configuration"
            title="Tune memory to your workflow."
          />
          <div className="mt-12 overflow-hidden rounded-2xl border border-white/10">
            <div className="border-b border-white/10 px-6 py-4">
              <span className="font-mono text-xs font-black uppercase tracking-[0.16em] text-zinc-500">
                .wrongstack/config.json → superMemory
              </span>
            </div>
            <div className="p-6 font-mono text-sm leading-7 text-zinc-300">
              <span className="text-zinc-600">{'{'}</span>
              <br />
              <span className="text-zinc-600">  "superMemory": {'{'}</span>
              <br />
              <span className="text-zinc-600">    </span>
              <span className="text-zinc-500">"enabled"</span>
              <span className="text-zinc-600">: </span>
              <span className="text-emerald-400">true</span>
              <span className="text-zinc-600">,</span>
              <span className="text-zinc-700">{' // toggle the entire subsystem'}</span>
              <br />
              <span className="text-zinc-600">    </span>
              <span className="text-zinc-500">"storage"</span>
              <span className="text-zinc-600">: {'{'}</span>
              <br />
              <span className="text-zinc-600">      </span>
              <span className="text-zinc-500">"projectLocal"</span>
              <span className="text-zinc-600">: </span>
              <span className="text-emerald-400">true</span>
              <span className="text-zinc-600">,</span>
              <span className="text-zinc-700">{' // store inside .wrongstack/memories'}</span>
              <br />
              <span className="text-zinc-600">      </span>
              <span className="text-zinc-500">"directory"</span>
              <span className="text-zinc-600">: </span>
              <span className="text-amber-300">".wrongstack/memories"</span>
              <br />
              <span className="text-zinc-600">    {'}'},</span>
              <br />
              <span className="text-zinc-600">    </span>
              <span className="text-zinc-500">"inject"</span>
              <span className="text-zinc-600">: {'{'}</span>
              <br />
              <span className="text-zinc-600">      </span>
              <span className="text-zinc-500">"turnContext"</span>
              <span className="text-zinc-600">: </span>
              <span className="text-emerald-400">true</span>
              <span className="text-zinc-600">,</span>
              <span className="text-zinc-700">{' // inject top 8 into every turn'}</span>
              <br />
              <span className="text-zinc-600">      </span>
              <span className="text-zinc-500">"toolResults"</span>
              <span className="text-zinc-600">: </span>
              <span className="text-emerald-400">true</span>
              <span className="text-zinc-600">,</span>
              <span className="text-zinc-700">{' // append hints to read/grep/tree output'}</span>
              <br />
              <span className="text-zinc-600">      </span>
              <span className="text-zinc-500">"maxHintsPerTool"</span>
              <span className="text-zinc-600">: </span>
              <span className="text-amber-300">4</span>
              <br />
              <span className="text-zinc-600">    {'}'}</span>
              <br />
              <span className="text-zinc-600">  {'}'}</span>
              <br />
              <span className="text-zinc-600">{'}'}</span>
            </div>
          </div>
          <div className="mt-6 flex items-start gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-5">
            <Check className="mt-0.5 size-4 shrink-0 text-emerald-500" />
            <p className="text-sm leading-6 text-zinc-400">
              <strong className="text-white">Sandbox survival:</strong> when the global root is a
              temporary directory (opencode, CI sandboxes), memory files are mirrored to the project
              tree automatically. Memory never disappears between sessions.
            </p>
          </div>
        </div>
      </section>

      <PageNext
        label="Memory & sessions"
        title="Understand the other continuity stores"
        body="Session logs reconstruct what happened. Checkpoints capture reversible file state. Compaction keeps the model window healthy."
        href="/memory"
      />
    </>
  );
}

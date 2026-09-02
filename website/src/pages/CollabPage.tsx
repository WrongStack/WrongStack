import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  Bug,
  Check,
  Clock,
  FileSearch,
  FileWarning,
  Lightbulb,
  MessageSquare,
  ScanSearch,
  ShieldAlert,
  Timer,
  Zap,
} from 'lucide-react';
import { ExternalDoc, PageHero, PageNext, SectionIntro } from '@/components/site/primitives';

export function CollabPage() {
  return (
    <>
      <PageHero
        index="26"
        eyebrow="Collab debugging"
        title={
          <>
            Three agents,
            <br />
            <span className="text-brand">one verdict.</span>
          </>
        }
        description="BugHunter finds bugs, RefactorPlanner proposes improvements, and Critic evaluates both — all running in parallel on the same file snapshot. Findings flow through the FleetBus as structured events, and the Director assembles a final report with an overall verdict."
        aside={<ExternalDoc path="docs/collab-debug.md">Open Collab docs</ExternalDoc>}
      />

      {/* ── The trio pipeline ──────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="01"
          eyebrow="Pipeline"
          title="BugHunter → RefactorPlanner → Critic"
          description="Three specialist agents run simultaneously on a shared file snapshot. Their findings flow through the FleetBus — each agent publishes events the others consume in real time."
        />
        <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-3">
          {[
            {
              step: '01',
              icon: Bug,
              title: 'BugHunter',
              body: 'Scans the file snapshot for bugs, anti-patterns, code smells, and security issues. Emits `bug.found` events immediately — one per finding, as soon as discovered. Writes a full markdown report to the shared scratchpad.',
              events: ['bug.found'],
              budget: '2000 iter / 5000 tools / 10 min',
            },
            {
              step: '02',
              icon: Lightbulb,
              title: 'RefactorPlanner',
              body: 'Subscribes to `bug.found` events and reads the BugHunter scratchpad report. For each addressable bug, proposes a concrete refactoring plan with phases, risk scores, and rollback strategies.',
              events: ['refactor.plan'],
              budget: '1500 iter / 4000 tools / 8 min',
            },
            {
              step: '03',
              icon: MessageSquare,
              title: 'Critic',
              body: 'Subscribes to both `bug.found` and `refactor.plan` events. Evaluates every finding and plan: scores 0–10, identifies strengths/weaknesses, raises blocking or advisory concerns, and delivers the final verdict.',
              events: ['critic.evaluation'],
              budget: '1000 iter / 3000 tools / 6 min',
            },
          ].map(({ step, icon: Icon, title, body, events, budget }) => (
            <article key={step} className="bg-card p-7">
              <div className="flex items-center gap-3">
                <span className="font-mono text-xs font-black text-brand-2">{step}</span>
                <Icon className="size-5 text-brand" />
              </div>
              <h2 className="mt-6 text-xl font-black text-fg">{title}</h2>
              <p className="mt-3 text-sm leading-7 text-muted">{body}</p>
              <div className="mt-5 space-y-2 border-t border-line pt-5">
                {events.map((e) => (
                  <code key={e} className="block font-mono text-xs text-brand">
                    {e}
                  </code>
                ))}
                <span className="block font-mono text-[10px] uppercase tracking-[0.08em] text-faint">
                  {budget}
                </span>
              </div>
            </article>
          ))}
        </div>
        <div className="mt-8 flex items-center justify-center gap-3 font-mono text-xs text-faint">
          <Bug className="size-3.5" />
          <ArrowRight className="size-3.5" />
          <Lightbulb className="size-3.5" />
          <ArrowDown className="size-3.5" />
          <MessageSquare className="size-3.5" />
          <span className="ml-2">
            All three start simultaneously • BugHunter emits first • RefactorPlanner and Critic
            consume in real time
          </span>
        </div>
      </section>

      {/* ── FleetBus events ─────────────────────────────────────────────── */}
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="02"
            eyebrow="FleetBus events"
            title="Structured events drive the pipeline."
            description="Each agent emits typed, schema-validated events on the FleetBus. The Director routes them to dependent agents. Every event carries a structured payload with exact fields."
          />
          <div className="mt-12 grid gap-6 lg:grid-cols-3">
            {[
              {
                icon: Bug,
                event: 'bug.found',
                fields: [
                  { name: 'finding.id', type: 'string', desc: 'UUID for this finding' },
                  {
                    name: 'finding.type',
                    type: 'string',
                    desc: 'Bug pattern name (e.g. race-condition)',
                  },
                  {
                    name: 'finding.severity',
                    type: 'enum',
                    desc: 'critical | high | medium | low',
                  },
                  {
                    name: 'finding.location',
                    type: 'object',
                    desc: '{ file: string, line: number }',
                  },
                  {
                    name: 'finding.description',
                    type: 'string',
                    desc: 'Human-readable explanation',
                  },
                  {
                    name: 'finding.suggestedFix',
                    type: 'string?',
                    desc: 'Optional fix suggestion',
                  },
                ],
              },
              {
                icon: Lightbulb,
                event: 'refactor.plan',
                fields: [
                  { name: 'plan.id', type: 'string', desc: 'UUID for this plan' },
                  {
                    name: 'plan.basedOnBugIds',
                    type: 'string[]',
                    desc: 'Bug IDs this plan addresses',
                  },
                  {
                    name: 'plan.phases',
                    type: 'object[]',
                    desc: '{ number, title, tasks[], risk }',
                  },
                  { name: 'plan.riskScore', type: 'enum', desc: 'low | medium | high' },
                  {
                    name: 'plan.estimatedChangeCount',
                    type: 'number',
                    desc: 'Approximate files/lines affected',
                  },
                  {
                    name: 'plan.rollbackStrategy',
                    type: 'string',
                    desc: 'How to reverse if needed',
                  },
                ],
              },
              {
                icon: MessageSquare,
                event: 'critic.evaluation',
                fields: [
                  { name: 'evaluation.id', type: 'string', desc: 'UUID for this evaluation' },
                  {
                    name: 'evaluation.subjectType',
                    type: 'enum',
                    desc: 'bug_finding | refactor_plan',
                  },
                  { name: 'evaluation.score', type: 'number', desc: '0–10 quality score' },
                  {
                    name: 'evaluation.verdict',
                    type: 'enum',
                    desc: 'approve | needs_revision | reject',
                  },
                  {
                    name: 'evaluation.strengths',
                    type: 'string[]',
                    desc: 'What the finding/plan did well',
                  },
                  {
                    name: 'evaluation.weaknesses',
                    type: 'string[]',
                    desc: 'What could be improved',
                  },
                  {
                    name: 'evaluation.concerns',
                    type: 'object[]',
                    desc: '{ description, severity: blocking|advisory }',
                  },
                ],
              },
            ].map(({ icon: Icon, event, fields }) => (
              <article key={event} className="rounded-2xl border border-line bg-card p-7">
                <div className="flex items-center gap-2">
                  <Icon className="size-4 text-brand" />
                  <code className="font-mono text-sm font-black text-brand">{event}</code>
                </div>
                <div className="mt-5 space-y-2">
                  {fields.map(({ name, type, desc }) => (
                    <div key={name} className="rounded-lg border border-line bg-bg px-3 py-2">
                      <div className="flex items-center gap-2">
                        <code className="font-mono text-xs text-fg">{name}</code>
                        <span className="font-mono text-[10px] text-faint">{type}</span>
                      </div>
                      <p className="mt-0.5 text-[11px] leading-4 text-muted">{desc}</p>
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── SharedFileSnapshot ──────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="03"
          eyebrow="File snapshot"
          title="All three agents see the same baseline."
          description="Before the session starts, the Director captures an immutable snapshot of every target file. Agents read from this snapshot — never from disk — so findings stay consistent even if files change during the run."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-line bg-card p-7">
            <FileSearch className="size-5 text-brand" />
            <h2 className="mt-8 text-xl font-black text-fg">Snapshot contents</h2>
            <div className="mt-5 space-y-3">
              {[
                {
                  label: 'File content',
                  body: 'Full UTF-8 text of every target file, captured at session start.',
                },
                {
                  label: 'Language detection',
                  body: 'Extension-based: .ts/.tsx→typescript, .js/.jsx→javascript, .md→markdown, .json→json.',
                },
                {
                  label: 'Metadata',
                  body: 'mtime and file size recorded at snapshot time. Used after the session to detect mid-run changes.',
                },
                {
                  label: 'Freshness check',
                  body: 'After all agents finish, the snapshot is compared against current disk state. Changed files are listed as warnings in the report.',
                },
              ].map(({ label, body }) => (
                <div key={label} className="rounded-lg border border-line bg-bg p-4">
                  <h3 className="font-black text-sm text-fg">{label}</h3>
                  <p className="mt-1 text-xs leading-5 text-muted">{body}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border border-line bg-card p-7">
            <FileWarning className="size-5 text-brand" />
            <h2 className="mt-8 text-xl font-black text-fg">File limits</h2>
            <p className="mt-3 text-sm leading-7 text-muted">
              Each agent receives the full file snapshot as context. Three agents × N files creates
              high token cost. The limit prevents overflow.
            </p>
            <div className="mt-5 space-y-3">
              {[
                {
                  label: 'Default limit',
                  body: '30 files (DEFAULT_MAX_TARGET_FILES). Safe for most package-level scans.',
                },
                {
                  label: 'Dynamic limit',
                  body: 'Pass contextWindow to calculate: floor((contextWindow × 0.4) ÷ 2000). Reserves 40% of context for the snapshot.',
                },
                {
                  label: 'Hard override',
                  body: 'Pass maxTargetFiles to set an exact limit, ignoring contextWindow.',
                },
                {
                  label: 'Exceeding the limit',
                  body: 'Throws a descriptive error. Narrow the target — run package-by-package for large codebases.',
                },
              ].map(({ label, body }) => (
                <div key={label} className="rounded-lg border border-line bg-bg p-4">
                  <h3 className="font-black text-sm text-fg">{label}</h3>
                  <p className="mt-1 text-xs leading-5 text-muted">{body}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── Budget & alerts ─────────────────────────────────────────────── */}
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="04"
            eyebrow="Budget & alerts"
            title="Smart budget management keeps the session alive."
            description="Collab agents hit soft budget limits, not hard ones. The Director decides whether to extend, cancel, or ignore based on progress and policy."
          />
          <div className="mt-12 grid gap-6 lg:grid-cols-3">
            {[
              {
                icon: AlertTriangle,
                title: 'DirectorAlertLevel',
                body: 'Three severity tiers for budget events. The Director receives them and can cancel the session, extend limits, or let the default auto-extend logic handle it.',
                items: [
                  {
                    label: 'WARNING',
                    body: 'Agent hit a soft limit but is still making progress. Default: auto-extend by 25%.',
                  },
                  {
                    label: 'CRITICAL',
                    body: 'Hard limit reached. Session cannot continue without Director intervention.',
                  },
                  {
                    label: 'CANCELLED',
                    body: 'Director explicitly cancelled. All agents finish early with cancelled status.',
                  },
                ],
              },
              {
                icon: Timer,
                title: 'Progress-based timeout',
                body: 'Wall-clock and idle timeouts are not denied blindly. If the agent has made tool calls since its last extension, the timeout is doubled. Only genuinely stuck agents are stopped.',
                items: [
                  {
                    label: 'Timeout track',
                    body: 'Tool call counts per subagent are tracked. Progress = any new tool call since last grant.',
                  },
                  {
                    label: 'Extend policy',
                    body: 'Progress detected → double the timeout (capped at 24h). No progress → deny.',
                  },
                  {
                    label: 'Auto-extend',
                    body: 'Soft budget kinds (iterations, tool_calls, tokens, cost) auto-extend by 25% on ignore.',
                  },
                ],
              },
              {
                icon: ShieldAlert,
                title: 'Budget override API',
                body: 'Callers can pass per-role budget overrides via CollabBudgetOverrides. The Director can also supply an onBudgetWarning callback for custom cancel/extend/ignore logic.',
                items: [
                  { label: 'bug-hunter', body: '2000 iter, 5000 tools, 10 min timeout (default)' },
                  {
                    label: 'refactor-planner',
                    body: '1500 iter, 4000 tools, 8 min timeout (default)',
                  },
                  { label: 'critic', body: '1000 iter, 3000 tools, 6 min timeout (default)' },
                  {
                    label: 'onBudgetWarning',
                    body: 'Return cancel | extend | ignore per alert. Custom policy for fleet-wide rules.',
                  },
                ],
              },
            ].map(({ icon: Icon, title, body, items }) => (
              <article key={title} className="rounded-2xl border border-line bg-card p-7">
                <Icon className="size-5 text-brand" />
                <h2 className="mt-8 text-xl font-black text-fg">{title}</h2>
                <p className="mt-3 text-sm leading-7 text-muted">{body}</p>
                <div className="mt-5 space-y-2">
                  {items.map(({ label, body: itemBody }) => (
                    <div key={label} className="rounded-lg border border-line bg-bg p-3">
                      <span className="font-black text-xs text-fg">{label}</span>
                      <p className="mt-0.5 text-[11px] leading-4 text-muted">{itemBody}</p>
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── CollabDebugReport ───────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="05"
          eyebrow="Final report"
          title="One structured report, complete audit trail."
          description="When all three agents finish (or the session is cancelled), the Director assembles a CollabDebugReport. Every finding, plan, evaluation, alert, and snapshot warning is included."
        />
        <div className="mt-12 overflow-hidden rounded-2xl border border-line bg-ink">
          <div className="border-b border-white/10 px-6 py-4">
            <span className="font-mono text-xs font-black uppercase tracking-[0.16em] text-zinc-500">
              CollabDebugReport structure
            </span>
          </div>
          <div className="p-6 font-mono text-sm leading-7 text-zinc-300">
            <div className="space-y-3">
              <div>
                <span className="text-zinc-500">sessionId</span>
                <span className="text-zinc-600">: </span>
                <span className="text-amber-300">uuid</span>
              </div>
              <div>
                <span className="text-zinc-500">disposition</span>
                <span className="text-zinc-600">: </span>
                <span className="text-emerald-400">completed</span>
                <span className="text-zinc-600"> | </span>
                <span className="text-amber-400">cancelled</span>
                <span className="text-zinc-600"> | </span>
                <span className="text-red-400">timeout</span>
                <span className="text-zinc-600"> | </span>
                <span className="text-red-400">critical_alert</span>
              </div>
              <div>
                <span className="text-zinc-500">overallVerdict</span>
                <span className="text-zinc-600">: </span>
                <span className="text-emerald-400">approve</span>
                <span className="text-zinc-600"> | </span>
                <span className="text-amber-400">needs_revision</span>
                <span className="text-zinc-600"> | </span>
                <span className="text-red-400">reject</span>
                <span className="text-zinc-600 ml-2">← worst evaluation determines overall</span>
              </div>
              <div className="mt-4 border-t border-white/10 pt-4">
                <span className="text-zinc-500">bugs</span>
                <span className="text-zinc-600">: </span>
                <span className="text-zinc-400">
                  BugFinding[] — id, type, severity, location, description, suggestedFix
                </span>
              </div>
              <div>
                <span className="text-zinc-500">refactorPlans</span>
                <span className="text-zinc-600">: </span>
                <span className="text-zinc-400">
                  RefactorPlan[] — id, basedOnBugIds, phases[], riskScore, rollbackStrategy
                </span>
              </div>
              <div>
                <span className="text-zinc-500">evaluations</span>
                <span className="text-zinc-600">: </span>
                <span className="text-zinc-400">
                  CriticEvaluation[] — id, subjectType, score, verdict, strengths, weaknesses,
                  concerns
                </span>
              </div>
              <div>
                <span className="text-zinc-500">alerts</span>
                <span className="text-zinc-600">: </span>
                <span className="text-zinc-400">
                  DirectorAlert[] — budget warnings raised during the session
                </span>
              </div>
              <div>
                <span className="text-zinc-500">snapshotWarnings</span>
                <span className="text-zinc-600">: </span>
                <span className="text-zinc-400">
                  string[] — files that changed after the snapshot was captured
                </span>
              </div>
              <div>
                <span className="text-zinc-500">summary</span>
                <span className="text-zinc-600">: </span>
                <span className="text-zinc-400">
                  Markdown-formatted summary for the Director's context window
                </span>
              </div>
            </div>
          </div>
        </div>
        <div className="mt-8 grid gap-5 sm:grid-cols-3">
          {[
            {
              title: 'Overall verdict',
              body: 'Computed as the worst evaluation across all subjects. One reject in any evaluation makes the whole report reject.',
            },
            {
              title: 'Mid-run changes',
              body: 'snapshotWarnings lists files modified during the session. Useful for catching concurrent edits that invalidate findings.',
            },
            {
              title: 'Cancellation audit',
              body: 'Cancelled sessions still produce a full report with disposition=cancelled. All partial findings are included.',
            },
          ].map(({ title, body }) => (
            <div key={title} className="rounded-xl border border-line bg-card p-5">
              <h3 className="font-black text-sm text-fg">{title}</h3>
              <p className="mt-2 text-xs leading-6 text-muted">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Usage guide ─────────────────────────────────────────────────── */}
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="06"
            eyebrow="Usage guide"
            title="Package by package. Never the whole repo."
            description="Collab sends the full file snapshot to three agents. Each agent reads every file. Target one module at a time — 10–20 files is ideal, 20–30 is the limit, 50+ will fail."
          />
          <div className="mt-12 grid gap-6 lg:grid-cols-2">
            <div className="rounded-2xl border border-line bg-card p-7">
              <Check className="size-5 text-emerald-400" />
              <h2 className="mt-8 text-xl font-black text-fg">Good targets</h2>
              <div className="mt-5 space-y-2">
                {[
                  {
                    cmd: '/collab packages/core/src/agents/',
                    desc: 'Single package directory — 10–15 files. Reliable in under 3 minutes.',
                  },
                  {
                    cmd: '/collab packages/runtime/src/sessions/',
                    desc: 'Subdirectory within a package — 5–8 files. Fast, focused results.',
                  },
                  {
                    cmd: '/collab src/auth/ src/middleware/',
                    desc: 'Multiple small targets — each 5–10 files. Handled in one snapshot.',
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
              <AlertTriangle className="size-5 text-amber-400" />
              <h2 className="mt-8 text-xl font-black text-fg">Avoid</h2>
              <div className="mt-5 space-y-2">
                {[
                  {
                    cmd: '/collab packages/**/src/**/*.ts',
                    desc: 'Entire monorepo — hundreds of files. Will throw a limit error immediately.',
                  },
                  {
                    cmd: '/collab packages/core/src/',
                    desc: 'Top-level package with deep nesting — often 150+ files. Split into subdirectories.',
                  },
                  {
                    cmd: '--timeout 1800000',
                    desc: 'Large timeout for big targets. Shrinking the target is always preferable to extending timeout.',
                  },
                ].map(({ cmd, desc }) => (
                  <div key={cmd} className="rounded-lg border border-line bg-bg p-4">
                    <code className="font-mono text-sm font-black text-faint">{cmd}</code>
                    <p className="mt-1.5 text-xs leading-5 text-muted">{desc}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Commands & integration ──────────────────────────────────────── */}
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="07"
          eyebrow="Commands & integration"
          title="Run from the slash command or the quality gate."
          description="Collab debugging integrates with `/collab` for direct invocation and with quality_gate for automated CI-style review pipelines."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-line bg-card p-7">
            <Zap className="size-5 text-brand" />
            <h2 className="mt-8 text-xl font-black text-fg">Slash commands</h2>
            <div className="mt-5 space-y-3">
              {[
                {
                  cmd: '/collab src/auth/',
                  desc: 'Run the trio on a specific directory. Default 10 min timeout, 30 file limit.',
                },
                {
                  cmd: '/collab --timeout 600000 src/auth/',
                  desc: 'Custom session timeout in ms. Agents still have their own per-role budgets.',
                },
                {
                  cmd: '/collab --max-files 50 src/',
                  desc: 'Override the file limit. Use cautiously — large snapshots cause token pressure.',
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
            <ScanSearch className="size-5 text-brand" />
            <h2 className="mt-8 text-xl font-black text-fg">Quality gate integration</h2>
            <div className="mt-5 space-y-3">
              {[
                {
                  label: 'Automated review',
                  body: 'quality_gate can spawn a collab session as part of its reviewer lane. The collab report feeds into the gate verdict.',
                },
                {
                  label: 'Repair loop',
                  body: 'When the gate fails, the implementer receives the collab report as feedback. Fix → re-run collab → re-evaluate.',
                },
                {
                  label: 'Standalone alternatives',
                  body: 'For quick scans without the full pipeline, run a standalone bug-hunter subagent. For lint/typecheck only, use the lint and typecheck tools directly.',
                },
              ].map(({ label, body }) => (
                <div key={label} className="rounded-lg border border-line bg-bg p-4">
                  <h3 className="font-black text-sm text-fg">{label}</h3>
                  <p className="mt-1 text-xs leading-5 text-muted">{body}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-8 rounded-2xl border border-line bg-card p-7">
          <Clock className="size-5 text-brand" />
          <h2 className="mt-8 text-xl font-black text-fg">When to use vs. alternatives</h2>
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                scenario: 'New feature final review',
                use: 'Yes — full trio',
                icon: Check,
                color: 'text-emerald-400',
              },
              {
                scenario: 'Planned refactor of one module',
                use: 'Yes — targeted collab',
                icon: Check,
                color: 'text-emerald-400',
              },
              {
                scenario: 'Security vulnerability scan',
                use: 'Yes — BugHunter finds these',
                icon: Check,
                color: 'text-emerald-400',
              },
              {
                scenario: 'Entire repository scan',
                use: 'No — package by package',
                icon: AlertTriangle,
                color: 'text-amber-400',
              },
              {
                scenario: 'CI/CD automated check',
                use: 'No — single agent scan',
                icon: AlertTriangle,
                color: 'text-amber-400',
              },
              {
                scenario: 'Quick lint or typecheck',
                use: 'No — use lint/typecheck',
                icon: AlertTriangle,
                color: 'text-amber-400',
              },
              {
                scenario: '1000+ line file review',
                use: 'Caution — review alone',
                icon: AlertTriangle,
                color: 'text-amber-400',
              },
              {
                scenario: 'Broad architecture audit',
                use: 'No — standalone scan',
                icon: AlertTriangle,
                color: 'text-amber-400',
              },
            ].map(({ scenario, use, icon: Icon, color }) => (
              <div key={scenario} className="rounded-lg border border-line bg-bg p-4">
                <Icon className={`size-3.5 ${color}`} />
                <p className="mt-2 text-xs leading-5 text-fg font-black">{scenario}</p>
                <p className="mt-1 text-[11px] leading-4 text-muted">{use}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <PageNext
        label="GitHub Sync"
        title="Keep machines in sync"
        body="Sync settings, skills, prompts, and memory across machines through GitHub."
        href="/sync"
      />
    </>
  );
}

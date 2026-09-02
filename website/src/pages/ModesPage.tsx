import { ArrowDown, Check, CircleGauge, Layers3, Sparkles, Wrench } from 'lucide-react';
import { useState } from 'react';
import {
  ExternalDoc,
  PageHero,
  PageNext,
  SectionIntro,
  heroTitleFontSize,
} from '@/components/site/primitives';
import { type ModeFamily, modeCatalog } from '@/data/product-catalog';
import { Link } from '@/lib/router';
import { cn } from '@/lib/utils';

const familyLabels: Record<ModeFamily | 'all', string> = {
  all: 'All 19',
  balanced: 'Balanced',
  lite: 'Lite · 8',
  deep: 'Deep · 10',
};

const pairs = [
  ['review-lite', 'code-reviewer', 'Changed-file sanity check → comprehensive review'],
  ['audit-lite', 'code-auditor', 'Narrow security triage → category-complete audit'],
  ['plan-lite', 'architect', 'Immediate execution steps → cross-module design'],
  ['debug-lite', 'debugger', 'One hypothesis → traced root-cause investigation'],
  ['test-lite', 'tester', 'One regression → full QA and coverage analysis'],
  ['refactor-lite', 'refactorer', 'Small cleanup → disciplined modernization'],
  ['research-lite', 'research-web', 'One authoritative check → cross-checked research'],
] as const;

export function ModesPage() {
  const [family, setFamily] = useState<ModeFamily | 'all'>('all');
  const visibleModes =
    family === 'all' ? modeCatalog : modeCatalog.filter((mode) => mode.family === family);

  return (
    <>
      <PageHero
        index="17"
        eyebrow="Session modes"
        titleFontSize={heroTitleFontSize('Nineteen working styles.')}
        title={
          <>
            One agent.
            <br />
            <span className="text-brand">Nineteen working styles.</span>
          </>
        }
        description="/mode changes the behavioral layer placed on top of WrongStack's base system prompt. Choose a narrow token-saving pass, a deep specialist checklist or the balanced default without changing the provider, model or project state."
        aside={
          <ExternalDoc path="docs/slash/mode.md">Open the canonical /mode reference</ExternalDoc>
        }
      />

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="01"
          eyebrow="Runtime contract"
          title="A mode is more than a tone preset."
          description="The active entry carries prompt instructions, discovery tags, preferred tools and suggested skills. Each part changes a different layer of the next request."
        />
        <div className="mt-14 space-y-2">
          {[
            [
              'Select',
              'The slash command resolves an exact mode id from DefaultModeStore.',
              '/mode debugger',
            ],
            [
              'Persist',
              'The active id is atomically stored under the WrongStack config directory.',
              'mode.json → activeMode',
            ],
            [
              'Inject',
              'The mode prompt is added to the system-prompt build for subsequent requests.',
              'base prompt + mode prompt',
            ],
            [
              'Prioritize',
              'Tool preferences highlight the most relevant capabilities without removing the rest.',
              'read · grep · test · logs',
            ],
            [
              'Suggest',
              'Relevant loaded skills are named so domain guidance can be used before generic reasoning.',
              'mode → suggestedSkills',
            ],
          ].map(([title, body, code], index) => (
            <div key={title}>
              <article className="grid gap-5 rounded-2xl border border-line bg-card p-6 sm:grid-cols-[52px_180px_1fr_220px] sm:items-center">
                <span className="grid size-11 place-items-center rounded-full border border-line bg-bg font-mono text-xs font-black text-brand-2">
                  0{index + 1}
                </span>
                <h2 className="font-black text-fg">{title}</h2>
                <p className="text-sm leading-7 text-muted">{body}</p>
                <code className="font-mono text-xs text-brand">{code}</code>
              </article>
              {index < 4 && <ArrowDown className="mx-auto my-1 size-4 text-faint" />}
            </div>
          ))}
        </div>
      </section>

      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="02"
            eyebrow="Mode atlas"
            title="Pick the amount of depth the task deserves."
            description="Lite modes deliberately constrain scope and output. Deep modes add wider evidence gathering and specialist checklists. Default removes both biases."
          />
          <div className="mt-10 flex flex-wrap gap-2">
            {(Object.keys(familyLabels) as Array<ModeFamily | 'all'>).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setFamily(id)}
                className={cn(
                  'rounded-full border px-4 py-2 font-mono text-xs font-black uppercase tracking-[0.12em] transition-colors',
                  family === id
                    ? 'border-brand-2 bg-brand-2 text-ink'
                    : 'border-line bg-card text-muted hover:text-fg',
                )}
              >
                {familyLabels[id]}
              </button>
            ))}
          </div>
          <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {visibleModes.map((mode, index) => (
              <Link
                key={mode.id}
                href={`/modes/${mode.id}`}
                className="group block rounded-2xl border border-line bg-card p-6 transition-all hover:-translate-y-0.5 hover:border-line-strong hover:shadow-lg"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <span className="font-mono text-xs font-black uppercase tracking-[0.16em] text-faint">
                      {mode.family}
                    </span>
                    <h2 className="mt-2 text-xl font-black text-fg">{mode.name}</h2>
                  </div>
                  <span className="font-mono text-xs font-black text-brand-2">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                </div>
                <code className="mt-5 block rounded-lg bg-bg px-3 py-2 font-mono text-xs text-brand">
                  /mode {mode.id}
                </code>
                <p className="mt-4 min-h-14 text-sm leading-7 text-muted">{mode.description}</p>
                <div className="mt-5 border-t border-line pt-5">
                  <div className="flex items-start gap-3">
                    <Wrench className="mt-0.5 size-3.5 shrink-0 text-faint" />
                    <p className="font-mono text-xs leading-5 text-muted">
                      {mode.toolPreferences.length > 0
                        ? mode.toolPreferences.join(' · ')
                        : 'No tool preference; use the balanced registry'}
                    </p>
                  </div>
                  <div className="mt-3 flex items-start gap-3">
                    <Sparkles className="mt-0.5 size-3.5 shrink-0 text-faint" />
                    <p className="font-mono text-xs leading-5 text-muted">
                      {mode.suggestedSkills.length > 0
                        ? mode.suggestedSkills.join(' · ')
                        : 'No additional skill bias'}
                    </p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="03"
          eyebrow="Lite → deep"
          title="Start narrow, escalate when the evidence demands it."
          description="The paired modes let you pay for broad context only after a quick pass shows that the task needs it."
        />
        <div className="mt-12 overflow-hidden rounded-2xl border border-line bg-card">
          {pairs.map(([lite, deep, reason], index) => (
            <div
              key={lite}
              className="grid gap-3 border-b border-line p-5 last:border-b-0 sm:grid-cols-[44px_150px_36px_170px_1fr] sm:items-center"
            >
              <span className="font-mono text-xs font-black text-brand-2">0{index + 1}</span>
              <code className="font-mono text-xs font-bold text-fg">{lite}</code>
              <ArrowDown className="size-4 -rotate-90 text-faint" />
              <code className="font-mono text-xs font-bold text-brand">{deep}</code>
              <p className="text-sm leading-6 text-muted">{reason}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-y border-line bg-ink text-white">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="04"
            eyebrow="Names matter"
            title="Four different controls are called “mode.”"
            description="They are independent. Changing one does not silently change the others."
          />
          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 md:grid-cols-2 xl:grid-cols-4">
            {[
              [
                CircleGauge,
                '/mode',
                'Persona',
                'Prompt, tool preference and suggested-skill behavior.',
              ],
              [
                Layers3,
                '/context mode',
                'Context policy',
                'Balanced, frugal, deep or archival window management.',
              ],
              [
                Sparkles,
                '/autonomy',
                'Continuation',
                'Off, suggest, auto, eternal or parallel execution behavior.',
              ],
              [
                Wrench,
                'TUI / REPL',
                'Interface',
                'Which terminal surface owns rendering and interaction.',
              ],
            ].map(([Icon, command, title, body]) => {
              const ItemIcon = Icon as typeof CircleGauge;
              return (
                <article key={String(command)} className="bg-[#0c0d12] p-6">
                  <ItemIcon className="size-5 text-brand" />
                  <code className="mt-7 block font-mono text-xs text-brand">{String(command)}</code>
                  <h2 className="mt-3 font-black">{String(title)}</h2>
                  <p className="mt-3 text-sm leading-6 text-zinc-500">{String(body)}</p>
                </article>
              );
            })}
          </div>
          <div className="mt-8 flex flex-wrap gap-5">
            <Link href="/commands/mode" className="text-sm font-black text-brand">
              Read /mode command guide →
            </Link>
            <Link href="/commands/context" className="text-sm font-black text-brand">
              Compare context modes →
            </Link>
            <Link href="/commands/autonomy" className="text-sm font-black text-brand">
              Compare autonomy modes →
            </Link>
          </div>
          <div className="mt-6 flex items-start gap-3 text-sm leading-6 text-emerald-400">
            <Check className="mt-1 size-4 shrink-0" /> Switching persona mode does not replace the
            selected model, clear context or grant new permissions.
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="04"
          eyebrow="Mode stacking"
          title="Combine modes for layered behavior."
          description="Modes are not exclusive — they stack. A base mode provides the agent persona; additional modes layer on capabilities and constraints."
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-3">
          {[
            {
              stack: 'teach + typescript-strict',
              desc: 'Pedagogical explanations with zero-implicit-any enforcement. Perfect for learning TS with strict guardrails.',
            },
            {
              stack: 'brief + bug-hunter',
              desc: 'Concise output while scanning for bugs. No walls of text — just findings and suggested fixes.',
            },
            {
              stack: 'code-reviewer + security-scanner',
              desc: 'Review code AND scan for vulnerabilities in one pass. Combined report with both perspectives.',
            },
            {
              stack: 'sdd + refactor-planner',
              desc: 'Spec-driven workflow with automatic refactor planning between phases.',
            },
            {
              stack: 'react-modern + node-modern',
              desc: 'Full-stack mode: React 19+ patterns on the frontend, Node 22+ on the backend.',
            },
            {
              stack: 'testing + chimera',
              desc: 'Write tests AND run post-session quality review. Catch test gaps before commit.',
            },
          ].map(({ stack, desc }) => (
            <div key={stack} className="rounded-xl border border-line bg-card p-4">
              <code className="font-mono text-xs font-black text-brand">{stack}</code>
              <p className="mt-1.5 text-[11px] leading-4 text-muted">{desc}</p>
            </div>
          ))}
        </div>
      </section>
      <PageNext
        label="Agent roster"
        title="Match the working style with a specialist role"
        body="Explore every built-in fleet role, its phase, tool scope and routing intent."
        href="/agent-roster"
      />
    </>
  );
}

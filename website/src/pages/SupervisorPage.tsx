import { Ban, BrainCircuit, ShieldAlert, ShieldCheck } from 'lucide-react';
import { ExternalDoc, PageHero, PageNext, SectionIntro } from '@/components/site/primitives';

export function SupervisorPage() {
  return (
    <>
      <PageHero
        index="21"
        eyebrow="Fleet Supervisor"
        title={
          <>
            The Brain's <span className="text-brand">safety gate.</span>
          </>
        }
        description="The Fleet Supervisor sits between the Director and every agent action. It evaluates spawns, assignments, and tool escalations against Brain risk thresholds — approving safe operations and blocking risky ones."
        aside={<ExternalDoc path="docs/slash/supervisor.md">Open Supervisor docs</ExternalDoc>}
      />

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="01"
          eyebrow="How it works"
          title="Every fleet action passes through the gate."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {[
            {
              icon: ShieldCheck,
              title: 'Approve',
              body: 'Safe actions pass through automatically. Routine spawns, reads, and single-file writes skip Brain evaluation entirely.',
              color: 'text-emerald-400',
            },
            {
              icon: ShieldAlert,
              title: 'Block',
              body: 'Risky actions are blocked with a reason. Multi-file mutations, external network calls, and permission changes require Brain approval.',
              color: 'text-amber-400',
            },
            {
              icon: Ban,
              title: 'Escalate',
              body: 'Critical actions escalate to interactive human approval. File deletion, policy changes, and production deploys always ask — regardless of YOLO mode.',
              color: 'text-red-400',
            },
          ].map(({ icon: Icon, title, body, color }) => (
            <article key={title} className="rounded-2xl border border-line bg-card p-7">
              <Icon className={`size-5 ${color}`} />
              <h2 className="mt-8 text-xl font-black text-fg">{title}</h2>
              <p className="mt-3 text-sm leading-7 text-muted">{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="02"
            eyebrow="What it checks"
            title="Four categories of fleet actions."
            description="Deterministic rules handle common cases. The Brain model only engages for borderline decisions."
          />
          <div className="mt-12 grid gap-6 lg:grid-cols-4">
            {[
              {
                label: 'Agent spawns',
                body: 'Before a new subagent is created, the Supervisor verifies the spawn is within budget limits and risk thresholds.',
              },
              {
                label: 'Task assignments',
                body: "Every task dispatch is checked: is the role appropriate? Does the task match the agent's capabilities?",
              },
              {
                label: 'Tool escalations',
                body: 'When an agent requests a tool outside its default permission set, the Supervisor evaluates against Brain policy.',
              },
              {
                label: 'Budget exhaustion',
                body: 'Agents approaching token, cost, or iteration caps trigger a pre-emptive review before the hard limit.',
              },
            ].map(({ label, body }) => (
              <div key={label} className="rounded-xl border border-line bg-card p-5">
                <BrainCircuit className="size-4 text-brand" />
                <h3 className="mt-3 font-black text-sm text-fg">{label}</h3>
                <p className="mt-2 text-xs leading-5 text-muted">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="03"
          eyebrow="Risk levels"
          title="Four tiers — from automatic to mandatory human approval."
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              level: 'Low',
              color: 'text-emerald-400',
              body: 'Routine spawns and reads. Automatically approved. No Brain involvement.',
            },
            {
              level: 'Medium',
              color: 'text-amber-400',
              body: 'Multi-file writes, worktree creation. Fast deterministic check, approved if under ceiling.',
            },
            {
              level: 'High',
              color: 'text-orange-400',
              body: 'Batch mutations, external network calls. Requires Brain model evaluation. May escalate to human.',
            },
            {
              level: 'Critical',
              color: 'text-red-400',
              body: 'Deletion of tracked files, permission policy changes. Always escalates to interactive human approval.',
            },
          ].map(({ level, color, body }) => (
            <div key={level} className="rounded-xl border border-line bg-card p-5">
              <span className={`font-mono text-xs font-black ${color}`}>{level}</span>
              <p className="mt-2 text-xs leading-5 text-muted">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro index="04" eyebrow="Commands" title="Status, enable, disable." />
          <div className="mt-12 grid gap-4 sm:grid-cols-3">
            {[
              {
                cmd: '/supervisor status',
                desc: 'Show current state: enabled/disabled, recent decisions, blocked actions count.',
              },
              {
                cmd: '/supervisor on',
                desc: 'Enable the Supervisor. All fleet actions are gated by Brain risk policy.',
              },
              {
                cmd: '/supervisor off',
                desc: 'Disable the Supervisor. Not recommended for production — bypasses Brain safety.',
              },
            ].map(({ cmd, desc }) => (
              <div key={cmd} className="rounded-xl border border-line bg-card p-5">
                <code className="font-mono text-sm font-black text-brand">{cmd}</code>
                <p className="mt-2 text-xs leading-5 text-muted">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <PageNext
        label="Goal"
        title="Autonomous phased workflows"
        body="Let the agent plan, execute, and verify across worktrees — fully autonomous."
        href="/goal"
      />
    </>
  );
}

import { Activity, AlertTriangle, Archive, Bell, Eye, Shield, Zap } from 'lucide-react';
import { ExternalDoc, PageHero, PageNext, SectionIntro } from '@/components/site/primitives';

export function ShadowAgentPage() {
  return (
    <>
      <PageHero
        index="19"
        eyebrow="Shadow Agent"
        title={
          <>
            Watch every agent <span className="text-brand">without getting in the way.</span>
          </>
        }
        description="The Shadow Agent is a background fleet monitor with a deterministic cron heartbeat. It observes agent status, detects anomalies, tracks spike tasks, and can intervene on command — silently, without blocking the fleet."
        aside={<ExternalDoc path="docs/shadow-agent.md">Open Shadow Agent docs</ExternalDoc>}
      />

      {/* ── Responsibilities ────────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="01"
          eyebrow="Responsibilities"
          title="Four lanes of silent observation."
          description="Every heartbeat cycle (default 30s), the Shadow checks fleet health, mailbox traffic, spike patterns, and anomaly thresholds."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-2">
          {[
            {
              icon: Activity,
              title: 'Heartbeat monitoring',
              body: 'Calls `fleet status` and `fleet health` on every tick. Agents unresponsive for 5 minutes (configurable) are flagged as stuck. New agents are logged; missing agents marked unknown.',
            },
            {
              icon: Zap,
              title: 'Spike detection',
              body: 'Tracks subagent spawn→terminate durations. Tasks completing in under 5 seconds (configurable) are flagged as spikes — often indicating configuration errors or permission problems.',
            },
            {
              icon: Bell,
              title: 'Mailbox surveillance',
              body: 'Monitors all mailbox messages — direct, broadcast, and typed. Flags orphan tasks (assign without result within 5 min) and stale asks. Tracks cross-session communication patterns.',
            },
            {
              icon: AlertTriangle,
              title: 'Anomaly classification',
              body: 'Four anomaly types: stuck_agent, spike_task, mailbox_loop, budget_exhausted. Each gets severity (low/medium/high/critical) plus a description and detection timestamp.',
            },
          ].map(({ icon: Icon, title, body }) => (
            <div key={title} className="rounded-xl border border-line bg-card p-6">
              <Icon className="size-5 text-brand" />
              <h2 className="mt-4 text-lg font-black text-fg">{title}</h2>
              <p className="mt-2 text-sm leading-6 text-muted">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Intervention ────────────────────────────────────────────────── */}
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="02"
            eyebrow="Intervention"
            title="Hoop commands let you act on anomalies."
            description="The Shadow can intervene on command. You send a control message through the mailbox, and the Shadow terminates the target agent immediately."
          />
          <div className="mt-12 grid gap-6 lg:grid-cols-2">
            <div className="rounded-2xl border border-line bg-card p-7">
              <Shield className="size-5 text-brand" />
              <h2 className="mt-8 text-xl font-black text-fg">Intervention commands</h2>
              <div className="mt-5 space-y-3">
                {[
                  {
                    cmd: 'hoop <subagentId>',
                    desc: 'Immediately terminate a specific subagent. The Shadow calls terminate_subagent and logs the intervention.',
                  },
                  {
                    cmd: 'hoop all',
                    desc: 'Terminate all running subagents. Also cancels all pending cron jobs. Use with caution.',
                  },
                  {
                    cmd: 'shadow intervene <task>',
                    desc: 'Assign a custom intervention task. The Shadow analyzes the task and decides the action.',
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
              <Archive className="size-5 text-brand" />
              <h2 className="mt-8 text-xl font-black text-fg">Intervention log</h2>
              <p className="mt-3 text-sm leading-7 text-muted">
                Every intervention — whether triggered by command or auto-intervene policy — is
                logged with timestamp, target agent, command issued, and result. The log persists
                across Shadow restarts.
              </p>
              <div className="mt-5 rounded-lg border border-line bg-bg p-4 font-mono text-xs leading-6">
                <div className="text-zinc-400">
                  10:23:01 <span className="text-brand">hoop</span> → subagent-xyz{' '}
                  <span className="text-emerald-400">terminated</span>
                </div>
                <div className="text-zinc-400">
                  10:25:33 <span className="text-brand">hoop</span> → all{' '}
                  <span className="text-emerald-400">3 agents terminated</span>
                </div>
                <div className="text-zinc-400">
                  10:30:15 <span className="text-brand">auto-intervene</span> →
                  budget-exhausted-agent <span className="text-emerald-400">terminated</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Commands ─────────────────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro index="03" eyebrow="Commands" title="Start, inspect, stop, configure." />
        <div className="mt-12 grid gap-4 sm:grid-cols-3">
          {[
            {
              cmd: '/shadow start',
              desc: 'Launch the Shadow Agent. Begins heartbeat monitoring. State is loaded from previous runs if available.',
            },
            {
              cmd: '/shadow status',
              desc: 'Print a full fleet snapshot: tracked agents, recent anomalies, mailbox summary, spike history.',
            },
            {
              cmd: '/shadow stop',
              desc: 'Deactivate the Shadow. All cron jobs are cancelled. State is persisted for next start.',
            },
            {
              cmd: '/shadow mute',
              desc: 'Pause heartbeat monitoring without stopping the Shadow. Anomaly detection and mailbox surveillance continue.',
            },
            {
              cmd: '/shadow resume',
              desc: 'Resume heartbeat monitoring after a mute. Picks up where it left off.',
            },
            {
              cmd: '/shadow interval <ms>',
              desc: 'Change the heartbeat interval on the fly. Minimum 1000 ms. Affects the next tick.',
            },
          ].map(({ cmd, desc }) => (
            <div key={cmd} className="rounded-xl border border-line bg-card p-5">
              <code className="font-mono text-sm font-black text-brand">{cmd}</code>
              <p className="mt-2 text-xs leading-5 text-muted">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Configuration ────────────────────────────────────────────────── */}
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="04"
            eyebrow="Configuration"
            title="Tune the Shadow to your fleet size and risk tolerance."
            description="Six configuration keys control the Shadow's behavior. All can be changed at runtime — the next heartbeat picks up new values."
          />
          <div className="mt-12 grid gap-6 lg:grid-cols-3">
            {[
              {
                icon: Activity,
                label: 'Interval',
                cmd: 'shadow_interval_ms',
                body: 'Heartbeat check frequency. Default 30 000 ms (30s). Lower for faster detection, higher for less overhead on large fleets.',
              },
              {
                icon: AlertTriangle,
                label: 'Stuck threshold',
                cmd: 'shadow_stuck_threshold_ms',
                body: 'How long an agent can be silent before being flagged as stuck. Default 300 000 ms (5 min). Increase for long-running tasks.',
              },
              {
                icon: Zap,
                label: 'Spike threshold',
                cmd: 'shadow_spike_threshold_ms',
                body: 'Maximum task duration that counts as a spike. Tasks completing faster than this are flagged. Default 5 000 ms (5s).',
              },
              {
                icon: Shield,
                label: 'Auto-intervene',
                cmd: 'shadow_auto_intervene',
                body: 'When enabled, the Shadow automatically terminates agents that exceed thresholds. Default false — report only.',
              },
              {
                icon: Eye,
                label: 'Model',
                cmd: 'shadow_model',
                body: 'The LLM used for pattern analysis. Defaults to the session model. Use setmodel to switch to a lighter model for analysis.',
              },
              {
                icon: Archive,
                label: 'State persistence',
                cmd: 'ShadowState',
                body: 'Shadow state is persisted to disk: known agents, spike history, anomaly log. Survives restarts. Clean state on /shadow stop.',
              },
            ].map(({ icon: Icon, label, cmd, body }) => (
              <div key={label} className="rounded-xl border border-line bg-card p-5">
                <Icon className="size-4 text-brand" />
                <h3 className="mt-3 font-black text-sm text-fg">{label}</h3>
                <code className="mt-1.5 block font-mono text-xs text-brand">{cmd}</code>
                <p className="mt-2 text-xs leading-5 text-muted">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <PageNext
        label="ACP"
        title="Drive external coding agents from WrongStack"
        body="Discover and run Claude Code, Codex CLI, Gemini CLI and more using their existing logins."
        href="/acp"
      />
    </>
  );
}

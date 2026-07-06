'use client';

import { Reveal, SectionHeading } from '@/components/ui/reveal';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Out, Prompt, TerminalFrame } from '@/components/ui/terminal';
import { Check, Globe, MonitorPlay, Terminal } from 'lucide-react';
import type { ReactNode } from 'react';

type Surface = {
  id: string;
  icon: typeof Terminal;
  label: string;
  badge: string;
  blurb: string;
  features: string[];
  preview: ReactNode;
};

const surfaces: Surface[] = [
  {
    id: 'repl',
    icon: Terminal,
    label: 'Plain REPL',
    badge: 'default',
    blurb:
      'Readline-based, streaming, and dependency-light. Works everywhere a terminal works — no GUI, no React import cost at startup.',
    features: [
      'Multiline heredoc with paste detection',
      'Full slash-command set + streaming text',
      'Signal-safe cleanup, non-TTY guard',
      'Runs offline with --no-features',
    ],
    preview: (
      <div className="space-y-1.5">
        <Prompt>wrongstack "refactor src/auth.ts to async/await"</Prompt>
        <div className="space-y-0.5 pl-4 text-zinc-400">
          <div>
            <Out tone="blue">[read]</Out> src/auth.ts — 142 lines
          </div>
          <div>
            <Out tone="yellow">[edit]</Out> rewrote 3 callbacks → async/await
          </div>
          <div>
            <Out tone="blue">[typecheck]</Out> tsc — 0 errors
          </div>
          <div>
            <Out tone="green">✓ done in 4 steps</Out>
          </div>
        </div>
        <Prompt>
          <span className="caret" />
        </Prompt>
      </div>
    ),
  },
  {
    id: 'tui',
    icon: MonitorPlay,
    label: 'TUI',
    badge: '--tui · Ink + React',
    blurb:
      'A rich terminal UI, lazy-loaded behind --tui. Live status, per-subagent timers, type-to-search model picking, and Esc-to-steer mid-run.',
    features: [
      'Status bar: model · tokens · cache hit · cost',
      '/model picker: provider → searchable model list with scroll window',
      'LiveActivityStrip: tool in flight + elapsed timer',
      'Esc-to-steer: abort and prepend a STEERING preamble',
      '@query fuzzy file picker · clipboard image paste',
      'Live stage chip: ⟳ DECIDE → ⚡ EXECUTE → ◎ REFLECT',
    ],
    preview: (
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-zinc-500">
          <span>model configured-model · ctx 41%</span>
          <span className="text-brand">⟳ EXECUTE</span>
        </div>
        <div className="space-y-0.5 rounded-md border border-white/10 bg-white/[0.03] p-2 text-xs">
          <div className="text-zinc-400">
            running: <Out tone="blue">grep</Out> "TODO" · 1.2s
          </div>
          <div className="text-zinc-400">
            running: <Out tone="yellow">test</Out> vitest · 3.8s
          </div>
        </div>
        <div className="text-xs text-zinc-500">fleet ⚡ extended ×2 · 3 subagents</div>
        <Prompt>
          <span className="caret" />
        </Prompt>
      </div>
    ),
  },
  {
    id: 'webui',
    icon: Globe,
    label: 'Web UI',
    badge: '@wrongstack/webui',
    blurb:
      'A React + Radix + Tailwind front end with a Node ws backend. Standalone webui binary, or piggy-back on the CLI with --webui.',
    features: [
      'Topbar: ctx% · tokens · cache hit · cost · iteration',
      'Tool bubbles stream live tool.progress',
      'Ctrl+K palette · Ctrl+M model switcher · Ctrl+F search',
      'Live TODO snapshot, pinned panel, history search',
      'AutoPhase phase/task view broadcasts during a run',
    ],
    preview: (
      <div className="space-y-1.5">
        <Prompt>wstackui</Prompt>
        <div className="space-y-0.5 pl-4 text-zinc-400">
          <div>
            <Out tone="green">▸ backend</Out> 127.0.0.1:3457
          </div>
          <div>
            <Out tone="green">▸ ui</Out> http://localhost:3456
          </div>
          <div className="text-zinc-500">WS_HOST=0.0.0.0 wstackui # expose on LAN</div>
        </div>
        <Prompt>
          <span className="caret" />
        </Prompt>
      </div>
    ),
  },
];

export function Interfaces() {
  return (
    <section
      id="interfaces"
      className="scroll-mt-20 border-y border-line bg-surface/40 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Three surfaces"
          title="Same agent,"
          highlight="three ways to drive it"
          description="One core, three front ends. Start in the plain REPL, switch to the TUI for live telemetry, or open the web UI for the full picture."
        />

        <Reveal className="mt-14">
          <Tabs defaultValue="repl" className="w-full">
            <TabsList className="mx-auto flex h-auto w-full max-w-md flex-wrap justify-center gap-1 p-1.5">
              {surfaces.map((s) => (
                <TabsTrigger key={s.id} value={s.id} className="flex-1 gap-2 px-3 py-2">
                  <s.icon className="size-4" />
                  {s.label}
                </TabsTrigger>
              ))}
            </TabsList>

            {surfaces.map((s) => (
              <TabsContent key={s.id} value={s.id} className="mt-8">
                <div className="grid items-center gap-8 lg:grid-cols-2">
                  <div>
                    <span className="font-mono text-xs text-brand">{s.badge}</span>
                    <h3 className="mt-2 text-2xl font-bold tracking-tight">{s.label}</h3>
                    <p className="mt-3 text-pretty text-muted">{s.blurb}</p>
                    <ul className="mt-5 space-y-2.5">
                      {s.features.map((f) => (
                        <li key={f} className="flex items-start gap-2.5 text-sm">
                          <Check className="mt-0.5 size-4 shrink-0 text-brand" />
                          <span className="text-muted">{f}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <TerminalFrame title={`wrongstack — ${s.label.toLowerCase()}`}>
                    <div className="min-h-[180px]">{s.preview}</div>
                  </TerminalFrame>
                </div>
              </TabsContent>
            ))}
          </Tabs>
        </Reveal>
      </div>
    </section>
  );
}

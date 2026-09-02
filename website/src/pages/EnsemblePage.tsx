import {
  AlertTriangle,
  ArrowRight,
  Cable,
  Check,
  Cpu,
  Disc,
  FileWarning,
  GitCompare,
  Globe,
  Layers3,
  Network,
  Play,
  Radio,
  ScanSearch,
  ShieldAlert,
  XCircle,
  Zap,
} from 'lucide-react';
import { ExternalDoc, PageHero, PageNext, SectionIntro } from '@/components/site/primitives';

export function EnsemblePage() {
  return (
    <>
      <PageHero
        index="23"
        eyebrow="Ensemble"
        title={
          <>
            Multiple agents,
            <br />
            <span className="text-brand">one problem.</span>
          </>
        }
        description="Fan one task to multiple ACP-capable coding agents simultaneously. Claude Code, Gemini CLI, Codex CLI, and 9 more — each works independently with its own tools and model. Compare results side by side or surface consensus patterns."
        aside={
          <ExternalDoc path="docs/acp-ensemble.md">Open ACP Ensemble architecture</ExternalDoc>
        }
      />

      {/* ── How it works ───────────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="01"
          eyebrow="Architecture"
          title="WrongStack is both client and server in the ACP ecosystem."
          description="Ensemble uses the Agent Client Protocol v1 — the cross-vendor standard. WrongStack drives external agents as a client, and external editors can drive WrongStack as a server. The ensemble feature is the client-side fan-out."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {[
            {
              icon: Cable,
              title: 'ACP Client',
              body: 'WrongStack spawns external agents as child processes over stdio. It sends tasks via `session/prompt` and streams results through `session/update` notifications. Each agent uses its own tools, models, and permissions.',
              tag: 'drives agents',
            },
            {
              icon: Layers3,
              title: 'ACP Server',
              body: 'External editors (Zed, JetBrains Junie, VS Code ACP) can drive WrongStack as an ACP server. Full v1 method set: initialize, session/new, session/prompt, session/cancel, mode/config management.',
              tag: 'driven by editors',
            },
            {
              icon: Network,
              title: 'Ensemble orchestrator',
              body: '`runEnsemble()` fans one task to multiple agents via Promise.allSettled. Result: per-agent success/failure/skipped/cancelled status, duration, and output. Same engine powers `/ensemble`, `wstack acp parallel`, and programmatic use.',
              tag: 'fan-out engine',
            },
          ].map(({ icon: Icon, title, body, tag }) => (
            <article key={title} className="rounded-2xl border border-line bg-card p-7">
              <Icon className="size-5 text-brand" />
              <div className="mt-8 flex items-center gap-2">
                <h2 className="text-lg font-black text-fg">{title}</h2>
                <span className="rounded-full border border-line bg-bg px-2 py-0.5 font-mono text-xs font-black uppercase text-faint">
                  {tag}
                </span>
              </div>
              <p className="mt-4 text-sm leading-7 text-muted">{body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* ── Agent catalog ───────────────────────────────────────────────── */}
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="02"
            eyebrow="Agent catalog"
            title="12 agents. Live detection. No API keys needed."
            description="Every agent uses its existing login — no extra configuration. WrongStack probes your `$PATH` to discover installed agents. The bundled catalog serves as offline fallback; a synced registry from the ACP project provides live updates."
          />
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {(
              [
                {
                  name: 'Claude Code',
                  vendor: 'Anthropic',
                  id: 'claude-code',
                  integration: 'adapter',
                },
                { name: 'Gemini CLI', vendor: 'Google', id: 'gemini-cli', integration: 'native' },
                { name: 'Codex CLI', vendor: 'OpenAI', id: 'codex-cli', integration: 'adapter' },
                {
                  name: 'GitHub Copilot',
                  vendor: 'GitHub',
                  id: 'copilot',
                  integration: 'experimental',
                },
                { name: 'Cline', vendor: 'Community', id: 'cline', integration: 'community' },
                {
                  name: 'Qwen Code',
                  vendor: 'Community',
                  id: 'qwen-code',
                  integration: 'experimental',
                },
                { name: 'OpenCode', vendor: 'Community', id: 'opencode', integration: 'native' },
                {
                  name: 'Kiro CLI',
                  vendor: 'Community',
                  id: 'kiro-cli',
                  integration: 'experimental',
                },
                { name: 'Cursor', vendor: 'Community', id: 'cursor', integration: 'experimental' },
                { name: 'Goose', vendor: 'Community', id: 'goose', integration: 'experimental' },
                {
                  name: 'OpenHands',
                  vendor: 'Community',
                  id: 'openhands',
                  integration: 'experimental',
                },
                {
                  name: 'Mistral Vibe',
                  vendor: 'Community',
                  id: 'mistral-vibe',
                  integration: 'experimental',
                },
              ] as { name: string; vendor: string; id: string; integration: string }[]
            ).map(({ name, vendor, id, integration }) => (
              <div key={id} className="rounded-xl border border-line bg-card p-5">
                <div className="flex items-center justify-between">
                  <h3 className="font-black text-sm text-fg">{name}</h3>
                  <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-faint">
                    {integration}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <span className="rounded bg-brand/10 px-1.5 py-0.5 font-mono text-[10px] text-brand">
                    {vendor}
                  </span>
                  <code className="font-mono text-[10px] text-faint">{id}</code>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-8 grid gap-6 lg:grid-cols-2">
            <div className="rounded-2xl border border-line bg-card p-7">
              <Radio className="size-5 text-brand" />
              <h2 className="mt-8 text-xl font-black text-fg">Live detection</h2>
              <p className="mt-3 text-sm leading-7 text-muted">
                `/acp probe` runs all 12 catalog entries in parallel via `Promise.allSettled`.
                Results are cached for 5 seconds. Each entry carries a probe command (e.g. `claude
                --version`) and an ACP startup command.
              </p>
              <div className="mt-5 rounded-lg border border-line bg-bg p-4 font-mono text-xs leading-6 text-zinc-400">
                <span className="text-emerald-400">✓</span> claude-code &nbsp;(adapter)
                <br />
                <span className="text-emerald-400">✓</span> gemini-cli &nbsp;&nbsp;(native)
                <br />
                <span className="text-emerald-400">✓</span> codex-cli &nbsp;&nbsp;&nbsp;(adapter)
                <br />
                <span className="text-emerald-400">✓</span> opencode
                &nbsp;&nbsp;&nbsp;&nbsp;(native)
                <br />
                <span className="text-amber-400">—</span> goose
                &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;binary not found
                <br />
                <span className="text-amber-400">—</span> cursor
                &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;binary not found
              </div>
            </div>
            <div className="rounded-2xl border border-line bg-card p-7">
              <Globe className="size-5 text-brand" />
              <h2 className="mt-8 text-xl font-black text-fg">Registry sync</h2>
              <p className="mt-3 text-sm leading-7 text-muted">
                The bundled 12-agent catalog is the offline fallback. `/acp sync` fetches the
                official ACP registry (37+ agents, hourly-updated) and caches it at
                `~/.wrongstack/cache/acp-registry.json`. Resolution order: user override → synced
                registry → legacy map → bundled catalog.
              </p>
              <div className="mt-5 space-y-2">
                {[
                  {
                    label: 'Bundled catalog',
                    body: '12 agents shipped with @wrongstack/acp. Always available offline.',
                  },
                  {
                    label: 'Synced registry',
                    body: '37+ agents from agentclientprotocol/registry. Fetched on demand.',
                  },
                  {
                    label: 'User overrides',
                    body: 'config.acp.agents — highest priority. Add custom agents or override defaults.',
                  },
                ].map(({ label, body }) => (
                  <div key={label} className="rounded-lg border border-line bg-bg p-3">
                    <span className="font-black text-xs text-fg">{label}</span>
                    <p className="mt-0.5 text-[11px] leading-4 text-muted">{body}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Ensemble flow ───────────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="03"
          eyebrow="Ensemble flow"
          title="Resolve → dispatch → collect → render."
          description="`runEnsemble()` is a pure orchestrator: no renderer dependency, no TUI coupling. Three entry points — CLI, slash command, and programmatic API — all consume the same engine."
        />
        <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-4">
          {[
            {
              step: '01',
              icon: ScanSearch,
              title: 'Resolve',
              body: 'Parse comma-separated agent ids. For each, resolve a spawn command via catalog lookup. Unresolved agents are marked skipped with a reason.',
            },
            {
              step: '02',
              icon: Play,
              title: 'Dispatch',
              body: '`Promise.allSettled` runs every installed agent concurrently. Each gets its own `ACPSession` — separate process, tools, model, and context.',
            },
            {
              step: '03',
              icon: Layers3,
              title: 'Collect',
              body: 'Results classified into success/failed/cancelled/skipped. Per-agent: `result` text, `durationMs`, `error` kind+message on failure.',
            },
            {
              step: '04',
              icon: GitCompare,
              title: 'Render',
              body: '`renderEnsembleText()` produces a formatted block: per-agent header, status badge, duration, and output. Caller can supply their own renderer.',
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
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-line bg-ink p-7">
            <div className="font-mono text-xs font-black uppercase tracking-[0.16em] text-zinc-600">
              EnsembleResult shape
            </div>
            <div className="mt-5 font-mono text-sm leading-7 text-zinc-300">
              <span className="text-zinc-500">task</span>
              <span className="text-zinc-600">: </span>
              <span className="text-amber-300">"review the auth module"</span>
              <br />
              <span className="text-zinc-500">requested</span>
              <span className="text-zinc-600">: </span>
              <span className="text-zinc-300">["claude-code", "gemini-cli"]</span>
              <br />
              <span className="text-zinc-500">summary</span>
              <span className="text-zinc-600">: </span>
              <span className="text-zinc-300">
                {'{ succeeded: 2, failed: 0, skipped: 0, cancelled: 0 }'}
              </span>
              <br />
              <span className="text-zinc-500">results[]</span>
              <span className="text-zinc-600">: </span>
              <span className="text-zinc-400">[agentId, status, result, durationMs]</span>
            </div>
          </div>
          <div className="rounded-2xl border border-line bg-card p-7">
            <Cpu className="size-5 text-brand" />
            <h2 className="mt-8 text-xl font-black text-fg">Three entry points</h2>
            <div className="mt-5 space-y-3">
              {[
                {
                  cmd: 'wstack acp parallel claude-code,gemini-cli "review auth"',
                  desc: 'CLI. Formatted text block output. Pipe-friendly for scripting.',
                },
                {
                  cmd: '/ensemble claude-code,gemini-cli "review auth"',
                  desc: 'TUI/REPL slash command. Same renderer, returned to chat history.',
                },
                {
                  cmd: "import { runEnsemble } from '@wrongstack/acp'",
                  desc: 'Programmatic. Any script or test. Full control over options and rendering.',
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

      {/* ── Protocol deep-dive ──────────────────────────────────────────── */}
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="04"
            eyebrow="Protocol"
            title="ACP v1: initialize, prompt, stream, cancel."
            description="The ACP v1 spec defines a JSON-RPC 2.0 protocol over stdio. WrongStack implements both sides — client and server — as spec-compliant, smoke-tested implementations."
          />
          <div className="mt-12 grid gap-6 lg:grid-cols-2">
            <div className="rounded-2xl border border-line bg-card p-7">
              <h2 className="text-xl font-black text-fg">Client state machine</h2>
              <div className="mt-5 flex items-center gap-1.5 font-mono text-xs text-faint flex-wrap">
                {[
                  'idle',
                  '→',
                  'initializing',
                  '→',
                  'ready',
                  '→',
                  'prompting',
                  '→',
                  'streaming',
                  '→',
                  'done',
                ].map((s, i) => (
                  <span
                    key={i}
                    className={s === '→' ? 'text-zinc-600' : 'rounded bg-bg px-1.5 py-0.5'}
                  >
                    {s}
                  </span>
                ))}
              </div>
              <div className="mt-6 space-y-3">
                {[
                  {
                    step: '1. Initialize',
                    body: 'Spawn agent process, send `initialize { protocolVersion: 1, clientCapabilities: {fs, terminal} }`, assert response.',
                  },
                  {
                    step: '2. New session',
                    body: 'Send `session/new { cwd, mcpServers: [] }`. Receive `sessionId`. Session is now ready for prompts.',
                  },
                  {
                    step: '3. Prompt',
                    body: 'Send `session/prompt { sessionId, prompt: [{type: "text", text: "..."}] }`. Stream pump begins.',
                  },
                  {
                    step: '4. Stream',
                    body: 'Listen for `session/update` notifications: agent_message_chunk, tool_call, tool_call_update, plan, usage_update.',
                  },
                  {
                    step: '5. Serve requests',
                    body: 'Answer fs/read_text_file, terminal/create, session/request_permission as they arrive mid-stream.',
                  },
                  {
                    step: '6. Done',
                    body: 'Agent returns `stopReason`. Possible values: end_turn, cancelled, refused, max_turns.',
                  },
                ].map(({ step, body }) => (
                  <div key={step} className="rounded-lg border border-line bg-bg p-3">
                    <span className="font-black text-xs text-fg">{step}</span>
                    <p className="mt-1 text-[11px] leading-4 text-muted">{body}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-2xl border border-line bg-card p-7">
              <h2 className="text-xl font-black text-fg">Server method set</h2>
              <p className="mt-3 text-sm leading-7 text-muted">
                When an external editor drives WrongStack, it speaks the full v1 server method set.
                Concurrency is per-session — multiple sessions can run in parallel.
              </p>
              <div className="mt-5 space-y-2">
                {[
                  {
                    method: 'initialize',
                    dir: 'req→res',
                    desc: 'Negotiate protocolVersion, return agentCapabilities',
                  },
                  {
                    method: 'session/new',
                    dir: 'req→res',
                    desc: 'Create session, emit current_mode_update, return sessionId + modes',
                  },
                  {
                    method: 'session/prompt',
                    dir: 'req→res',
                    desc: 'Start turn, stream session/update notifications, return stopReason',
                  },
                  {
                    method: 'session/cancel',
                    dir: 'notif',
                    desc: 'Cancel in-flight turn + active tool calls. No response.',
                  },
                  {
                    method: 'session/set_mode',
                    dir: 'req→res',
                    desc: 'Switch active mode, emit current_mode_update',
                  },
                  {
                    method: 'session/load',
                    dir: 'req→res',
                    desc: 'Resume a prior session (opt-in, loadSession capability)',
                  },
                ].map(({ method, dir, desc }) => (
                  <div key={method} className="rounded-lg border border-line bg-bg p-3">
                    <div className="flex items-center gap-2">
                      <code className="font-mono text-xs text-brand">{method}</code>
                      <span className="font-mono text-[10px] text-faint">{dir}</span>
                    </div>
                    <p className="mt-1 text-[11px] leading-4 text-muted">{desc}</p>
                  </div>
                ))}
              </div>
              <div className="mt-5 rounded-lg border border-line bg-bg p-4">
                <h3 className="font-black text-sm text-fg">Notifications emitted to client</h3>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {[
                    'agent_message_chunk',
                    'tool_call',
                    'tool_call_update',
                    'plan',
                    'usage_update',
                    'current_mode_update',
                    'config_option_update',
                    'available_commands_update',
                  ].map((n) => (
                    <code
                      key={n}
                      className="rounded bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-faint"
                    >
                      {n}
                    </code>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Failure modes ───────────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="05"
          eyebrow="Failure modes"
          title="One agent fails — the others keep running."
          description="Ensemble uses Promise.allSettled, not Promise.all. A crashed agent marks its result as failed; the other agents continue independently. Skipped agents (not installed) don't block the session."
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            {
              icon: XCircle,
              title: 'Agent not installed',
              body: 'Marked `skipped` with reason "binary not found". The CLI prints a warning and continues with remaining agents.',
              severity: 'skipped',
            },
            {
              icon: FileWarning,
              title: 'Agent dies mid-turn',
              body: 'Transport emits `close`. ACPSession reports `failed` with `error.kind = "bridge_failed"`. Other agents unaffected.',
              severity: 'failed',
            },
            {
              icon: ShieldAlert,
              title: 'Permission prompt',
              body: '`session/request_permission` arrives mid-stream. ACPSession calls PermissionPolicy.request() → user accepts/denies in TUI.',
              severity: 'interactive',
            },
            {
              icon: Disc,
              title: 'User aborts (Ctrl-C)',
              body: 'AbortSignal fires → sends `session/cancel` notification to every running agent → waits for stopReason: cancelled → marks all cancelled.',
              severity: 'cancelled',
            },
            {
              icon: AlertTriangle,
              title: 'Sandbox escape attempt',
              body: 'fs/read_text_file for a path outside projectRoot → FileServer refuses with JSON-RPC error -32602. Sibling-prefix attacks also blocked.',
              severity: 'blocked',
            },
            {
              icon: ArrowRight,
              title: 'v2-only updates',
              body: 'Agents emitting v2-RFD kinds (`_unstable_*`) are accepted via UnstableSessionUpdate. Logged at debug, never rejected. Forward-compat safe.',
              severity: 'accepted',
            },
          ].map(({ icon: Icon, title, body, severity }) => (
            <div key={title} className="rounded-xl border border-line bg-card p-5">
              <div className="flex items-center justify-between">
                <Icon className="size-4 text-brand" />
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-faint">
                  {severity}
                </span>
              </div>
              <h3 className="mt-4 font-black text-sm text-fg">{title}</h3>
              <p className="mt-2 text-xs leading-5 text-muted">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Commands ────────────────────────────────────────────────────── */}
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="06"
            eyebrow="Commands"
            title="Single agent or full ensemble — one command."
            description="The same `runEnsemble()` engine powers both the CLI subcommand and the REPL slash command. Use single-agent dispatch for focused work; use parallel for comparison."
          />
          <div className="mt-12 grid gap-6 lg:grid-cols-2">
            <div className="rounded-2xl border border-line bg-card p-7">
              <h2 className="text-xl font-black text-fg">Single agent</h2>
              <div className="mt-5 space-y-3">
                {[
                  {
                    cmd: '/acp probe',
                    desc: 'Test connectivity to all installed agents. Reports reachability and version.',
                  },
                  {
                    cmd: '/acp gemini-cli "review this module"',
                    desc: 'Send a task to a specific agent by name. Blocking call — waits for completion.',
                  },
                  {
                    cmd: '/acp list',
                    desc: 'Show live detection results with installed/not-found status for all 12 catalog entries.',
                  },
                  {
                    cmd: '/acp sync',
                    desc: 'Fetch the latest ACP registry (37+ agents) and cache it for offline use.',
                  },
                  {
                    cmd: '/acp server',
                    desc: 'Start WrongStack as an ACP server. External editors can connect and drive it.',
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
              <h2 className="text-xl font-black text-fg">Ensemble (parallel)</h2>
              <div className="mt-5 space-y-3">
                {[
                  {
                    cmd: '/ensemble claude-code,gemini-cli "review auth"',
                    desc: 'Fan out to multiple agents simultaneously. Comma-separated ids, deduped automatically.',
                  },
                  {
                    cmd: 'wstack acp parallel claude,gemini,codex "task"',
                    desc: 'Same engine from the CLI. Formatted text output, pipe-friendly.',
                  },
                  {
                    cmd: '/ensemble claude-code,gemini-cli --timeout 300000 "task"',
                    desc: 'Custom timeout per agent in ms. Default matches agent-specific budgets.',
                  },
                ].map(({ cmd, desc }) => (
                  <div key={cmd} className="rounded-lg border border-line bg-bg p-4">
                    <code className="font-mono text-sm font-black text-brand">{cmd}</code>
                    <p className="mt-1.5 text-xs leading-5 text-muted">{desc}</p>
                  </div>
                ))}
              </div>
              <div className="mt-5 rounded-lg border border-line bg-ink p-4">
                <h3 className="font-black text-sm text-zinc-300">When to ensemble vs. delegate</h3>
                <div className="mt-3 space-y-2">
                  {[
                    {
                      use: 'Ensemble',
                      when: 'You want independent perspectives from multiple agents on the same problem.',
                    },
                    {
                      use: 'Delegate',
                      when: 'You want to split work across agents — each does a different sub-task.',
                    },
                    {
                      use: 'Ensemble',
                      when: 'You are comparing agent quality or picking the best tool for a workflow.',
                    },
                    {
                      use: 'Single /acp',
                      when: 'You know which external agent you want and just need it to do one thing.',
                    },
                  ].map(({ use, when }) => (
                    <div key={when} className="flex items-start gap-2">
                      <span
                        className={`mt-0.5 shrink-0 font-mono text-[10px] font-black ${use === 'Ensemble' ? 'text-brand' : 'text-faint'}`}
                      >
                        {use}
                      </span>
                      <p className="text-xs leading-5 text-zinc-400">{when}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── What ships today ────────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="07"
          eyebrow="Coverage"
          title="Spec-compliant, smoke-tested, 153 tests."
          description="The ACP integration ships as `@wrongstack/acp` with 14 test files, 153 tests, and an end-to-end smoke harness. Both client and server are v1 spec-compliant."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {[
            {
              icon: Check,
              title: 'Ships today',
              items: [
                'v1 client + server (spec-compliant)',
                '12-agent static catalog with live $PATH probe',
                '/acp list (live detection)',
                '/acp spawn <id> <task> (single agent)',
                '/acp parallel <csv> <task> (multi-agent)',
                '/ensemble <csv> <task> (TUI/REPL)',
                'makeACPServerAgentTurn (real Agent→server)',
                'End-to-end smoke test (pnpm smoke)',
              ],
            },
            {
              icon: Zap,
              title: 'Roadmap',
              items: [
                'Live tabbed TUI panel for parallel runs',
                'Synthesis step: 4th agent folds results',
                'Save/load ensemble presets as JSON',
                'HTTP/WebSocket transport (waiting on v2 RFD)',
                'Token-level streaming in server',
                'Multimodal content blocks (images, audio)',
                'session/load support in server',
                'ACP Registry HTTP API live refresh',
              ],
            },
            {
              icon: ShieldAlert,
              title: 'Non-goals (v1)',
              items: [
                'HTTP/WebSocket transport (v2 RFD)',
                'Cross-agent session sharing',
                'Live multi-tab TUI streaming',
                'Built-in synthesis/fold step',
                'Auto-discovery via Registry HTTP API',
              ],
            },
          ].map(({ icon: Icon, title, items }) => (
            <article key={title} className="rounded-2xl border border-line bg-card p-7">
              <Icon className="size-5 text-brand" />
              <h2 className="mt-8 text-xl font-black text-fg">{title}</h2>
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
      </section>

      <PageNext
        label="HQ Command Center"
        title="Remote fleet orchestration"
        body="A web-based control panel for monitoring and steering your fleet from anywhere."
        href="/hq"
      />
    </>
  );
}

import { Cable, Globe, Network, Radio } from 'lucide-react';
import { ExternalDoc, PageHero, PageNext, SectionIntro } from '@/components/site/primitives';

export function AcpPage() {
  return (
    <>
      <PageHero
        index="20"
        eyebrow="ACP"
        title={
          <>
            Drive external agents <span className="text-brand">from one terminal.</span>
          </>
        }
        description="Agent Communication Protocol v1 — WrongStack is both client and server. Drive Claude Code, Gemini CLI, Codex CLI, and 9 more using their existing logins. External editors can drive WrongStack as an ACP server."
        aside={<ExternalDoc path="docs/acp-ensemble.md">Open ACP architecture</ExternalDoc>}
      />

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="01"
          eyebrow="Dual role"
          title="Client and server in the ACP ecosystem."
          description="WrongStack implements both sides of the ACP v1 spec. As a client, it drives external agents over stdio. As a server, external editors (Zed, JetBrains, VS Code) can drive WrongStack."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-2">
          {[
            {
              icon: Cable,
              title: 'ACP Client',
              items: [
                'Spawns agents as child processes over stdio',
                'Full v1 client state machine: init→new→prompt→stream',
                'Answer fs/read, terminal/create, session/request_permission',
                'session/cancel notification on abort',
                'Each agent uses its own tools, models, and permissions',
              ],
            },
            {
              icon: Network,
              title: 'ACP Server',
              items: [
                'Full v1 method set: 9 methods',
                'initialize, authenticate, session/new, session/prompt',
                'session/cancel, set_mode, set_config_option, session/load, session/list',
                '8 notification types emitted to client',
                'Per-session concurrency with proper AbortController cancellation',
              ],
            },
          ].map(({ icon: Icon, title, items }) => (
            <article key={title} className="rounded-2xl border border-line bg-card p-7">
              <Icon className="size-5 text-brand" />
              <h2 className="mt-8 text-xl font-black text-fg">{title}</h2>
              <ul className="mt-5 space-y-2">
                {items.map((item) => (
                  <li key={item} className="flex items-start gap-2 text-sm leading-6 text-muted">
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand-2" />
                    {item}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="02"
            eyebrow="Discovery"
            title="Live $PATH probe. 12 agents. Cached results."
            description="EnsembleRegistry probes all catalog entries in parallel. Results are cached for 5 seconds. The bundled catalog is the offline fallback; `/acp sync` fetches the official registry (37+ agents)."
          />
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { name: 'Claude Code', vendor: 'Anthropic', integration: 'adapter' },
              { name: 'Gemini CLI', vendor: 'Google', integration: 'native' },
              { name: 'Codex CLI', vendor: 'OpenAI', integration: 'adapter' },
              { name: 'GitHub Copilot', vendor: 'GitHub', integration: 'experimental' },
              { name: 'Cline', vendor: 'Community', integration: 'community' },
              { name: 'Qwen Code', vendor: 'Community', integration: 'experimental' },
              { name: 'OpenCode', vendor: 'Community', integration: 'native' },
              { name: 'Kiro CLI', vendor: 'Community', integration: 'experimental' },
              { name: 'Cursor', vendor: 'Community', integration: 'experimental' },
              { name: 'Goose', vendor: 'Community', integration: 'experimental' },
              { name: 'OpenHands', vendor: 'Community', integration: 'experimental' },
              { name: 'Mistral Vibe', vendor: 'Community', integration: 'experimental' },
            ].map(({ name, vendor, integration }) => (
              <div key={name} className="rounded-xl border border-line bg-card p-4">
                <h3 className="font-black text-sm text-fg">{name}</h3>
                <div className="mt-1.5 flex items-center gap-2">
                  <span className="font-mono text-[10px] text-faint">{vendor}</span>
                  <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-brand-2">
                    {integration}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="03"
          eyebrow="Commands"
          title="Single agent dispatch and server mode."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-line bg-card p-7">
            <Radio className="size-5 text-brand" />
            <h2 className="mt-8 text-xl font-black text-fg">Client commands</h2>
            <div className="mt-5 space-y-3">
              {[
                {
                  cmd: '/acp probe',
                  desc: 'Handshake-test agents — fast initialize-only check. Shows which agents can speak ACP at all.',
                },
                {
                  cmd: '/acp gemini-cli "review auth"',
                  desc: 'Send a task to a specific agent. Blocking — waits for completion. Use --bg for background dispatch.',
                },
                {
                  cmd: '/acp bench [csv] [--fs]',
                  desc: 'Full end-to-end verification per agent. Runs handshake→prompt→result and grades pass/partial/fail.',
                },
                {
                  cmd: '/acp list',
                  desc: 'Live detection: installed/not-found for all 12 catalog entries with integration status.',
                },
                {
                  cmd: '/acp sync',
                  desc: 'Fetch latest ACP registry (37+ agents) and cache for offline use.',
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
            <Globe className="size-5 text-brand" />
            <h2 className="mt-8 text-xl font-black text-fg">Server mode</h2>
            <div className="mt-5 space-y-3">
              {[
                {
                  label: '/acp server',
                  body: 'Start WrongStack as an ACP server on stdio. External editors connect and drive it.',
                },
                {
                  label: 'Spec compliance',
                  body: 'Full v1 method set. Smoke-tested. JSON-RPC 2.0. Proper cancel propagation.',
                },
                {
                  label: 'Editor integration',
                  body: 'Zed, JetBrains Junie, VS Code ACP can all drive WrongStack. No adapter needed.',
                },
                {
                  label: 'Tool registry',
                  body: 'WrongStack tools are exposed as ACP ToolDefinitions. External editors can call any permitted tool.',
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

      <PageNext
        label="Ensemble"
        title="Fan one task to multiple agents"
        body="Send the same problem to multiple ACP agents and compare their independent solutions."
        href="/ensemble"
      />
    </>
  );
}

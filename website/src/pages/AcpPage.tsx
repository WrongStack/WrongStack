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
        description="Agent Communication Protocol v1 — WrongStack is both client and server. Drive Claude Code, Gemini CLI, Codex CLI, and 10 more using their existing logins. External editors can drive WrongStack as an ACP server."
        aside={<ExternalDoc path="docs/acp-ensemble.md">Open ACP architecture</ExternalDoc>}
      />

      <section className="site-section site-container">
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
                'Answer fs/read_text_file, fs/write_text_file, terminal/create, session/request_permission',
                'session/cancel notification on abort',
                'Each agent uses its own tools and models; host file access follows WrongStack permission rules',
                'Outside-project reads and writes check the resolved target and open that same path',
                'In-project writes keep their original path, including linked project roots',
              ],
            },
            {
              icon: Network,
              title: 'ACP Server',
              items: [
                'Starts without a configured provider and offers login before opening a session',
                'initialize, authenticate, logout, session/new, session/prompt',
                'session/load, session/resume, session/close, session/delete, session/fork',
                'session/set_mode, session/set_config_option and session/list',
                'Per-session model selection from the editor, saved across session/load',
                'Authentication-required errors are reserved for missing authentication',
                'session/update notifications streamed to the client per turn',
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
        <div className="site-section site-section--short site-container">
          <SectionIntro
            index="02"
            eyebrow="Discovery"
            title="Live $PATH probe. 13 agents. Cached results."
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
              { name: 'Kimi Code CLI', vendor: 'Moonshot', integration: 'native' },
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

      <section className="site-section site-container">
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
                  desc: 'Live detection: installed/not-found for all 13 catalog entries with integration status.',
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
                  label: 'wstack acp',
                  body: 'Start WrongStack as an ACP server on stdio. External editors connect and drive it.',
                },
                {
                  label: 'Spec compliance',
                  body: 'JSON-RPC 2.0 with cancellation and ACP error codes. Unadvertised providers/set and mcp/message requests return method-not-found.',
                },
                {
                  label: 'Editor integration',
                  body: 'Zed, JetBrains Junie, VS Code ACP can all drive WrongStack. No adapter needed.',
                },
                {
                  label: 'File access policy',
                  body: 'ACP agents driven by WrongStack follow features.allowOutsideProjectRoot and the session’s permission rules. Reads and writes that leave the project are checked on the resolved target, including links. Probe and bench stay project-only.',
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

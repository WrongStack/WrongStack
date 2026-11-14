import {
  ArrowRight,
  CodeXml,
  KeyRound,
  Laptop,
  LogIn,
  Monitor,
  Rocket,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import {
  CopyCommand,
  ExternalDoc,
  PageHero,
  PageNext,
  SectionIntro,
} from '@/components/site/primitives';
import { installCommand, installCommandWindows, releasesUrl } from '@/data/content';
import { Link } from '@/lib/router';

const setupSteps = [
  [
    '01',
    'Install the CLI',
    'One self-contained binary from GitHub Releases, checksum-verified. No Node.js or npm needed. Installs wstack with a wrongstack alias; on Windows run the PowerShell line instead.',
    installCommand,
  ],
  [
    '02',
    'Choose authentication',
    'Use a metered provider API key or sign in with a supported ChatGPT, Claude or GitHub Copilot subscription.',
    'wstack auth',
  ],
  [
    '03',
    'Launch from the project root',
    'Interactive startup detects the repository and offers to scaffold .wrongstack/AGENTS.md when it is missing.',
    'wstack',
  ],
  [
    '04',
    'Start on the right surface',
    'Pick the surface that fits the work — REPL, TUI, browser workspace, lightweight chat, HQ or a one-shot prompt.',
    'wstack --tui',
  ],
] as const;

export function GettingStartedPage() {
  return (
    <>
      <PageHero
        index="09"
        eyebrow="Getting started"
        title={
          <>
            From install to
            <br />
            <span className="text-brand">first useful run.</span>
          </>
        }
        description="Set up WrongStack without guessing which credential, interface or safety mode you need. This path starts local, keeps project instructions explicit and leaves room to grow into fleets later."
        aside={<ExternalDoc path="docs/getting-started.md">Open first-session guide</ExternalDoc>}
      />
      <section className="site-section site-container">
        <SectionIntro index="01" eyebrow="Setup path" title="Four steps. No hidden bootstrap." />
        <div className="mt-14 space-y-4">
          {setupSteps.map(([number, title, body, command]) => (
            <article
              key={number}
              className="grid gap-5 rounded-2xl border border-line bg-card p-6 lg:grid-cols-[64px_230px_1fr_auto] lg:items-center"
            >
              <span className="font-mono text-xs font-black text-brand-2">{number}</span>
              <h2 className="text-xl font-black tracking-[-0.035em] text-fg">{title}</h2>
              <p className="text-sm leading-7 text-muted">{body}</p>
              <div className="flex flex-col items-start gap-2">
                <CopyCommand command={command} />
                {number === '01' && <CopyCommand label="Windows" command={installCommandWindows} />}
              </div>
            </article>
          ))}
        </div>
        <div className="mt-6 rounded-2xl border border-line bg-surface p-6 text-sm leading-7 text-muted">
          <h2 className="font-black text-fg">Desktop: upgrading from 1.7.0 or earlier</h2>
          <p className="mt-2">
            Run <code className="font-mono text-fg">wstack update</code>, then{' '}
            <code className="font-mono text-fg">wstack desktop update</code> to install the first
            desktop with the updater public key. Later signed Windows and macOS releases can install
            from the application. Linux continues to use its package manager.
          </p>
        </div>
        <div className="mt-6 rounded-2xl border border-line bg-surface p-6 text-sm leading-7 text-muted">
          <h2 className="font-black text-fg">Installed from npm before?</h2>
          <p className="mt-2">
            The npm packages are legacy and no longer updated. The installer finds old
            <code className="mx-1 font-mono text-fg">wrongstack</code>/
            <code className="mx-1 font-mono text-fg">@wrongstack/cli</code>
            globals from npm, pnpm, yarn or bun and uninstalls them so they cannot shadow the
            binary. From then on, <code className="font-mono text-fg">wstack update</code> pulls new
            versions straight from{' '}
            <a
              href={releasesUrl}
              target="_blank"
              rel="noreferrer"
              className="font-bold text-fg underline hover:text-brand"
            >
              GitHub Releases
            </a>
            .
          </p>
        </div>
      </section>
      <section className="border-y border-line bg-surface">
        <div className="site-section site-section--short site-container">
          <SectionIntro
            index="02"
            eyebrow="Authentication"
            title="Start with the account you already have."
            description="ChatGPT with Codex, Claude and GitHub Copilot have subscription sign-in routes. Other coding plans use dedicated API keys. Authentication changes billing and access—not the agent kernel or tool system."
          />
          <div className="mt-12 grid gap-6 overflow-hidden rounded-2xl border border-emerald-500/30 bg-ink p-6 text-white sm:p-8 lg:grid-cols-[1fr_auto] lg:items-center">
            <div>
              <div className="flex items-center gap-3 font-mono text-xs font-black uppercase tracking-[0.17em] text-emerald-300">
                <LogIn className="size-4" /> Fastest path for existing access
              </div>
              <h2 className="mt-5 text-3xl font-black tracking-[-0.035em] sm:text-4xl">
                Already have ChatGPT with Codex? Connect it directly.
              </h2>
              <p className="mt-4 max-w-3xl text-sm leading-7 text-zinc-400">
                No Platform API key is required for this path. WrongStack opens the ChatGPT browser
                login, creates the <code className="font-mono text-emerald-300">openai-codex</code>{' '}
                provider and refreshes the encrypted local credential when needed.
              </p>
            </div>
            <div className="flex flex-col items-start gap-4 lg:items-end">
              <CopyCommand command="wstack auth login chatgpt" />
              <Link
                href="/coding-plans"
                className="inline-flex items-center gap-2 text-sm font-black text-white"
              >
                See the complete connection guide <ArrowRight className="size-4" />
              </Link>
            </div>
          </div>
          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <article className="rounded-2xl border border-line bg-card p-7">
              <KeyRound className="size-5 text-brand" />
              <h2 className="mt-8 text-2xl font-black text-fg">Provider API keys</h2>
              <p className="mt-3 text-sm leading-7 text-muted">
                Run the auth manager, choose a provider and store the key in the per-machine
                encrypted vault. Environment variables remain available for CI and ephemeral shells.
              </p>
              <div className="mt-6 space-y-2">
                <code className="block rounded-lg bg-bg px-4 py-3 font-mono text-xs text-fg">
                  wstack auth anthropic
                </code>
                <code className="block rounded-lg bg-bg px-4 py-3 font-mono text-xs text-fg">
                  ANTHROPIC_API_KEY=… wstack
                </code>
              </div>
            </article>
            <article className="rounded-2xl border border-line bg-card p-7">
              <ShieldCheck className="size-5 text-status-success" />
              <h2 className="mt-8 text-2xl font-black text-fg">Other subscription sign-ins</h2>
              <p className="mt-3 text-sm leading-7 text-muted">
                Claude and GitHub Copilot have their own subscription credential routes. Access and
                refresh tokens are encrypted at rest and refreshed near expiry or after an
                authentication failure.
              </p>
              <div className="mt-6 space-y-2">
                {['wstack auth login claude', 'wstack auth login copilot'].map((command) => (
                  <code
                    key={command}
                    className="block rounded-lg bg-bg px-4 py-3 font-mono text-xs text-fg"
                  >
                    {command}
                  </code>
                ))}
              </div>
            </article>
          </div>
        </div>
      </section>
      <section className="site-section site-container">
        <SectionIntro
          index="03"
          eyebrow="First run recipes"
          title="Start at the complexity you actually need."
        />
        <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
          {[
            [
              Terminal,
              'Plain interactive session',
              'wstack',
              'Best default when you want slash commands and streaming output without a full-screen UI.',
            ],
            [
              Laptop,
              'Instrumented terminal UI',
              'wstack --tui',
              'Adds model pickers, panels, cost/context status, permission overlays and fleet monitors.',
            ],
            [
              Rocket,
              'One-shot change',
              'wstack "explain src/auth.ts"',
              'Runs one prompt from the shell and returns without entering the interactive REPL.',
            ],
            [
              Laptop,
              'Browser workspace',
              'wstack --webui --open',
              'Starts a browser-driven agent session instead of the terminal REPL. Add --open to launch the browser automatically.',
            ],
            [
              CodeXml,
              'Focused coding workspace',
              'wstack --vibeui',
              'A browser coding workspace beside the full WebUI—chat queue, sessions, model picker, diffs and agent transcripts on port 3476.',
            ],
            [
              ShieldCheck,
              'Trusted project session',
              'wstack --tui --yolo',
              'Auto-approves permitted work while explicit deny rules and policy hooks remain active.',
            ],
            [
              Rocket,
              'Director task',
              'wstack --goal "audit src/"',
              'Promotes the leader into fleet orchestration for independently verifiable parallel work.',
            ],
            [
              Monitor,
              'HQ Command Center',
              'wstack --hq',
              'Cross-session control plane — steer live agents, queue work and watch mailboxes from any browser.',
            ],
          ].map(([Icon, title, command, body], index, items) => {
            const ItemIcon = Icon as typeof Terminal;
            // A lone recipe in the last three-column row spans the whole row.
            const spanRow = index === items.length - 1 && items.length % 3 === 1;
            return (
              <article
                key={String(title)}
                className={spanRow ? 'bg-card p-6 lg:col-span-3' : 'bg-card p-6'}
              >
                <ItemIcon className="size-5 text-brand" />
                <h2 className="mt-7 font-black text-fg">{String(title)}</h2>
                <code className="mt-3 block overflow-x-auto font-mono text-xs text-brand">
                  {String(command)}
                </code>
                <p className="mt-4 text-sm leading-6 text-muted">{String(body)}</p>
              </article>
            );
          })}
        </div>
      </section>
      <section className="border-t border-line bg-ink text-white">
        <div className="site-container grid gap-10 py-20 lg:grid-cols-[.65fr_1fr]">
          <div>
            <span className="font-mono text-xs font-black uppercase tracking-[0.2em] text-brand">
              Before the first mutation
            </span>
            <h2 className="mt-5 text-4xl font-black tracking-[-0.025em]">
              Give the agent a project contract.
            </h2>
          </div>
          <div>
            <p className="text-lg leading-8 text-zinc-400">
              <code className="font-mono text-brand">.wrongstack/AGENTS.md</code> is where build
              commands, package boundaries, testing expectations and repository-specific safety
              rules belong. On the first interactive launch, WrongStack detects a project manifest
              and offers to scaffold this file automatically. It travels with the project and
              becomes persistent context.
            </p>
            <p className="mt-4 rounded-xl border border-white/10 bg-white/[0.035] px-4 py-3 text-sm leading-6 text-terminal-muted">
              <code className="font-mono text-brand">/init</code> is an in-session slash command,
              not the setup command for the shell. Use it later to regenerate the project contract;
              the existing file is copied to <code className="font-mono">AGENTS.md.bak</code> first.
              Provider and model setup belongs to <code className="font-mono">wstack auth</code>.
            </p>
            <div className="mt-6 flex flex-wrap gap-4">
              <Link
                href="/commands/init"
                className="group inline-flex items-center gap-2 text-sm font-bold text-white"
              >
                Learn /init <ArrowRight className="size-4 group-hover:translate-x-1" />
              </Link>
              <Link
                href="/settings"
                className="group inline-flex items-center gap-2 text-sm font-bold text-zinc-400"
              >
                Understand project config{' '}
                <ArrowRight className="size-4 group-hover:translate-x-1" />
              </Link>
            </div>
          </div>
        </div>
      </section>
      <section className="site-section site-container">
        <SectionIntro
          index="04"
          eyebrow="Quickstart"
          title="Platform-specific setup notes."
          description="WrongStack runs on macOS, Linux, and Windows. The core experience is identical — these notes cover platform-specific prerequisites."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {[
            {
              title: 'macOS',
              body: 'Native binary for Apple silicon and Intel, ad-hoc signed by the installer. Ensure Git is installed. Use Terminal.app or iTerm2. Run wstack auth to save encrypted credentials in the active profile configuration.',
            },
            {
              title: 'Linux',
              body: 'x64 and arm64 builds for glibc and musl (Alpine needs libstdc++ and libgcc). Git is the only prerequisite. Works on any terminal emulator.',
            },
            {
              title: 'Windows',
              body: 'x64 binary (runs on ARM under emulation); the installer puts it first on your user PATH. Git for Windows. Use Windows Terminal or PowerShell.',
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
        label="Workflows"
        title="Choose how the work should run"
        body="Direct prompts are only the beginning. Compare goals, SDD, Goal, reviews and collaboration."
        href="/workflows"
      />
    </>
  );
}

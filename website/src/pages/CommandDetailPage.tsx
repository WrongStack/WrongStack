import { ArrowRight, Check, Command, Copy, Layers3, Terminal } from 'lucide-react';
import { useState } from 'react';
import {
  ExternalDoc,
  PageHero,
  PageNext,
  SectionIntro,
  heroTitleFontSize,
} from '@/components/site/primitives';
import { commandDetails } from '@/data/command-details';
import { commandFromSlug, commandSlug, commands } from '@/data/content';
import { commandGuidance } from '@/data/deep-dives';
import { Link, useRouter } from '@/lib/router';

const commandDeepGuides: Partial<Record<string, { href: string; label: string }>> = {
  '/mode': { href: '/modes', label: 'Compare all 19 session modes' },
  '/fleet': { href: '/agent-roster', label: 'Browse 50 phase roles plus Shadow' },
  '/spawn': { href: '/agent-roster', label: 'Choose a specialist role' },
  '/agents': { href: '/agent-roster', label: 'Understand the roster and lifecycle phases' },
  '/director': { href: '/agent-roster', label: 'See the Director’s complete roster' },
  '/delegate': { href: '/agent-roster', label: 'Compare explicit roles and smart dispatch' },
  '/supervisor': { href: '/agent-roster', label: 'See which workers the Supervisor watches' },
};

/** Generate fallback usage examples that are more contextual than bare `/help <cmd>`. */
function fallbackExamples(name: string): string[] {
  const bare = name.slice(1);
  // For commands with known sub-patterns, produce a realistic starter example.
  if (name === '/help') return ['/help', '/help fleet', '/help mode code-reviewer'];
  if (name === '/exit') return ['/exit', '/quit', '/q'];
  if (name === '/sessions') return ['/sessions', '/resume', '/sessions rename <id> "label"'];
  if (name === '/clear') return ['/clear', '/clear --reset-context'];
  if (name === '/save') return ['/save'];
  if (name === '/stats') return ['/stats'];
  if (name === '/diag') return ['/diag'];
  if (name === '/compact') return ['/compact'];
  if (name === '/desktop') return ['/desktop'];
  if (name === '/webui') return ['/webui'];
  if (name === '/todos') return ['/todos'];
  if (name === '/tasks') return ['/tasks', '/tasks promote <id>'];
  if (name === '/models') return ['/models', '/models add <provider> <model-id>'];
  if (name === '/modelcaps') return ['/modelcaps'];
  if (name === '/yolo') return ['/yolo', '/yolo off'];
  if (name === '/autonomy') return ['/autonomy', '/autonomy high'];
  if (name === '/tool') return ['/tool', '/tool simple', '/tool extended'];
  if (name === '/tools') return ['/tools'];
  if (name === '/plugin') return ['/plugin', '/plugin list', '/plugin enable <name>'];
  if (name === '/telegram-setup') return ['/telegram-setup'];
  if (name === '/telegram-settings') return ['/telegram-settings', '/telegram-settings test'];
  if (name === '/prompts') return ['/prompts', '/prompts search "code review"'];
  if (name === '/prompt-gen') return ['/prompt-gen "explain complex refactors"'];
  if (name === '/sync') return ['/sync', '/sync push', '/sync pull'];
  if (name === '/metrics') return ['/metrics'];
  if (name === '/health') return ['/health', '/health provider-reachability'];
  if (name === '/skill') return ['/skill', '/skill list', '/skill bug-hunter'];
  if (name === '/skill-gen') return ['/skill-gen "audit logging conventions"'];
  if (name === '/skill-search') return ['/skill-search security'];
  if (name === '/skill-import') return ['/skill-import', '/skill-import ~/.claude/skills/'];
  if (name === '/skill-update') return ['/skill-update', '/skill-update bug-hunter'];
  if (name === '/skill-uninstall') return ['/skill-uninstall bug-hunter'];
  if (name === '/gitcheck') return ['/gitcheck'];
  if (name === '/push') return ['/push'];
  if (name === '/gitid') return ['/gitid', '/gitid set name "Jane Dev"'];
  if (name === '/doctor') return ['/doctor'];
  if (name === '/working_dir') return ['/working_dir', '/working_dir src/'];
  if (name === '/project') return ['/project', '/project add ../other-project'];
  if (name === '/f') return ['/f', '/f 2'];
  if (name === '/mouse') return ['/mouse'];
  if (name === '/design') return ['/design list', '/design use minimal-clarity'];
  if (name === '/fallback') return ['/fallback', '/fallback add claude-sonnet'];
  if (name === '/auth') return ['/auth'];
  if (name === '/statusline') return ['/statusline', '/statusline model on'];
  if (name === '/codebase-reindex') return ['/codebase-reindex', '/codebase-reindex --force'];
  if (name === '/techstack') return ['/techstack'];
  if (name === '/worktree') return ['/worktree list', '/worktree prune'];
  if (name === '/mailbox-demo') return ['/mailbox-demo'];
  if (name === '/mailbox-serve') return ['/mailbox-serve', '/mailbox-serve --port 7788'];
  if (name === '/shadow') return ['/shadow start', '/shadow status', '/shadow stop'];
  if (name === '/hq') return ['/hq', '/hq connect http://localhost:4000'];
  if (name === '/coordinator') return ['/coordinator status', '/coordinator pause'];
  if (name === '/collab') return ['/collab src/auth/', '/collab --timeout 120000 src/'];
  if (name === '/ensemble') return ['/ensemble "review the API layer"'];
  return [name, `/help ${bare}`];
}

export function CommandDetailPage() {
  const { path } = useRouter();
  const pathParts = path.split('/').filter(Boolean);
  const slug = pathParts[pathParts.length - 1] ?? '';
  const command = commandFromSlug(slug);
  const [copied, setCopied] = useState<string | null>(null);

  if (!command) return null;

  const detail = commandDetails[command.name];
  const guidance = commandGuidance[command.category];
  const position = commands.findIndex((item) => item.name === command.name) + 1;
  const related = commands
    .filter((item) => item.category === command.category && item.name !== command.name)
    .slice(0, 5);
  const examples = command.usage ?? fallbackExamples(command.name);
  const deepGuide = commandDeepGuides[command.name];

  // Per-command content with category-level fallback.
  const purpose = detail?.purpose ?? guidance.intent;
  const behavior = detail?.behavior ?? command.summary;
  const before = detail?.before ?? guidance.before;
  const during = detail?.during ?? guidance.during;
  const after = detail?.after ?? guidance.after;

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      // clipboard unavailable; ignore
    }
  };

  return (
    <>
      <PageHero
        index={`04.${String(position).padStart(2, '0')}`}
        eyebrow={`${command.category} command`}
        title={<span className="font-mono text-brand">{command.name}</span>}
        titleFontSize={heroTitleFontSize(command.name, { mono: true })}
        description={command.summary}
        aside={
          <div className="flex flex-wrap gap-2">
            <span className="rounded-full border border-line bg-card px-3 py-1.5 font-mono text-xs font-black uppercase text-faint">
              {command.origin}
            </span>
            <span className="rounded-full border border-line bg-card px-3 py-1.5 font-mono text-xs font-black uppercase text-faint">
              REPL + TUI
            </span>
          </div>
        }
      />

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-32">
        <SectionIntro
          index="01"
          eyebrow="Purpose"
          title={`What ${command.name} is for`}
          description={purpose}
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-[1fr_.72fr]">
          <article className="rounded-2xl border border-line bg-card p-6 sm:p-8">
            <Command className="size-5 text-brand" />
            <h2 className="mt-8 text-2xl font-black tracking-[-0.04em] text-fg">Behavior</h2>
            <p className="mt-4 text-base leading-8 text-muted">{behavior}</p>
            {!detail && (
              <p className="mt-4 text-sm leading-7 text-muted">
                The REPL parses the command name before a provider request is built. It dispatches
                through the shared slash-command registry, so the same behavior is available from
                the plain REPL and command-aware TUI surfaces.
              </p>
            )}
            {command.note && (
              <div className="mt-6 rounded-xl border border-brand/15 bg-brand/5 p-4 text-sm leading-6 text-muted">
                {command.note}
              </div>
            )}
            {deepGuide && (
              <Link
                href={deepGuide.href}
                className="group mt-6 inline-flex items-center gap-2 text-sm font-black text-brand"
              >
                {deepGuide.label}
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
              </Link>
            )}
          </article>
          <aside className="overflow-hidden rounded-2xl border border-line bg-ink text-zinc-300">
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
              <span className="font-mono text-xs font-black uppercase tracking-[0.16em] text-zinc-500">
                Quick reference
              </span>
              <Terminal className="size-4 text-brand" />
            </div>
            {[
              ['Command', command.name],
              ['Category', command.category],
              ['Owner', command.origin],
              ['Index', `${position} / ${commands.length}`],
            ].map(([label, value]) => (
              <div
                key={label}
                className="grid grid-cols-[90px_1fr] border-b border-white/10 px-5 py-4 last:border-b-0"
              >
                <span className="text-xs text-zinc-600">{label}</span>
                <code className="font-mono text-xs text-zinc-300">{value}</code>
              </div>
            ))}
          </aside>
        </div>
      </section>

      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="02"
            eyebrow="Usage"
            title="Start with the smallest useful invocation."
            description="Copy any example below. Use the built-in help command whenever you need the live version's exact subcommands and argument shape."
          />
          <div className="mt-12 overflow-hidden rounded-2xl border border-line bg-ink">
            {examples.map((example, index) => (
              <div
                key={example}
                className="group flex items-center gap-4 border-b border-white/10 px-5 py-5 last:border-b-0 sm:px-7"
              >
                <span className="font-mono text-brand">❯</span>
                <code className="min-w-0 flex-1 overflow-x-auto font-mono text-sm text-zinc-200">
                  {example}
                </code>
                <button
                  type="button"
                  onClick={() => copy(example)}
                  className="grid size-8 shrink-0 place-items-center rounded-full text-zinc-600 hover:bg-white/5 hover:text-white"
                  aria-label={copied === example ? 'Copied' : `Copy ${example}`}
                >
                  {copied === example ? (
                    <Check className="size-3.5 text-emerald-500" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                </button>
                <span className="hidden font-mono text-xs text-zinc-700 sm:block">
                  0{index + 1}
                </span>
              </div>
            ))}
          </div>
          {copied && (
            <p className="mt-3 text-right text-xs font-semibold text-emerald-500">
              Copied to clipboard.
            </p>
          )}
        </div>
      </section>

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="03"
          eyebrow="Operating pattern"
          title="Before, during and after the command."
        />
        <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-3">
          {[
            ['Before', before],
            ['During', during],
            ['After', after],
          ].map(([label, body], index) => (
            <article key={label} className="bg-card p-7">
              <span className="font-mono text-xs font-black text-brand-2">0{index + 1}</span>
              <h2 className="mt-8 text-xl font-black text-fg">{label}</h2>
              <p className="mt-3 text-sm leading-7 text-muted">{body}</p>
            </article>
          ))}
        </div>
        <div className="mt-6 flex items-start gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-5">
          <Check className="mt-0.5 size-4 shrink-0 text-emerald-500" />
          <p className="text-sm leading-6 text-muted">
            <strong className="text-fg">Live help is authoritative:</strong> run{' '}
            <code className="font-mono text-xs text-brand">/help {command.name.slice(1)}</code> to
            see the exact command contract installed in your current version.
          </p>
        </div>
      </section>

      <section className="border-t border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 lg:px-10">
          <div className="flex items-center gap-3">
            <Layers3 className="size-5 text-brand" />
            <h2 className="text-2xl font-black tracking-[-0.04em] text-fg">
              Related {command.category.toLowerCase()} commands
            </h2>
          </div>
          <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {related.map((item) => (
              <Link
                key={item.name}
                href={`/commands/${commandSlug(item.name)}`}
                className="group rounded-xl border border-line bg-card p-4 hover:border-brand"
              >
                <code className="font-mono text-sm font-black text-brand">{item.name}</code>
                <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted">{item.summary}</p>
                <ArrowRight className="mt-5 size-3.5 text-faint transition-transform group-hover:translate-x-1 group-hover:text-brand" />
              </Link>
            ))}
          </div>
          <div className="mt-8">
            <ExternalDoc path="docs/slash/README.md">
              Open the canonical slash-command index
            </ExternalDoc>
          </div>
        </div>
      </section>
      <PageNext
        label="Command atlas"
        title={`Browse all ${commands.length} commands`}
        body="Search by intent, filter by category and open another dedicated reference page."
        href="/commands"
      />
    </>
  );
}

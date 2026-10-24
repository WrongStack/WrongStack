import type { Plugin } from '@wrongstack/contracts/types/plugin';
import type { PromptEntry, PromptLoader } from '@wrongstack/contracts/types/prompt';
import type { SlashCommand } from '@wrongstack/contracts/types/slash-command';
import { DefaultPromptLoader, renderPrompt } from '../execution/prompt-loader.js';
import { DefaultPromptStore } from '../storage/prompt-store.js';
import { PromptUsageStore } from '../storage/prompt-usage-store.js';
import type { WstackPaths } from '../utils/wstack-paths.js';
import { buildProofDrivenHuntCommands, PROOF_DRIVEN_HUNT_SPECS } from './hunt-commands.js';
import { buildPerfCommand } from './perf-command.js';
import { buildPromptsCommand, dim, formatPrompt, unquote } from './prompts-command.js';

interface PromptsPluginOptions {
  store?: DefaultPromptStore | undefined;
  loader?: PromptLoader | undefined;
  usage?: PromptUsageStore | undefined;
  paths?: WstackPaths | undefined;
}

/**
 * PromptsPlugin — built-in prompt library.
 *
 * Registers slash commands:
 *   - `/prompts`     manage your library (list/view/add/edit/delete/favorite/extend)
 *   - `/prompt`      search the merged library (builtin + user + project) and insert
 *   - `/prompt-gen`  AI-guided authoring of a new high-quality prompt
 *   - `/bughunt`     run one Proof-Driven Bug Hunter round
 *   - `/perf`        run one measure-change-measure performance ratchet round
 *   - `/sechunt`     run one Proof-Driven Security Hardener round
 *   - `/racehunt`    run one Proof-Driven Race & Leak Hunter round
 *   - `/debloat`     run one Proof-Driven Dead-Code & Bloat Excisor round
 *   - `/uipolish`    run one Proof-Driven UI & Accessibility Ratchet round
 *   - `/typehunt`    run one Proof-Driven Type & Boundary Guard round
 *   - `/testgap`     run one Proof-Driven Blind-Spot & Invariant Tester round
 *
 * Active by default for all WrongStack sessions. The host injects a
 * `PromptLoader` (cross-layer read + copy-on-write) via `config.promptLoader`;
 * without one the commands degrade to the writable user store only.
 */
export function createPromptsPlugin(opts?: PromptsPluginOptions): Plugin {
  let store: DefaultPromptStore | null = null;
  let loader: PromptLoader | null = null;
  let usage: PromptUsageStore | null = null;

  return {
    name: 'wstack-prompts',
    version: '1.0.0',
    description: 'Prompt library with 100+ builtin prompts, search, and AI authoring',
    apiVersion: '^0.1',
    capabilities: { slashCommands: true, llm: true },
    defaultConfig: {},

    setup(api) {
      const rawConfig = api.config as never as Record<string, unknown>;
      const paths = opts?.paths ?? (rawConfig['paths'] as WstackPaths | undefined);
      store = opts?.store ?? (paths ? new DefaultPromptStore(paths) : null);
      loader =
        opts?.loader ??
        (rawConfig['promptLoader'] as PromptLoader | undefined) ??
        (paths
          ? new DefaultPromptLoader({
              paths,
              bundledDir: rawConfig['bundledPromptsDir'] as string | undefined,
            })
          : null);

      usage = opts?.usage ?? (paths ? new PromptUsageStore(paths.promptUsage) : null);

      api.slashCommands.register(
        buildPromptsCommand(
          () => store,
          () => loader,
          () => api.llm,
        ),
      );
      api.slashCommands.register(
        buildPromptSearchCommand(
          () => loader,
          () => usage,
        ),
      );
      api.slashCommands.register(buildPromptGenCommand(() => loader));
      const huntCommands = buildProofDrivenHuntCommands(
        () => loader,
        () => usage,
      );
      const [bugHuntCommand, ...extraHuntCommands] = huntCommands;
      if (bugHuntCommand) api.slashCommands.register(bugHuntCommand);
      api.slashCommands.register(
        buildPerfCommand(
          () => loader,
          () => usage,
        ),
      );
      for (const cmd of extraHuntCommands) {
        api.slashCommands.register(cmd);
      }
      const huntNames = PROOF_DRIVEN_HUNT_SPECS.map((s) => `/${s.name}`).join(', ');
      api.log.info(
        `[prompts] loaded — /prompts, /prompt, /prompt-gen, ${huntNames}, /perf available`,
      );
    },

    teardown(api) {
      api.slashCommands.unregister('prompts');
      api.slashCommands.unregister('prompt');
      api.slashCommands.unregister('prompt-gen');
      for (const spec of PROOF_DRIVEN_HUNT_SPECS) {
        api.slashCommands.unregister(spec.name);
      }
      api.slashCommands.unregister('perf');
      api.log.info('[prompts] unloaded');
    },

    async health() {
      return { ok: true, message: 'Prompt store accessible' };
    },
  };
}

// ── /prompt — search the merged library and insert ────────────────────────────

function buildPromptSearchCommand(
  getLoader: () => PromptLoader | null,
  getUsage: () => PromptUsageStore | null,
): SlashCommand {
  return {
    name: 'prompt',
    description:
      'Search the prompt library and insert one: /prompt <query> | /prompt insert <slug>',
    argsHint: '<query> | insert <slug> [var=value …] | recent | favorites',
    async run(args: string) {
      const loader = getLoader();
      if (!loader) return { message: 'Prompt library not available.' };
      const trimmed = args.trim();

      // /prompt insert <slug> [k=v ...]
      if (trimmed.startsWith('insert ') || trimmed.startsWith('use ')) {
        const rest = trimmed.slice(trimmed.indexOf(' ') + 1).trim();
        // Quote-aware: `topic="error handling"` is one token, which `unquote`
        // then strips; a plain whitespace split cut it into `topic="error`.
        const [slug, ...kvs] = rest.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
        if (!slug) return { message: 'Usage: /prompt insert <slug> [var=value …]' };
        const entry = await loader.find(slug);
        if (!entry) return { message: `No prompt with slug/id "${slug}". Try /prompt ${slug}` };
        const levelArg = kvs.find((kv) => kv.startsWith('--level='))?.slice('--level='.length);
        if (
          levelArg !== undefined &&
          levelArg !== 'simple' &&
          levelArg !== 'detailed' &&
          levelArg !== 'advanced'
        ) {
          return { message: 'Invalid detail level. Use --level=simple|detailed|advanced.' };
        }
        const values = parseKeyValues(kvs.filter((kv) => !kv.startsWith('--level=')));
        const { text, missing, invalid } = renderPrompt(entry, values, levelArg || undefined);
        if (invalid.length > 0) {
          const hint = (entry.variables ?? [])
            .filter((v) => invalid.includes(v.name))
            .map((v) => `  ${v.name}: one of ${(v.enum ?? []).join(' | ')}`)
            .join('\n');
          return {
            message: `"${entry.title}" got an out-of-range value for: ${invalid.join(', ')}\n${hint}`,
          };
        }
        if (missing.length > 0) {
          const hint = (entry.variables ?? [])
            .filter((v) => missing.includes(v.name))
            .map((v) => {
              const opts = v.enum && v.enum.length > 0 ? `  [${v.enum.join(' | ')}]` : '';
              return `  ${v.name}=…${v.description ? `  (${v.description})` : ''}${opts}`;
            })
            .join('\n');
          return {
            message: `"${entry.title}" needs values for: ${missing.join(', ')}\n${hint}\n\nRe-run: /prompt insert ${entry.slug} ${missing.map((m) => `${m}=…`).join(' ')}`,
          };
        }
        // Record usage (best-effort) then inject the rendered prompt as the next turn.
        try {
          await getUsage()?.record(entry.slug);
        } catch {
          // usage tracking is non-essential
        }
        return { message: `Inserted "${entry.title}".`, runText: text };
      }

      // /prompt recent — most-recently-inserted prompts
      if (trimmed === 'recent' || trimmed === 'popular') {
        const u = getUsage();
        if (!u) return { message: 'Usage tracking not available.' };
        const top = trimmed === 'popular' ? await u.top(15) : await u.recent(15);
        if (top.length === 0) {
          return { message: 'No prompt usage yet. Insert one with /prompt insert <slug>.' };
        }
        const lines: string[] = [];
        for (const { slug, usage } of top) {
          const e = await loader.find(slug);
          const title = e?.title ?? slug;
          lines.push(
            `  ${e ? sourceGlyph(e) : '•'} ${title}  ${dim(slug)}  ${dim(`×${usage.count}`)}`,
          );
        }
        return {
          message: `${trimmed === 'popular' ? 'Most-used' : 'Recent'} prompts:\n${lines.join('\n')}\n\nInsert: /prompt insert <slug>`,
        };
      }

      // /prompt favorites — list starred prompts only
      if (trimmed === 'favorites' || trimmed === 'fav' || trimmed === 'starred') {
        const favs = (await loader.list()).filter((e) => e.favorite);
        if (favs.length === 0) {
          return { message: 'No favorites yet. Star one with /prompts favorite <slug>.' };
        }
        const lines = favs.map(
          (e) => `  ${sourceGlyph(e)} ★ ${e.title}  ${dim(e.slug)}  ${dim(`[${e.category}]`)}`,
        );
        return {
          message: `Favorites (${favs.length}):\n${lines.join('\n')}\n\nInsert: /prompt insert <slug>`,
        };
      }

      // /prompt  (no query) → overview
      if (!trimmed) {
        const cats = await loader.categories();
        const total = cats.reduce((n, c) => n + c.count, 0);
        const catLine = cats.map((c) => `${c.label} (${c.count})`).join(' · ');
        return {
          message: [
            `Prompt library: ${total} prompts.`,
            catLine,
            '',
            'Search: /prompt <query>   ·   Recent: /prompt recent   ·   Favorites: /prompt favorites   ·   Insert: /prompt insert <slug>',
          ].join('\n'),
        };
      }

      // /prompt <query> → ranked results
      const results = await loader.search(trimmed, { limit: 15 });
      if (results.length === 0) return { message: `No prompts matching "${trimmed}".` };
      const lines = results.map(
        (e) =>
          `  ${sourceGlyph(e)} ${e.favorite ? '★ ' : ''}${e.title}  ${dim(e.slug)}  ${dim(`[${e.category}]`)}\n     ${e.description}`,
      );
      return {
        message: `${results.length} match(es) for "${trimmed}":\n${lines.join('\n')}\n\nInsert: /prompt insert <slug>`,
      };
    },
  };
}

// ── /prompt-gen — AI-guided authoring ─────────────────────────────────────────

function buildPromptGenCommand(getLoader: () => PromptLoader | null): SlashCommand {
  return {
    name: 'prompt-gen',
    description: 'Create a new reusable prompt with AI guidance. The AI will interview you.',
    help: [
      '╔═══ Prompt Generator ═══╗',
      '',
      'Create a high-quality, reusable prompt with AI guidance.',
      '',
      'Usage:',
      '  /prompt-gen              Start AI-guided authoring',
      '  /prompt-gen list         List prompts in your library',
      '  /prompt-gen edit <slug>  View an existing prompt',
      '',
      'The AI asks about purpose, task and variables, drafts a strong',
      'prompt, then saves it via /prompts add.',
    ].join('\n'),
    async run(args: string) {
      const loader = getLoader();
      const trimmed = args.trim();

      if (trimmed === 'list' || trimmed === 'ls') {
        if (!loader) return { message: 'Prompt library not available.' };
        const all = await loader.list();
        if (all.length === 0) return { message: 'No prompts found.' };
        const lines = all.slice(0, 50).map((e) => `  ${sourceGlyph(e)} ${e.title}  ${dim(e.slug)}`);
        return { message: `Prompts (${all.length}):\n${lines.join('\n')}` };
      }

      if (trimmed.startsWith('edit ') || trimmed.startsWith('view ')) {
        if (!loader) return { message: 'Prompt library not available.' };
        const slug = trimmed.slice(trimmed.indexOf(' ') + 1).trim();
        const entry = await loader.find(slug);
        if (!entry) return { message: `Prompt "${slug}" not found.` };
        return { message: formatPrompt(entry) };
      }

      // AI-guided creation — drive the agent with runText.
      return {
        message:
          '╔═══ Prompt Generator ═══╗\n\nThe AI will guide you through creating a new prompt.\nAnswer its questions naturally.',
        runText: [
          'I want to create a new reusable prompt for my prompt library.',
          'Read the `prompt-engineering` skill and use it as your playbook.',
          'Interview me ONE question at a time to elicit:',
          '  1. the purpose and the exact task the prompt should accomplish,',
          '  2. the inputs that change each time (these become {{variables}}),',
          '  3. the desired output format and tone.',
          'Then draft a high-quality prompt that uses {{double-brace}} placeholders for the variables.',
          'Show me the draft for approval, then SAVE it by calling:',
          '  /prompts add --category <category> --description "<one-line summary>" --tags <comma,separated> --var <name:description> "<Title>" "<prompt content>"',
          'Pick the best-fitting category from: coding, debugging, refactoring, testing, code-review, architecture, devops, documentation, data-analysis, writing, research, product, agentic-workflows, meta-prompting.',
        ].join('\n'),
      };
    },
  };
}

function sourceGlyph(e: PromptEntry): string {
  return e.source === 'project'
    ? '📁'
    : e.source === 'user'
      ? '👤'
      : e.source === 'synced'
        ? '☁'
        : '📦';
}

function parseKeyValues(kvs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of kvs) {
    const eq = kv.indexOf('=');
    if (eq > 0) out[kv.slice(0, eq)] = unquote(kv.slice(eq + 1));
  }
  return out;
}

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DefaultPromptLoader, renderPrompt } from '../execution/prompt-loader.js';
import { DefaultPromptStore, migratePromptEntry } from '../storage/prompt-store.js';
import { PromptUsageStore } from '../storage/prompt-usage-store.js';
import type { PromptEntry, PromptLoader, PromptVariable } from '../types/prompt.js';
import type { WstackPaths } from '../utils/wstack-paths.js';
import { expectDefined } from '../utils/expect-defined.js';
import {
  readBundledInstructionText,
  renderInstructionTemplate,
} from '../utils/instruction-file.js';
import type { Plugin } from '../types/plugin.js';
import type { SlashCommand, Context } from '../index.js';

interface PromptsPluginOptions {
  store?: DefaultPromptStore | undefined;
  loader?: PromptLoader | undefined;
  usage?: PromptUsageStore | undefined;
  paths?: WstackPaths | undefined;
}

/**
 * PromptsPlugin — built-in prompt library.
 *
 * Registers three slash commands:
 *   - `/prompts`     manage your library (list/view/add/edit/delete/favorite/extend)
 *   - `/prompt`      search the merged library (builtin + user + project) and insert
 *   - `/prompt-gen`  AI-guided authoring of a new high-quality prompt
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

      api.slashCommands.register(buildPromptsCommand(() => store, () => loader, () => api.llm));
      api.slashCommands.register(buildPromptSearchCommand(() => loader, () => usage));
      api.slashCommands.register(buildPromptGenCommand(() => loader));
      api.log.info('[prompts] loaded — /prompts, /prompt, /prompt-gen available');
    },

    teardown(api) {
      api.slashCommands.unregister('prompts');
      api.slashCommands.unregister('prompt');
      api.slashCommands.unregister('prompt-gen');
      api.log.info('[prompts] unloaded');
    },

    async health() {
      return { ok: true, message: 'Prompt store accessible' };
    },
  };
}

// ── /prompts — library manager ────────────────────────────────────────────────

function buildPromptsCommand(
  getStore: () => DefaultPromptStore | null,
  getLoader: () => PromptLoader | null,
  getLlm: () => import('../types/plugin.js').PluginLLM | undefined,
): SlashCommand {
  return {
    name: 'prompts',
    description:
      'Manage your prompt library: /prompts [list|view|add|edit|delete|favorite|extend]',
    async run(args: string, ctx: Context) {
      const store = getStore();
      const loader = getLoader();
      if (!store) return { message: 'Prompt store not available.' };

      const [verb, ...rest] = args.trim().split(/\s+/);
      const restJoined = rest.join(' ');

      switch (verb) {
        case '':
        case 'list':
        case 'ls': {
          const entries = await store.list();
          if (entries.length === 0) {
            return { message: 'Prompt library empty. Add: /prompts add "title" "content"' };
          }
          const lines = entries.map(
            (e) => `  ${e.favorite ? '★ ' : ''}${e.title}  ${dim(e.id)}  ${e.tags.join(', ') || ''}`,
          );
          return { message: `Prompt library (${entries.length}):\n${lines.join('\n')}\n` };
        }

        case 'view':
        case 'show': {
          if (!restJoined) return { message: 'Usage: /prompts view <title>' };
          const matches = await store.find(restJoined);
          if (matches.length === 0) return { message: `No prompt matching "${restJoined}".` };
          const entry =
            matches.find((m) => m.title.toLowerCase() === restJoined.toLowerCase()) ??
            expectDefined(matches[0]);
          return { message: formatPrompt(entry) };
        }

        case 'add':
        case 'new': {
          const { flags, positional } = parseFlags(restJoined);
          const parsed = parseTitleContent(positional);
          if (!parsed.title) return { message: 'Usage: /prompts add "title" "prompt content"' };
          const category = flags['category'] ?? flags['cat'];
          const variables = parseVarFlags(flags['var']);
          const entry = store.createNew(parsed.title, parsed.content, parseTags(flags['tags']), {
            description: flags['description'] ?? flags['desc'] ?? '',
            ...(category ? { category } : {}),
            ...(variables ? { variables } : {}),
          });
          await store.save(entry);
          getLoader()?.invalidateCache();
          return { message: `Added prompt "${entry.title}" (${entry.slug}).` };
        }

        case 'delete':
        case 'rm': {
          if (!restJoined) return { message: 'Usage: /prompts delete <title>' };
          const matches = await store.find(restJoined);
          if (matches.length === 0) return { message: `No prompt matching "${restJoined}".` };
          const exact =
            matches.find((m) => m.title.toLowerCase() === restJoined.toLowerCase()) ??
            expectDefined(matches[0]);
          const deleted = await store.delete(exact.id);
          getLoader()?.invalidateCache();
          return { message: deleted ? `Deleted "${exact.title}".` : 'Delete failed.' };
        }

        case 'edit':
        case 'update': {
          const parsed = parseTitleContent(restJoined);
          if (!parsed.title) return { message: 'Usage: /prompts edit "title" "new content"' };
          const matches = await store.find(parsed.title);
          if (matches.length === 0) return { message: `No prompt matching "${parsed.title}".` };
          const exact =
            matches.find((m) => m.title.toLowerCase() === parsed.title?.toLowerCase()) ??
            expectDefined(matches[0]);
          exact.content = parsed.content;
          exact.updatedAt = new Date().toISOString();
          await store.save(exact);
          getLoader()?.invalidateCache();
          return { message: `Updated "${exact.title}".` };
        }

        case 'favorite':
        case 'star': {
          if (!restJoined) return { message: 'Usage: /prompts favorite <slug-or-title>' };
          // Prefer the loader so favoriting a builtin copies it into the user layer.
          if (loader) {
            const updated = await loader.setFavorite(restJoined, true);
            if (!updated) return { message: `No prompt matching "${restJoined}".` };
            return { message: `★ Favorited "${updated.title}" (${updated.slug}).` };
          }
          const matches = await store.find(restJoined);
          if (matches.length === 0) return { message: `No prompt matching "${restJoined}".` };
          const exact = expectDefined(matches[0]);
          exact.favorite = true;
          exact.updatedAt = new Date().toISOString();
          await store.save(exact);
          return { message: `★ Favorited "${exact.title}".` };
        }

        case 'extend': {
          if (!restJoined) return { message: 'Usage: /prompts extend "title" <instructions>' };
          const parsed = parseTitleContent(restJoined);
          if (!parsed.title) return { message: 'Usage: /prompts extend "title" <instructions>' };
          const matches = await store.find(parsed.title);
          if (matches.length === 0) return { message: `No prompt matching "${parsed.title}".` };
          const exact =
            matches.find((m) => m.title.toLowerCase() === parsed.title?.toLowerCase()) ??
            expectDefined(matches[0]);

          const llm = getLlm();
          if (!llm) return { message: 'LLM not available. Configure a provider first.' };

          let enhanced: Awaited<ReturnType<typeof llm.complete>>;
          try {
            enhanced = await llm.complete(
              renderInstructionTemplate(readBundledInstructionText('llm/prompt-extend.md'), {
                existingPrompt: exact.content,
                additionalInstructions: parsed.content,
              }),
              {
                system: 'You improve reusable prompts while preserving their intent and variables.',
                role: 'prompt-refiner',
                maxTokens: 2_048,
              },
            );
          } catch {
            return { message: 'LLM enhancement failed. The saved prompt was not changed.' };
          }

          exact.content = enhanced.text.trim();
          exact.updatedAt = new Date().toISOString();
          await store.save(exact);
          getLoader()?.invalidateCache();
          return { message: `Extended "${exact.title}".\n\n${dim('New content:')}\n${exact.content}` };
        }

        case 'export': {
          if (!loader) return { message: 'Prompt library not available.' };
          // Export only user-authored prompts (builtins are shipped already).
          const own = (await loader.list()).filter((e) => e.source !== 'builtin');
          if (own.length === 0) {
            return { message: 'No user prompts to export. (Builtin prompts ship with WrongStack.)' };
          }
          const target = resolveIoPath(restJoined || 'wrongstack-prompts.json', ctx);
          const payload = JSON.stringify(
            { version: 2, exportedAt: new Date().toISOString(), prompts: own },
            null,
            2,
          );
          try {
            await fs.writeFile(target, payload, 'utf8');
            return { message: `Exported ${own.length} prompt(s) → ${target}` };
          } catch (err) {
            return { message: `Export failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        }

        case 'import': {
          if (!loader) return { message: 'Prompt library not available.' };
          if (!restJoined) return { message: 'Usage: /prompts import <path-to.json>' };
          const src = resolveIoPath(restJoined, ctx);
          let raw: unknown;
          try {
            raw = JSON.parse(await fs.readFile(src, 'utf8'));
          } catch (err) {
            return { message: `Import failed: ${err instanceof Error ? err.message : String(err)}` };
          }
          const list = Array.isArray(raw)
            ? raw
            : Array.isArray((raw as { prompts?: unknown }).prompts)
              ? (raw as { prompts: unknown[] }).prompts
              : null;
          if (!list) return { message: 'Import failed: expected a JSON array or { prompts: [...] }.' };

          let imported = 0;
          let skipped = 0;
          for (const item of list) {
            const entry = migratePromptEntry(item);
            if (!entry) {
              skipped++;
              continue;
            }
            entry.source = 'user';
            entry.updatedAt = new Date().toISOString();
            // Overwrite an existing same-slug user/project prompt in place.
            const existing = await loader.find(entry.slug);
            if (existing && existing.source !== 'builtin') entry.id = existing.id;
            await loader.save(entry);
            imported++;
          }
          return {
            message: `Imported ${imported} prompt(s)${skipped ? ` (${skipped} skipped — invalid)` : ''} from ${src}.`,
          };
        }

        default:
          return {
            message: `Unknown subcommand "${verb}". Try: list | view | add | edit | delete | favorite | export | import | extend`,
          };
      }
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
    description: 'Search the prompt library and insert one: /prompt <query> | /prompt insert <slug>',
    argsHint: '<query> | insert <slug> [var=value …] | recent | favorites',
    async run(args: string) {
      const loader = getLoader();
      if (!loader) return { message: 'Prompt library not available.' };
      const trimmed = args.trim();

      // /prompt insert <slug> [k=v ...]
      if (trimmed.startsWith('insert ') || trimmed.startsWith('use ')) {
        const rest = trimmed.slice(trimmed.indexOf(' ') + 1).trim();
        const [slug, ...kvs] = rest.split(/\s+/);
        if (!slug) return { message: 'Usage: /prompt insert <slug> [var=value …]' };
        const entry = await loader.find(slug);
        if (!entry) return { message: `No prompt with slug/id "${slug}". Try /prompt ${slug}` };
        const values = parseKeyValues(kvs);
        const { text, missing, invalid } = renderPrompt(entry, values);
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
          lines.push(`  ${e ? sourceGlyph(e) : '•'} ${title}  ${dim(slug)}  ${dim(`×${usage.count}`)}`);
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
        return { message: `Favorites (${favs.length}):\n${lines.join('\n')}\n\nInsert: /prompt insert <slug>` };
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
        const lines = all
          .slice(0, 50)
          .map((e) => `  ${sourceGlyph(e)} ${e.title}  ${dim(e.slug)}`);
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

// ── helpers ───────────────────────────────────────────────────────────────────

function formatPrompt(entry: PromptEntry): string {
  const tags = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
  const vars =
    entry.variables && entry.variables.length > 0
      ? `\n\nVariables: ${entry.variables.map((v) => `{{${v.name}}}${v.required ? '*' : ''}`).join(', ')}`
      : '';
  return [
    `# ${entry.title}${tags}`,
    entry.description ? `\n${entry.description}` : '',
    `\n${entry.content}${vars}`,
    `\n${dim(`slug: ${entry.slug} | category: ${entry.category} | source: ${entry.source}`)}`,
  ].join('\n');
}

/** Resolve a user-supplied export/import path against the project root (or cwd). */
function resolveIoPath(p: string, ctx: Context): string {
  const cleaned = p.trim().replace(/^["']|["']$/g, '');
  if (path.isAbsolute(cleaned)) return cleaned;
  const base = (ctx as { projectRoot?: string }).projectRoot ?? process.cwd();
  return path.resolve(base, cleaned);
}

function sourceGlyph(e: PromptEntry): string {
  return e.source === 'project' ? '📁' : e.source === 'user' ? '👤' : e.source === 'synced' ? '☁' : '📦';
}

/** Parse leading `--flag value` / `--flag=value` pairs; return the rest as positional. */
function parseFlags(input: string): { flags: Record<string, string>; positional: string } {
  const flags: Record<string, string> = {};
  let s = input.trim();
  // Repeatedly consume a leading --flag (with =value, "quoted value", or bare token).
  const flagRe = /^--([a-zA-Z][\w-]*)(?:=("[^"]*"|'[^']*'|\S+)|\s+("[^"]*"|'[^']*'|\S+))?\s*/;
  let m: RegExpExecArray | null;
  // Only consume flags while the string still starts with `--`.
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic RegExp.exec loop
  while (s.startsWith('--') && (m = flagRe.exec(s))) {
    const name = expectDefined(m[1]);
    const rawVal = m[2] ?? m[3] ?? 'true';
    flags[name] = unquote(rawVal);
    s = s.slice(m[0].length);
  }
  return { flags, positional: s.trim() };
}

function unquote(v: string): string {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function parseTags(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * `--var name:description` may repeat; we accept a comma-separated list too.
 * An optional `::meta` suffix declares richness: `::multiline` for a textarea
 * hint and `::enum=a|b|c` for a closed value set. Examples:
 *   name:What it does
 *   code:Paste the snippet::multiline
 *   flavor:Regex flavor::enum=PCRE|JS|Python
 */
function parseVarFlags(raw: string | undefined): PromptVariable[] | undefined {
  if (!raw) return undefined;
  const out: PromptVariable[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    // Split the optional `::meta` tail off first so a `:` in the description
    // (before `::`) still parses as part of the description.
    const metaAt = trimmed.indexOf('::');
    const head = metaAt === -1 ? trimmed : trimmed.slice(0, metaAt).trim();
    const meta = metaAt === -1 ? '' : trimmed.slice(metaAt + 2).trim();
    const colon = head.indexOf(':');
    const name = colon === -1 ? head : head.slice(0, colon).trim();
    const description = colon === -1 ? undefined : head.slice(colon + 1).trim();
    if (!name) continue;
    const v: PromptVariable = { name, description, required: true };
    for (const token of meta.split('::').map((t) => t.trim()).filter(Boolean)) {
      if (token === 'multiline') v.multiline = true;
      else if (token.startsWith('enum=')) {
        const opts = token
          .slice(5)
          .split('|')
          .map((o) => o.trim())
          .filter(Boolean);
        if (opts.length > 0) v.enum = opts;
      }
    }
    out.push(v);
  }
  return out.length > 0 ? out : undefined;
}

function parseKeyValues(kvs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of kvs) {
    const eq = kv.indexOf('=');
    if (eq > 0) out[kv.slice(0, eq)] = unquote(kv.slice(eq + 1));
  }
  return out;
}

function parseTitleContent(args: string): { title: string; content: string } {
  const trimmed = args.trim();
  if (!trimmed) return { title: '', content: '' };
  const doubleMatch =
    /^"([^"]+)"\s+"([^"]+)"$/.exec(trimmed) || /^'([^']+)'\s+'([^']+)'$/.exec(trimmed);
  if (doubleMatch)
    return { title: expectDefined(doubleMatch[1]), content: expectDefined(doubleMatch[2]) };
  const quotedTitleMatch = /^"([^"]+)"\s+(.+)$/.exec(trimmed) || /^'([^']+)'\s+(.+)$/.exec(trimmed);
  if (quotedTitleMatch)
    return { title: expectDefined(quotedTitleMatch[1]), content: expectDefined(quotedTitleMatch[2]) };
  const firstSpace = trimmed.indexOf(' ');
  if (firstSpace === -1) return { title: trimmed, content: '' };
  return { title: trimmed.slice(0, firstSpace), content: trimmed.slice(firstSpace + 1) };
}

function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}

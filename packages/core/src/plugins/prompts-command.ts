import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PromptEntry, PromptLoader, PromptVariable } from '@wrongstack/contracts/types/prompt';
import type { SlashCommand } from '@wrongstack/contracts/types/slash-command';
import type { Context } from '../core/context.js';
import { type DefaultPromptStore, migratePromptEntry } from '../storage/prompt-store.js';
import { toErrorMessage } from '../utils/error.js';
import { expectDefined } from '../utils/expect-defined.js';
import {
  readBundledInstructionText,
  renderInstructionTemplate,
} from '../utils/instruction-file.js';

// ── /prompts — library manager ────────────────────────────────────────────────

export function buildPromptsCommand(
  getStore: () => DefaultPromptStore | null,
  getLoader: () => PromptLoader | null,
  getLlm: () => import('@wrongstack/contracts/types/plugin').PluginLLM | undefined,
): SlashCommand {
  return {
    name: 'prompts',
    description: 'Manage your prompt library: /prompts [list|view|add|edit|delete|favorite|extend]',
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
            (e) =>
              `  ${e.favorite ? '★ ' : ''}${e.title}  ${dim(e.id)}  ${e.tags.join(', ') || ''}`,
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
              },
            );
          } catch {
            return { message: 'LLM enhancement failed. The saved prompt was not changed.' };
          }

          exact.content = enhanced.text.trim();
          exact.updatedAt = new Date().toISOString();
          await store.save(exact);
          getLoader()?.invalidateCache();
          return {
            message: `Extended "${exact.title}".\n\n${dim('New content:')}\n${exact.content}`,
          };
        }

        case 'export': {
          if (!loader) return { message: 'Prompt library not available.' };
          // Export only user-authored prompts (builtins are shipped already).
          const own = (await loader.list()).filter((e) => e.source !== 'builtin');
          if (own.length === 0) {
            return {
              message: 'No user prompts to export. (Builtin prompts ship with WrongStack.)',
            };
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
            return {
              message: `Export failed: ${toErrorMessage(err)}`,
            };
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
            return {
              message: `Import failed: ${toErrorMessage(err)}`,
            };
          }
          const list = Array.isArray(raw)
            ? raw
            : Array.isArray((raw as { prompts?: unknown }).prompts)
              ? (raw as { prompts: unknown[] }).prompts
              : null;
          if (!list)
            return { message: 'Import failed: expected a JSON array or { prompts: [...] }.' };

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

// ── helpers ───────────────────────────────────────────────────────────────────

export function formatPrompt(entry: PromptEntry): string {
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

export function unquote(v: string): string {
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
    for (const token of meta
      .split('::')
      .map((t) => t.trim())
      .filter(Boolean)) {
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

function parseTitleContent(args: string): { title: string; content: string } {
  const trimmed = args.trim();
  if (!trimmed) return { title: '', content: '' };
  const doubleMatch =
    /^"([^"]+)"\s+"([^"]+)"$/.exec(trimmed) || /^'([^']+)'\s+'([^']+)'$/.exec(trimmed);
  if (doubleMatch)
    return { title: expectDefined(doubleMatch[1]), content: expectDefined(doubleMatch[2]) };
  const quotedTitleMatch = /^"([^"]+)"\s+(.+)$/.exec(trimmed) || /^'([^']+)'\s+(.+)$/.exec(trimmed);
  if (quotedTitleMatch)
    return {
      title: expectDefined(quotedTitleMatch[1]),
      content: expectDefined(quotedTitleMatch[2]),
    };
  const firstSpace = trimmed.indexOf(' ');
  if (firstSpace === -1) return { title: trimmed, content: '' };
  return { title: trimmed.slice(0, firstSpace), content: trimmed.slice(firstSpace + 1) };
}

export function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}

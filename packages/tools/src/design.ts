import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DesignStack, Tool } from '@wrongstack/core';
import {
  applyTokenOverrides,
  getDesignKitLoader,
  isDesignStack,
  loadActiveKit,
  materializeTokens,
  recordKitChoice,
  recordOverrides,
  setActiveKit,
  setDesignOverrides,
  verifyFiles,
} from '@wrongstack/core';

type Overrides = Record<string, string>;

interface DesignInput {
  action?: 'list' | 'use' | 'foundations' | 'set' | 'materialize' | 'verify' | undefined;
  kit?: string | undefined;
  stack?: string | undefined;
  /** action "set" / "use": token overrides, e.g. { primary: "oklch(...)", "dark.bg": "#111" }. */
  set?: Overrides | undefined;
  /** action "materialize": output path (project-relative); defaults per stack. */
  out?: string | undefined;
  /** action "materialize": overwrite an existing file. */
  force?: boolean | undefined;
  /** action "verify": explicit files to scan (project-relative). Defaults to a UI-file walk. */
  files?: string[] | undefined;
}

interface DesignOutput {
  action: string;
  kit?: string | undefined;
  stack?: string | undefined;
  output: string;
  /** action "materialize": where the theme file was (or would be) written. */
  path?: string | undefined;
  /** action "verify": adherence score 0..1 and violation count. */
  score?: number | undefined;
  violations?: number | undefined;
}

// Bounded UI-file walk for `verify` when no explicit files are given.
const UI_EXT_RE = /\.(css|scss|sass|less|tsx|jsx|vue|svelte|astro|html?)$/i;
const SKIP_DIR = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  '.wrongstack',
  '.design',
]);

async function walkUiFiles(root: string, max = 200): Promise<string[]> {
  const found: string[] = [];
  async function rec(dir: string, depth: number): Promise<void> {
    if (found.length >= max || depth > 8) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found.length >= max) return;
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name) || e.name.startsWith('.')) continue;
        await rec(path.join(dir, e.name), depth + 1);
      } else if (UI_EXT_RE.test(e.name)) {
        found.push(path.join(dir, e.name));
      }
    }
  }
  await rec(root, 0);
  return found;
}

function normalizeOverrides(set: unknown): Overrides {
  const out: Overrides = {};
  if (set && typeof set === 'object') {
    for (const [k, v] of Object.entries(set as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
  }
  return out;
}

/**
 * Design Studio tool — progressive disclosure + token enforcement.
 *
 * `list`/`use`/`foundations` browse and pin kits. `set` records structured color
 * overrides (these win over kit tokens). `materialize` writes the active kit's
 * (override-applied) tokens to a real, stack-appropriate theme file so the
 * palette becomes the codebase's source of truth — not just a prompt hint.
 * `verify` scans UI files for off-palette drift.
 */
export const designTool: Tool<DesignInput, DesignOutput> = {
  name: 'design',
  category: 'Design',
  description:
    'Browse, load, customize, and enforce curated frontend/mobile UI design kits. Use BEFORE writing ' +
    'UI code to commit to one coherent, modern, responsive, dark/light, accessible design. Actions: ' +
    '"list" (menu), "use" (load+pin a kit for a stack), "foundations" (baseline), "set" (override kit ' +
    'colors/tokens), "materialize" (write the tokens to a real theme file — CSS @theme/OKLCH or native), ' +
    '"verify" (scan UI files for off-palette colors).',
  usageHint:
    'Flow: `design {action:"use", kit:"minimal-clarity", stack:"web"}` → optionally ' +
    '`design {action:"set", set:{primary:"oklch(62% 0.2 25)"}}` → `design {action:"materialize"}` ' +
    'to write tokens to disk → implement against them → `design {action:"verify"}`.',
  permission: 'auto',
  mutating: false,
  capabilities: [],
  timeoutMs: 15_000,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'use', 'foundations', 'set', 'materialize', 'verify'],
        description:
          'list = menu; use = load+pin a kit; foundations = baseline; set = override colors/tokens; ' +
          'materialize = write tokens to a theme file; verify = scan UI for off-palette colors. Default: list.',
      },
      kit: {
        type: 'string',
        description: 'Kit id (required for "use"), e.g. "minimal-clarity", "neo-brutalist".',
      },
      stack: {
        type: 'string',
        enum: ['web', 'react-native', 'flutter', 'swiftui', 'compose'],
        description: 'Target stack — narrows guidance + materialize format. Default: web.',
      },
      set: {
        type: 'object',
        description:
          'Token overrides for "set"/"use": { "primary": "oklch(…)", "dark.bg": "#111" }. Bare key = ' +
          'both themes; "light."/"dark." prefix = that theme only. Empty value clears an override.',
        additionalProperties: { type: 'string' },
      },
      out: {
        type: 'string',
        description: 'Materialize output path (project-relative). Defaults to a per-stack convention.',
      },
      force: {
        type: 'boolean',
        description: 'Materialize: overwrite an existing file (default false — refuses to clobber).',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Verify: explicit project-relative files to scan. Default: a bounded UI-file walk.',
      },
    },
    required: [],
  },
  async execute(input, ctx): Promise<DesignOutput> {
    const loader = getDesignKitLoader(ctx.projectRoot);
    const action = input.action ?? 'list';
    const stack: DesignStack | undefined =
      input.stack && isDesignStack(input.stack) ? input.stack : undefined;

    if (action === 'foundations') {
      const text = await loader.foundationsText(stack);
      return { action, stack, output: text || 'No foundations document is installed.' };
    }

    if (action === 'use') {
      const kitId = input.kit?.trim();
      if (!kitId) {
        const menu = await loader.menuText();
        return { action, output: `No kit id provided.\n\n${menu}` };
      }
      const manifest = await loader.find(kitId);
      if (!manifest) {
        const menu = await loader.menuText();
        return { action, kit: kitId, output: `Kit "${kitId}" not found.\n\n${menu}` };
      }
      const resolvedStack = stack ?? manifest.stacks[0] ?? 'web';
      const body = await loader.readBody(manifest.id, resolvedStack);
      const rawTokens = await loader.readTokens(manifest.id);
      // Preserve any persisted overrides; merge in any passed with `use`.
      const persisted = await loadActiveKit(ctx.projectRoot);
      const keepOverrides =
        persisted?.kit === manifest.id ? (persisted.overrides ?? {}) : {};
      const overrides: Overrides = { ...keepOverrides, ...normalizeOverrides(input.set) };
      const tokens = rawTokens ? applyTokenOverrides(rawTokens, overrides) : rawTokens;

      setActiveKit(ctx, manifest.id, resolvedStack, overrides);
      await recordKitChoice(
        ctx.projectRoot,
        manifest.id,
        resolvedStack,
        'design-tool',
        new Date().toISOString(),
        Object.keys(overrides).length ? overrides : undefined,
      );

      const ovLine = Object.keys(overrides).length
        ? `\nActive color overrides: ${Object.entries(overrides)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')}\n`
        : '';
      const header =
        `# Active design kit: ${manifest.name} (${manifest.id}) — stack: ${resolvedStack}\n` +
        `${manifest.aesthetic}\n${ovLine}\n` +
        'Implement the UI faithfully to this spec. Keep light/dark, responsive, and WCAG AA.\n';
      const tokenBlock = tokens
        ? `\n## Token snapshot (overrides applied)\n\`\`\`json\n${JSON.stringify(tokens, null, 2)}\n\`\`\`\n` +
          'Tip: run `design {action:"materialize"}` to write these tokens to a real theme file.\n'
        : '';
      return {
        action,
        kit: manifest.id,
        stack: resolvedStack,
        output: `${header}${tokenBlock}\n${body}`,
      };
    }

    if (action === 'set') {
      const patch = normalizeOverrides(input.set);
      if (Object.keys(patch).length === 0) {
        return { action, output: 'No overrides given. Pass set:{ "primary": "oklch(…)" }.' };
      }
      const merged = await recordOverrides(ctx.projectRoot, patch, new Date().toISOString());
      if (!merged) {
        return {
          action,
          output: 'No active kit. Pick one first: `design {action:"use", kit:"<id>"}`.',
        };
      }
      setDesignOverrides(ctx, merged);
      return {
        action,
        output:
          `Overrides updated. Active overrides: ${Object.entries(merged)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')}\n` +
          'These win over kit tokens. Run `design {action:"materialize"}` to write them to a theme file.',
      };
    }

    if (action === 'materialize') {
      const active = await loadActiveKit(ctx.projectRoot);
      if (!active) {
        return {
          action,
          output: 'No active kit. Pick one first: `design {action:"use", kit:"<id>"}`.',
        };
      }
      const resolvedStack: DesignStack =
        stack ?? (active.stack && isDesignStack(active.stack) ? active.stack : 'web');
      const rawTokens = await loader.readTokens(active.kit);
      if (!rawTokens) {
        return { action, kit: active.kit, output: `Kit "${active.kit}" has no tokens.json.` };
      }
      const tokens = applyTokenOverrides(rawTokens, active.overrides);
      const result = materializeTokens({
        tokens,
        stack: resolvedStack,
        kitId: active.kit,
        outPath: input.out,
      });
      const abs = path.join(ctx.projectRoot, result.path);
      let exists = false;
      try {
        await fs.access(abs);
        exists = true;
      } catch {
        // does not exist — safe to write
      }
      if (exists && !input.force) {
        return {
          action,
          kit: active.kit,
          stack: resolvedStack,
          path: result.path,
          output:
            `${result.path} already exists. Re-run with force:true to overwrite, or write this ` +
            `${result.format} yourself:\n\n\`\`\`\n${result.content}\n\`\`\``,
        };
      }
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, result.content);
      return {
        action,
        kit: active.kit,
        stack: resolvedStack,
        path: result.path,
        output:
          `Wrote ${result.format} to ${result.path}. Import these tokens in your UI so the kit ` +
          `palette is the source of truth. ${exists ? '(overwrote existing file)' : ''}`,
      };
    }

    if (action === 'verify') {
      const active = await loadActiveKit(ctx.projectRoot);
      if (!active) {
        return {
          action,
          output: 'No active kit to verify against. Pick one: `design {action:"use", kit:"<id>"}`.',
        };
      }
      const rawTokens = await loader.readTokens(active.kit);
      if (!rawTokens) {
        return { action, kit: active.kit, output: `Kit "${active.kit}" has no tokens.json.` };
      }
      const tokens = applyTokenOverrides(rawTokens, active.overrides);
      const rels =
        input.files && input.files.length > 0
          ? input.files.map((f) => path.join(ctx.projectRoot, f))
          : await walkUiFiles(ctx.projectRoot);
      const files: { path: string; text: string }[] = [];
      for (const abs of rels) {
        try {
          files.push({ path: path.relative(ctx.projectRoot, abs), text: await fs.readFile(abs, 'utf8') });
        } catch {
          // unreadable — skip
        }
      }
      const report = verifyFiles(tokens, files);
      const pct = Math.round(report.score * 100);
      const top = report.violations
        .slice(0, 25)
        .map((v) => `  ${v.file}:${v.line} — ${v.reason}: ${v.snippet}`)
        .join('\n');
      const summary =
        `Adherence: ${pct}% on-palette across ${report.filesScanned} file(s). ` +
        `${report.violations.length} violation(s).` +
        (report.violations.length
          ? `\n${top}${report.violations.length > 25 ? `\n  …and ${report.violations.length - 25} more` : ''}` +
            `\n\nReplace off-palette colors with kit tokens (or the materialized CSS vars / token utilities).`
          : '\nNo off-palette colors found — UI adheres to the kit palette.');
      return {
        action,
        kit: active.kit,
        output: summary,
        score: report.score,
        violations: report.violations.length,
      };
    }

    // Default: list
    const menu = await loader.menuText();
    return {
      action: 'list',
      output:
        (menu || 'No design kits are installed.') +
        '\n\nLoad one with `design {action:"use", kit:"<id>", stack:"<stack>"}`.',
    };
  },
};

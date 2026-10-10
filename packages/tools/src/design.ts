import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DesignStack } from '@wrongstack/core/design';
import {
  applyTokenOverrides,
  captureProjectTokens,
  getDesignKitLoader,
  isDesignStack,
  kitContrastIssues,
  loadActiveKit,
  materializeTokens,
  recordKitChoice,
  recordOverrides,
  resolveSemanticTune,
  resolveVerifyTokens,
  runDesignVerify,
  saveCapturedTokens,
  type KitContrastIssue,
  type SemanticTune,
  setActiveKit,
  setDesignOverrides,
} from '@wrongstack/core/design';
import type { Tool } from '@wrongstack/core/types';
import { ToolValidationError } from '@wrongstack/core/types';
import { atomicWrite } from '@wrongstack/core/utils';

type Overrides = Record<string, string>;

const NO_ACTIVE_KIT = 'design: no active kit. Pick one first: `design {action:"use", kit:"<id>"}`.';

/**
 * Canonicalize `p` through `fs.realpath` so symlinks / bind mounts don't
 * hide out-of-root writes. Falls back to `path.resolve(p)` when the path
 * (or any of its parents) doesn't exist yet — callers frequently pass a
 * destination that the tool is about to write.
 */
async function resolveReal(p: string): Promise<string> {
  const resolved = path.resolve(p);
  let probe = resolved;
  const missing: string[] = [];
  for (;;) {
    try {
      return path.resolve(await fs.realpath(probe), ...missing);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        const parent = path.dirname(probe);
        if (parent === probe) return resolved; // reached fs root
        missing.unshift(path.basename(probe));
        probe = parent;
        continue;
      }
      // Any other error (EACCES, EBUSY, …) — fall back to the lexical
      // resolve rather than throwing, so the caller can still surface a
      // meaningful error from the path.relative check below.
      return resolved;
    }
  }
}

export interface DesignInput {
  action?:
    | 'list'
    | 'use'
    | 'foundations'
    | 'set'
    | 'tune'
    | 'materialize'
    | 'verify'
    | 'capture'
    | undefined;
  kit?: string | undefined;
  stack?: string | undefined;
  /** action "set" / "use": token overrides, e.g. { primary: "oklch(...)", "dark.bg": "#111" }. */
  set?: Overrides | undefined;
  /** action "tune": high-level knobs, e.g. { radius:"lg", density:"compact", font:"Space Grotesk" }. */
  tune?: SemanticTune | undefined;
  /** action "materialize": output path (project-relative); defaults per stack. */
  out?: string | undefined;
  /** action "materialize": overwrite an existing file. */
  force?: boolean | undefined;
  /** action "verify"/"capture": explicit files to scan/read (project-relative). Verify defaults to a UI-file walk; capture to conventional token-source paths. */
  files?: string | string[] | undefined;
}

export interface DesignOutput {
  action: string;
  kit?: string | undefined;
  stack?: string | undefined;
  output: string;
  /** action "materialize": where the theme file was (or would be) written. */
  path?: string | undefined;
  /** action "verify"/"capture": what the token basis was — 'kit' or 'captured'. */
  source?: string | undefined;
  /** action "verify": adherence score 0..1 and violation count. */
  score?: number | undefined;
  violations?: number | undefined;
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
 * Refuse a caller-supplied project-relative path that would escape the
 * project root (shared by verify's scan list and capture's source list).
 * Canonicalized through realpath so symlinks / bind mounts can't smuggle an
 * out-of-root path past the prefix check; `rel === '..'` / '..<sep>' prefix
 * (not bare startsWith) so in-root names like `..hidden` stay legal.
 */
async function assertProjectRelative(
  files: string[],
  projectRoot: string,
  label: string,
): Promise<void> {
  const root = await resolveReal(projectRoot);
  for (const f of files) {
    const absResolved = path.isAbsolute(f)
      ? path.resolve(f)
      : path.resolve(path.join(projectRoot, f));
    const absParent = await resolveReal(path.dirname(absResolved));
    const abs = path.join(absParent, path.basename(absResolved));
    const rel = path.relative(root, abs);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new ToolValidationError({
        message: `design: ${label} "${f}" would escape the project root`,
        field: 'files',
      });
    }
  }
}

/**
 * WCAG AA gate text: warns (never blocks) when a kit's readable-text pairs fall
 * below 4.5:1 in either theme. Empty string when the kit is clean.
 */
function contrastWarning(issues: KitContrastIssue[]): string {
  if (issues.length === 0) return '';
  const detail = issues.map((i) => `${i.theme} ${i.pair} = ${i.ratio.toFixed(2)}:1`).join(', ');
  return (
    `\n⚠️ WCAG AA contrast: ${detail} (< 4.5:1). Fix the override or re-tune the token ` +
    '(design set primary=oklch(…)) — foundations make AA the floor, not a preference.\n'
  );
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
  permission: 'confirm',
  // WS-046: gives permission decisions something to key on.
  // The action performed; `out` is optional so it cannot be the subject.
  subjectKey: 'action',
  mutating: true,
  capabilities: ['fs.write'],
  timeoutMs: 15_000,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'use', 'foundations', 'set', 'tune', 'materialize', 'verify', 'capture'],
        description:
          'list = menu; use = load+pin a kit; foundations = baseline; set = override colors/tokens; ' +
          'tune = high-level knobs (radius/density/font/motion); materialize = write tokens to a theme ' +
          'file; verify = scan UI for token drift (pinned kit, or the project\u2019s captured tokens); ' +
          'capture = snapshot the project\u2019s existing token source so verify works without a kit. ' +
          'Default: list.',
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
      tune: {
        type: 'object',
        description:
          'High-level knobs for "tune": { "radius": "lg", "density": "compact", "font": "Space Grotesk", ' +
          '"motion": "snappy" }. radius = none|sm|md|lg|xl|full or a base length; density = ' +
          'compact|cozy|comfortable; motion = snappy|smooth|none. Resolved to concrete token overrides.',
        properties: {
          radius: { type: 'string' },
          density: { type: 'string' },
          font: { type: 'string' },
          motion: { type: 'string' },
        },
      },
      out: {
        type: 'string',
        description:
          'Materialize output path (project-relative). Defaults to a per-stack convention.',
      },
      force: {
        type: 'boolean',
        description:
          'Materialize: overwrite an existing file (default false — refuses to clobber).',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Verify: explicit project-relative files to scan. Default: a bounded UI-file walk. ' +
          'Capture: explicit token-source files (.css / theme .ts / .dart). Default: conventional ' +
          'paths like src/index.css, src/theme/theme.ts, lib/theme/theme.dart.',
      },
    },
    required: [],
  },
  async execute(input, ctx, _opts): Promise<DesignOutput> {
    const signal = _opts?.signal ?? ctx?.signal;
    signal?.throwIfAborted();

    const VALID_ACTIONS: ReadonlySet<string> = new Set([
      'list',
      'use',
      'foundations',
      'set',
      'tune',
      'materialize',
      'verify',
      'capture',
    ]);
    if (input.action !== undefined && !VALID_ACTIONS.has(input.action)) {
      throw new ToolValidationError({
        message: `design: unknown action "${input.action}". Allowed actions: ${[...VALID_ACTIONS].join(', ')}`,
        field: 'action',
      });
    }

    if (input.stack !== undefined && !isDesignStack(input.stack)) {
      throw new ToolValidationError({
        message: `design: invalid stack "${input.stack}". Allowed stacks: web, react-native, flutter, swiftui, compose`,
        field: 'stack',
      });
    }

    const loader = getDesignKitLoader(ctx.projectRoot);
    const action = input.action ?? 'list';
    const stack: DesignStack | undefined = input.stack;

    if (action === 'foundations') {
      const text = await loader.foundationsText(stack);
      return { action, stack, output: text || 'No foundations document is installed.' };
    }

    // Failures below throw (with the same guidance text) instead of returning
    // it as `output`: a returned value is recorded as a successful call.
    if (action === 'use') {
      const kitId = input.kit?.trim();
      if (!kitId) {
        const menu = await loader.menuText();
        throw new ToolValidationError({
          message: `design: "use" requires a kit id.\n\n${menu}`,
          field: 'kit',
        });
      }
      const manifest = await loader.find(kitId);
      if (!manifest) {
        const menu = await loader.menuText();
        throw new ToolValidationError({
          message: `design: kit "${kitId}" not found.\n\n${menu}`,
          field: 'kit',
        });
      }
      const resolvedStack = stack ?? manifest.stacks[0] ?? 'web';
      if (!manifest.stacks.includes(resolvedStack)) {
        throw new ToolValidationError({
          message: `design: kit "${manifest.id}" does not support stack "${resolvedStack}". Supported stacks: ${manifest.stacks.join(', ') || '(none)'}.`,
          field: 'stack',
        });
      }
      const body = await loader.readBody(manifest.id, resolvedStack);
      const rawTokens = await loader.readTokens(manifest.id);
      // Preserve any persisted overrides; merge in any passed with `use`.
      const persisted = await loadActiveKit(ctx.projectRoot);
      const keepOverrides = persisted?.kit === manifest.id ? (persisted.overrides ?? {}) : {};
      const overrides: Overrides = { ...keepOverrides, ...normalizeOverrides(input.set) };
      const tokens = rawTokens ? applyTokenOverrides(rawTokens, overrides) : rawTokens;
      const contrastWarn = tokens ? contrastWarning(kitContrastIssues(tokens)) : '';

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
        output: `${header}${tokenBlock}${contrastWarn}\n${body}`,
      };
    }

    if (action === 'set') {
      const patch = normalizeOverrides(input.set);
      if (Object.keys(patch).length === 0) {
        throw new ToolValidationError({
          message: 'design: no overrides given. Pass set:{ "primary": "oklch(…)" }.',
          field: 'set',
        });
      }
      const merged = await recordOverrides(ctx.projectRoot, patch, new Date().toISOString());
      if (!merged) throw new Error(NO_ACTIVE_KIT);
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

    if (action === 'tune') {
      const patch = resolveSemanticTune(input.tune ?? {});
      if (Object.keys(patch).length === 0) {
        throw new ToolValidationError({
          message:
            'design: no recognized knobs. Pass tune:{ radius:"lg", density:"compact", font:"…", motion:"snappy" }.',
          field: 'tune',
        });
      }
      const merged = await recordOverrides(ctx.projectRoot, patch, new Date().toISOString());
      if (!merged) throw new Error(NO_ACTIVE_KIT);
      setDesignOverrides(ctx, merged);
      return {
        action,
        output:
          `Tuned. Resolved ${Object.keys(patch).length} token override(s): ${Object.entries(patch)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')}\n` +
          'Run `design {action:"materialize"}` to write the tuned tokens to your theme file.',
      };
    }

    if (action === 'materialize') {
      const active = await loadActiveKit(ctx.projectRoot);
      if (!active) throw new Error(NO_ACTIVE_KIT);
      const resolvedStack: DesignStack =
        stack ?? (active.stack && isDesignStack(active.stack) ? active.stack : 'web');
      const rawTokens = await loader.readTokens(active.kit);
      if (!rawTokens) throw new Error(`design: kit "${active.kit}" has no tokens.json.`);
      const tokens = applyTokenOverrides(rawTokens, active.overrides);
      const contrastWarn = contrastWarning(kitContrastIssues(tokens));
      const result = materializeTokens({
        tokens,
        stack: resolvedStack,
        kitId: active.kit,
        outPath: input.out,
      });
      // Containment: result.path derives from caller-supplied input.out and
      // may be either relative (joined under projectRoot) or absolute
      // (used as-is). Pin the write inside the project root, mirroring the
      // scaffold tool.
      //
      // #249 (design.ts escape check): resolve both sides through fs.realpath
      // before the relative check, so symlinks / bind mounts (e.g. /tmp on
      // CI runners is often a symlink to /private/tmp) can't smuggle an
      // out-of-root path past the prefix-startsWith-`..` guard. The
      // destination file does not exist yet, so realpath the parent
      // directory and re-join the basename.
      //
      // Note: on Windows, path.join(absoluteA, absoluteB) concatenates
      // literally (path.join('C:\\A\\B', 'C:\\A\\C.css') === 'C:\\A\\B\\C:\\A\\C.css')
      // rather than collapsing absoluteB onto the drive root. Treating
      // absolute result.path as absolute (not as a join-input) keeps the
      // behavior consistent across platforms and is what the test asserts.
      //
      // Match on `rel === '..'` / a '..<sep>' prefix (not a bare
      // startsWith('..')): in-root names like `..hidden/theme.css` or
      // `..tokens.css` produce rel values "..hidden\theme.css" / "..tokens.css"
      // — legal project-relative paths a loose prefix misreads as escapes.
      const root = await resolveReal(ctx.projectRoot);
      const absResolved = path.isAbsolute(result.path)
        ? path.resolve(result.path)
        : path.resolve(path.join(ctx.projectRoot, result.path));
      const absParent = await resolveReal(path.dirname(absResolved));
      const abs = path.join(absParent, path.basename(absResolved));
      const rel = path.relative(root, abs);
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        throw new ToolValidationError({
          message: `design: materialize path "${result.path}" would escape the project root`,
          field: 'out',
        });
      }
      let exists = false;
      try {
        await fs.access(abs);
        exists = true;
      } catch {
        // does not exist — safe to write
      }
      if (exists && !input.force) {
        throw new Error(
          `design: ${result.path} already exists — nothing was written. Re-run with force:true to ` +
            `overwrite, or write this ${result.format} yourself:\n\n\`\`\`\n${result.content}\n\`\`\``,
        );
      }
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await atomicWrite(abs, result.content);
      return {
        action,
        kit: active.kit,
        stack: resolvedStack,
        path: result.path,
        output:
          `Wrote ${result.format} to ${result.path}. Import these tokens in your UI so the kit ` +
          `palette is the source of truth. ${exists ? '(overwrote existing file)' : ''}` +
          contrastWarn,
      };
    }

    if (action === 'capture') {
      signal?.throwIfAborted();
      const normalizedFiles = input.files
        ? (Array.isArray(input.files) ? input.files : String(input.files).split(','))
            .filter((f): f is string => typeof f === 'string')
            .map((f) => f.trim().replace(/\\/g, '/'))
            .filter(Boolean)
        : undefined;
      if (normalizedFiles)
        await assertProjectRelative(normalizedFiles, ctx.projectRoot, 'capture file');
      const result = await captureProjectTokens(ctx.projectRoot, { files: normalizedFiles });
      const lightN = Object.keys(result.tokens.light ?? {}).length;
      const darkN = Object.keys(result.tokens.dark ?? {}).length;
      if (lightN + darkN === 0) {
        throw new Error(
          `design capture: no tokens found.${result.notes.length ? ` ${result.notes.join(' ')}` : ''}`,
        );
      }
      const relPath = await saveCapturedTokens(ctx.projectRoot, {
        stack: result.stack,
        files: result.files,
        tokens: result.tokens,
        palettes: result.palettes,
      });
      const lines = [
        `Captured ${lightN + darkN} token value(s) (${lightN} light / ${darkN} dark) from ${result.files.join(', ')} → ${relPath}.`,
        `Stack inferred: ${result.stack}.`,
        result.skipped.length ? `Skipped (no tokens found): ${result.skipped.join(', ')}.` : '',
        result.notes.length ? `Notes: ${result.notes.join(' · ')}` : '',
        'These are the project\u2019s OWN tokens — `design {action:"verify"}` and the write-time ' +
          'drift check now run against them while no kit is pinned. Re-run capture when the ' +
          'token source changes.',
      ].filter(Boolean);
      return {
        action,
        stack: result.stack,
        path: relPath,
        source: 'captured',
        output: lines.join('\n'),
      };
    }

    if (action === 'verify') {
      signal?.throwIfAborted();
      // Kit-less middle case: a pinned kit wins, else the project's captured
      // tokens (design capture), else there is nothing to verify against.
      const source = await resolveVerifyTokens(ctx.projectRoot);
      if (!source) {
        throw new Error(
          'design: nothing to verify against (no active kit, no captured tokens). Pin one with ' +
            '`design {action:"use", kit:"<id>"}`, or capture the project\u2019s own tokens with ' +
            '`design {action:"capture"}`.',
        );
      }
      signal?.throwIfAborted();
      const tokens = source.tokens;
      const normalizedFiles = input.files
        ? (Array.isArray(input.files) ? input.files : String(input.files).split(','))
            .filter((f): f is string => typeof f === 'string')
            .map((f) => f.trim().replace(/\\/g, '/'))
            .filter(Boolean)
        : undefined;
      // Containment: explicit files are documented as project-relative; mirror
      // the materialize guard (realpath-canonicalized, in-root absolutes OK).
      if (normalizedFiles) {
        await assertProjectRelative(normalizedFiles, ctx.projectRoot, 'verify file');
      }
      const report = await runDesignVerify(ctx.projectRoot, tokens, normalizedFiles);
      const pct = Math.round(report.score * 100);
      const top = report.violations
        .slice(0, 25)
        .map((v) => `  ${v.file}:${v.line} — ${v.reason}: ${v.snippet}`)
        .join('\n');
      // Break the count down by axis: "on-palette %" only describes color, and
      // a composition hit means token-clean code that still reads as generated.
      const byAxis = new Map<string, number>();
      for (const v of report.violations) {
        const axis = v.axis ?? 'color';
        byAxis.set(axis, (byAxis.get(axis) ?? 0) + 1);
      }
      const axisLine = [...byAxis]
        .sort((a, b) => b[1] - a[1])
        .map(([axis, n]) => `${axis}: ${n}`)
        .join(', ');
      const composition = byAxis.get('composition') ?? 0;
      const colorHits = byAxis.get('color') ?? 0;
      // A native-stack screen (react-native / flutter / swiftui / compose) carries
      // theme constants, not utility classes, so the palette axis reads nothing and
      // the file scores a clean 100% regardless of what it looks like. Saying nothing
      // here lets "0 violations" pass for "clean" when it means "not checked" — but
      // the claim must stay scoped to the palette axis: radius/spacing/type still
      // scan those files, so an unchecked file can carry non-color findings.
      const unchecked = report.filesWithNoSignal
        ? `\n\n${report.filesWithNoSignal} of ${report.filesScanned} file(s) carried no class or color ` +
          'signal — the palette axis had nothing to check in them (native stacks express the ' +
          'kit as theme constants), so a clean palette result there means "not checkable", ' +
          'not "clean": review them by hand against the materialized theme, or load the ' +
          '`design-critique` skill.'
        : '';
      const sourceLine =
        source.source === 'kit'
          ? `Kit: ${source.kit}.`
          : `Token source: the project\u2019s own captured tokens (${source.files?.join(', ') ?? 'design capture'}).`;
      const summary =
        `${sourceLine}\n` +
        `Adherence: ${pct}% on-palette across ${report.filesScanned} file(s). ` +
        `${report.violations.length} violation(s)${axisLine ? ` (${axisLine})` : ''}.` +
        (report.violations.length
          ? `\n${top}${report.violations.length > 25 ? `\n  …and ${report.violations.length - 25} more` : ''}` +
            (colorHits
              ? `\n\nReplace off-palette colors with ${
                  source.source === 'kit' ? 'kit tokens' : 'the project\u2019s own tokens'
                } (or the materialized CSS vars / token utilities).`
              : '') +
            (composition
              ? `\n${composition} composition finding(s) need contextual review against the brief. ` +
                'Load `design-craft`; preserve intentional repetition and inspect the rendered UI.'
              : '')
          : '\nNo source findings in the scanned files; this does not prove complete token adherence.') +
        unchecked +
        '\n\nSource heuristic only: the percentage describes detected color signals, not visual quality. ' +
        'No signals can also yield 100%. Layout, accessibility, interaction states and originality ' +
        'require rendered review with `design-critique`.';
      return {
        action,
        kit: source.source === 'kit' ? source.kit : undefined,
        source: source.source,
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

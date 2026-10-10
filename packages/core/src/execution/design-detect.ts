/**
 * Design Studio detection + injection middleware.
 *
 * The system prompt is built ONCE per session (boot / project-switch), so a
 * system-prompt contributor cannot react to "the model just started building a
 * UI" mid-session. Instead, detection and injection ride the per-turn pipelines:
 *
 *   - userInput  middleware → detect UI intent in the user's message
 *   - toolCall   middleware → detect a frontend file being written
 *       (both set `ctx.meta.designStudio`)
 *   - request    middleware → on every turn, read `ctx.meta.designStudio` and
 *       append an ephemeral block to `req.system`: the kit menu (until a kit is
 *       chosen) or a one-line adherence reminder (once chosen).
 *
 * Keeping the heavy kit body out of this path — the model loads it on demand via
 * the `design` tool — is what keeps per-turn token cost low.
 */

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import type {
  AgentPipelines,
  ToolCallPipelinePayload,
  UserInputPayload,
} from '../core/agent-types.js';
import type { Context } from '../core/context.js';
import type { Middleware } from '../kernel/pipeline.js';
import type { TextBlock } from '../types/blocks.js';
import type {
  DesignKitLoader,
  DesignKitTokens,
  DesignStack,
  DesignStudioState,
} from '../types/design-kit.js';
import { isDesignStack } from '../types/design-kit.js';
import type { Request } from '../types/provider.js';
import { getDesignKitLoader } from './design-kit-loader.js';
import {
  applyTokenOverrides,
  loadActiveKit,
  loadCapturedTokens,
  loadProjectDesignRules,
} from './design-project-store.js';
import { verifyFiles } from './design-verify.js';

const META_KEY = 'designStudio';

/**
 * Session flag: the "no kit pinned, so nothing was checked" notice has been
 * given. Kept as its own `ctx.meta` key rather than a `DesignStudioState` field
 * because the state object is part of the published type surface, and this is
 * transport bookkeeping, not design state.
 */
const UNPINNED_NOTICE_KEY = 'designStudioUnpinnedNotice';

export function getDesignState(ctx: {
  meta: Record<string, unknown>;
}): DesignStudioState | undefined {
  const v = ctx.meta[META_KEY];
  return v && typeof v === 'object' ? (v as DesignStudioState) : undefined;
}

function ensureState(ctx: { meta: Record<string, unknown> }): DesignStudioState {
  let s = getDesignState(ctx);
  if (!s) {
    s = { active: false, signals: [] };
    ctx.meta[META_KEY] = s;
  }
  return s;
}

/** Mark Design Studio active and merge in detected signals/stack. */
export function activateDesign(
  ctx: { meta: Record<string, unknown> },
  signals: string[],
  stack?: DesignStack,
): DesignStudioState {
  const s = ensureState(ctx);
  s.active = true;
  for (const sig of signals) if (!s.signals.includes(sig)) s.signals.push(sig);
  if (stack && !s.stack) s.stack = stack;
  return s;
}

/** Record the kit the model/user committed to. */
export function setActiveKit(
  ctx: { meta: Record<string, unknown> },
  kitId: string,
  stack?: DesignStack,
  overrides?: Record<string, string> | undefined,
): void {
  const s = ensureState(ctx);
  s.active = true;
  s.activeKit = kitId;
  if (stack) s.stack = stack;
  if (overrides !== undefined) s.overrides = overrides;
}

/** Merge color/token overrides into the live state (used by `design set`). */
export function setDesignOverrides(
  ctx: { meta: Record<string, unknown> },
  overrides: Record<string, string>,
): void {
  const s = ensureState(ctx);
  s.overrides = { ...(s.overrides ?? {}), ...overrides };
}

/** Clear the active kit (e.g. `/design off`), leaving detection state intact. */
export function clearActiveKit(ctx: { meta: Record<string, unknown> }): void {
  const s = getDesignState(ctx);
  if (s) s.activeKit = undefined;
}

// ── Detection ──────────────────────────────────────────────────────────────

const STACK_HINTS: { re: RegExp; stack: DesignStack; label: string }[] = [
  { re: /\b(flutter|dart)\b/i, stack: 'flutter', label: 'flutter' },
  { re: /\bjetpack\s*compose\b|\bcompose\b/i, stack: 'compose', label: 'compose' },
  { re: /\bswift\s*ui\b|\bswiftui\b/i, stack: 'swiftui', label: 'swiftui' },
  { re: /\b(react\s*native|expo|nativewind)\b/i, stack: 'react-native', label: 'react-native' },
];

const WEB_INTENT_RE =
  /\b(ui|ux|frontend|front-end|landing\s*page|web\s*site|website|web\s*app|webapp|dashboard|screen|design\s*system|component|react|next\.?js|vue|svelte|tailwind|shadcn|css|theme|redesign|style|interface|hero\s*section|navbar|sidebar|button|modal|form\s*design)\b/i;

const GENERIC_UI_RE = /\b(ui|interface|screen|page|app|component|design)\b/i;

/**
 * Inspect user text for UI/design intent. Returns the strongest stack hint and
 * the matched signals, or `null` when nothing UI-ish was found.
 */
export function detectFrontendIntent(
  text: string,
): { stack?: DesignStack; signals: string[] } | null {
  if (!text) return null;
  const signals: string[] = [];
  let stack: DesignStack | undefined;
  for (const h of STACK_HINTS) {
    if (h.re.test(text)) {
      signals.push(`intent:${h.label}`);
      stack ??= h.stack;
    }
  }
  const webMatch = WEB_INTENT_RE.exec(text);
  if (webMatch) {
    signals.push(`intent:${webMatch[0].toLowerCase().replace(/\s+/g, '-')}`);
    stack ??= 'web';
  } else if (
    stack === undefined &&
    GENERIC_UI_RE.test(text) &&
    /\b(build|make|create|design|implement|add)\b/i.test(text)
  ) {
    // Weak generic signal — only when paired with a build verb.
    signals.push('intent:ui');
    stack = 'web';
  }
  if (signals.length === 0) return null;
  return stack ? { stack, signals } : { signals };
}

const FRONTEND_EXT_STACK: { re: RegExp; stack?: DesignStack }[] = [
  { re: /\.(tsx|jsx)$/i, stack: 'web' },
  { re: /\.(css|scss|sass|less)$/i, stack: 'web' },
  { re: /\.(vue|svelte|astro)$/i, stack: 'web' },
  { re: /\.html?$/i, stack: 'web' },
  { re: /\.dart$/i, stack: 'flutter' },
  { re: /\.swift$/i, stack: 'swiftui' },
  { re: /\.kt$/i, stack: 'compose' },
];

/**
 * `.tsx`/`.jsx` are stack-ambiguous: they are the React Native screen
 * language too. When the project's package.json depends on a RN marker
 * (react-native / expo / nativewind), those writes scope Design Studio to
 * `react-native` instead of `web` — the materialized theme shape differs.
 *
 * Memoized per projectRoot: dependencies rarely change mid-session, and this
 * runs on every frontend write. Best-effort — a missing or malformed
 * package.json simply means "not an RN project" (web stays the default).
 */
const RN_MARKER_DEPS = ['react-native', 'expo', 'nativewind'] as const;
const rnProjectMemo = new Map<string, boolean>();

function isReactNativeProject(projectRoot: string | undefined): boolean {
  if (!projectRoot) return false;
  const cached = rnProjectMemo.get(projectRoot);
  if (cached !== undefined) return cached;
  let hit = false;
  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      hit = RN_MARKER_DEPS.some((dep) => deps[dep] !== undefined);
    }
  } catch {
    hit = false;
  }
  rnProjectMemo.set(projectRoot, hit);
  return hit;
}

/**
 * Detect whether a written/edited file path is a frontend file. Pass
 * `projectRoot` to resolve stack-ambiguous extensions: in a React Native
 * project, `.tsx`/`.jsx` writes report `react-native` rather than `web`.
 */
export function detectFrontendFile(
  filePath: string,
  projectRoot?: string | undefined,
): { stack?: DesignStack } | null {
  if (!filePath) return null;
  for (const { re, stack } of FRONTEND_EXT_STACK) {
    if (re.test(filePath)) {
      if (stack === 'web' && /\.(tsx|jsx)$/i.test(filePath) && isReactNativeProject(projectRoot)) {
        return { stack: 'react-native' };
      }
      return stack ? { stack } : {};
    }
  }
  return null;
}

// ── Middleware ───────────────────────────────────────────────────────────────

/** userInput middleware: detect UI intent from the user's message. */
export function makeDesignDetectUserInputMiddleware(): Middleware<UserInputPayload> {
  return {
    name: 'DesignStudioDetectIntent',
    owner: 'core',
    async handler(payload, next) {
      const hit = detectFrontendIntent(payload.text);
      if (hit) activateDesign(payload.ctx, hit.signals, hit.stack);
      return next(payload);
    },
  };
}

/** toolCall middleware: detect frontend file writes/edits. */
export function makeDesignDetectToolCallMiddleware(): Middleware<ToolCallPipelinePayload> {
  return {
    name: 'DesignStudioDetectFile',
    owner: 'core',
    async handler(payload, next) {
      const name = payload.toolUse?.name;
      if (name === 'write' || name === 'edit' || name === 'replace' || name === 'patch') {
        const input = payload.toolUse.input as { path?: unknown } | undefined;
        const p = typeof input?.path === 'string' ? input.path : '';
        const hit = detectFrontendFile(p, payload.ctx.projectRoot);
        if (hit) activateDesign(payload.ctx, [`file:${p}`], hit.stack);
      }
      return next(payload);
    },
  };
}

const WRITE_TOOLS = new Set(['write', 'edit', 'replace', 'patch']);

/**
 * toolCall middleware: after a frontend file is written/edited AND a kit is
 * pinned, scan the file for off-palette colors and append a non-blocking
 * warning to the tool result. This makes adherence PASSIVE — the model is
 * nudged toward kit tokens the moment it drifts, without anyone running
 * `design verify` by hand. Best-effort: any failure leaves the result untouched.
 */
export function makeDesignVerifyToolCallMiddleware(): Middleware<ToolCallPipelinePayload> {
  return {
    name: 'DesignStudioVerifyWrite',
    owner: 'core',
    async handler(payload, next) {
      const out = await next(payload);
      try {
        const name = out.toolUse?.name;
        if (!name || !WRITE_TOOLS.has(name)) return out;
        if (out.result?.is_error) return out;
        const input = out.toolUse.input as { path?: unknown } | undefined;
        const p = typeof input?.path === 'string' ? input.path : '';
        if (!p || !detectFrontendFile(p, out.ctx.projectRoot)) return out;

        const state = getDesignState(out.ctx);
        const ctx = out.ctx;
        let tokens: DesignKitTokens | undefined;
        let basis: string;
        if (state?.activeKit) {
          const loader = getDesignKitLoader(ctx.projectRoot);
          const rawTokens = await loader.readTokens(state.activeKit).catch(() => undefined);
          if (!rawTokens) return out;
          const persisted = await loadActiveKit(ctx.projectRoot).catch(() => undefined);
          tokens = applyTokenOverrides(rawTokens, persisted?.overrides ?? state.overrides);
          basis = `kit "${state.activeKit}"`;
        } else {
          // No kit pinned — fall back to the project's OWN captured tokens
          // (`design capture`). Without those either, this write goes out
          // unchecked; returning silently is the dangerous shape: zero
          // findings reads exactly like a clean pass. Say it once per session.
          const captured = await loadCapturedTokens(ctx.projectRoot).catch(() => undefined);
          if (!captured) {
            if (!out.ctx.meta[UNPINNED_NOTICE_KEY]) {
              out.ctx.meta[UNPINNED_NOTICE_KEY] = true;
              out.result.content +=
                '\n\n⚠️ Design Studio: no kit is pinned, so frontend writes are NOT being ' +
                'design-checked — this is "unverified", not "clean". Pin one with the `design` ' +
                'tool for a new design system, run `design {action:"capture"}` to check drift ' +
                'against the project\u2019s own tokens, or review manually. Do not replace an ' +
                'established system merely to obtain a scanner score.';
            }
            return out;
          }
          tokens = captured.tokens;
          basis = 'captured project tokens';
        }

        const fs = await import('node:fs/promises');
        const nodePath = await import('node:path');
        const abs = nodePath.isAbsolute(p) ? p : nodePath.join(ctx.projectRoot, p);
        const text = await fs.readFile(abs, 'utf8').catch(() => '');
        if (!text) return out;

        const rel = nodePath.relative(ctx.projectRoot, abs);
        const report = verifyFiles(tokens, [{ path: rel, text }]);
        if (report.violations.length === 0) return out;

        const top = report.violations
          .slice(0, 5)
          .map((v) => `  L${v.line}: [${v.axis ?? 'color'}] ${v.snippet} — ${v.reason}`)
          .join('\n');
        const more =
          report.violations.length > 5 ? `\n  …and ${report.violations.length - 5} more` : '';
        // Summarize which axes drifted (color / radius / spacing / …).
        const axes = [...new Set(report.violations.map((v) => v.axis ?? 'color'))].join(', ');
        out.result.content +=
          `\n\n⚠️ Design Studio (${basis}): ${report.violations.length} ` +
          `source finding(s) [${axes}] in ${rel}. Check token drift against the active theme; ` +
          `composition findings are review prompts, not proof of poor design. Keep intentional ` +
          `patterns justified by the brief and inspect the rendered result:\n${top}${more}`;
      } catch {
        // best-effort — never break a tool result
      }
      return out;
    },
  };
}

const BASELINE = [
  '**Non-negotiable baseline (every UI you write):**',
  '- Mobile-first & fully responsive; respect safe-area insets on native.',
  "- Preserve the project's stack, components, tokens and supported themes; do not introduce a redesign for a local UI change.",
  '- Meet applicable WCAG 2.2 AA: semantic markup, keyboard operation, visible focus, contrast and labelled controls.',
  '- Tasteful motion with `prefers-reduced-motion` honored.',
  "- Choose dependencies only when needed by the task, using the project's installed versions.",
].join('\n');

const CRAFT_GUIDANCE = [
  '## Design quality beyond tokens',
  'Use `design-craft` for substantial UI work and `design-critique` to review the result. ' +
    'For a small edit, match the established system without a new design ceremony.',
  'Before a new screen or redesign, record the audience, primary task, real content, ' +
    'layout hierarchy, product-specific visual idea and acceptance checks in `.design/brief.md`. ' +
    'Inspect supplied references; label assumptions and never invent testimonials, metrics or research.',
  "Originality should come from the product's content and workflow. Repeated rows, symmetry, " +
    'gradients and restrained styling can be correct; do not add novelty merely to evade a heuristic.',
  'Before delivery, inspect the rendered UI at relevant desktop, narrow and short viewports; ' +
    'exercise keyboard and loading/empty/error/overflow states. Fix the highest-impact problems ' +
    'and recheck. Report observed evidence and unverified states; a source scan cannot certify visual quality.',
].join('\n');

/** Fresh on every turn so revised decisions survive kit switches and compaction. */
async function readDesignBrief(projectRoot: string): Promise<string> {
  try {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const file = await fs.open(path.join(projectRoot, '.design', 'brief.md'), 'r');
    try {
      // Bound both IO and prompt size; a full brief remains available via read.
      const buffer = Buffer.alloc(6001);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const excerpt = buffer.subarray(0, Math.min(bytesRead, 6000)).toString('utf8').trim();
      return excerpt
        ? `\n\n## Project design brief (.design/brief.md)\n${excerpt}` +
            (bytesRead > 6000
              ? '\n[Brief truncated; read `.design/brief.md` before changing its decisions.]'
              : '')
        : '';
    } finally {
      await file.close();
    }
  } catch {
    return '';
  }
}

/**
 * request middleware: per-turn, inject the kit menu (until a kit is chosen) or a
 * compact adherence reminder (once chosen). No-op when Design Studio is inactive.
 *
 * Closes over the live `Context` because the `request` pipeline payload is just
 * the `Request` — it carries no ctx. `req.system` shares the array reference
 * with `ctx.systemPrompt`, so we return a NEW array rather than mutating it.
 */
export function makeDesignStudioRequestMiddleware(deps: {
  ctx: Context;
  loader: DesignKitLoader;
  enabled?: () => boolean;
}): Middleware<Request> {
  const { ctx, loader } = deps;
  return {
    name: 'DesignStudioInject',
    owner: 'core',
    async handler(req, next) {
      if (deps.enabled && !deps.enabled()) return next(req);
      const state = getDesignState(ctx);
      if (!state?.active) return next(req);

      let text: string;
      if (state.activeKit) {
        const ov =
          state.overrides && Object.keys(state.overrides).length > 0
            ? `\nUser color overrides (these WIN over kit tokens): ${Object.entries(state.overrides)
                .map(([k, v]) => `${k}=${v}`)
                .join(', ')}.`
            : '';
        text =
          `## Active design kit: ${state.activeKit}\n` +
          `Adhere strictly to its tokens, components, and patterns. Keep light/dark + ` +
          `responsive + WCAG AA. Re-load the full spec with \`design use ${state.activeKit}\` if unsure.` +
          `${ov}`;
      } else {
        const menu = await loader.menuText().catch(() => '');
        const stackLine = state.stack ? ` (detected stack: ${state.stack})` : '';
        const parts = [
          `## Design Studio — UI work detected${stackLine}`,
          'Before writing UI code, COMMIT to ONE coherent design direction. Do NOT produce generic, ' +
            'default-framework, unstyled output.',
          '',
          menu || '(no kits installed)',
          '',
          BASELINE,
          '',
          'First inspect the existing design system and reuse it. For greenfield work or an ' +
            'authorized system replacement, call `design list`, then `design use <kit-id> --stack <stack>` ' +
            'and materialize its tokens. A user can also pin one with `/design <kit-id>`.',
        ];
        text = parts.join('\n');
      }

      text += `\n\n${CRAFT_GUIDANCE}${await readDesignBrief(ctx.projectRoot)}`;

      // Project-local design rules (.design/rules.md) override kit defaults.
      const rules = await loadProjectDesignRules(ctx.projectRoot).catch(() => undefined);
      if (rules) {
        text += `\n\n## Project design rules (.design/rules.md) — these OVERRIDE kit defaults on conflict\n${rules}`;
      }

      const block: TextBlock = {
        type: 'text',
        text,
        cache_control: { type: 'ephemeral' },
      };
      const system = Array.isArray(req.system) ? [...req.system, block] : [block];
      return next({ ...req, system });
    },
  };
}

/**
 * Install the Design Studio per-turn middleware onto an agent's pipelines.
 * Shared by every host (CLI/TUI + both WebUI servers) so auto-detection behaves
 * identically everywhere. All three are PREPENDED:
 *   - detection runs first so a short-circuiting middleware can't suppress it;
 *   - the request injector must sit ahead of `ModelRuntimeSettings`, which does
 *     not call `next` and would otherwise end the chain before us.
 *
 * The `design` tool and `/design` command are wired separately (builtin pack +
 * slash registry); this only installs the activation behavior.
 */
export function installDesignStudioMiddleware(deps: {
  pipelines: AgentPipelines;
  ctx: Context;
  /** When false, nothing is installed (tool + /design stay manual). */
  enabled?: boolean | undefined;
}): void {
  if (deps.enabled === false) return;
  const loader = getDesignKitLoader(deps.ctx.projectRoot);
  deps.pipelines.userInput.prepend(makeDesignDetectUserInputMiddleware());
  deps.pipelines.toolCall.prepend(makeDesignDetectToolCallMiddleware());
  deps.pipelines.toolCall.prepend(makeDesignVerifyToolCallMiddleware());
  deps.pipelines.request.prepend(makeDesignStudioRequestMiddleware({ ctx: deps.ctx, loader }));

  // Restore a previously pinned kit from `.design/active.json` so a design
  // direction survives across sessions. Fire-and-forget — a missing/old file
  // simply leaves Design Studio idle until detection or an explicit pick.
  void loadActiveKit(deps.ctx.projectRoot)
    .then((persisted) => {
      if (persisted && !getDesignState(deps.ctx)?.activeKit) {
        const stack =
          persisted.stack && isDesignStack(persisted.stack) ? persisted.stack : undefined;
        setActiveKit(deps.ctx, persisted.kit, stack, persisted.overrides);
      }
    })
    .catch(() => {
      // best-effort restore
    });
}

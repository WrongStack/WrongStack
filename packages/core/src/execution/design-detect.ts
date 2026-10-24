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
import type { Middleware } from '@wrongstack/contracts/kernel/pipeline';
import type { TextBlock } from '@wrongstack/contracts/types/blocks';
import type {
  DesignKitLoader,
  DesignKitTokens,
  DesignStack,
  DesignStudioState,
} from '@wrongstack/contracts/types/design-kit';
import { isDesignStack } from '@wrongstack/contracts/types/design-kit';
import type { Request } from '@wrongstack/contracts/types/provider';
import type {
  AgentPipelines,
  ToolCallPipelinePayload,
  UserInputPayload,
} from '../core/agent-types.js';
import type { Context } from '../core/context.js';
import { detectEstablishedDesignSystem, type EstablishedDesignSystem } from './design-capture.js';
import { classifyTokenValue } from './design-color.js';
import { ensureDesignDeal, renderDesignDeal } from './design-deal.js';
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

/**
 * Consecutive user turns without a design signal. Kept beside the state for
 * the same reason as the notice flag. After `IDLE_TURNS_BEFORE_SLEEP` of them
 * the per-turn block stops riding every request; the next signal wakes it.
 */
const IDLE_TURNS_KEY = 'designStudioIdleTurns';
const IDLE_TURNS_BEFORE_SLEEP = 3;

/** Tools whose use is itself a design signal. */
const DESIGN_TOOLS = new Set(['design', 'design_reference']);

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
      if (hit) {
        activateDesign(payload.ctx, hit.signals, hit.stack);
        payload.ctx.meta[IDLE_TURNS_KEY] = 0;
      } else {
        // A session that moved on from UI work stops paying for the block on
        // every request. The pinned kit, overrides and signals stay.
        const state = getDesignState(payload.ctx);
        if (state?.active) {
          const idle = Number(payload.ctx.meta[IDLE_TURNS_KEY] ?? 0) + 1;
          payload.ctx.meta[IDLE_TURNS_KEY] = idle;
          if (idle >= IDLE_TURNS_BEFORE_SLEEP) {
            state.active = false;
            payload.ctx.meta[IDLE_TURNS_KEY] = 0;
          }
        }
      }
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
        if (hit) {
          activateDesign(payload.ctx, [`file:${p}`], hit.stack);
          payload.ctx.meta[IDLE_TURNS_KEY] = 0;
        }
      } else if (name && DESIGN_TOOLS.has(name)) {
        activateDesign(payload.ctx, [`tool:${name}`]);
        payload.ctx.meta[IDLE_TURNS_KEY] = 0;
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
          // No kit pinned — fall back to the project's OWN tokens: a
          // `design capture` snapshot, else the system it declares at a
          // conventional path. Without either, this write goes out
          // unchecked; returning silently is the dangerous shape: zero
          // findings reads exactly like a clean pass. Say it once per session.
          const captured = await loadCapturedTokens(ctx.projectRoot).catch(() => undefined);
          const established = captured
            ? undefined
            : await detectEstablishedDesignSystem(ctx.projectRoot).catch(() => undefined);
          if (established) {
            tokens = established.tokens;
            basis = `project tokens in ${established.files.join(', ')}`;
          } else if (!captured) {
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
          } else {
            tokens = captured.tokens;
            basis = 'captured project tokens';
          }
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
          .map(
            (v) =>
              `  L${v.line}: ${v.severity ?? 'WARN'} [${v.id ?? v.axis ?? 'color'}] ${v.snippet} — ${v.reason}`,
          )
          .join('\n');
        const more =
          report.violations.length > 5 ? `\n  …and ${report.violations.length - 5} more` : '';
        // Summarize which axes drifted (color / radius / spacing / …).
        const axes = [...new Set(report.violations.map((v) => v.axis ?? 'color'))].join(', ');
        out.result.content +=
          `\n\n⚠️ Design Studio (${basis}): ${report.violations.length} ` +
          `source finding(s) [${axes}] in ${rel}. Check token drift against the active theme; ` +
          `composition findings are review prompts, not proof of poor design. Keep intentional ` +
          'patterns justified by the brief and inspect the rendered result. A deliberate ' +
          'exception can be waived in the file with a `design-ignore: <id>` comment:' +
          `\n${top}${more}`;
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

/**
 * The project's own system: a `design capture` snapshot (an explicit choice,
 * so it wins), else what it declares at a conventional path.
 */
async function projectDesignSystem(
  projectRoot: string | undefined,
): Promise<EstablishedDesignSystem | undefined> {
  if (!projectRoot) return undefined;
  const captured = await loadCapturedTokens(projectRoot).catch(() => undefined);
  if (captured) {
    const names = new Set<string>();
    for (const theme of [captured.tokens.light, captured.tokens.dark]) {
      for (const [name, value] of Object.entries(theme ?? {})) {
        if (classifyTokenValue(value) === 'color') names.add(name);
      }
    }
    return {
      stack:
        captured.stack === 'react-native' || captured.stack === 'flutter' ? captured.stack : 'web',
      files: captured.files.length > 0 ? captured.files : ['.design/captured-tokens.json'],
      tokens: captured.tokens,
      colorNames: [...names],
    };
  }
  return detectEstablishedDesignSystem(projectRoot).catch(() => undefined);
}

/** The no-kit block for a project that already has its own token system. */
function renderEstablishedSystem(
  system: EstablishedDesignSystem,
  stack: DesignStack | undefined,
): string {
  const shown = system.colorNames.slice(0, 16);
  const more =
    system.colorNames.length > shown.length
      ? `, … (${system.colorNames.length - shown.length} more)`
      : '';
  return [
    `## Design Studio — UI work detected${stack ? ` (detected stack: ${stack})` : ''}`,
    `This project already has a design system: ${system.files.join(', ')} — ` +
      `${system.colorNames.length} color tokens (${shown.join(', ')}${more}).`,
    'Extend it: use these tokens and the components that already consume them; read the ' +
      'source file before adding a value. Do not pin a kit, add a parallel palette or restyle ' +
      'unrelated screens. Only if the user asks for a new visual direction, offer `design deal`.',
    'Frontend writes are checked against these tokens. Add a missing role to the source ' +
      'file rather than hardcoding a value; `design capture` snapshots a token source kept elsewhere.',
    '',
    BASELINE,
  ].join('\n');
}

/** First `limit` characters of a project file as a titled block; '' when absent. */
async function readExcerpt(
  projectRoot: string,
  rel: string,
  title: string,
  limit: number,
): Promise<string> {
  try {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const file = await fs.open(path.join(projectRoot, rel), 'r');
    try {
      // Bound both IO and prompt size; the full file remains available via read.
      const buffer = Buffer.alloc(limit + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const excerpt = buffer.subarray(0, Math.min(bytesRead, limit)).toString('utf8').trim();
      return excerpt
        ? `\n\n## ${title} (${rel})\n${excerpt}` +
            (bytesRead > limit
              ? `\n[Excerpt truncated; read \`${rel}\` before changing its decisions.]`
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
 * Fresh on every turn so revised decisions survive kit switches and compaction.
 * PRODUCT.md (audience, job, voice — the product half that tokens cannot
 * carry) comes before the design brief, which records the visual decisions.
 */
async function readDesignBrief(projectRoot: string): Promise<string> {
  return (
    (await readExcerpt(projectRoot, 'PRODUCT.md', 'Product context', 3000)) +
    (await readExcerpt(projectRoot, '.design/brief.md', 'Project design brief', 6000))
  );
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

      const established = state.activeKit ? undefined : await projectDesignSystem(ctx.projectRoot);
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
      } else if (established) {
        // The project declares its own system: dealing kits to it invites the
        // redesign nobody asked for. Point at the system instead.
        text = renderEstablishedSystem(established, state.stack);
      } else {
        // Shown the whole catalogue, models converge on the same few kits; a
        // seeded deal of three (recent choices left out) replaces the menu once
        // there is more than a deal's worth to choose from.
        const entries = await loader.listEntries().catch(() => []);
        const menu =
          entries.length > 3
            ? await ensureDesignDeal(ctx, loader, { stack: state.stack })
                .then(({ deal, entries: dealt }) => renderDesignDeal(deal, dealt))
                .catch(() => loader.menuText().catch(() => ''))
            : await loader.menuText().catch(() => '');
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
            'authorized system replacement, choose a kit (`design deal` / `design list`), then ' +
            '`design use <kit-id> --stack <stack>` ' +
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
  // WRONGSTACK_DESIGN_STUDIO=off runs a host without the layer — the "bare"
  // arm of the design evaluation, or a user who wants only the manual tool.
  if (deps.enabled === false || process.env['WRONGSTACK_DESIGN_STUDIO'] === 'off') return;
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
      const current = getDesignState(deps.ctx);
      if (persisted && !current?.activeKit) {
        const stack =
          persisted.stack && isDesignStack(persisted.stack) ? persisted.stack : undefined;
        const wasActive = current?.active ?? false;
        setActiveKit(deps.ctx, persisted.kit, stack, persisted.overrides);
        // Restoring the pin is not UI work: the reminder waits for a signal,
        // so a backend session in a designed project pays nothing per turn.
        const restored = getDesignState(deps.ctx);
        if (restored) restored.active = wasActive;
      }
    })
    .catch(() => {
      // best-effort restore
    });
}

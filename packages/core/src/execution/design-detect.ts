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

import type {
  AgentPipelines,
  ToolCallPipelinePayload,
  UserInputPayload,
} from '../core/agent-types.js';
import type { Context } from '../core/context.js';
import type { Middleware } from '../kernel/pipeline.js';
import type { TextBlock } from '../types/blocks.js';
import type { DesignKitLoader, DesignStack, DesignStudioState } from '../types/design-kit.js';
import { isDesignStack } from '../types/design-kit.js';
import type { Request } from '../types/provider.js';
import { getDesignKitLoader } from './design-kit-loader.js';
import { loadActiveKit, loadProjectDesignRules } from './design-project-store.js';

const META_KEY = 'designStudio';

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
];

/** Detect whether a written/edited file path is a frontend file. */
export function detectFrontendFile(filePath: string): { stack?: DesignStack } | null {
  if (!filePath) return null;
  for (const { re, stack } of FRONTEND_EXT_STACK) {
    if (re.test(filePath)) return stack ? { stack } : {};
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
        const hit = detectFrontendFile(p);
        if (hit) activateDesign(payload.ctx, [`file:${p}`], hit.stack);
      }
      return next(payload);
    },
  };
}

const BASELINE = [
  '**Non-negotiable baseline (every UI you write):**',
  '- Mobile-first & fully responsive; respect safe-area insets on native.',
  '- Ship BOTH light and dark themes from one token set (no hard-coded colors).',
  '- WCAG 2.2 AA: semantic markup, focus-visible, 4.5:1 contrast, labelled controls, hit targets ≥44px.',
  '- Tasteful motion with `prefers-reduced-motion` honored.',
  '- Use current stack defaults (e.g. web: React 19 + Tailwind v4 `@theme`/OKLCH + shadcn/ui + Motion).',
].join('\n');

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
          'Next: call `design list` to review, then `design use <kit-id> --stack <stack>` to load the ' +
            'full spec, then implement it faithfully. A user can also pin one with `/design <kit-id>`.',
        ];
        text = parts.join('\n');
      }

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

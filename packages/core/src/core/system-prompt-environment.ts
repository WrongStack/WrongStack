/**
 * The `## Environment` section of the system prompt — OS, shell, git, detected
 * languages, model capabilities, and the skills-in-scope footer.
 *
 * Split out of `system-prompt-builder.ts`. The builder passes the pieces of its
 * own state this section reads; `envCacheByRoot` is the builder's Map, mutated
 * here by reference exactly as before.
 *
 * @module core/system-prompt-environment
 */
import * as os from 'node:os';
import * as path from 'node:path';
import type { ConcreteTokenSavingTier } from '../types/config.js';
import type { BuildContext, ModelCapabilities } from '../types/system-prompt.js';
import { detectLanguages, dirExists, gitStatus } from './system-prompt-environment-probes.js';
import { effectiveShell, SHELL_DISPLAY, shellGuidanceBlock } from './system-prompt-shell.js';

/** The builder state this section reads. */
export interface EnvironmentSectionContext {
  tier: ConcreteTokenSavingTier;
  isCompact: boolean;
  modelCapabilities: ModelCapabilities | undefined;
  /** Builder's per-projectRoot cache — read and written by reference. */
  envCacheByRoot: Map<string, string>;
  skillCache: string | undefined;
  todayIso: string | undefined;
  modeId: string | undefined;
  skillMode: string | undefined;
}

const MAX_ENVIRONMENT_CACHE_ENTRIES = 16;

export async function buildEnvironment(
  ctx: BuildContext,
  env: EnvironmentSectionContext,
): Promise<string> {
  const modelCapabilities = env.modelCapabilities;
  const cacheKey = [
    ctx.projectRoot,
    ctx.provider ?? '',
    ctx.model ?? '',
    modelCapabilities?.maxContextTokens ?? 0,
    modelCapabilities?.supportsTools ? 1 : 0,
    modelCapabilities?.supportsVision ? 1 : 0,
    modelCapabilities?.supportsReasoning ? 1 : 0,
    env.skillCache ?? '',
  ].join('\0');
  const cached = env.envCacheByRoot.get(cacheKey);
  if (cached) {
    env.envCacheByRoot.delete(cacheKey);
    env.envCacheByRoot.set(cacheKey, cached);
    return cached;
  }
  const today = env.todayIso ?? new Date().toISOString().slice(0, 10);
  const platform = `${os.platform()} ${os.release()}`;
  // The bash tool's effective shell, pinned at boot via WRONGSTACK_SHELL.
  // On POSIX we keep reporting the raw $SHELL; on Windows we report the
  // resolved shell + a "write X syntax" nudge, and append a syntax guidance
  // sub-block below so the model doesn't default to bash/POSIX idioms.
  const effShell = effectiveShell(os.platform(), process.env['WRONGSTACK_SHELL']);
  const shell =
    effShell === 'posix'
      ? (process.env.SHELL ?? process.env.ComSpec ?? 'unknown')
      : SHELL_DISPLAY[effShell];
  const node = process.version;
  const isGit = await dirExists(path.join(ctx.projectRoot, '.git'));
  // Fan out the per-root probes so the prompt build doesn't serialize
  // ~12 fs.access calls plus the git status spawn back-to-back. On a
  // cold cache (CI / first turn) this trims hundreds of ms.
  const [git, langs] = await Promise.all([
    isGit ? gitStatus(ctx.projectRoot) : Promise.resolve('not a git repo'),
    detectLanguages(ctx.projectRoot),
  ]);

  // Tier-aware environment block content.
  // - 'off':        Full — all fields
  // - 'minimal':    Compact single line — git + date only
  // - 'light':      +platform
  // - 'medium':     +languages
  // - 'aggressive': +capabilities (context window, provider/model)
  const tier = env.tier;
  const lines: string[] = ['## Environment'];

  if (tier === 'minimal') {
    // Single compact line
    lines.push(`- Git: ${git} | Date: ${today}`);
  } else {
    lines.push(`- Operating system: ${platform}`);
    if (tier !== 'light') {
      lines.push(`- Shell: ${shell}`);
      lines.push(`- Node.js: ${node}`);
    }
    // Languages appear in the full ('off') block and the richer trimming
    // tiers; only 'minimal' (single line) and 'light' (platform only) omit
    // them. 'off' is the most complete tier (no token saving), per the
    // toolDescLimit ordering off=80 > aggressive=70 > … > minimal=40.
    if (tier === 'off' || tier === 'medium' || tier === 'aggressive') {
      lines.push(`- Detected languages: ${langs}`);
    }
    lines.push(`- Git status: ${git}`);
    lines.push(`- Today's date: ${today}`);
    if (tier === 'aggressive') {
      if (ctx.provider || ctx.model) {
        lines.push(
          `- Running on: ${ctx.provider ?? '<unknown provider>'}/${ctx.model ?? '<unknown model>'}`,
        );
      }
      if (modelCapabilities) {
        lines.push(
          `- Context window: ${modelCapabilities.maxContextTokens.toLocaleString()} tokens max`,
        );
      }
    }
    if (tier !== 'aggressive' && modelCapabilities) {
      lines.push(
        `- Context window: ${modelCapabilities.maxContextTokens.toLocaleString()} tokens max`,
      );
    }
    if (tier !== 'aggressive' && (ctx.provider || ctx.model)) {
      lines.push(
        `- Running on: ${ctx.provider ?? '<unknown provider>'}/${ctx.model ?? '<unknown model>'}`,
      );
    }
    if (tier !== 'aggressive' && env.modeId && env.modeId !== 'default') {
      lines.push(`- Mode: ${env.modeId}`);
    }
  }

  // Shell syntax guidance — only meaningful on Windows, where the model must
  // not fall back to bash/POSIX idioms. Tier-gated: full for off/medium/
  // aggressive, a one-liner for light, omitted for minimal. POSIX returns ''.
  if (
    ctx.tools.some((tool) => tool.name === 'bash') &&
    effShell !== 'posix' &&
    tier !== 'minimal'
  ) {
    const guide = shellGuidanceBlock(effShell, tier === 'light' ? 'short' : 'full');
    if (guide) lines.push('', guide);
  }

  if (env.skillCache) {
    lines.push(
      '',
      '## Skills in scope for this session',
      env.skillCache,
      '',
      env.skillMode === 'progressive'
        ? 'Skill names and triggers are injected below; load full instructions deterministically with the `skill` tool before relying on one.'
        : env.isCompact
          ? 'Compact skill instructions are injected in the Active Skills block below (Overview + Rules only).'
          : 'Skill bodies are injected below up to the eager budget; overflow remains listed by name and trigger for deterministic loading with the `skill` tool.',
    );
  }
  const text = lines.join('\n');
  env.envCacheByRoot.set(cacheKey, text);
  while (env.envCacheByRoot.size > MAX_ENVIRONMENT_CACHE_ENTRIES) {
    const oldestKey = env.envCacheByRoot.keys().next().value;
    if (oldestKey === undefined) break;
    env.envCacheByRoot.delete(oldestKey);
  }
  return text;
}

/**
 * The shared catalogue of system-prompt identity variants - Lite / Standard /
 * Pro - plus the per-variant token estimate every surface shows before a user
 * commits to one.
 *
 * This lives in core because three surfaces need the same answer: the CLI's
 * startup menu, the WebUI's new-session modal, and any host that wants to
 * report which variant a session is running. Each of them would otherwise
 * re-derive the label set, the ordering, and - worse - the token count. A
 * count computed a second way drifts from the one the builder actually emits,
 * which is the number the user is choosing on.
 */

import * as fs from 'node:fs/promises';
import { atomicWrite } from '../utils/atomic-write.js';
import { estimateTextTokens } from '../utils/token-estimate.js';
import { loadInstructionBundle, type SystemInstructionVariant } from './instruction-bundle.js';
import { buildIdentityLayer } from './system-prompt-builder.js';

/** Menu order + display labels. `default` is shown as "Standard". */
export const SYSTEM_PROMPT_VARIANT_OPTIONS: ReadonlyArray<{
  variant: SystemInstructionVariant;
  label: string;
  hint: string;
}> = [
  { variant: 'lite', label: 'Lite', hint: 'leanest - best for small context windows' },
  { variant: 'default', label: 'Standard', hint: 'balanced - the default' },
  { variant: 'pro', label: 'Pro', hint: 'most detailed guidance - uses more tokens' },
];

/** All selectable variants, in menu order. */
export const SYSTEM_PROMPT_VARIANTS: readonly SystemInstructionVariant[] =
  SYSTEM_PROMPT_VARIANT_OPTIONS.map((o) => o.variant);

const VALID_VARIANTS = new Set<string>(SYSTEM_PROMPT_VARIANTS);

/** Narrow an untrusted value (WS payload, config file, CLI flag) to a variant. */
export function isSystemInstructionVariant(value: unknown): value is SystemInstructionVariant {
  return typeof value === 'string' && VALID_VARIANTS.has(value);
}

/** Human label for a variant; falls back to the raw id for an unknown value. */
export function systemPromptVariantLabel(variant: SystemInstructionVariant): string {
  return SYSTEM_PROMPT_VARIANT_OPTIONS.find((o) => o.variant === variant)?.label ?? variant;
}

/** Instruction dirs used to resolve the identity text per variant. */
export interface SystemPromptVariantPaths {
  /** Profile override directory, e.g. `~/.wrongstack/profiles/<name>/instructions`. */
  globalDir?: string | undefined;
  /** Project override directory, e.g. `<project>/.wrongstack/instructions`. */
  projectDir?: string | undefined;
}

/**
 * Estimate the tokens of the system identity block each variant injects.
 *
 * Resolution goes through the same `loadInstructionBundle` the
 * SystemPromptBuilder runs (bundled -> global -> project, later layers override
 * `system.identity`), and composition goes through the builder's own
 * `buildIdentityLayer`. Calling the real composer matters: when the identity
 * came from the *project* layer, WS-016 makes the builder emit the bundled
 * identity PLUS a `<project-supplied-instructions>` delimiter block PLUS the
 * project text rather than replacing the identity. Counting
 * `bundle.system.identity` alone therefore under-reports a project override by
 * the whole bundled prompt - exactly the case a repo that ships its own
 * `system-pro.md` hits.
 *
 * The figure is an **upper bound**, not `/context` parity: `buildIdentityLayer`
 * is called without an `InstructionTemplateContext`, which by its own contract
 * keeps the full text, so `ws:if` blocks for tools the live request never
 * registers are still counted. Erring high is the right direction for a picker
 * whose purpose is comparing variant cost, and every figure is rendered with a
 * leading tilde.
 */
export async function countSystemPromptTokens(
  paths: SystemPromptVariantPaths,
): Promise<Record<SystemInstructionVariant, number>> {
  const counts = {} as Record<SystemInstructionVariant, number>;
  for (const variant of SYSTEM_PROMPT_VARIANTS) {
    const bundle = await loadInstructionBundle({
      globalDir: paths.globalDir,
      projectDir: paths.projectDir,
      systemVariant: variant,
    });
    const identity = buildIdentityLayer(
      bundle.system?.identity,
      bundle.system?.identitySource,
      undefined,
    );
    counts[variant] = estimateTextTokens(identity);
  }
  return counts;
}

/**
 * Read the variant the user explicitly saved to the profile config file.
 *
 * The config loader materializes `systemPrompt: { variant: 'default' }` for
 * every config (see the config-loader defaults), so the in-memory Config cannot
 * distinguish "user chose Standard" from "never chose". Only the raw file can:
 * {@link persistSystemPromptVariant} writes the key explicitly, so its presence
 * on disk is the signal that a selection was made. Absence (first run, or a
 * config edited before this feature existed) returns undefined, and the caller
 * shows the full picker instead of a one-line confirmation.
 */
export async function readSavedSystemPromptVariant(
  configPath: string,
): Promise<SystemInstructionVariant | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { systemPrompt?: { variant?: unknown } | undefined };
    const variant = parsed.systemPrompt?.variant;
    return isSystemInstructionVariant(variant) ? variant : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Persist the chosen variant to the profile config file so the next boot can
 * offer a one-line "Continue with these?" gate. Mirrors the launch-choices
 * writer: read the existing JSON, mutate only the `systemPrompt` block, write
 * back atomically with mode 0600. Other fields (including encrypted secrets)
 * pass through round-trip unchanged.
 *
 * @throws when the config file exists but is corrupt (same policy as the
 * launch-choices writer - never overwrite unreadable user config silently).
 */
export async function persistSystemPromptVariant(
  configPath: string,
  variant: SystemInstructionVariant,
): Promise<void> {
  let fileExists = false;
  try {
    await fs.access(configPath);
    fileExists = true;
  } catch {}

  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if (fileExists) {
      throw new Error(
        `Refusing to overwrite corrupt config at ${configPath} ` +
          `(${(err as Error).message}). Fix or move the file aside before retrying.`,
        { cause: err },
      );
    }
    existing = {};
  }

  const systemPrompt = (existing.systemPrompt ?? {}) as Record<string, unknown>;
  existing.systemPrompt = { ...systemPrompt, variant };

  await atomicWrite(configPath, JSON.stringify(existing, null, 2), { mode: 0o600 });
}

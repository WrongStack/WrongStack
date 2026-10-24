import type {
  ModelsRegistry,
  ProviderConfig,
  SecretScrubber,
  SecretVault,
} from '@wrongstack/contracts/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import type { AuthFlowIo, AuthFlowResult } from '@wrongstack/tui';
import type { AuthMenuDeps } from './types.js';

export interface AuthPanelServiceDeps {
  vault: SecretVault;
  modelsRegistry: ModelsRegistry;
  /** The sole config file read or written by auth operations. */
  profileConfigPath: string;
  secretScrubber?: SecretScrubber | undefined;
  providerAuthRegistry?: AuthMenuDeps['providerAuthRegistry'];
  /** Re-read the live provider snapshot after a successful auth mutation. */
  onProvidersChanged?: (() => Promise<void>) | undefined;
}

// ── Text bridge helpers ────────────────────────────────────────────────────

// Strip SGR color/style sequences — the flows emit `color.*`-formatted text
// for the terminal; the panel log renders plain text with its own styling.
export const ANSI_RE = /\u001b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/** Normalise a flow prompt ("  ? Label for this key [default]: ") for the modal. */
export function cleanPrompt(prompt: string): string {
  return stripAnsi(prompt)
    .replace(/[\r\n]+/g, ' ')
    .replace(/^\s*\?\s*/, '')
    .replace(/[:\s]+$/, '')
    .trim();
}

/** Fan a multi-line renderer write out into individual trimmed log lines. */
export function emitLines(io: AuthFlowIo, raw: string, prefix = ''): void {
  for (const line of stripAnsi(raw).split(/\r?\n/)) {
    const text = line.trim();
    if (text.length > 0) io.onLog(prefix + text);
  }
}

/** Adapt an {@link AuthFlowIo} bridge into the deps shape the flows expect. */
export function flowDeps(base: AuthPanelServiceDeps, io: AuthFlowIo): AuthMenuDeps {
  return {
    renderer: {
      write: (input: string) => emitLines(io, input),
      writeInfo: (text: string) => emitLines(io, text),
      writeWarning: (text: string) => emitLines(io, text, '⚠ '),
      writeError: (text: string) => emitLines(io, text, '✗ '),
    },
    reader: {
      readLine: (prompt = '') => io.prompt(cleanPrompt(prompt), { secret: false }),
      readSecret: (prompt: string) => io.prompt(cleanPrompt(prompt), { secret: true }),
    },
    modelsRegistry: base.modelsRegistry,
    vault: base.vault,
    profileConfigPath: base.profileConfigPath,
    providerAuthRegistry: base.providerAuthRegistry,
    secretScrubber: base.secretScrubber,
  };
}

export function isCancel(err: unknown): boolean {
  return (
    (err instanceof Error && err.name === 'AbortError') ||
    (err instanceof DOMException && err.name === 'AbortError')
  );
}

/** Run a flow, translating throws (Esc-cancel, I/O errors) into a result. */
export async function runFlow(
  run: () => Promise<boolean>,
  onSuccess?: (() => Promise<void>) | undefined,
): Promise<AuthFlowResult> {
  try {
    const ok = await run();
    if (ok) await onSuccess?.();
    return { ok };
  } catch (err) {
    if (isCancel(err)) return { ok: false, message: 'Cancelled.' };
    return { ok: false, message: toErrorMessage(err) };
  }
}

// ── Display helpers ────────────────────────────────────────────────────────

/** Plain (color-free) key mask: first 4 + last 4 characters. */
export function plainMaskedKey(key: string): string {
  if (!key) return '—';
  if (key.length <= 8) return '•'.repeat(key.length);
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** A model is editable when the provider lists it or defines it in `customModels`. */
export function hasEditableModel(provider: ProviderConfig, modelId: string): boolean {
  return (
    provider.models?.includes(modelId) === true ||
    Object.hasOwn(provider.customModels ?? {}, modelId)
  );
}

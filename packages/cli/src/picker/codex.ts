import type { ResolvedProvider } from '@wrongstack/core/types';
import { color } from '@wrongstack/core/utils';

const CODEX_PROVIDER_ID = 'openai-codex';
const CODEX_PICKER_HEADER = 'Select Model and Effort';
const CODEX_LEGACY_NOTE =
  'Access legacy models by running `wstack -m <model_name>` or in your `config.json`.';

/**
 * openai-codex picker preamble - the "Select Model and Effort" header + the
 * legacy-models note. Returns an empty string for any other provider.
 */
export function codexPickerPreamble(provider: ResolvedProvider): string {
  if (provider.id !== CODEX_PROVIDER_ID) return '';
  return `  ${color.bold(CODEX_PICKER_HEADER)}\n${color.dim(`  ${CODEX_LEGACY_NOTE}`)}\n\n`;
}

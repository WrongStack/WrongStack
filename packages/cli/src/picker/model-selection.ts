import type { ResolvedProvider } from '@wrongstack/core/types';
import { color } from '@wrongstack/core/utils';
import type { ReadlineInputReader } from '../input-reader.js';
import type { TerminalRenderer } from '../renderer.js';
import type { PickerResult } from './types.js';

export async function resolveModelSelection(
  answer: string,
  models: {
    id: string;
    name: string;
    release_date?: string | undefined;
    limit?: { context?: number | undefined };
    cost?: { input?: number | undefined; output?: number | undefined };
    tool_call?: boolean | undefined;
    reasoning?: boolean | undefined;
    modalities?: { input?: string[] | undefined };
  }[],
  provider: ResolvedProvider,
  _registry: unknown,
  renderer: TerminalRenderer,
  _reader: ReadlineInputReader,
): Promise<PickerResult | undefined> {
  const idx = Number.parseInt(answer, 10);
  let modelId: string | undefined;

  if (!Number.isNaN(idx) && idx >= 1 && idx <= models.length) {
    modelId = models[idx - 1]?.id;
  } else {
    const lower = answer.toLowerCase();
    const match = models.find((m) => m.id.toLowerCase() === lower);
    if (match) {
      modelId = match.id;
    } else {
      const partial = models.filter((m) => m.id.toLowerCase().includes(lower));
      if (partial.length === 1) {
        modelId = partial[0]?.id;
      } else if (partial.length > 1) {
        renderer.writeError(`"${answer}" matches multiple models. Be more specific.`);
        return undefined;
      }
    }
  }

  if (!modelId) {
    modelId = answer;
  }

  renderer.write(`\n  ${color.green('✓')} ${color.bold(provider.id)} / ${color.bold(modelId)}\n\n`);
  return { provider: provider.id, model: modelId };
}

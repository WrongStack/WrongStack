import type { ModelsRegistry, ResolvedProvider } from '@wrongstack/core/types';
import { color, expectDefined } from '@wrongstack/core/utils';
import type { ReadlineInputReader } from '../input-reader.js';
import type { TerminalRenderer } from '../renderer.js';
import { boxBottom, boxRow, boxTop, padVisible, theme } from './frame.js';
import { resolveModelSelection } from './model-selection.js';
import type { PickerResult } from './types.js';

export async function pickNumberedModel(opts: {
  provider: ResolvedProvider;
  registry: ModelsRegistry;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  defaultModel?: string | undefined;
}): Promise<PickerResult | undefined> {
  const { provider, registry, renderer, reader, defaultModel } = opts;
  const models = [...provider.models].sort((a, b) =>
    (b.release_date ?? '').localeCompare(a.release_date ?? ''),
  );

  if (models.length === 0) {
    renderer.write(
      color.dim(
        '  No models listed yet for this provider — type a model id to use it ' +
          '(local servers auto-discover models at launch).\n',
      ),
    );
    const typed = (
      await reader.readLine(`\n${color.amber('?')} Model id ${color.dim('(or Enter to cancel)')}: `)
    ).trim();
    if (!typed) {
      renderer.write(color.dim('Cancelled.\n'));
      return undefined;
    }
    renderer.write(`\n  ${color.green('✓')} ${color.bold(provider.id)} / ${color.bold(typed)}\n\n`);
    return { provider: provider.id, model: typed };
  }

  const defaultIdxInModels =
    defaultModel !== undefined ? models.findIndex((m) => m.id === defaultModel) : -1;

  const pageSize = 30;
  let offset = 0;

  while (offset < models.length) {
    const page = models.slice(offset, offset + pageSize);
    const pageFrom = offset + 1;
    const pageTo = Math.min(offset + page.length, models.length);
    renderer.write(`${boxTop(`Models ${pageFrom}–${pageTo} of ${models.length}`)}\n`);
    for (let i = 0; i < page.length; i++) {
      const m = expectDefined(page[i]);
      const num = offset + i + 1;
      const ctxRaw = m.limit?.context ? `${(m.limit.context / 1000).toFixed(0)}k` : '?';
      const ctx = theme.ctx(ctxRaw.padStart(6));
      const cost = m.cost?.input !== undefined ? `$${m.cost.input}/$${m.cost.output ?? '?'}` : '';
      const costCol = cost ? theme.cost(cost) : '';
      const capTags: string[] = [];
      if (m.tool_call) capTags.push('tools');
      if (m.reasoning) capTags.push('reason');
      if (m.modalities?.input?.includes('image')) capTags.push('vision');
      const capStr = capTags.map((c) => theme.caps(c)).join(color.dim(' '));
      const isDefault = m.id === defaultModel;
      const idLabel = isDefault ? theme.accent(color.bold(m.id)) : m.id;
      const suffix = isDefault ? color.dim(' (default)') : '';
      const num5 = color.dim(`${num}.`.padStart(5));
      renderer.write(
        `${boxRow(`${num5} ${padVisible(idLabel, 34)} ${ctx}  ${padVisible(costCol, 11)} ${capStr}${suffix}`)}\n`,
      );
    }
    renderer.write(`${boxBottom()}\n`);
    offset += pageSize;

    if (offset < models.length) {
      const more = (
        await reader.readLine(
          `\n${color.amber('?')} Showing ${Math.min(offset, models.length)}/${models.length} — Enter number, ${color.dim('Enter')} for more, or ${color.dim('q')} to quit: `,
        )
      ).trim();
      if (more.toLowerCase() === 'q') {
        renderer.write(color.dim('Cancelled.\n'));
        return undefined;
      }
      if (!more) continue;
      return resolveModelSelection(more, models, provider, registry, renderer, reader);
    }
  }

  const defaultHint =
    defaultIdxInModels >= 0 && defaultModel ? ` ${color.dim(`[Enter = ${defaultModel}]`)}` : '';
  const answer = (
    await reader.readLine(
      `\n${color.amber('?')} Select model (1-${models.length})${defaultHint} ${color.dim('[q to quit]')}: `,
    )
  ).trim();
  if (answer.toLowerCase() === 'q') {
    renderer.write(color.dim('Cancelled.\n'));
    return undefined;
  }
  if (!answer) {
    if (defaultIdxInModels >= 0 && defaultModel) {
      renderer.write(
        `\n  ${color.green('✓')} ${color.bold(provider.id)} / ${color.bold(defaultModel)}\n\n`,
      );
      return { provider: provider.id, model: defaultModel };
    }
    renderer.write(color.dim('Cancelled.\n'));
    return undefined;
  }
  return resolveModelSelection(answer, models, provider, registry, renderer, reader);
}

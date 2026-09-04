import * as path from 'node:path';
import {
  type BenchConfig,
  configFromCells,
  loadBenchConfig,
  parseCellList,
  CORE_CONFIG_DEFAULTS,
  SMOKE_CONFIG_DEFAULTS,
} from '@wrongstack/bench';

export const DEFAULT_BENCH_MODELS_FILE = 'bench.config.json';

export interface ResolveBenchRunConfigInput {
  suiteId: string;
  cwd: string;
  flags?: Record<string, string | boolean> | undefined;
  savedProvider?: string | undefined;
  savedModel?: string | undefined;
}

/**
 * Resolve the model matrix for `wstack bench run`.
 *
 * A missing default `bench.config.json` is not an error — fall through to
 * `--cell`, `--provider`/`--model`, or the saved CLI provider/model. Only an
 * explicit `--models <other-file>` that cannot be read fails closed.
 */
export async function resolveBenchRunConfig(
  input: ResolveBenchRunConfigInput,
): Promise<BenchConfig> {
  const suiteDefaults =
    input.suiteId === 'core'
      ? CORE_CONFIG_DEFAULTS
      : input.suiteId === 'smoke'
        ? SMOKE_CONFIG_DEFAULTS
        : undefined;
  const cellSpec = stringFlag(input.flags, 'cell') ?? stringFlag(input.flags, 'cells');
  if (cellSpec) {
    return configFromCells(parseCellList(cellSpec), suiteDefaults);
  }

  const providerFlag = stringFlag(input.flags, 'provider');
  const modelFlag = stringFlag(input.flags, 'model');
  if (providerFlag && modelFlag) {
    return configFromCells(
      [{ label: `${providerFlag}/${modelFlag}`, provider: providerFlag, model: modelFlag }],
      suiteDefaults,
    );
  }

  const modelsFlag = stringFlag(input.flags, 'models');
  const modelsPath = modelsFlag ?? DEFAULT_BENCH_MODELS_FILE;
  const resolvedModels = path.resolve(input.cwd, modelsPath);
  const customModelsFile = modelsFlag !== undefined && modelsFlag !== DEFAULT_BENCH_MODELS_FILE;

  try {
    return await loadBenchConfig(resolvedModels);
  } catch (err) {
    if (customModelsFile || !isMissingConfigError(err)) throw err;
  }

  const savedProvider = input.savedProvider;
  const savedModel = input.savedModel;
  if (savedProvider && savedModel) {
    return configFromCells(
      [
        {
          label: `${savedProvider}/${savedModel}`,
          provider: savedProvider,
          model: savedModel,
        },
      ],
      suiteDefaults,
    );
  }

  throw new Error(
    'No model cells. Pass --cell provider/model[,provider/model], --provider + --model, or --models <config.json>',
  );
}

function stringFlag(
  flags: Record<string, string | boolean> | undefined,
  name: string,
): string | undefined {
  const value = flags?.[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isMissingConfigError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /ENOENT|no such file or directory/i.test(message);
}

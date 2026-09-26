/**
 * TechStackView — analyze controls.
 *
 * The control bar the user picks depth (Inventory / +Advisories / +AI) and
 * the model id for the next analyze run, before they click "Analyze with AI".
 *
 * The depth/model choices live on the store (`selectedDepth` / `selectedModel`)
 * so a refresh keeps them and so the same controls work in both the empty
 * "no snapshot" state and the populated state.
 *
 * `availableModels` is lazy-loaded via `GET /api/techstack/models`; until the
 * response lands, the model picker is disabled with a hint that no provider
 * is wired yet.
 */

import { useCallback, useEffect, useState } from 'react';
import { Brain, Loader2, Sparkles, Zap } from 'lucide-react';
import {
  type TechStackAnalyzeDepth,
  type TechStackModelInfo,
  useTechStackStore,
} from '@/stores';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';

interface AnalyzeControlsProps {
  /** Disabled while a job is in flight. */
  readonly busy: boolean;
  /** Kick off an `analyze` run with the current depth/model selection. */
  readonly onAnalyze: () => void;
  /** Kick off an `inventory`-only run regardless of the depth selector. */
  readonly onInventory: () => void;
}

async function jsonOrThrow<T>(response: Response): Promise<T> {
  const text = await response.text();
  const body: unknown = text.length > 0 ? safeParse(text) : null;
  if (!response.ok) {
    const detail =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error?: unknown }).error)
        : text || `${response.status} ${response.statusText}`;
    throw new Error(detail);
  }
  return body as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function fetchModels(): Promise<TechStackModelInfo> {
  const res = await fetch('/api/techstack/models', { method: 'GET' });
  const body = await jsonOrThrow<TechStackModelInfo>(res);
  return body;
}

const DEPTH_OPTIONS: ReadonlyArray<{ value: TechStackAnalyzeDepth; labelKey: string }> = [
  { value: 'inventory', labelKey: 'activity:techStack.depthInventory' },
  { value: 'enrich', labelKey: 'activity:techStack.depthEnrich' },
  { value: 'full', labelKey: 'activity:techStack.depthFull' },
];

export function AnalyzeControls({ busy, onAnalyze, onInventory }: AnalyzeControlsProps) {
  const { t } = useAppTranslation();
  const selectedDepth = useTechStackStore((state) => state.selectedDepth);
  const selectedModel = useTechStackStore((state) => state.selectedModel);
  const availableModels = useTechStackStore((state) => state.availableModels);
  const setSelectedDepth = useTechStackStore((state) => state.setSelectedDepth);
  const setSelectedModel = useTechStackStore((state) => state.setSelectedModel);
  const setAvailableModels = useTechStackStore((state) => state.setAvailableModels);

  const [modelsLoading, setModelsLoading] = useState(false);

  const refreshModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const next = await fetchModels();
      setAvailableModels(next);
    } catch {
      // The endpoint always answers 200 with `{ available: false }`, so an
      // exception here means the server is unreachable. Keep the previous
      // models value rather than blanking the picker.
    } finally {
      setModelsLoading(false);
    }
  }, [setAvailableModels]);

  useEffect(() => {
    if (!availableModels && !modelsLoading) {
      void refreshModels();
    }
  }, [availableModels, modelsLoading, refreshModels]);

  const aiDisabled = busy || !availableModels?.available;
  const inventoryDisabled = busy;

  return (
    <div className="shrink-0 border-b border-border/70 bg-card/45 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
          {t('activity:techStack.runControls')}
        </p>
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <fieldset className="flex flex-wrap items-center gap-1.5" aria-label={t('activity:techStack.depthPicker')}>
          {DEPTH_OPTIONS.map((option) => {
            const selected = selectedDepth === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setSelectedDepth(option.value)}
                aria-pressed={selected}
                disabled={busy}
                className={cn(
                  'inline-flex h-7 items-center gap-1 border px-2 text-[10px] font-medium',
                  selected
                    ? 'border-info/55 bg-info/15 text-info'
                    : 'border-border/70 bg-background text-muted-foreground hover:text-foreground',
                )}
              >
                <DepthIcon depth={option.value} />
                {t(option.labelKey)}
              </button>
            );
          })}
        </fieldset>

        <div className="flex items-center gap-1.5">
          <label htmlFor="techstack-model-picker" className="sr-only">
            {t('activity:techStack.modelPicker')}
          </label>
          <select
            id="techstack-model-picker"
            value={selectedModel ?? (availableModels?.model ?? '')}
            onChange={(event) => setSelectedModel(event.target.value || null)}
            disabled={aiDisabled || modelsLoading}
            className="h-7 w-full min-w-0 border border-border/70 bg-background px-2 text-[10px]"
          >
            {!availableModels ? (
              <option value="">{t('activity:techStack.loadingModels')}</option>
            ) : !availableModels.available ? (
              <option value="">{t('activity:techStack.noModelConfigured')}</option>
            ) : (
              <>
                <option value="">{t('activity:techStack.useActiveModel', { model: availableModels.model ?? '?' })}</option>
                {availableModels.candidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.id}
                  </option>
                ))}
              </>
            )}
          </select>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void refreshModels()}
            disabled={modelsLoading}
            aria-label={t('activity:techStack.refreshModels')}
            title={t('activity:techStack.refreshModels')}
            className="h-7 w-7 shrink-0"
          >
            <Loader2 className={cn('size-3.5', modelsLoading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={onInventory} disabled={inventoryDisabled}>
          <Zap className="size-3.5" />
          {t('activity:techStack.runInventory')}
        </Button>
        <Button size="sm" onClick={onAnalyze} disabled={aiDisabled}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
          {t('activity:techStack.runAnalyze')}
        </Button>
        {!availableModels?.available && !modelsLoading && (
          <p className="text-[10px] text-muted-foreground">
            {t('activity:techStack.aiRequiresModel')}
          </p>
        )}
      </div>
    </div>
  );
}

function DepthIcon({ depth }: { depth: TechStackAnalyzeDepth }) {
  switch (depth) {
    case 'inventory':
      return <Zap className="size-3" />;
    case 'enrich':
      return <Brain className="size-3" />;
    case 'full':
      return <Sparkles className="size-3" />;
    default:
      return null;
  }
}

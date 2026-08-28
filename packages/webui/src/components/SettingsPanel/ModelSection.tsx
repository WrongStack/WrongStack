import { Cpu, Loader2, RefreshCw } from 'lucide-react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores';
import { Button } from '../ui/button';
import { PickerCardList } from '../ui/PickerCardList';

interface CatalogModel {
  id: string;
  name: string;
  releaseDate?: string | undefined;
  contextWindow?: number | undefined;
  inputCost?: number | undefined;
  outputCost?: number | undefined;
  capabilities: string[];
  /** Effort levels the model documents (models.dev reasoningConfig). */
  reasoningEffortLevels?: string[] | undefined;
}

interface CatalogProvider {
  id: string;
  name: string;
}

export interface ModelSectionProps {
  /** Current provider id. */
  provider: string;
  /** Provider → models cache. */
  catalogModels: Record<string, CatalogModel[]>;
  /** The current catalog provider object (for displaying name). */
  currentCatalogProvider: CatalogProvider | undefined;
  /** Loading flag. */
  isLoadingModels: boolean;
  isSwitching: boolean;
  setIsLoadingModels: (v: boolean) => void;
  /** Called when a model is selected. */
  onModelSelect: (modelId: string) => void;
  /** Refresh model list from backend. */
  refreshModels: (providerId: string) => void;
}

export function ModelSection({
  provider,
  catalogModels,
  currentCatalogProvider,
  isLoadingModels,
  isSwitching,
  setIsLoadingModels,
  onModelSelect,
  refreshModels,
}: ModelSectionProps) {
  const model = useConfigStore((s) => s.model);
  const { t } = useAppTranslation();

  return (
    <div className="space-y-4">
      {provider ? (
        <>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">{currentCatalogProvider?.name || provider}</p>
              <p className="text-xs text-muted-foreground">{provider}</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setIsLoadingModels(true);
                refreshModels(provider);
              }}
            >
              <RefreshCw className={cn('h-4 w-4', isLoadingModels && 'animate-spin')} />
            </Button>
          </div>

          {isLoadingModels && !catalogModels[provider] ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              <span className="ml-2 text-muted-foreground">{t('settings:model.loading')}</span>
            </div>
          ) : (
            <>
              <PickerCardList
                options={(catalogModels[provider] || []).map((m) => ({
                  id: m.id,
                  label: m.name || m.id,
                  badges: m.capabilities,
                  detail: [
                    m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k` : '',
                    m.inputCost != null ? `${m.inputCost}/${m.outputCost}` : '',
                    m.reasoningEffortLevels?.length
                      ? `effort ${m.reasoningEffortLevels.join('/')}`
                      : '',
                  ]
                    .filter(Boolean)
                    .join(' · '),
                  detailHighlight: true,
                }))}
                selectedId={model}
                onSelect={onModelSelect}
                disabled={isSwitching}
                emptyMessage={t('settings:model.notFound')}
              />
              {isSwitching ? (
                <p className="text-xs text-muted-foreground">{t('settings:toast.switching')}</p>
              ) : null}
            </>
          )}
        </>
      ) : (
        <div className="text-center py-8 text-muted-foreground">
          <Cpu className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p>{t('settings:model.selectProviderFirst')}</p>
        </div>
      )}
    </div>
  );
}

import { toast } from '@/components/Toaster';
import { useFieldKeyboardNav } from '@/hooks/useFieldKeyboardNav';
import { getWSClient } from '@/lib/ws-client';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores';
import { useAppTranslation } from '@/i18n';
import { ChevronRight, Loader2, Plus } from 'lucide-react';
import { useState } from 'react';
import { LOCAL_PRESET_FAMILY, LOCAL_SERVER_PRESETS } from '../SettingsPanel/local-presets';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { waitForKeyOperationResult } from './key-operation';
import { ModelEditor, type ModelEntry } from './ModelEditor';

export function CustomProviderSection({
  onKeySaved,
}: {
  onKeySaved: (providerId: string) => void;
}) {
  const { t } = useAppTranslation();
  const [expanded, setExpanded] = useState(false);
  const [providerId, setProviderId] = useState('');
  const [family, setFamily] = useState<string>('openai-compatible');
  const [baseUrl, setBaseUrl] = useState('');
  const [key, setKey] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const { setFieldRef, handleKeyDown } = useFieldKeyboardNav();

  const handleSave = async () => {
    if (!providerId.trim()) return;
    setIsSaving(true);
    try {
      const ws = getWSClient(useConfigStore.getState().wsUrl);
      const ack = waitForKeyOperationResult(ws);
      ws.send({
        type: 'provider.add',
        payload: {
          id: providerId.trim(),
          family,
          baseUrl: baseUrl.trim() || undefined,
          apiKey: key.trim() || undefined,
          models: models.length > 0 ? models.map((m) => m.id) : undefined,
          customModels:
            models.length > 0
              ? Object.fromEntries(
                  models
                    .filter((m) => m.name || m.maxOutput || m.capabilities)
                    .map((m) => [
                      m.id,
                      {
                        ...(m.name && m.name !== m.id ? { name: m.name } : {}),
                        ...(m.maxOutput ? { maxOutput: m.maxOutput } : {}),
                        ...(m.capabilities && Object.values(m.capabilities).some(Boolean)
                          ? { capabilities: m.capabilities }
                          : {}),
                      },
                    ]),
                )
              : undefined,
        },
      });
      const result = await ack;
      if (!result.success) throw new Error(result.message);
      toast.success(t('setup:screen.toasts.providerAdded', { id: providerId.trim() }));
      onKeySaved(providerId.trim());
      ws.listSavedProviders();
      ws.probeProvider(providerId.trim());
      setProviderId('');
      setBaseUrl('');
      setKey('');
      setModels([]);
      setExpanded(false);
    } catch (err) {
      const detail =
        err instanceof Error && err.message && err.message !== 'timeout' ? err.message : null;
      toast.error(detail ?? t('setup:screen.toasts.providerAddFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-dashed border-border/60 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 p-4 text-left hover:bg-muted/30 transition-colors"
      >
        <div className="w-10 h-10 rounded-lg bg-muted/50 flex items-center justify-center">
          <Plus className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-medium">{t('setup:screen.custom.title')}</h3>
          <p className="text-xs text-muted-foreground">{t('setup:screen.custom.description')}</p>
        </div>
        <ChevronRight
          className={cn(
            'h-4 w-4 text-muted-foreground transition-transform',
            expanded && 'rotate-90',
          )}
        />
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-border/40">
          {/* Local-server quick-pick - mirrors the CLI's `wstack auth local`. */}
          <div className="space-y-1.5 pt-3">
            <span className="text-[11px] font-medium text-muted-foreground block">
              {t('setup:screen.custom.localServers')}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {LOCAL_SERVER_PRESETS.map((preset) => (
                <Button
                  key={preset.id}
                  type="button"
                  size="sm"
                  variant={providerId === preset.id ? 'default' : 'outline'}
                  onClick={() => {
                    setProviderId(preset.id);
                    setFamily(LOCAL_PRESET_FAMILY);
                    setBaseUrl(preset.defaultBaseUrl);
                    if (preset.noAuth) setKey('');
                    setModels([]);
                  }}
                  title={preset.hint}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className="text-[11px] font-medium text-muted-foreground mb-1 block">
                {t('setup:screen.custom.providerId')}
              </span>
              <Input
                placeholder={t('activity:customProviderSection.eGMyLlm')}
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
                className="text-sm"
                ref={setFieldRef(0)}
                onKeyDown={(e) => handleKeyDown(e, 0)}
              />
            </div>
            <div>
              <span className="text-[11px] font-medium text-muted-foreground mb-1 block">
                {t('setup:screen.custom.family')}
              </span>
              <select
                value={family}
                onChange={(e) => setFamily(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                ref={setFieldRef(1)}
                onKeyDown={(e) => handleKeyDown(e, 1)}
              >
                <option value="openai-compatible">
                  {t('setup:screen.custom.familyOpenAiCompatible')}
                </option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="google">Google</option>
              </select>
            </div>
          </div>
          <div>
            <span className="text-[11px] font-medium text-muted-foreground mb-1 block">
              {t('setup:screen.custom.baseUrl')}
            </span>
            <Input
              placeholder={t('activity:customProviderSection.eGHttpLocalhost11434V1')}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="text-sm font-mono"
              ref={setFieldRef(2)}
              onKeyDown={(e) => handleKeyDown(e, 2)}
            />
          </div>
          <div>
            <span className="text-[11px] font-medium text-muted-foreground mb-1 block">
              {t('setup:screen.custom.apiKey')}
            </span>
            <Input
              type="password"
              placeholder={t('setup:screen.custom.apiKeyPlaceholder')}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              className="text-sm font-mono"
              ref={setFieldRef(3)}
              onKeyDown={(e) => handleKeyDown(e, 3)}
            />
          </div>

          {/* Model editor */}
          <ModelEditor models={models} onChange={setModels} />

          <Button
            onClick={handleSave}
            disabled={!providerId.trim() || isSaving}
            size="sm"
            ref={setFieldRef(4)}
            onKeyDown={(e) => handleKeyDown(e, 4, handleSave)}
          >
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            {t('setup:screen.custom.add')}
          </Button>
        </div>
      )}
    </div>
  );
}

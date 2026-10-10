import type { TFunction } from 'i18next';
import {
  Cpu,
  Eye,
  EyeOff,
  Globe,
  Key,
  Loader2,
  Plus,
  Server,
  ShieldCheck,
  Trash2,
} from 'lucide-react';

import { confirmModal } from '@/components/ConfirmModal';
import { isProviderDisabled } from '@/components/QuickModelSwitcher.filter';

import { ModelEditor } from '../SetupScreen/ModelEditor';

import { ApiKeyDisplay } from '../ui/api-key-display';

import { Button } from '../ui/button';

import { Input } from '../ui/input';

import { LOCAL_SERVER_PRESETS } from './local-presets';

import { PreferenceToggle } from './PreferenceToggle';

import { ProviderModelsPanel } from './ProviderModelsPanel';
import { ProviderCloudSettings } from './ProviderCloudSettings';
export function ProviderSavedProfiles({
  t,
  savedProviders,
  savedProviderStats,
  setShowAddProviderForm,
  showAddProviderForm,
  newProviderId,
  handlePickLocalPreset,
  setNewProviderId,
  addProviderNav,
  newProviderFamily,
  setNewProviderFamily,
  newProviderBaseUrl,
  setNewProviderBaseUrl,
  newProviderApiKey,
  setNewProviderApiKey,
  newProviderModels,
  setNewProviderModels,
  handleAddProvider,
  saving,
  isLoadingSaved,
  save,
  onRemoveProvider,
  ws,
  onPickProviderModel,
  disabledProviders,
  onToggleProviderDisabled,
  setShowAddKeyForm,
  showAddKeyForm,
  onSetActiveKey,
  onDeleteKey,
  newKeyLabel,
  setNewKeyLabel,
  addKeyNav,
  showNewKeyValue,
  newKeyValue,
  setNewKeyValue,
  setShowNewKeyValue,
  handleAddKey,
}: {
  t: TFunction<'translation', undefined>;
  savedProviders: import('./provider-section-types.js').SavedProvider[];
  savedProviderStats: { keys: number; activeKeys: number; models: number };
  setShowAddProviderForm: React.Dispatch<React.SetStateAction<boolean>>;
  showAddProviderForm: boolean;
  newProviderId: string;
  handlePickLocalPreset: (
    preset: import('../../../../providers/dist/provider-definitions.js').LocalProviderPresetProjection,
  ) => void;
  setNewProviderId: React.Dispatch<React.SetStateAction<string>>;
  addProviderNav: {
    setFieldRef: (index: number) => (el: HTMLElement | null) => void;
    handleKeyDown: (
      e: React.KeyboardEvent<Element>,
      index: number,
      onEnter?: (() => void) | undefined,
    ) => void;
  };
  newProviderFamily: string;
  setNewProviderFamily: React.Dispatch<React.SetStateAction<string>>;
  newProviderBaseUrl: string;
  setNewProviderBaseUrl: React.Dispatch<React.SetStateAction<string>>;
  newProviderApiKey: string;
  setNewProviderApiKey: React.Dispatch<React.SetStateAction<string>>;
  newProviderModels: import('../SetupScreen/ModelEditor.js').ModelEntry[];
  setNewProviderModels: React.Dispatch<
    React.SetStateAction<import('../SetupScreen/ModelEditor.js').ModelEntry[]>
  >;
  handleAddProvider: () => void;
  saving: boolean;
  isLoadingSaved: boolean;
  save: (action: () => void | Promise<boolean | void>, confirmed: () => void) => Promise<void>;
  onRemoveProvider: (providerId: string) => void | Promise<boolean>;
  ws: import('../../lib/ws-client.js').WrongStackWebSocketClient;
  onPickProviderModel: (providerId: string, modelId: string) => void;
  /** Provider ids switched off entirely (`Config.disabledProviders`). */
  disabledProviders: string[];
  /** Flip one provider's disabled state (persisted through `updatePrefs`). */
  onToggleProviderDisabled: (providerId: string) => void;
  setShowAddKeyForm: React.Dispatch<React.SetStateAction<string | null>>;
  showAddKeyForm: string | null;
  onSetActiveKey: (providerId: string, label: string) => void | Promise<boolean>;
  onDeleteKey: (providerId: string, label: string) => void | Promise<boolean>;
  newKeyLabel: string;
  setNewKeyLabel: React.Dispatch<React.SetStateAction<string>>;
  addKeyNav: {
    setFieldRef: (index: number) => (el: HTMLElement | null) => void;
    handleKeyDown: (
      e: React.KeyboardEvent<Element>,
      index: number,
      onEnter?: (() => void) | undefined,
    ) => void;
  };
  showNewKeyValue: boolean;
  newKeyValue: string;
  setNewKeyValue: React.Dispatch<React.SetStateAction<string>>;
  setShowNewKeyValue: React.Dispatch<React.SetStateAction<boolean>>;
  handleAddKey: (providerId: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{t('settings:provider.manageKeys')}</p>
          <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/30 px-2 py-1">
              <Server className="h-3.5 w-3.5" />
              {t('settings:provider.savedProviderCount', { count: savedProviders.length })}
            </span>
            <span className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/30 px-2 py-1">
              <Key className="h-3.5 w-3.5" />
              {t('settings:provider.keyCount', { count: savedProviderStats.keys })}
            </span>
            <span className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/30 px-2 py-1">
              <ShieldCheck className="h-3.5 w-3.5" />
              {t('settings:provider.activeKeyCount', { count: savedProviderStats.activeKeys })}
            </span>
            <span className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/30 px-2 py-1">
              <Cpu className="h-3.5 w-3.5" />
              {t('settings:provider.modelCount', { count: savedProviderStats.models })}
            </span>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setShowAddProviderForm(!showAddProviderForm)}
        >
          <Plus className="h-4 w-4 mr-1" />
          {t('settings:provider.addProvider')}
        </Button>
      </div>

      {/* Add Provider Form */}
      {showAddProviderForm && (
        <div className="p-4 border rounded-lg space-y-3 bg-muted/50">
          <h4 className="font-medium">{t('settings:provider.addCustomHeading')}</h4>

          {/* Local-server quick-pick — mirrors the CLI's `wstack auth
                  local`. Click a preset to pre-fill id / family / baseUrl. */}
          <div className="space-y-1.5">
            <span className="text-xs text-muted-foreground">
              {t('settings:provider.localServers')}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {LOCAL_SERVER_PRESETS.map((preset) => (
                <Button
                  key={preset.id}
                  type="button"
                  size="sm"
                  variant={newProviderId === preset.id ? 'default' : 'outline'}
                  onClick={() => handlePickLocalPreset(preset)}
                  title={preset.hint}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
          </div>

          <Input
            placeholder={t('settings:provider.providerIdPlaceholder')}
            value={newProviderId}
            onChange={(e) => setNewProviderId(e.target.value)}
            ref={addProviderNav.setFieldRef(0)}
            onKeyDown={(e) => addProviderNav.handleKeyDown(e, 0)}
          />
          <select
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={newProviderFamily}
            onChange={(e) => setNewProviderFamily(e.target.value)}
            ref={addProviderNav.setFieldRef(1)}
            onKeyDown={(e) => addProviderNav.handleKeyDown(e, 1)}
          >
            <option value="anthropic">{t('activity:provider.anthropic')}</option>
            <option value="openai">{t('activity:provider.openai')}</option>
            <option value="openai-compatible">{t('activity:provider.openaiCompatible')}</option>
            <option value="google">{t('activity:provider.google')}</option>
          </select>
          <Input
            placeholder={t('activity:provider.baseUrlOptionalEGHttpLocalhost11434V1')}
            value={newProviderBaseUrl}
            onChange={(e) => setNewProviderBaseUrl(e.target.value)}
            ref={addProviderNav.setFieldRef(2)}
            onKeyDown={(e) => addProviderNav.handleKeyDown(e, 2)}
          />
          <Input
            type="password"
            placeholder={t('settings:provider.apiKeyOptionalPlaceholder')}
            value={newProviderApiKey}
            onChange={(e) => setNewProviderApiKey(e.target.value)}
            ref={addProviderNav.setFieldRef(3)}
            onKeyDown={(e) => addProviderNav.handleKeyDown(e, 3)}
          />

          {/* Model editor — search catalog, confirm matches, add custom IDs */}
          <ModelEditor models={newProviderModels} onChange={setNewProviderModels} />

          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={handleAddProvider}
              disabled={saving || !newProviderId.trim()}
              ref={addProviderNav.setFieldRef(4)}
              onKeyDown={(e) => addProviderNav.handleKeyDown(e, 4, handleAddProvider)}
            >
              {t('common:action.add')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowAddProviderForm(false)}
              ref={addProviderNav.setFieldRef(5)}
              onKeyDown={(e) => addProviderNav.handleKeyDown(e, 5)}
            >
              {t('common:action.cancel')}
            </Button>
          </div>
        </div>
      )}

      {isLoadingSaved ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : savedProviders.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <Key className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p>{t('settings:provider.noSaved')}</p>
          <p className="text-sm">{t('settings:provider.noSavedHint')}</p>
        </div>
      ) : (
        savedProviders.map((sp) => (
          <div
            key={sp.id}
            className="rounded-lg border border-border/80 bg-card/70 p-4 shadow-sm shadow-black/[0.02]"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h4 className="min-w-0 break-words font-mono text-sm font-semibold text-foreground">
                    {sp.id}
                  </h4>
                  {isProviderDisabled(sp.id, disabledProviders) && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                      <EyeOff className="h-3 w-3" />
                      {t('settings:provider.disabledBadge')}
                    </span>
                  )}
                  {sp.family && (
                    <span className="rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                      {sp.family}
                    </span>
                  )}
                  {sp.apiKeys.some((key) => key.isActive) && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">
                      <ShieldCheck className="h-3 w-3" />
                      {t('settings:provider.active')}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  {sp.baseUrl && (
                    <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/70 bg-background/60 px-2 py-1">
                      <Globe className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{sp.baseUrl}</span>
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-background/60 px-2 py-1">
                    <Cpu className="h-3.5 w-3.5" />
                    {t('settings:provider.modelCount', { count: sp.models?.length ?? 0 })}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-background/60 px-2 py-1">
                    <Key className="h-3.5 w-3.5" />
                    {t('settings:provider.keyCount', { count: sp.apiKeys.length })}
                  </span>
                </div>
              </div>
              <div className="flex gap-2 sm:justify-end">
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={saving}
                  onClick={() =>
                    void save(
                      async () => {
                        if (
                          !(await confirmModal({
                            title: t('settings:provider.removeProfileConfirm', {
                              alias: sp.id,
                            }),
                            message: t('settings:provider.removeProfileBody'),
                            confirmLabel: t('common:action.delete'),
                            danger: true,
                            defaultAction: 'cancel',
                          }))
                        )
                          return false;
                        return onRemoveProvider(sp.id);
                      },
                      () => {},
                    )
                  }
                  aria-label={`Remove provider ${sp.id}`}
                  title={`Remove provider ${sp.id}`}
                  className="h-8 w-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-border/70 bg-background/60 px-3">
              <PreferenceToggle
                label={t('settings:provider.disableToggle')}
                hint={t('settings:provider.disableToggleHint')}
                value={isProviderDisabled(sp.id, disabledProviders)}
                disabled={saving}
                onChange={() => onToggleProviderDisabled(sp.id)}
              />
            </div>

            <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.85fr)]">
              <ProviderCloudSettings
                key={sp.id}
                id={sp.id}
                type={sp.type ?? sp.id}
                cloud={sp.cloud}
                ws={ws}
              />
              <ProviderModelsPanel
                providerId={sp.id}
                savedPickedModelId={sp.pickedModelId}
                savedModels={sp.models}
                savedCustomModels={sp.customModels}
                ws={ws}
                onPickModel={onPickProviderModel}
              />

              {/* API Keys */}
              <div className="rounded-lg border border-border/70 bg-background/75 p-3 shadow-sm shadow-black/[0.02]">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="text-sm font-semibold">
                      {t('settings:provider.apiKeysLabel')}
                    </span>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t('settings:provider.keyCount', { count: sp.apiKeys.length })}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setShowAddKeyForm(showAddKeyForm === sp.id ? null : sp.id)}
                    className="h-8 px-2 text-xs"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t('settings:provider.addKey')}
                  </Button>
                </div>

                {sp.apiKeys.length === 0 && !showAddKeyForm && (
                  <p className="mt-3 rounded-md border border-dashed border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                    {t('settings:provider.noKeys')}
                  </p>
                )}

                {sp.apiKeys.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {sp.apiKeys.map((key) => (
                      <div
                        key={key.label}
                        className="flex flex-col gap-2 rounded-lg border border-border/70 bg-muted/20 p-2.5 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="flex min-w-0 items-start gap-2">
                          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background text-muted-foreground">
                            <Key className="h-3.5 w-3.5" />
                          </span>
                          <div className="min-w-0">
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                              <span className="truncate text-sm font-medium">{key.label}</span>
                              {key.isActive && (
                                <span className="rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">
                                  {t('settings:provider.active')}
                                </span>
                              )}
                            </div>
                            <div className="mt-0.5">
                              <ApiKeyDisplay maskedKey={key.maskedKey} />
                            </div>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center justify-end gap-1">
                          {!key.isActive && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={saving}
                              onClick={() =>
                                void save(
                                  () => onSetActiveKey(sp.id, key.label),
                                  () => {},
                                )
                              }
                              className="h-8 px-2 text-xs"
                            >
                              {t('settings:provider.setActive')}
                            </Button>
                          )}
                          <Button
                            size="icon"
                            variant="ghost"
                            disabled={saving}
                            onClick={() =>
                              void save(
                                async () => {
                                  if (
                                    !(await confirmModal({
                                      title: t('settings:provider.deleteKeyConfirm', {
                                        alias: sp.id,
                                        label: key.label,
                                      }),
                                      confirmLabel: t('common:action.delete'),
                                      danger: true,
                                      defaultAction: 'cancel',
                                    }))
                                  )
                                    return false;
                                  return onDeleteKey(sp.id, key.label);
                                },
                                () => {},
                              )
                            }
                            aria-label={`Delete key ${key.label}`}
                            title={`Delete key ${key.label}`}
                            className="h-8 w-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Add Key Form */}
                {showAddKeyForm === sp.id && (
                  <div className="mt-3 space-y-2 rounded-lg border border-border/70 bg-background p-3">
                    <Input
                      placeholder={t('settings:provider.keyLabelPlaceholder')}
                      value={newKeyLabel}
                      onChange={(e) => setNewKeyLabel(e.target.value)}
                      ref={addKeyNav.setFieldRef(0)}
                      onKeyDown={(e) => addKeyNav.handleKeyDown(e, 0)}
                    />
                    <div className="flex gap-2">
                      <Input
                        type={showNewKeyValue ? 'text' : 'password'}
                        placeholder={t('settings:provider.apiKeyPlaceholder')}
                        value={newKeyValue}
                        onChange={(e) => setNewKeyValue(e.target.value)}
                        ref={addKeyNav.setFieldRef(1)}
                        onKeyDown={(e) => addKeyNav.handleKeyDown(e, 1)}
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => setShowNewKeyValue(!showNewKeyValue)}
                      >
                        {showNewKeyValue ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        onClick={() => handleAddKey(sp.id)}
                        disabled={saving || !newKeyLabel.trim() || !newKeyValue.trim()}
                        ref={addKeyNav.setFieldRef(2)}
                        onKeyDown={(e) => addKeyNav.handleKeyDown(e, 2, () => handleAddKey(sp.id))}
                      >
                        {t('settings:provider.saveKey')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setShowAddKeyForm(null);
                          setNewKeyLabel('');
                          setNewKeyValue('');
                        }}
                        ref={addKeyNav.setFieldRef(3)}
                        onKeyDown={(e) => addKeyNav.handleKeyDown(e, 3)}
                      >
                        {t('common:action.cancel')}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

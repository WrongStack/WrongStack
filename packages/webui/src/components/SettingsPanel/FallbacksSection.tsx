import { Cpu, ListPlus, Layers } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { i18n, useAppTranslation } from '@/i18n';
import { useLocalPrefs } from '@/stores/local-prefs';
import { toast } from '@/components/Toaster';
import { FallbackEditor } from '@/components/FallbackEditor';
import { ModelSelectDialog } from '@/components/ModelSelectDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PreferenceToggle } from './PreferenceToggle';

interface FallbacksSectionProps {
  /** Push a pref change locally + to the server. */
  syncPref: (key: string, value: unknown) => void;
  /** Candidate models for fallback editors. */
  candidates?: Array<{ provider: string; model: string; label: string }> | undefined;
  /** Active provider for creating default profile. */
  provider?: string | undefined;
  /** Active model for creating default profile. */
  activeModel?: string | undefined;
  /** Update the active session provider. */
  setProvider: (provider: string) => void;
  /** Update the active session model. */
  setModel: (model: string) => void;
  /** Switch the running session's provider/model on the server. */
  switchModel?: ((provider: string, model: string) => void) | undefined;
}

export function FallbacksSection({
  syncPref,
  candidates,
  provider: activeProvider,
  activeModel,
  setProvider,
  setModel,
  switchModel,
}: FallbacksSectionProps) {
  const { t } = useAppTranslation();
  const localPrefs = useLocalPrefs();
  const [newFallbackProfileName, setNewFallbackProfileName] = useState('');

  const setFallbackProfiles = useCallback(
    (next: Record<string, string[]>) => syncPref('fallbackProfiles', next),
    [syncPref],
  );

  const addFallbackProfile = useCallback(() => {
    const name = newFallbackProfileName.trim();
    if (!name) return;
    if (localPrefs.fallbackProfiles[name]) {
      toast.error(i18n.t('settings:toast.fallbackExists', { name }));
      return;
    }
    setFallbackProfiles({ ...localPrefs.fallbackProfiles, [name]: [] });
    setNewFallbackProfileName('');
  }, [localPrefs.fallbackProfiles, newFallbackProfileName, setFallbackProfiles]);

  const removeFallbackProfile = useCallback(
    (name: string) => {
      const { [name]: _removed, ...rest } = localPrefs.fallbackProfiles;
      setFallbackProfiles(rest);
    },
    [localPrefs.fallbackProfiles, setFallbackProfiles],
  );

  const updateFallbackProfile = useCallback(
    (name: string, chain: string[]) => {
      setFallbackProfiles({ ...localPrefs.fallbackProfiles, [name]: chain });
    },
    [localPrefs.fallbackProfiles, setFallbackProfiles],
  );

  const createDefaultFallbackProfile = useCallback(() => {
    const primary = activeProvider && activeModel ? `${activeProvider}/${activeModel}` : '';
    if (!primary) {
      toast.error(i18n.t('settings:toast.selectProviderModelFirst'));
      return;
    }
    const chain = [primary, ...localPrefs.fallbackModels].filter(
      (ref, index, arr) => ref && arr.indexOf(ref) === index,
    );
    setFallbackProfiles({ ...localPrefs.fallbackProfiles, default: chain });
    toast.success(i18n.t('settings:toast.defaultProfileCreated'));
  }, [
    activeModel,
    activeProvider,
    localPrefs.fallbackModels,
    localPrefs.fallbackProfiles,
    setFallbackProfiles,
  ]);

  // Auto-create a `default` fallback profile once for fresh configs that have
  // no profiles yet, as soon as an active provider/model is known. Guarded so
  // it fires at most once and never resurrects a profile the user deleted.
  const autoDefaultCreatedRef = useRef(false);
  useEffect(() => {
    if (autoDefaultCreatedRef.current) return;
    if (Object.keys(localPrefs.fallbackProfiles).length > 0) return;
    if (!activeProvider || !activeModel) return;
    autoDefaultCreatedRef.current = true;
    const primary = `${activeProvider}/${activeModel}`;
    const chain = [primary, ...localPrefs.fallbackModels].filter(
      (ref, index, arr) => ref && arr.indexOf(ref) === index,
    );
    setFallbackProfiles({ ...localPrefs.fallbackProfiles, default: chain });
  }, [
    activeProvider,
    activeModel,
    localPrefs.fallbackModels,
    localPrefs.fallbackProfiles,
    setFallbackProfiles,
  ]);

  const useFallbackProfileAsActive = useCallback(
    (name: string) => {
      const chain = localPrefs.fallbackProfiles[name] ?? [];
      syncPref('fallbackModels', chain);
    },
    [localPrefs.fallbackProfiles, syncPref],
  );

  const setLeaderFromFallbackProfile = useCallback(
    (name: string) => {
      const chain = localPrefs.fallbackProfiles[name] ?? [];
      const first = chain[0];
      if (!first) {
        toast.error(i18n.t('settings:toast.profileEmpty', { name }));
        return;
      }
      const slash = first.indexOf('/');
      // A chain entry may be either "provider/model" or a bare model name;
      // when there is no slash, keep the current session provider.
      const targetProvider = slash > 0 ? first.slice(0, slash) : activeProvider;
      const targetModel = slash > 0 ? first.slice(slash + 1) : first;
      if (!targetProvider) {
        toast.error(i18n.t('settings:toast.selectProviderModelFirst'));
        return;
      }
      setProvider(targetProvider);
      setModel(targetModel);
      switchModel?.(targetProvider, targetModel);
      syncPref('fallbackModels', chain.slice(1));
      toast.success(i18n.t('settings:toast.leaderSetFrom', { name }));
    },
    [activeProvider, localPrefs.fallbackProfiles, setModel, setProvider, switchModel, syncPref],
  );

  return (
    <div className="space-y-6">
      {/* Fallback Chain */}
      <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
        <div className="flex items-start gap-3 mb-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <Layers className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">{t('settings:fallbacks.heading')}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{t('settings:fallbacks.body')}</p>
          </div>
        </div>
        <FallbackEditor
          value={localPrefs.fallbackModels}
          candidates={candidates ?? []}
          onChange={(next) => syncPref('fallbackModels', next)}
        />
        <div className="mt-3 flex flex-wrap gap-4">
          <PreferenceToggle
            label={t('settings:fallbacks.autoFallbackLabel')}
            hint={t('settings:fallbacks.autoFallbackHint')}
            value={localPrefs.fallbackAuto}
            onChange={() => syncPref('fallbackAuto', !localPrefs.fallbackAuto)}
          />
          <PreferenceToggle
            label={t('settings:fallbacks.favoritesOnlyLabel')}
            hint={t('settings:fallbacks.favoritesOnlyHint')}
            value={localPrefs.favoriteModelsOnly}
            onChange={() => syncPref('favoriteModelsOnly', !localPrefs.favoriteModelsOnly)}
          />
        </div>
      </div>

      {/* Favorite Models */}
      <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
        <div className="flex items-start gap-3 mb-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <Cpu className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">{t('settings:fallbacks.favoritesHeading')}</h3>
            <p className="text-xs text-muted-foreground mt-1">
              {t('settings:fallbacks.favoritesEmpty')}
            </p>
          </div>
        </div>
        <FallbackEditor
          value={localPrefs.favoriteModels}
          candidates={candidates ?? []}
          placeholder={t('settings:fallbacks.addFavoriteModel')}
          emptyHint={t('settings:fallbacks.favoritesEmpty')}
          onChange={(next) => syncPref('favoriteModels', next)}
        />
      </div>

      {/* Fallback Profiles */}
      <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
        <div className="flex items-start gap-3 mb-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <ListPlus className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">{t('settings:fallbacks.profilesHeading')}</h3>
          </div>
        </div>
        <div className="flex gap-2">
          <Input
            value={newFallbackProfileName}
            onChange={(e) => setNewFallbackProfileName(e.target.value)}
            placeholder="fallback1"
            className="font-mono text-sm"
            onKeyDown={(e) => {
              if (e.key === 'Enter') addFallbackProfile();
            }}
          />
          <Button type="button" variant="outline" onClick={addFallbackProfile}>
            {t('settings:fallbacks.addProfile')}
          </Button>
        </div>
        <div className="mt-4 space-y-3">
          {Object.keys(localPrefs.fallbackProfiles).length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-4">
              <p className="text-xs text-muted-foreground">
                {t('settings:fallbacks.noProfiles')}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={createDefaultFallbackProfile}
              >
                {t('settings:fallbacks.createDefault')}
              </Button>
            </div>
          ) : (
            Object.entries(localPrefs.fallbackProfiles)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([name, chain]) => (
                <div key={name} className="rounded-lg border border-border/70 bg-muted/30 p-4">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <span className="font-mono text-sm font-medium">{name}</span>
                    <div className="flex gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => useFallbackProfileAsActive(name)}
                      >
                        {t('settings:fallbacks.useChain')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setLeaderFromFallbackProfile(name)}
                      >
                        {t('settings:fallbacks.setLeader')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => removeFallbackProfile(name)}
                      >
                        {t('common:action.remove')}
                      </Button>
                    </div>
                  </div>
                  <FallbackEditor
                    value={chain}
                    candidates={candidates ?? []}
                    placeholder={t('settings:fallbacks.addModelToProfile')}
                    emptyHint={t('settings:fallbacks.profileEmpty')}
                    onChange={(next) => updateFallbackProfile(name, next)}
                  />
                </div>
              ))
          )}
        </div>
      </div>
    </div>
  );
}

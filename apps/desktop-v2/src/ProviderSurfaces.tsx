import { applyQuotaFrame } from '@wrongstack/project-surfaces/providers/frames';
import { ProviderQuotaView } from '@wrongstack/project-surfaces/providers/ProviderQuotaView';
import { ProviderTestView } from '@wrongstack/project-surfaces/providers/ProviderTestView';
import type {
  ModelPrefsPatch,
  ProviderClient,
  ProviderHost,
} from '@wrongstack/project-surfaces/providers/provider-host';
import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import { profileHttp } from './engine-http';
import type { EngineState } from './engine-state';
import { backendStream } from './engine-stream';
import { prefList, prefProfiles, profileSurfaceHost } from './profile-surface-host';
import { SurfaceFrame, useSurfaceConfirm } from './SurfaceFrame';
import './provider-surfaces.css';

const NO_PROFILE_PREFS: Record<string, unknown> = {};

/** The profile engine's live state, read by the provider host's hooks. */
const ProfileStateContext = createContext<EngineState | null>(null);

function useProfileState(): EngineState {
  const state = useContext(ProfileStateContext);
  if (!state) throw new Error('A provider page rendered outside the profile settings.');
  return state;
}

/** The provider pages on the profile engine; its state arrives through `ProfileStateContext`. */
function desktopProviderHost(
  client: ProviderClient,
  updatePrefs: (patch: ModelPrefsPatch) => void,
): ProviderHost {
  return {
    useClient: () => client,
    useConnected: () => useProfileState().connected,
    useActiveModel: () => {
      const { provider, model } = useProfileState();
      return useMemo(() => ({ provider, model }), [provider, model]);
    },
    useModelPrefs: () => {
      const prefs = useProfileState().results['prefs.updated'] ?? NO_PROFILE_PREFS;
      return useMemo(
        () => ({
          favoriteModels: prefList(prefs['favoriteModels']),
          disabledModels: prefList(prefs['disabledModels']),
          disabledProviders: prefList(prefs['disabledProviders']),
          fallbackModels: prefList(prefs['fallbackModels']),
          fallbackProfiles: prefProfiles(prefs['fallbackProfiles']),
          update: updatePrefs,
        }),
        [prefs],
      );
    },
    // Each conversation keeps its own model; the profile default is what new work runs on.
    useModelsInUse: () => {
      const { provider, model } = useProfileState();
      return useMemo(() => (provider ? [{ provider, model }] : []), [provider, model]);
    },
  };
}

/**
 * WebUI's model test and plan-quota pages on the profile engine, inside WrongStack settings.
 * `updatePrefs` saves a model-preference patch (favorites, disabled and fallback models).
 */
export function ProviderSurfaces({
  page,
  state,
  updatePrefs,
}: {
  page: 'quota' | 'tests';
  state: EngineState;
  updatePrefs: (patch: ModelPrefsPatch) => void;
}) {
  const confirm = useSurfaceConfirm();
  const save = useRef(updatePrefs);
  save.current = updatePrefs;
  const surface = useMemo(() => {
    const base = profileSurfaceHost(backendStream('profile', ''), profileHttp(), confirm.confirm);
    const providers = desktopProviderHost(base.client, (patch) => save.current(patch));
    return { host: { ...base.host, providers }, client: base.client };
  }, [confirm.confirm]);
  // Quota readings land in the shared store wherever they come from.
  useEffect(
    () => surface.client.on('provider.quota', (message) => applyQuotaFrame(message.payload)),
    [surface],
  );
  return (
    <ProfileStateContext.Provider value={state}>
      <SurfaceFrame host={surface.host} confirm={confirm}>
        <div className="provider-surface">
          {page === 'quota' ? <ProviderQuotaView /> : <ProviderTestView />}
        </div>
      </SurfaceFrame>
    </ProfileStateContext.Provider>
  );
}

import { applyQuotaFrame } from '@wrongstack/project-surfaces/providers/frames';
import { ProviderQuotaView } from '@wrongstack/project-surfaces/providers/ProviderQuotaView';
import { ProviderTestView } from '@wrongstack/project-surfaces/providers/ProviderTestView';
import type {
  ModelPrefsPatch,
  ProviderClient,
  ProviderHost,
} from '@wrongstack/project-surfaces/providers/provider-host';
import { SetupScreen } from '@wrongstack/project-surfaces/setup/SetupScreen';
import type { SetupHost } from '@wrongstack/project-surfaces/setup/setup-host';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { profileHttp } from './engine-http';
import type { EngineCommand } from './engine-operations';
import type { EngineState } from './engine-state';
import { backendStream, projectMemoryReviews } from './engine-stream';
import {
  chooseSetupModel,
  prefList,
  prefProfiles,
  profileSurfaceHost,
} from './profile-surface-host';
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

/** The first-run setup on the profile engine; its notices land in `notify`. */
function desktopSetupHost(
  client: ProviderClient,
  notify: SetupHost['notify'],
  chooseModel: SetupHost['chooseModel'],
): SetupHost {
  return {
    useClient: () => client,
    useConnected: () => useProfileState().connected,
    useCurrentModel: () => useProfileState().model,
    notify,
    chooseModel,
  };
}

/**
 * WebUI's first-run setup, model test and plan-quota pages on the profile engine, inside
 * WrongStack settings. `updatePrefs` saves a model-preference patch (favorites, disabled and
 * fallback models); a setup choice becomes the profile default, and `onConfigured` takes the
 * user back to the conversation that sent them here.
 */
export function ProviderSurfaces({
  page,
  state,
  updatePrefs,
  command,
  onConfigured,
}: {
  page: 'quota' | 'tests' | 'setup';
  state: EngineState;
  updatePrefs: (patch: ModelPrefsPatch) => void;
  command: EngineCommand;
  onConfigured: (provider: string, model: string) => void;
}) {
  const confirm = useSurfaceConfirm();
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const save = useRef(updatePrefs);
  save.current = updatePrefs;
  const choose = useRef({ command, onConfigured });
  choose.current = { command, onConfigured };
  const surface = useMemo(() => {
    // Conversations run in project engines: their memory reviews, as far as this window read.
    const base = profileSurfaceHost(
      backendStream('profile', ''),
      profileHttp(),
      confirm.confirm,
      projectMemoryReviews(),
    );
    const providers = desktopProviderHost(base.client, (patch) => save.current(patch));
    const setup = desktopSetupHost(
      base.client,
      {
        success: (text) => setStatus({ ok: true, text }),
        error: (text) => setStatus({ ok: false, text }),
      },
      (provider, model, start) =>
        chooseSetupModel(
          choose.current.command,
          { provider, model, start },
          {
            configured: (...picked) => choose.current.onConfigured(...picked),
            saved: (text) => setStatus({ ok: true, text }),
          },
        ),
    );
    return { host: { ...base.host, providers, setup }, client: base.client };
  }, [confirm.confirm]);
  // Quota readings land in the shared store wherever they come from.
  useEffect(
    () => surface.client.on('provider.quota', (message) => applyQuotaFrame(message.payload)),
    [surface],
  );
  return (
    <ProfileStateContext.Provider value={state}>
      <SurfaceFrame host={surface.host} confirm={confirm}>
        {status && (
          <p
            role={status.ok ? 'status' : 'alert'}
            className={`provider-result ${status.ok ? 'saved' : 'failed'}`}
          >
            {status.text}
          </p>
        )}
        <div className="provider-surface">
          {page === 'quota' ? (
            <ProviderQuotaView />
          ) : page === 'setup' ? (
            <SetupScreen />
          ) : (
            <ProviderTestView />
          )}
        </div>
      </SurfaceFrame>
    </ProfileStateContext.Provider>
  );
}

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  PALETTE_STORAGE_KEY,
  isPaletteId,
  readStoredPalette,
  type PaletteId,
} from '@/lib/palettes';
import { defaultWsUrl } from '@/lib/ws-client-utils';

// ============================================
// Config Store
// ============================================

export interface ConfigState {
  provider: string;
  model: string;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  wsUrl: string;
  wsConnected: boolean;
  /** Fine-grained connection state from the WS client. Drives the topbar's
   *  reconnect indicator. */
  wsStatus:
    | { state: 'connecting' }
    | { state: 'open' }
    | { state: 'closed'; error?: string | undefined }
    | {
        state: 'reconnecting';
        attempt: number;
        nextRetryAt: number;
        lastError?: string | undefined;
      };
  theme: 'light' | 'dark' | 'system';
  /** Selected color palette id — see `lib/palettes.ts` + `index.css` token
   *  blocks. Mirrors the ThemeProvider's `wrongstack-palette` localStorage
   *  entry so the choice survives reloads and cross-surface config reads. */
  palette: PaletteId;
  autoConnect: boolean;
  /** Play a soft synthesized chime when run.result lands with status=done.
   *  Off by default — opt-in via the Command Palette. Persisted so the
   *  preference survives reloads. Actual playback only fires after the
   *  user has interacted with the page (Web Audio autoplay policy). */
  soundOnComplete: boolean;

  setProvider: (provider: string) => void;
  setModel: (model: string) => void;
  setConfig: (
    config: Partial<
      Omit<ConfigState, 'setProvider' | 'setModel' | 'setConfig' | 'setTheme' | 'setPalette'>
    >,
  ) => void;
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  setPalette: (palette: PaletteId) => void;
  setWsConnected: (connected: boolean) => void;
  setWsStatus: (s: ConfigState['wsStatus']) => void;
  setSoundOnComplete: (on: boolean) => void;
}

export const useConfigStore = create<ConfigState>()(
  persist(
    (set) => ({
      provider: '',
      model: '',
      wsUrl: defaultWsUrl(),
      wsConnected: false,
      wsStatus: { state: 'connecting' },
      theme: 'system',
      palette: 'signal',
      autoConnect: true,
      soundOnComplete: false,
      setProvider: (provider) => set({ provider }),
      setModel: (model) => set({ model }),
      setConfig: (config) => set(config),
      setTheme: (theme) => set({ theme }),
      setPalette: (palette) => set({ palette }),
      setWsConnected: (connected) => set({ wsConnected: connected }),
      setWsStatus: (wsStatus) => set({ wsStatus, wsConnected: wsStatus.state === 'open' }),
      setSoundOnComplete: (on) => set({ soundOnComplete: on }),
    }),
    {
      name: 'wrongstack-config',
      // WS-069: `apiKey` is deliberately NOT persisted. Nothing writes it
      // today — provider credentials travel over the WebSocket to the server,
      // which owns them — so this was a latent sink: the day something did set
      // it, a provider key would land in `localStorage`, readable by any script
      // on the origin and surviving until the user clears site data.
      // Removing it from `partialize` costs nothing precisely because it is
      // dormant, which is the cheapest moment to close a sink.
      partialize: (state) => ({
        provider: state.provider,
        model: state.model,
        baseUrl: state.baseUrl,
        theme: state.theme,
        palette: state.palette,
        autoConnect: state.autoConnect,
        soundOnComplete: state.soundOnComplete,
      }),
      merge: (persisted, current) => {
        // A build that ran before the change above may have written one, and
        // dropping it from `partialize` alone would leave that value sitting in
        // storage and rehydrating into memory on every load. Strip it on read
        // so the next persist drops it from disk too.
        const { apiKey: _discardedLegacyApiKey, ...rest } =
          (persisted as Partial<ConfigState> | undefined) ?? {};
        return {
          ...current,
          ...rest,
          wsUrl: defaultWsUrl(),
          wsConnected: false,
          wsStatus: { state: 'connecting' },
          // A corrupted/legacy persisted palette id must not land in store
          // state. Fall back to the ThemeProvider's localStorage entry (the
          // authoritative user choice) before settling on the default, so the
          // store converges even on the upgrade path where `wrongstack-config`
          // predates the `palette` field.
          palette: isPaletteId(rest.palette)
            ? rest.palette
            : readStoredPalette(PALETTE_STORAGE_KEY, current.palette),
        };
      },
    },
  ),
);

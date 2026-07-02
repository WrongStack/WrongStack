import { detectLocale } from '@/i18n/languages';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Local preference store — persisted in localStorage.
 * Mirrors the TUI's SettingsPicker fields that don't require
 * a live WS server connection. The server can still override
 * these via WS events when connected.
 */
export interface LocalPrefs {
  /** Autonomy mode */
  autonomy: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel';
  /** Auto-proceed delay in ms */
  autonomyDelayMs: number;
  /** Stop auto-proceed after N iterations (0 = unlimited). */
  autoProceedMaxIterations: number;
  /** YOLO mode — bypass tool confirmations */
  yolo: boolean;
  /** Maximum agent iterations per run */
  maxIterations: number;
  /** Chime on run completion */
  chime: boolean;
  /** Confirm before exit (Ctrl+C) */
  confirmExit: boolean;
  /** Stream fleet events in realtime */
  streamFleet: boolean;
  /** Predict next steps after turn completes */
  nextPrediction: boolean;
  /** Global fallback model chain (entries: `model` or `provider/model`). */
  fallbackModels: string[];
  /** Named fallback chains selectable by setmodel/model routing. */
  fallbackProfiles: Record<string, string[]>;
  /** User-curated model references prioritized by pickers and smart fallbacks. */
  favoriteModels: string[];
  /** Restrict auto-derived fallback chains to favorite models. */
  favoriteModelsOnly: boolean;
  /** Per-role/phase/default model routing matrix. */
  modelMatrix: Record<
    string,
    {
      provider?: string;
      model?: string;
      fallbackProfile?: string;
      modelRuntime?: {
        reasoning?: { mode?: 'auto' | 'on' | 'off'; effort?: string; preserve?: boolean };
        cache?: { ttl?: '5m' | '1h' };
        parameters?: Record<string, unknown>;
      };
    }
  >;
  /** Auto-derive a fallback chain from keyed providers when the list is empty. */
  fallbackAuto: boolean;

  // --- Feature flags ---
  featureMcp: boolean;
  featurePlugins: boolean;
  featureMemory: boolean;
  featureSkills: boolean;
  featureModelsRegistry: boolean;
  indexOnStart: boolean;

  // --- Context ---
  contextAutoCompact: boolean;
  /** Compactor strategy — matches core's config.context.strategy. */
  contextStrategy: 'hybrid' | 'intelligent' | 'selective';
  /** Context window mode — matches core's config.context.mode. */
  contextMode: 'balanced' | 'frugal' | 'deep' | 'archival';
  /** Token-saving mode — matches core's config.features.tokenSavingMode. */
  tokenSavingTier: 'off' | 'minimal' | 'light' | 'medium' | 'aggressive';
  /** Max concurrent subagents */
  maxConcurrent: number;
  /** Terminal title animation */
  titleAnimation: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Session audit detail — matches core's config.session.auditLevel. */
  auditLevel: 'minimal' | 'standard' | 'full';

  // --- Refine ---
  enhanceEnabled: boolean;
  enhanceDelayMs: number;
  enhanceLanguage: 'original' | 'english';

  // --- Reasoning / cache runtime ---
  reasoningMode: 'auto' | 'on' | 'off';
  reasoningEffort: string;
  reasoningPreserve: boolean;
  cacheTtl: 'default' | '5m' | '1h';

  // --- HQ client publishing ---
  hqEnabled: boolean;
  hqUrl: string;
  hqToken: string;
  hqRawContent: boolean;

  // --- Telegram notifications ---
  /** Plugin configured with a bot token (gates the whole section). */
  tgConfigured: boolean;
  tgSessionEnd: boolean;
  tgDelegate: boolean;
  /** Long-tool threshold in ms. 0 = disabled. */
  tgLongToolMs: number;

  /**
   * Display-only UI language (BCP-47 code, e.g. `en`, `pt-BR`).
   * NOT synced to the server / config.json — only affects which translation
   * catalog the WebUI chrome renders. Follows the same local-only precedent
   * as `theme`. Distinct from `enhanceLanguage` (a prompt-refinement pref).
   */
  uiLocale: string;

  set: (patch: Partial<LocalPrefs>) => void;
  reset: () => void;
}

const DEFAULTS: Omit<LocalPrefs, 'set' | 'reset'> = {
  // Default to self-driving + auto-approve, matching the core config defaults
  // (config.autonomy.defaultMode='auto', config.yolo=true). Existing browsers
  // are synced from the server's prefs snapshot on connect (handlePrefsUpdated),
  // so this only seeds fresh browsers before the first connect.
  autonomy: 'auto',
  autonomyDelayMs: 45_000,
  autoProceedMaxIterations: 50,
  yolo: true,
  maxIterations: 500,
  chime: false,
  confirmExit: true,
  streamFleet: true,
  nextPrediction: false,
  fallbackModels: [],
  fallbackProfiles: {},
  favoriteModels: [],
  favoriteModelsOnly: false,
  modelMatrix: {},
  fallbackAuto: true,
  featureMcp: true,
  featurePlugins: true,
  featureMemory: true,
  featureSkills: true,
  featureModelsRegistry: true,
  indexOnStart: true,
  contextAutoCompact: true,
  contextStrategy: 'hybrid',
  contextMode: 'balanced',
  tokenSavingTier: 'off',
  maxConcurrent: 10,
  titleAnimation: true,
  logLevel: 'info',
  auditLevel: 'standard',
  enhanceEnabled: true,
  enhanceDelayMs: 60_000,
  enhanceLanguage: 'original',
  reasoningMode: 'auto',
  reasoningEffort: 'high',
  reasoningPreserve: false,
  cacheTtl: 'default',
  hqEnabled: false,
  hqUrl: '',
  hqToken: '',
  hqRawContent: false,
  tgConfigured: false,
  tgSessionEnd: false,
  tgDelegate: true,
  tgLongToolMs: 30_000,
  uiLocale: detectLocale(),
};

export const useLocalPrefs = create<LocalPrefs>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      set: (patch) => set(patch),
      reset: () => set(DEFAULTS),
    }),
    {
      name: 'wrongstack-local-prefs',
      version: 5,
      // v1 stored option values that don't exist in core's config schema —
      // contextStrategy frugal/balanced/deep/archival (context-window modes,
      // a different setting) and auditLevel 'verbose'. Map them onto the
      // canonical values so persisted stores don't resurrect invalid prefs.
      //
      // v2 added autoProceedMaxIterations.
      //
      // v3 added Telegram notification prefs (tgConfigured, tgSessionEnd,
      // tgDelegate, tgLongToolMs). Older stores simply get the defaults via
      // the spread of DEFAULTS; no explicit remap is needed.
      //
      // v4 added fallbackProfiles/favoriteModels/favoriteModelsOnly/modelMatrix.
      //
      // v5 added uiLocale (display-only UI language; not synced to server).
      migrate: (persisted) => {
        const p = (persisted ?? {}) as Record<string, unknown>;
        const validStrategies = ['hybrid', 'intelligent', 'selective'];
        if (!validStrategies.includes(p.contextStrategy as string)) {
          p.contextStrategy = 'hybrid';
        }
        if (p.auditLevel === 'verbose') p.auditLevel = 'full';
        if (!['minimal', 'standard', 'full'].includes(p.auditLevel as string)) {
          p.auditLevel = 'standard';
        }
        if (typeof p.autoProceedMaxIterations !== 'number') {
          p.autoProceedMaxIterations = 50;
        }
        if (!p.fallbackProfiles || typeof p.fallbackProfiles !== 'object' || Array.isArray(p.fallbackProfiles)) {
          p.fallbackProfiles = {};
        }
        if (!Array.isArray(p.favoriteModels)) p.favoriteModels = [];
        if (typeof p.favoriteModelsOnly !== 'boolean') p.favoriteModelsOnly = false;
        if (!p.modelMatrix || typeof p.modelMatrix !== 'object' || Array.isArray(p.modelMatrix)) {
          p.modelMatrix = {};
        }
        if (typeof p.uiLocale !== 'string' || !p.uiLocale) {
          // Backfill older stores with the browser-detected language.
          p.uiLocale = detectLocale();
        }
        return p as never as LocalPrefs;
      },
    },
  ),
);

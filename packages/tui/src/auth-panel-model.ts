// Pure data model for the interactive /auth panel — NO React or Ink imports.
//
// Three consumers share this module so the row layout can never drift:
//   - app-reducer.ts      → cursor clamping via `authPanelRows(...).length`
//   - hooks/use-auth-panel.ts → Enter/shortcut dispatch on the selected row
//   - components/auth-panel.tsx → rendering
//
// The `AuthPanelHost` interface is the contract the CLI implements
// (packages/cli/src/auth-menu/panel-service.ts) and passes through
// RunTuiOptions. The TUI never touches the config file or the vault —
// every mutation goes through the host, and every secret stays CLI-side
// (key values arrive pre-masked).

/** One saved API key / OAuth token, with the secret already masked. */
export interface AuthKeyRow {
  label: string;
  /** Pre-masked display form ("sk-a…f3k2" / "••••••") — never the secret. */
  masked: string;
  createdAt: string;
  active: boolean;
  authMethod?: 'api_key' | 'oauth' | 'session_token' | undefined;
  expiresAt?: string | undefined;
}

/** One saved provider from the active profile config. */
export interface AuthProviderRow {
  id: string;
  type?: string | undefined;
  family?: string | undefined;
  baseUrl?: string | undefined;
  models: string[];
  envVars: string[];
  keys: AuthKeyRow[];
}

/** One models.dev catalog entry offered by "Add provider (catalog)". */
export interface AuthCatalogRow {
  id: string;
  name: string;
  family: string;
  apiBase?: string | undefined;
  envVars: string[];
  /** Already present in the saved config (shown as ◉). */
  saved: boolean;
}

/** One local-LLM preset (OmniRoute / Ollama / vLLM / LM Studio). */
export interface AuthLocalPresetRow {
  id: string;
  label: string;
  defaultBaseUrl: string;
  noAuth: boolean;
  hint: string;
}

export type AuthOAuthKind = 'chatgpt' | 'claude' | 'copilot';

/**
 * Bridge the CLI flows use to talk to the panel while a flow runs.
 * `prompt` REJECTS when the user cancels (Esc) — flows treat a thrown
 * prompt as user-cancel, which aborts before anything is saved.
 */
export interface AuthFlowIo {
  onLog(line: string): void;
  prompt(question: string, opts: { secret: boolean }): Promise<string>;
  signal: AbortSignal;
}

/**
 * One-screen "add provider" form (catalog card or fully custom entry).
 * Every field arrives as raw text exactly as typed; the CLI host trims,
 * validates, and splits the comma-separated lists. `apiKey` is the only
 * secret here and never re-enters the TUI after the save.
 */
export interface AuthProviderSetup {
  /** `catalog` prefills from models.dev; `custom` is user-authored. */
  source: 'catalog' | 'custom';
  /** Provider type id (models.dev id for catalog entries). */
  type: string;
  /** Human label shown on the setup card. */
  name: string;
  family: string;
  baseUrl: string;
  /** Config key the provider is saved under — may differ from `type`. */
  alias: string;
  keyLabel: string;
  apiKey: string;
  /** Comma-separated model allowlist. */
  models: string;
  /** Comma-separated env var names. */
  envVars: string;
}

/** Non-secret settings of an existing provider, edited as one form. */
export interface AuthProviderEdit {
  providerId: string;
  family: string;
  baseUrl: string;
  /** Comma-separated model allowlist. */
  models: string;
  /** Comma-separated env var names. */
  envVars: string;
}

/**
 * The subset of a model's models.dev schema the panel edits inline.
 * Numeric fields are carried as text so a half-typed value round-trips;
 * the host parses and rejects non-numeric input with a message.
 */
export interface AuthModelEdit {
  providerId: string;
  modelId: string;
  name: string;
  contextWindow: string;
  maxOutput: string;
  costInput: string;
  costOutput: string;
}

/**
 * Add-or-rename form for one saved key. `originalLabel` absent means
 * "append a new key"; present means "replace that key in place".
 */
export interface AuthKeyEdit {
  providerId: string;
  label: string;
  apiKey: string;
  originalLabel?: string | undefined;
}

export interface AuthFlowResult {
  ok: boolean;
  message?: string | undefined;
}

/**
 * Host callbacks the CLI provides. Simple mutations return an error
 * string (or null on success); multi-step interactions run as "flows"
 * that log and prompt through {@link AuthFlowIo}.
 */
export interface AuthPanelHost {
  listProviders(): Promise<AuthProviderRow[]>;
  listCatalog(): Promise<AuthCatalogRow[]>;
  localPresets(): AuthLocalPresetRow[];
  setActiveKey(providerId: string, label: string): Promise<string | null>;
  deleteKey(providerId: string, label: string): Promise<string | null>;
  removeProvider(providerId: string): Promise<string | null>;
  addKey(providerId: string, io: AuthFlowIo): Promise<AuthFlowResult>;
  updateKey(providerId: string, label: string, io: AuthFlowIo): Promise<AuthFlowResult>;
  editField(
    providerId: string,
    field: 'family' | 'baseUrl' | 'models',
    io: AuthFlowIo,
  ): Promise<AuthFlowResult>;
  /**
   * Edit a single model's detailed schema fields (ME-5). Opens a field-group
   * prompt flow covering identity, limits, pricing, modalities, capability
   * flags, and dates. Validates via the ME-1 zod schema.
   *
   * Shows the models.dev catalog reference values alongside the current
   * values so the user can see what the upstream defaults are and reset
   * individual fields back to them.
   */
  editModelDetails(providerId: string, modelId: string, io: AuthFlowIo): Promise<AuthFlowResult>;
  /**
   * Add a model to the provider's allowlist with optional full schema details
   * (ME-5). When `fromCatalog` is true, prefills from the models.dev registry.
   */
  addModel(
    providerId: string,
    io: AuthFlowIo,
    opts?: { fromCatalog?: boolean | undefined },
  ): Promise<AuthFlowResult>;
  /** Remove a single model from the provider's allowlist + customModels (ME-5). */
  removeModel(providerId: string, modelId: string): Promise<string | null>;
  /**
   * Reset a model's customModels override back to the models.dev catalog
   * values (ME-5). Drops the customModels entry for this modelId so the
   * runtime falls back to the live catalog data.
   */
  resetModelToCatalog(providerId: string, modelId: string): Promise<string | null>;
  addCatalogProvider(catalogId: string, io: AuthFlowIo): Promise<AuthFlowResult>;
  addCustomProvider(io: AuthFlowIo): Promise<AuthFlowResult>;
  addLocal(presetId: string, io: AuthFlowIo): Promise<AuthFlowResult>;
  oauthLogin(kind: AuthOAuthKind, io: AuthFlowIo): Promise<AuthFlowResult>;
  /**
   * Form-shaped counterparts to the `io`-driven flows above: the panel hands
   * over one filled-in form instead of a question-at-a-time sequence, and the
   * host validates the whole thing in a single config mutation. Each resolves
   * to an error string, or null on success.
   */
  saveProviderSetup(setup: AuthProviderSetup): Promise<string | null>;
  saveProviderEdit(edit: AuthProviderEdit): Promise<string | null>;
  /** Current editable schema values, or null when the model is gone. */
  getModelEdit(providerId: string, modelId: string): Promise<AuthModelEdit | null>;
  saveModelEdit(edit: AuthModelEdit): Promise<string | null>;
  saveKeyEdit(edit: AuthKeyEdit): Promise<string | null>;
}

// ── Panel state slice ──────────────────────────────────────────────────────

export type AuthPanelView = 'list' | 'provider' | 'models' | 'catalog' | 'local' | 'oauth' | 'flow';

export type AuthConfirmAction =
  | { kind: 'delete-key'; providerId: string; label: string }
  | { kind: 'remove-provider'; providerId: string }
  | { kind: 'remove-model'; providerId: string; modelId: string };

export interface AuthPanelState {
  open: boolean;
  view: AuthPanelView;
  busy: boolean;
  hint?: string | undefined;
  providers: AuthProviderRow[];
  presets: AuthLocalPresetRow[];
  catalog: AuthCatalogRow[];
  /** Cursor index into `authPanelRows(state)` for the current view. */
  selected: number;
  /** Provider shown in the 'provider' detail view. */
  providerId?: string | undefined;
  /** Type-to-filter query for the catalog view. */
  filter: string;
  /** Running/last flow (OAuth, catalog add, local add, key edit, …). */
  flowTitle: string;
  log: string[];
  flowDone: boolean;
  flowOk?: boolean | undefined;
  /** Modal one-line prompt raised by a flow (masked for secrets). */
  input?: { label: string; masked: boolean; draft: string } | undefined;
  /** Modal y/N confirmation for destructive actions. */
  confirm?: { question: string; action: AuthConfirmAction } | undefined;
}

export const AUTH_PANEL_INITIAL: AuthPanelState = {
  open: false,
  view: 'list',
  busy: false,
  providers: [],
  presets: [],
  catalog: [],
  selected: 0,
  filter: '',
  flowTitle: '',
  log: [],
  flowDone: false,
};

// ── Row descriptors ────────────────────────────────────────────────────────

export type AuthPanelRow =
  | { kind: 'provider'; provider: AuthProviderRow }
  | { kind: 'list-action'; action: 'catalog' | 'local' | 'custom' | 'oauth' }
  | { kind: 'key'; keyRow: AuthKeyRow }
  | {
      kind: 'provider-action';
      action:
        | 'add-key'
        | 'edit-family'
        | 'edit-base-url'
        | 'edit-models'
        | 'edit-model-details'
        | 'add-model'
        | 'reset-model-to-catalog'
        | 'remove'
        | 'back-to-list';
    }
  | { kind: 'model-row'; providerId: string; modelId: string; name: string }
  | { kind: 'catalog-entry'; entry: AuthCatalogRow }
  | { kind: 'local-preset'; preset: AuthLocalPresetRow }
  | { kind: 'oauth-option'; oauth: AuthOAuthKind };

/** Case-insensitive substring filter over id + name + family. */
export function filterAuthCatalog(catalog: AuthCatalogRow[], filter: string): AuthCatalogRow[] {
  const q = filter.trim().toLowerCase();
  if (!q) return catalog;
  return catalog.filter(
    (c) =>
      c.id.toLowerCase().includes(q) ||
      c.name.toLowerCase().includes(q) ||
      c.family.toLowerCase().includes(q),
  );
}

export function authSelectedProvider(state: AuthPanelState): AuthProviderRow | undefined {
  return state.providers.find((p) => p.id === state.providerId);
}

/**
 * Selectable rows for the current view, in render order. The component
 * renders exactly this list; the reducer clamps `selected` to its length;
 * the Enter handler dispatches on `rows[selected]`.
 */
export function authPanelRows(state: AuthPanelState): AuthPanelRow[] {
  switch (state.view) {
    case 'list': {
      const rows: AuthPanelRow[] = state.providers.map((provider) => ({
        kind: 'provider' as const,
        provider,
      }));
      rows.push(
        { kind: 'list-action', action: 'catalog' },
        { kind: 'list-action', action: 'local' },
        { kind: 'list-action', action: 'custom' },
        { kind: 'list-action', action: 'oauth' },
      );
      return rows;
    }
    case 'provider': {
      const provider = authSelectedProvider(state);
      if (!provider) return [];
      const rows: AuthPanelRow[] = provider.keys.map((keyRow) => ({
        kind: 'key' as const,
        keyRow,
      }));
      // ME-5: show each model as a navigable row
      for (const modelId of provider.models) {
        rows.push({
          kind: 'model-row' as const,
          providerId: provider.id,
          modelId,
          name: modelId,
        });
      }
      rows.push(
        { kind: 'provider-action', action: 'add-key' },
        { kind: 'provider-action', action: 'edit-family' },
        { kind: 'provider-action', action: 'edit-base-url' },
        { kind: 'provider-action', action: 'edit-models' },
        { kind: 'provider-action', action: 'add-model' },
        { kind: 'provider-action', action: 'remove' },
      );
      return rows;
    }
    case 'models': {
      // ME-5: dedicated model editing view (entered from a model-row)
      const provider = authSelectedProvider(state);
      if (!provider) return [];
      const rows: AuthPanelRow[] = provider.models.map((modelId) => ({
        kind: 'model-row' as const,
        providerId: provider.id,
        modelId,
        name: modelId,
      }));
      rows.push(
        { kind: 'provider-action', action: 'add-model' },
        { kind: 'provider-action', action: 'edit-models' },
        { kind: 'provider-action', action: 'back-to-list' },
      );
      return rows;
    }
    case 'catalog':
      return filterAuthCatalog(state.catalog, state.filter).map((entry) => ({
        kind: 'catalog-entry' as const,
        entry,
      }));
    case 'local':
      return state.presets.map((preset) => ({ kind: 'local-preset' as const, preset }));
    case 'oauth':
      return (['chatgpt', 'claude', 'copilot'] as const).map((oauth) => ({
        kind: 'oauth-option' as const,
        oauth,
      }));
    case 'flow':
      return [];
  }
}

/** Wrap-around cursor move over the current view's rows. */
export function authMoveSelected(state: AuthPanelState, delta: number): number {
  const count = authPanelRows(state).length;
  if (count === 0) return 0;
  return (((state.selected + delta) % count) + count) % count;
}

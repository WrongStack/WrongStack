/**
 * Auth-panel controller — owns every side-effectful interaction of the
 * interactive `/auth` panel so `app.tsx` only wires props.
 *
 * Two interaction shapes:
 *
 *   - **Direct host calls** (set active key, delete key, remove provider):
 *     awaited inline, surfaced via the panel hint, then the provider list
 *     reloads.
 *
 *   - **Flows** (add key / catalog add / custom add / local add / OAuth /
 *     field edits): the CLI-side flow runs against an {@link AuthFlowIo}
 *     bridge; its log lines stream into the panel's flow view, and each
 *     `prompt()` raises the panel's modal input (masked for secrets). Esc
 *     rejects the pending prompt (flow sees a cancel) or aborts the flow's
 *     AbortController (unblocks OAuth loopback waits).
 */
import { useCallback, useEffect, useRef } from 'react';
import type { Action, State } from '../app-reducer.js';
import {
  type AuthCatalogRow,
  type AuthFlowIo,
  type AuthFlowResult,
  type AuthFormState,
  type AuthLocalPresetRow,
  type AuthPanelHost,
  type AuthProviderEdit,
  type AuthProviderSetup,
  authPanelRows,
  WIRE_FAMILIES,
  type WireFamily,
} from '../auth-panel-model.js';

interface UseAuthPanelOptions {
  authHost: AuthPanelHost | undefined;
  stateRef: { current: State };
  dispatch: React.Dispatch<Action>;
  /**
   * Live `state.authPanel.open` — when the panel closes from OUTSIDE the
   * controller (another panel's `closePanels`, an F-key toggle, Ctrl+C),
   * any in-flight flow must be aborted so an invisible prompt can't leave
   * an OAuth loopback server (or a pending readline promise) running
   * behind a closed panel.
   */
  open: boolean;
}

export interface AuthPanelController {
  /** Open the panel (used by `/auth` via the panel bridge). No-op without a host. */
  openAuthPanel: (view?: 'list' | 'oauth') => boolean;
  onAuthEnter: () => void;
  onAuthBack: () => void;
  onAuthShortcut: (input: string) => void;
  onAuthPromptSubmit: () => void;
  onAuthPromptCancel: () => void;
  onAuthConfirm: (yes: boolean) => void;
  onAuthFlowCancel: () => void;
  /**
   * Ctrl+C while the panel is open. In raw-mode terminals (ConPTY, most
   * Windows setups) Ctrl+C arrives as key DATA — not a SIGINT — so the
   * key router must handle it; the app's SIGINT ladder covers the
   * console-event delivery path. Both paths abort any in-flight flow and
   * close the panel.
   */
  onAuthCtrlC: () => void;
  /** Open the existing masked modal for a slash-command secret prompt. */
  readSecret: (label: string) => Promise<string>;
  /** Open the same modal with visible text for slash-command selections. */
  readText: (label: string) => Promise<string>;
}

function abortError(): Error {
  return Object.assign(new Error('Cancelled'), { name: 'AbortError' });
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const OAUTH_TITLE: Record<string, string> = {
  chatgpt: 'Sign in with ChatGPT',
  claude: 'Sign in with Claude',
  copilot: 'Sign in with GitHub Copilot',
};

export function useAuthPanel(opts: UseAuthPanelOptions): AuthPanelController {
  const { authHost, stateRef, dispatch, open } = opts;

  const flowAbortRef = useRef<AbortController | null>(null);
  const standaloneSecretRef = useRef(false);
  const promptRef = useRef<{
    resolve: (value: string) => void;
    reject: (err: Error) => void;
  } | null>(null);

  const mountedRef = useRef(true);

  /** Abort a live flow + reject its pending prompt (idempotent). */
  const abortLiveFlow = useCallback(() => {
    flowAbortRef.current?.abort();
    flowAbortRef.current = null;
    standaloneSecretRef.current = false;
    const pending = promptRef.current;
    promptRef.current = null;
    pending?.reject(abortError());
  }, []);

  // A closed panel and an unmounted TUI have the same cancellation contract:
  // abort signal-aware host work, reject modal prompts, and prevent every
  // non-cancellable host promise from dispatching into the dead component.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortLiveFlow();
    };
  }, [abortLiveFlow]);

  // Safety net: the panel can be closed from outside this controller
  // (sibling panel opens run `closePanels`, Ctrl+C, F-keys). Without this,
  // a running flow would keep prompting into a closed panel.
  useEffect(() => {
    if (!open) abortLiveFlow();
  }, [open, abortLiveFlow]);

  const reloadProviders = useCallback(async () => {
    if (!authHost || !mountedRef.current) return;
    try {
      const providers = await authHost.listProviders();
      if (mountedRef.current) dispatch({ type: 'authProviders', providers });
    } catch (err) {
      if (!mountedRef.current) return;
      dispatch({ type: 'authHint', text: `✗ Failed to reload providers: ${toMessage(err)}` });
      dispatch({ type: 'authBusy', busy: false });
    }
  }, [authHost, dispatch]);

  const openAuthPanel = useCallback(
    (view: 'list' | 'oauth' = 'list'): boolean => {
      if (!authHost) return false;
      // Re-opening while a previous flow is still running (e.g. `/auth`
      // typed mid-OAuth) — kill the old flow before resetting the panel.
      abortLiveFlow();
      dispatch({ type: 'authOpen', view, presets: authHost.localPresets() });
      void reloadProviders();
      return true;
    },
    [authHost, dispatch, reloadProviders, abortLiveFlow],
  );

  const runFlow = useCallback(
    (title: string, run: (io: AuthFlowIo) => Promise<AuthFlowResult>) => {
      if (!authHost) return;
      const ac = new AbortController();
      flowAbortRef.current = ac;
      dispatch({ type: 'authFlowStart', title });
      // Every dispatch below is gated on the flow still being live — once
      // cancelled (Esc, panel closed, /auth re-opened) a straggling flow
      // must not write logs or a done-marker into the reset panel state.
      const live = () => mountedRef.current && !ac.signal.aborted;
      const io: AuthFlowIo = {
        onLog: (line) => {
          if (live()) dispatch({ type: 'authFlowLog', line });
        },
        prompt: (question, { secret }) =>
          new Promise<string>((resolve, reject) => {
            if (!live()) {
              reject(abortError());
              return;
            }
            promptRef.current = { resolve, reject };
            dispatch({ type: 'authPromptStart', label: question, masked: secret });
          }),
        signal: ac.signal,
      };
      void (async () => {
        try {
          const result = await run(io);
          if (live()) {
            dispatch({ type: 'authFlowDone', ok: result.ok, message: result.message });
          }
        } catch (err) {
          if (live()) {
            dispatch({ type: 'authFlowDone', ok: false, message: toMessage(err) });
          }
        } finally {
          // Only release the refs if they still belong to THIS flow — a new
          // flow may have started after this one was cancelled.
          if (flowAbortRef.current === ac) flowAbortRef.current = null;
          // The flow may have added/edited providers — refresh the list the
          // user returns to. Ignore-fire: errors surface via the hint.
          if (live() || (mountedRef.current && stateRef.current.authPanel.open)) {
            void reloadProviders();
          }
        }
      })();
    },
    [authHost, dispatch, reloadProviders, stateRef],
  );

  const openCatalog = useCallback(() => {
    if (!authHost) return;
    dispatch({ type: 'authView', view: 'catalog' });
    dispatch({ type: 'authBusy', busy: true });
    void (async () => {
      try {
        const catalog = await authHost.listCatalog();
        if (mountedRef.current) dispatch({ type: 'authCatalog', catalog });
      } catch (err) {
        if (!mountedRef.current) return;
        dispatch({ type: 'authBusy', busy: false });
        dispatch({ type: 'authHint', text: `✗ Catalog unavailable: ${toMessage(err)}` });
      }
    })();
  }, [authHost, dispatch]);

  /**
   * Open the add-provider form with the user-typed values fresh from the
   * screen — every input field sits on its own row with Cancel/Save at
   * the bottom. The form is pre-filled with sensible defaults so the
   * user only edits what differs.
   */
  const openCustomSetupForm = useCallback(() => {
    dispatch({
      type: 'authFormStart',
      form: {
        kind: 'setup',
        fields: {
          type: '',
          name: '',
          family: 'openai-compatible',
          baseUrl: '',
          alias: '',
          keyLabel: 'default',
          apiKey: '',
          models: '',
          envVars: '',
        },
      },
    });
  }, [dispatch]);

  /** Prefill from a models.dev catalog row and open the add-provider form. */
  const openCatalogSetupForm = useCallback(
    (entry: AuthCatalogRow) => {
      // The catalog may carry a family we don't validate (e.g. external
      // providers); fall back to 'openai-compatible' so the arrows always
      // have a meaningful cycle and the host accepts the value.
      const family: WireFamily = (WIRE_FAMILIES as readonly string[]).includes(entry.family)
        ? (entry.family as WireFamily)
        : 'openai-compatible';
      dispatch({
        type: 'authFormStart',
        form: {
          kind: 'setup',
          fields: {
            type: entry.id,
            name: entry.name,
            family,
            baseUrl: entry.apiBase ?? '',
            alias: entry.id,
            keyLabel: 'default',
            apiKey: '',
            models: '',
            envVars: entry.envVars.join(', '),
          },
        },
      });
    },
    [dispatch],
  );

  /** Open the edit-provider form pre-filled from the saved AuthProviderRow. */
  const openEditProviderForm = useCallback(
    (providerId: string) => {
      const provider = stateRef.current.authPanel.providers.find((p) => p.id === providerId);
      if (!provider) {
        dispatch({ type: 'authHint', text: `✗ Provider "${providerId}" no longer in config.` });
        return;
      }
      const family: WireFamily = (WIRE_FAMILIES as readonly string[]).includes(
        provider.family ?? '',
      )
        ? (provider.family as WireFamily)
        : 'openai-compatible';
      dispatch({
        type: 'authFormStart',
        form: {
          kind: 'edit',
          providerId,
          fields: {
            type: provider.type ?? providerId,
            name: '',
            family,
            baseUrl: provider.baseUrl ?? '',
            alias: providerId,
            keyLabel: '',
            apiKey: '',
            models: provider.models.join(', '),
            envVars: provider.envVars.join(', '),
          },
        },
      });
    },
    [dispatch, stateRef],
  );

  /** Send the live form to the host. Errors stay on the form via the hint. */
  const submitAuthForm = useCallback(async () => {
    if (!authHost) return;
    const form = stateRef.current.authPanel.form;
    if (!form) return;
    dispatch({ type: 'authBusy', busy: true });
    let err: string | null;
    if (form.kind === 'setup') {
      const setup: AuthProviderSetup = {
        source: form.fields.type ? 'catalog' : 'custom',
        type: form.fields.type,
        name: form.fields.name,
        family: form.fields.family,
        baseUrl: form.fields.baseUrl,
        alias: form.fields.alias,
        keyLabel: form.fields.keyLabel,
        apiKey: form.fields.apiKey,
        models: form.fields.models,
        envVars: form.fields.envVars,
      };
      err = await authHost.saveProviderSetup(setup);
    } else {
      const edit: AuthProviderEdit = {
        providerId: form.providerId ?? '',
        family: form.fields.family,
        baseUrl: form.fields.baseUrl,
        models: form.fields.models,
        envVars: form.fields.envVars,
      };
      err = await authHost.saveProviderEdit(edit);
    }
    if (!mountedRef.current) return;
    dispatch({ type: 'authBusy', busy: false });
    if (err) {
      // Stay on the form — the hint carries the message; the user's edits
      // remain in panel state because we never touched `form`.
      dispatch({ type: 'authHint', text: `✗ ${err}` });
      return;
    }
    dispatch({ type: 'authHint', text: '✓ Provider saved.' });
    const nextView: 'list' | 'provider' =
      form.kind === 'edit' && form.providerId ? 'provider' : 'list';
    const nextProviderId = form.kind === 'edit' ? form.providerId : undefined;
    dispatch({
      type: 'authView',
      view: nextView,
      providerId: nextProviderId,
    });
    await reloadProviders();
  }, [authHost, stateRef, dispatch, reloadProviders]);

  /** Open the local-server form pre-filled from the preset defaults. */
  const openLocalForm = useCallback(
    (preset: AuthLocalPresetRow) => {
      dispatch({
        type: 'authFormStart',
        form: {
          kind: 'local',
          presetId: preset.id,
          fields: {
            type: '',
            name: '',
            family: '',
            baseUrl: preset.defaultBaseUrl,
            alias: '',
            keyLabel: '',
            apiKey: '',
            models: '',
            envVars: '',
          },
        },
      });
    },
    [dispatch],
  );

  /**
   * Local adds health-probe the server — run them as a flow after the form
   * Save so the probe output streams into the flow view. The form already
   * collected URL + key, so addLocal runs without interactive prompts
   * (an empty apiKey string means "save without a key").
   */
  const startLocalFlow = useCallback(
    (form: AuthFormState) => {
      if (!authHost) return;
      const presetId = form.presetId ?? '';
      const preset = stateRef.current.authPanel.presets.find((p) => p.id === presetId);
      runFlow(`Add ${preset?.label ?? presetId}`, (io) =>
        authHost.addLocal(presetId, io, {
          baseUrl: form.fields.baseUrl,
          apiKey: form.fields.apiKey,
        }),
      );
    },
    [authHost, stateRef, runFlow],
  );

  const onAuthEnter = useCallback(() => {
    if (!authHost) return;
    const panel = stateRef.current.authPanel;
    if (panel.busy && panel.view !== 'flow') return;

    if (panel.view === 'flow') {
      if (panel.flowDone) dispatch({ type: 'authView', view: 'list' });
      return;
    }

    const row = authPanelRows(panel)[panel.selected];
    if (!row) return;

    switch (row.kind) {
      case 'provider':
        dispatch({ type: 'authView', view: 'provider', providerId: row.provider.id });
        return;
      case 'model-row': {
        const providerId = row.providerId;
        // From the provider view, Enter navigates into the dedicated models
        // view (which lists all models + add/reset/back actions). Inside the
        // models view, Enter edits the selected model's details.
        if (panel.view === 'provider') {
          dispatch({ type: 'authView', view: 'models', providerId });
          return;
        }
        runFlow(`Edit model — ${row.modelId}`, (io) =>
          authHost.editModelDetails(providerId, row.modelId, io),
        );
        return;
      }
      case 'list-action':
        if (row.action === 'catalog') openCatalog();
        else if (row.action === 'local') dispatch({ type: 'authView', view: 'local' });
        else if (row.action === 'oauth') dispatch({ type: 'authView', view: 'oauth' });
        else openCustomSetupForm();
        return;
      case 'key': {
        const providerId = panel.providerId;
        if (!providerId) return;
        const label = row.keyRow.label;
        void (async () => {
          const err = await authHost.setActiveKey(providerId, label);
          if (!mountedRef.current) return;
          dispatch({ type: 'authHint', text: err ? `✗ ${err}` : `✓ Active key → ${label}` });
          await reloadProviders();
        })();
        return;
      }
      case 'provider-action': {
        const providerId = panel.providerId;
        if (!providerId) return;
        switch (row.action) {
          case 'add-key':
            runFlow(`Add key — ${providerId}`, (io) => authHost.addKey(providerId, io));
            break;
          case 'edit-provider':
            openEditProviderForm(providerId);
            break;
          case 'add-model':
            runFlow(`Add model — ${providerId}`, (io) => authHost.addModel(providerId, io));
            break;
          case 'back-to-list':
            dispatch({ type: 'authView', view: 'list' });
            break;
          case 'remove': {
            const provider = panel.providers.find((p) => p.id === providerId);
            dispatch({
              type: 'authConfirmStart',
              question: `Remove provider "${providerId}" and ${provider?.keys.length ?? 0} key(s)?`,
              action: { kind: 'remove-provider', providerId },
            });
            break;
          }
          case 'edit-model-details':
          case 'reset-model-to-catalog':
            dispatch({ type: 'authHint', text: 'Select a model row first.' });
            break;
        }
        return;
      }
      case 'form-field':
        // Field rows are typed into directly via the key router; Enter on a
        // field row advances focus one step down so a double-tap reaches Save.
        dispatch({ type: 'authMove', delta: 1 });
        return;
      case 'form-action':
        if (row.action === 'cancel') {
          dispatch({ type: 'authFormCancel' });
          return;
        }
        // Local adds probe the server — they run as a flow (log streaming),
        // not as a direct save; the form already collected URL + key.
        if (stateRef.current.authPanel.form?.kind === 'local') {
          startLocalFlow(stateRef.current.authPanel.form);
          return;
        }
        void submitAuthForm();
        return;
      case 'catalog-entry':
        openCatalogSetupForm(row.entry);
        return;
      case 'local-preset':
        openLocalForm(row.preset);
        return;
      case 'oauth-option':
        runFlow(OAUTH_TITLE[row.oauth] ?? 'Sign in', (io) => authHost.oauthLogin(row.oauth, io));
        return;
      default:
        return;
    }
  }, [authHost, stateRef, dispatch, runFlow, openCatalog, reloadProviders]);

  const onAuthBack = useCallback(() => {
    const panel = stateRef.current.authPanel;
    if (panel.view === 'catalog' && panel.filter.length > 0) {
      dispatch({ type: 'authFilter', filter: '' });
      return;
    }
    if (panel.view === 'list') {
      dispatch({ type: 'authClose' });
      return;
    }
    // Esc on the add/edit form returns to the screen the form was opened
    // from — setup forms go back to the provider list, edit forms go back
    // to that provider's detail view.
    if (panel.view === 'form' && panel.form?.kind === 'edit' && panel.form.providerId) {
      dispatch({ type: 'authView', view: 'provider', providerId: panel.form.providerId });
      return;
    }
    dispatch({ type: 'authView', view: 'list' });
  }, [stateRef, dispatch]);

  const onAuthShortcut = useCallback(
    (input: string) => {
      if (!authHost) return;
      const panel = stateRef.current.authPanel;
      if (panel.view !== 'provider' && panel.view !== 'models') return;
      if (!panel.providerId) return;
      const providerId = panel.providerId;
      const row = authPanelRows(panel)[panel.selected];

      // Key shortcuts (provider view)
      if (row?.kind === 'key') {
        const label = row.keyRow.label;
        if (input === 'u') {
          runFlow(`Update key — ${providerId}/${label}`, (io) =>
            authHost.updateKey(providerId, label, io),
          );
        } else if (input === 'd') {
          dispatch({
            type: 'authConfirmStart',
            question: `Delete key "${label}" (${row.keyRow.masked})?`,
            action: { kind: 'delete-key', providerId, label },
          });
        }
        return;
      }

      // ME-5: Model shortcuts (provider + models view)
      if (row?.kind === 'model-row') {
        const modelId = row.modelId;
        if (input === 'x') {
          dispatch({
            type: 'authConfirmStart',
            question: `Remove model "${modelId}"?`,
            action: { kind: 'remove-model', providerId, modelId },
          });
        } else if (input === 'r') {
          void (async () => {
            const err = await authHost.resetModelToCatalog(providerId, modelId);
            if (!mountedRef.current) return;
            dispatch({
              type: 'authHint',
              text: err ? `✗ ${err}` : `✓ Reset "${modelId}" to catalog values`,
            });
            await reloadProviders();
          })();
        }
        return;
      }

      // ME-5: 'a' shortcut on model actions to add from catalog
      if (row?.kind === 'provider-action' && row.action === 'add-model' && input === 'a') {
        runFlow(`Add model (catalog) — ${providerId}`, (io) =>
          authHost.addModel(providerId, io, { fromCatalog: true }),
        );
        return;
      }
    },
    [authHost, stateRef, dispatch, runFlow, reloadProviders],
  );

  const onAuthPromptSubmit = useCallback(() => {
    const pending = promptRef.current;
    const draft = stateRef.current.authPanel.input?.draft ?? '';
    promptRef.current = null;
    dispatch({ type: 'authPromptEnd' });
    if (standaloneSecretRef.current) {
      standaloneSecretRef.current = false;
      dispatch({ type: 'authClose' });
    }
    pending?.resolve(draft);
  }, [stateRef, dispatch]);

  const onAuthPromptCancel = useCallback(() => {
    const pending = promptRef.current;
    promptRef.current = null;
    dispatch({ type: 'authPromptEnd' });
    if (standaloneSecretRef.current) {
      standaloneSecretRef.current = false;
      dispatch({ type: 'authClose' });
    }
    pending?.reject(abortError());
  }, [dispatch]);

  const readPrompt = useCallback(
    (label: string, masked: boolean) =>
      new Promise<string>((resolve, reject) => {
        const pending = promptRef.current;
        if (pending) {
          dispatch({ type: 'authPromptEnd' });
          pending.reject(abortError());
        }
        standaloneSecretRef.current = true;
        promptRef.current = { resolve, reject };
        dispatch({ type: 'authOpen', view: 'list', presets: [] });
        dispatch({ type: 'authPromptStart', label, masked });
      }),
    [dispatch],
  );
  const readSecret = useCallback((label: string) => readPrompt(label, true), [readPrompt]);
  const readText = useCallback((label: string) => readPrompt(label, false), [readPrompt]);

  const onAuthConfirm = useCallback(
    (yes: boolean) => {
      if (!authHost) return;
      const confirm = stateRef.current.authPanel.confirm;
      dispatch({ type: 'authConfirmEnd' });
      if (!confirm || !yes) return;
      void (async () => {
        if (confirm.action.kind === 'delete-key') {
          const { providerId, label } = confirm.action;
          const err = await authHost.deleteKey(providerId, label);
          if (!mountedRef.current) return;
          dispatch({
            type: 'authHint',
            text: err ? `✗ ${err}` : `✓ Deleted ${providerId}/${label}.`,
          });
        } else if (confirm.action.kind === 'remove-model') {
          const { providerId, modelId } = confirm.action;
          const err = await authHost.removeModel(providerId, modelId);
          if (!mountedRef.current) return;
          dispatch({
            type: 'authHint',
            text: err ? `✗ ${err}` : `✓ Removed model ${modelId}.`,
          });
        } else {
          const { providerId } = confirm.action;
          const err = await authHost.removeProvider(providerId);
          if (!mountedRef.current) return;
          dispatch({ type: 'authHint', text: err ? `✗ ${err}` : `✓ Removed ${providerId}.` });
          if (!err) dispatch({ type: 'authView', view: 'list' });
        }
        await reloadProviders();
      })();
    },
    [authHost, stateRef, dispatch, reloadProviders],
  );

  const onAuthFlowCancel = useCallback(() => {
    const panel = stateRef.current.authPanel;
    if (panel.flowDone) {
      dispatch({ type: 'authView', view: 'list' });
      return;
    }
    // Abort the flow AND reject any pending prompt — an OAuth flow may be
    // blocked on the loopback wait (signal) or on a paste prompt (reject).
    dispatch({ type: 'authPromptEnd' });
    abortLiveFlow();
  }, [stateRef, dispatch, abortLiveFlow]);

  const onAuthCtrlC = useCallback(() => {
    dispatch({ type: 'authPromptEnd' });
    abortLiveFlow();
    dispatch({ type: 'authClose' });
    dispatch({ type: 'addEntry', entry: { kind: 'warn', text: 'Auth panel cancelled.' } });
  }, [dispatch, abortLiveFlow]);

  return {
    openAuthPanel,
    onAuthEnter,
    onAuthBack,
    onAuthShortcut,
    onAuthPromptSubmit,
    onAuthPromptCancel,
    onAuthConfirm,
    onAuthFlowCancel,
    onAuthCtrlC,
    readSecret,
    readText,
  };
}

import type { BrainConfigPatchWire } from './brain.js';
import type { SessionScopedPayload } from './protocol-core.js';
import type { ProviderCustomModelWire } from './provider-custom-model-wire.js';
import type { OAuthKind } from './system.js';
export type ClientMessageSettings =
  | {
      type: 'acp.config_options';
      payload: { agentId: string; values: Record<string, string>; requestId: string };
    }
  | { type: 'providers.list' }
  | {
      type: 'provider.models';
      payload: { providerId: string; includeDisabled?: boolean | undefined };
    }
  | { type: 'provider.models.search'; payload: { query: string; limit?: number | undefined } }
  | {
      type: 'provider.test.run';
      payload: {
        requestId: string;
        providerId: string;
        modelIds: string[];
        timeoutMs?: number | undefined;
        maxTokens?: number | undefined;
      };
    }
  | { type: 'provider.test.cancel'; payload: { requestId: string } }
  | { type: 'providers.saved' }
  | { type: 'key.add'; payload: { providerId: string; label: string; apiKey: string } }
  | { type: 'key.update'; payload: { providerId: string; label: string; apiKey: string } }
  | { type: 'key.delete'; payload: { providerId: string; label: string } }
  | { type: 'key.set_active'; payload: { providerId: string; label: string } }
  | {
      type: 'provider.add';
      payload: {
        id: string;
        type?: string | undefined;
        family: string;
        baseUrl?: string | undefined;
        apiKey?: string | undefined;
        models?: string[] | undefined;
        customModels?: Record<string, ProviderCustomModelWire> | undefined;
      };
    }
  | { type: 'provider.remove'; payload: { providerId: string } }
  | { type: 'provider.clear_models'; payload: { providerId: string } }
  | {
      type: 'provider.custom_models.set';
      payload: {
        providerId: string;
        modelId: string;
        customModel: ProviderCustomModelWire;
      };
    }
  | {
      type: 'provider.custom_models.remove';
      payload: { providerId: string; modelId: string };
    }
  | { type: 'provider.undo_clear'; payload: { providerId: string; previousModels: string[] } }
  | {
      type: 'provider.update';
      payload: {
        id: string;
        cloud?: import('@wrongstack/core/cloud-provider').NativeCloudSettings | undefined;
        family?: string | undefined;
        baseUrl?: string | undefined;
        envVars?: string[] | undefined;
        models?: string[] | undefined;
        customModels?: Record<string, ProviderCustomModelWire> | undefined;
      };
    }
  | { type: 'provider.probe'; payload: { providerId: string; timeoutMs?: number | undefined } }
  | { type: 'auth.oauth.list' }
  | { type: 'auth.oauth.start'; payload: { kind: OAuthKind; providerId?: string | undefined } }
  | { type: 'auth.oauth.code'; payload: { kind: OAuthKind; input: string } }
  | { type: 'auth.oauth.cancel'; payload: { kind: OAuthKind } }
  | { type: 'provider.quota.get' }
  | { type: 'provider.quota.refresh' }
  | { type: 'provider.status.get' }
  | { type: 'provider.audit.get'; payload?: { count?: number | undefined } }
  | { type: 'provider.status.retry'; payload: { providerId: string; model: string } }
  | { type: 'provider.status.clear'; payload: { providerId: string; model: string } }
  | { type: 'prefs.update'; payload: Record<string, unknown> }
  | { type: 'prefs.get'; payload?: SessionScopedPayload | undefined }
  | { type: 'brain.status'; payload?: SessionScopedPayload }
  | { type: 'brain.risk'; payload: { level: string } & SessionScopedPayload }
  | { type: 'brain.ask'; payload: { question: string; requestId?: string } & SessionScopedPayload }
  | { type: 'brain.config.get' }
  | { type: 'brain.config.set'; payload: { patch: BrainConfigPatchWire } & SessionScopedPayload }
  | {
      type: 'model.refine';
      payload: {
        text: string;
        /** Retry window override (ms). Set on the auto-retry after a timeout. */
        timeoutMs?: number | undefined;
        /** Refine on this provider/model instead of the session's — ephemeral, no session switch. */
        provider?: string | undefined;
        model?: string | undefined;
        /** Previous refinement when the user asks the preview to try again better. */
        previousRefined?: string | undefined;
        previousEnglish?: string | undefined;
        retryFeedback?: string | undefined;
      };
    }
  | { type: 'config.doctor'; payload?: { apply?: boolean } | undefined }
  | { type: 'browser.policy'; payload: { args: string; sessionId?: string | undefined } }
  | {
      type: 'model.fallback_choice';
      payload: {
        requestId: string;
        providerId?: string | undefined;
        model?: string | undefined;
        /** When true, auto-switch to the next candidate (countdown expired or Esc). */
        autoSwitch?: boolean | undefined;
      };
    };

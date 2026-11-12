import { randomUUID } from 'node:crypto';
import type { Logger, PluginPromptOptions, PluginUiTone } from '@wrongstack/contracts/types';
import type { PluginUiRegistry } from '@wrongstack/core/plugin';
import type { WSClientMessage, WSServerMessage } from './types.js';

const DEFAULT_WEBUI_PLUGIN_PROMPT_TIMEOUT_MS = 60_000;
const MAX_WEBUI_PLUGIN_PROMPT_TIMEOUT_MS = 300_000;

interface PendingWebuiPluginPrompt {
  resolve: (value: string | boolean | null) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanupAbort: () => void;
}

export interface PluginUiWsBridgeOptions {
  registry: PluginUiRegistry | undefined;
  broadcast: (msg: WSServerMessage) => void;
  logger: Logger;
}

export interface PluginUiWsBridge {
  /** Consume `plugin.ui.prompt_response` client frames. Returns true when handled. */
  handleClientMessage(msg: WSClientMessage): boolean;
  /** Unsubscribe registry listeners and settle any pending prompts with `null`. */
  dispose(): void;
}

/**
 * Live WebSocket bridge for `PluginUiRegistry` (`api.ui`) on WebUI/Desktop hosts:
 * - Pushes `plugin.ui.updated` whenever status chips or panels change (4 Hz throttled upstream).
 * - Pushes `plugin.ui.notify` toasts when plugins invoke `api.ui.notify(...)`.
 * - Coordinates interactive `api.ui.prompt(...)` modals (`select` | `confirm` | `input`) with
 *   bounded timeout and `AbortSignal` cleanup.
 */
export function createPluginUiWsBridge(opts: PluginUiWsBridgeOptions): PluginUiWsBridge {
  const { registry, broadcast, logger } = opts;
  if (!registry) {
    return {
      handleClientMessage: () => false,
      dispose: () => {},
    };
  }

  const pendingPrompts = new Map<string, PendingWebuiPluginPrompt>();

  const settlePrompt = (
    promptId: string,
    value: string | boolean | null,
    correlationId?: string,
  ): boolean => {
    const pending = pendingPrompts.get(promptId);
    if (!pending) {
      if (correlationId && correlationId !== promptId) {
        broadcast({
          type: 'plugin.ui.prompt_resolved',
          payload: { requestId: correlationId, promptId },
        });
      }
      return false;
    }
    pendingPrompts.delete(promptId);
    clearTimeout(pending.timer);
    pending.cleanupAbort();
    broadcast({
      type: 'plugin.ui.prompt_resolved',
      payload: { requestId: correlationId ?? promptId, promptId },
    });
    pending.resolve(value);
    return true;
  };

  const unsubscribe = registry.subscribe(() => {
    broadcast({
      type: 'plugin.ui.updated',
      payload: {
        statusChips: registry.listStatusChips(),
        panelIds: registry.listPanels().map((p) => p.qualifiedId),
      },
    });
  });

  registry.setHandlers({
    onNotify: (owner: string, message: string, tone: PluginUiTone) => {
      if (tone === 'danger' || tone === 'warning') {
        logger.warn(`[plugin:${owner}] ${message}`);
      } else {
        logger.info(`[plugin:${owner}] ${message}`);
      }
      broadcast({
        type: 'plugin.ui.notify',
        payload: { owner, message, tone },
      });
    },
    onPrompt: <T extends string = string>(
      owner: string,
      promptOpts: PluginPromptOptions<T>,
      signal: AbortSignal,
    ): Promise<T | boolean | string | null> => {
      if (signal.aborted) return Promise.resolve(null);
      const requestId = randomUUID();
      const timeoutMs = Math.max(
        1_000,
        Math.min(
          MAX_WEBUI_PLUGIN_PROMPT_TIMEOUT_MS,
          promptOpts.timeoutMs ?? DEFAULT_WEBUI_PLUGIN_PROMPT_TIMEOUT_MS,
        ),
      );

      return new Promise<T | boolean | string | null>((resolve) => {
        const onAbort = () => {
          settlePrompt(requestId, null);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => {
          settlePrompt(requestId, null);
        }, timeoutMs);
        timer.unref?.();

        pendingPrompts.set(requestId, {
          resolve: resolve as (value: string | boolean | null) => void,
          timer,
          cleanupAbort: () => signal.removeEventListener('abort', onAbort),
        });

        broadcast({
          type: 'plugin.ui.prompt',
          payload: {
            requestId,
            promptId: requestId,
            owner,
            kind: promptOpts.kind,
            title: promptOpts.title,
            ...(promptOpts.message ? { message: promptOpts.message } : {}),
            ...(promptOpts.options ? { options: promptOpts.options } : {}),
          },
        });
      });
    },
  });

  return {
    handleClientMessage(msg: WSClientMessage): boolean {
      if (msg.type !== 'plugin.ui.prompt_response') return false;
      const payload = msg.payload as
        | { requestId?: unknown; promptId?: unknown; value?: unknown }
        | undefined;
      if (!payload) return true;
      const promptId =
        typeof payload.promptId === 'string'
          ? payload.promptId
          : typeof payload.requestId === 'string'
            ? payload.requestId
            : undefined;
      if (!promptId) return true;
      const correlationId = typeof payload.requestId === 'string' ? payload.requestId : promptId;
      const raw = payload.value;
      const value =
        typeof raw === 'string' || typeof raw === 'boolean' || raw === null ? raw : null;
      settlePrompt(promptId, value, correlationId);
      return true;
    },
    dispose(): void {
      unsubscribe();
      for (const requestId of [...pendingPrompts.keys()]) {
        settlePrompt(requestId, null);
      }
    },
  };
}

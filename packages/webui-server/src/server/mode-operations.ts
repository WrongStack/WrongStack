import type { ModeStore } from '@wrongstack/core/types';
import { ToolValidationError } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import type { WebSocket } from 'ws';
import type { WSServerMessage } from './types.js';

interface ModeSession {
  append(event: { type: 'mode_changed'; ts: string; from: string; to: string }): Promise<unknown>;
}

export interface ModeOperationsContext {
  modeStore?: ModeStore | undefined;
  getSession?: (() => ModeSession | null | undefined) | undefined;
  /**
   * Record the active mode. `sessionId` names the tab that switched — each
   * WebUI tab carries its own mode, so the process-wide value is only the
   * default a newly opened tab inherits.
   */
  applyModeId: (id: string, sessionId?: string) => void;
  afterSwitch?: ((id: string, sessionId?: string) => void | Promise<void>) | undefined;
  send: (ws: WebSocket, message: WSServerMessage) => void;
}

function sendResult(
  context: ModeOperationsContext,
  ws: WebSocket,
  success: boolean,
  message: string,
): void {
  context.send(ws, { type: 'key.operation_result', payload: { success, message } });
}

export function createModeOperations(context: ModeOperationsContext) {
  return {
    async listModes(ws: WebSocket): Promise<void> {
      if (!context.modeStore) {
        context.send(ws, {
          type: 'modes.list',
          payload: { modes: [], activeId: 'default', error: 'Mode store not available' },
        });
        return;
      }
      try {
        const modes = await context.modeStore.listModes();
        const active = await context.modeStore.getActiveMode();
        context.send(ws, {
          type: 'modes.list',
          payload: {
            modes: modes.map((mode) => ({
              id: mode.id,
              name: mode.name,
              description: mode.description,
              isActive: mode.id === (active?.id ?? 'default'),
            })),
            activeId: active?.id ?? 'default',
          },
        });
      } catch (error) {
        context.send(ws, {
          type: 'modes.list',
          payload: { modes: [], activeId: 'default', error: toErrorMessage(error) },
        });
      }
    },

    async switchMode(ws: WebSocket, id: string, sessionId?: string): Promise<void> {
      if (!context.modeStore) {
        sendResult(context, ws, false, 'Mode store not available');
        return;
      }
      try {
        const previous = await context.modeStore.getActiveMode();
        if (id === 'default') await context.modeStore.setActiveMode(null);
        else {
          const found = await context.modeStore.getMode(id);
          if (!found) {
            throw new ToolValidationError({
              message: `Unknown mode "${id}"`,
              field: 'modeId',
              context: { requestedMode: id, kind: 'mode.switch' },
            });
          }
          await context.modeStore.setActiveMode(id);
        }
        context.applyModeId(id, sessionId);
        const from = previous?.id ?? 'default';
        const session = context.getSession?.();
        if (session && from !== id) {
          void session
            .append({ type: 'mode_changed', ts: new Date().toISOString(), from, to: id })
            .catch(() => undefined);
        }
        await context.afterSwitch?.(id);
        sendResult(context, ws, true, `Switched to mode "${id}"`);
      } catch (error) {
        sendResult(context, ws, false, toErrorMessage(error));
      }
    },
  };
}

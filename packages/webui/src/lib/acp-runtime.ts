import type {
  AcpNativeModeChoice,
  AcpNativeModeSelector,
  AcpRuntimeOptionsResult,
  AcpRuntimeValues,
} from '@wrongstack/contracts/types/acp-runtime';
import { acpModeKey, useAcpModeStore } from '@/stores/acp-mode-store';
import { safeId } from './utils';
import { getWSClient } from './ws-client';

export function saveSessionAcpRuntime(
  settings: import('@wrongstack/contracts/types/acp-runtime').AcpRuntimeSelections,
  sessionId: string | null,
): Promise<void> {
  const client = getWSClient();
  if (!sessionId || client.status.state !== 'open')
    return Promise.reject(new Error('ACP settings require a connected session.'));
  const requestId = safeId();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error('ACP settings save was not confirmed.'));
    }, 15_000);
    const off = client.on('key.operation_result', (message) => {
      const payload = message.payload as Record<string, unknown>;
      if (payload['requestId'] !== requestId) return;
      clearTimeout(timer);
      off();
      if (payload['success'] !== true)
        reject(new Error(String(payload['message'] ?? 'ACP settings save failed.')));
      else resolve();
    });
    if (
      !client.send({
        type: 'prefs.update',
        payload: { sessionId, requestId, acpRuntime: settings },
      })
    ) {
      clearTimeout(timer);
      off();
      reject(new Error('ACP settings save could not be sent.'));
    }
  });
}

export function requestAcpRuntime(
  agentId: string,
  values: AcpRuntimeValues,
): Promise<AcpRuntimeOptionsResult> {
  const client = getWSClient();
  if (client.status.state !== 'open')
    return Promise.reject(new Error('ACP settings require a connected session.'));
  const requestId = safeId();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error('ACP settings request timed out.'));
    }, 100_000);
    const off = client.on('acp.config_options', (message) => {
      const payload = message.payload as Record<string, unknown>;
      if (payload['requestId'] !== requestId) return;
      clearTimeout(timer);
      off();
      if (payload['ok'] !== true)
        reject(new Error(String(payload['error'] ?? 'ACP settings request failed.')));
      else resolve(payload as unknown as AcpRuntimeOptionsResult);
    });
    if (!client.send({ type: 'acp.config_options', payload: { agentId, values, requestId } })) {
      clearTimeout(timer);
      off();
      reject(new Error('ACP settings require a connected session.'));
    }
  });
}

export function requestAcpMode(
  agentId: string,
  sessionId: string | null,
  choice?: AcpNativeModeChoice,
): Promise<{ modes: AcpNativeModeSelector[] }> {
  const client = getWSClient();
  if (client.status.state !== 'open')
    return Promise.reject(new Error('ACP mode requires a connected session.'));
  const requestId = safeId();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error('ACP mode request timed out.'));
    }, 100_000);
    const off = client.on('acp.mode', (message) => {
      const payload = message.payload as Record<string, unknown>;
      if (payload['requestId'] !== requestId) return;
      clearTimeout(timer);
      off();
      if (payload['ok'] !== true)
        reject(new Error(String(payload['error'] ?? 'ACP mode request failed.')));
      else {
        const modes = (payload['modes'] as AcpNativeModeSelector[] | undefined) ?? [];
        useAcpModeStore.getState().record(acpModeKey(sessionId, agentId), modes);
        resolve({ modes });
      }
    });
    if (
      !client.send({
        type: 'acp.mode',
        payload: {
          agentId,
          ...(sessionId ? { sessionId } : {}),
          ...(choice?.optionId ? { optionId: choice.optionId } : {}),
          ...(choice?.value ? { value: choice.value } : {}),
          requestId,
        },
      })
    ) {
      clearTimeout(timer);
      off();
      reject(new Error('ACP mode requires a connected session.'));
    }
  });
}

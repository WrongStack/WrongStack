import type { Config, MemoryPort } from '@wrongstack/contracts/types';
import {
  getSageSurface,
  SAGE_DOCTOR_FIX_IDS,
  type SageDoctorFixId,
  sageHygieneOptionsFromConfig,
} from '@wrongstack/sage';
import type { WebSocket } from 'ws';
import { requiresSage } from './memory-candidate-handlers.js';
import { errMessage, send, withRequestId } from './ws-utils.js';

/**
 * SAGE Doctor: the store health report, optionally after named repairs.
 * Request:  { type: 'memory.sage.doctor', payload?: { fix?: SageDoctorFixId[], requestId? } }
 * Response: { type: 'memory.sage.doctor', payload: { report, requestId? } | { error, requestId? } }
 *
 * `fix` ids are validated against `SAGE_DOCTOR_FIX_IDS` before anything runs,
 * so a typo never silently degrades to a read-only report. The `hygiene`
 * repair uses the host's configured hygiene options when config is reachable;
 * the remote port already allows it minutes, so the handler adds no timeout.
 */
export async function handleSageDoctor(
  ws: WebSocket,
  msg: unknown,
  memoryStore: MemoryPort,
  getConfig?: () => Config | undefined,
): Promise<void> {
  const reply = (payload: Record<string, unknown>) =>
    send(ws, { type: 'memory.sage.doctor', payload: withRequestId(msg, payload) });
  const Sage = getSageSurface(memoryStore);
  if (!Sage?.doctor) {
    reply({ error: requiresSage('memory.sage.doctor') });
    return;
  }
  const payload = (msg as { payload?: Record<string, unknown> } | undefined)?.payload ?? {};
  const rawFix = payload['fix'];
  if (rawFix !== undefined && !Array.isArray(rawFix)) {
    reply({ error: '`fix` must be an array of doctor fix ids.' });
    return;
  }
  const unknown = (rawFix ?? []).filter(
    (id) => typeof id !== 'string' || !SAGE_DOCTOR_FIX_IDS.includes(id as SageDoctorFixId),
  );
  if (unknown.length > 0) {
    reply({
      error: `Unknown doctor fix: ${unknown.map(String).join(', ')}. Valid: ${SAGE_DOCTOR_FIX_IDS.join(', ')}.`,
    });
    return;
  }
  const fix = [...new Set(rawFix as SageDoctorFixId[] | undefined)];
  try {
    const config = getConfig?.();
    const report = await Sage.doctor({
      ...(fix.length > 0 ? { fix } : {}),
      ...(config ? { hygieneOptions: sageHygieneOptionsFromConfig(config.Sage?.hygiene) } : {}),
    });
    if (!report || !Array.isArray(report.checks)) {
      reply({
        error:
          'The running SAGE daemon predates `doctor`; it restarts once every session for this project closes.',
      });
      return;
    }
    reply({ report });
  } catch (err) {
    reply({ error: `SAGE doctor failed: ${errMessage(err)}` });
  }
}

import {
  formatAutoWakeNotice,
  formatAutoWakeSuppressedNotice,
  formatDeliveryPendingNotice,
} from '@wrongstack/webui-protocol';

/**
 * Engine reports about a conversation that change what the user should know or do next, but
 * that do not belong to a message: why a run stopped early, a damaged journal, a failed
 * compaction, a model the provider substituted or a blocked provider.
 */
export interface ConversationNotice {
  id: string;
  severity: 'error' | 'warning' | 'info';
  text: string;
  hint: string;
  at: number;
  /** An engine request the user can make from the notice, such as accepting a proposal. */
  action?: { label: string; type: string; payload: Record<string, unknown> } | undefined;
  /** Shown once per conversation: a repeat of the same text is dropped wherever it is. */
  once?: boolean | undefined;
  /**
   * What the WebUI shows as a passing toast: only when it happens live (never from a replayed
   * journal) and only for a few seconds.
   */
  transient?: boolean | undefined;
}

/** Notices kept per conversation, newest last. */
export const NOTICE_LIMIT = 10;

const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const num = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const route = (value: unknown) => {
  const target = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return [str(target['providerId']), str(target['model'])].filter(Boolean).join('/');
};
const ids = (value: unknown) =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];

/**
 * What the WebUI tells the user about a run as it happens, in a toast or a system line: a stream
 * warning, a model switch, a checkpoint, a cost that cannot be estimated, a persisted approval,
 * background delegation results, and an MCP server that dropped or came back.
 */
function runEventNotice(
  type: string,
  payload: Record<string, unknown>,
): {
  severity: ConversationNotice['severity'];
  text: string;
  hint?: string;
  once?: boolean;
  transient?: boolean;
} | null {
  if (type === 'provider.stream_error')
    return {
      severity: 'warning',
      text: `Provider stream warning (${str(payload['eventType']) || 'unknown event'}): ${str(payload['message']) || 'no detail'}.`,
      hint: 'The engine skipped this stream event and kept going.',
    };
  if (type === 'provider.model_switched') {
    const from = route(payload['from']),
      to = route(payload['to']);
    if (!to || from === to) return null;
    return {
      severity: 'info',
      text: `Model: ${to}${from ? ` (was ${from})` : ''}.`,
      transient: true,
    };
  }
  if (type === 'checkpoint.written') {
    const index = num(payload['promptIndex']),
      files = num(payload['fileCount']);
    return {
      severity: 'info',
      text: `Checkpoint${index === null ? '' : ` #${index}`} written (${files ?? 0} ${files === 1 ? 'file' : 'files'}).`,
      hint: str(payload['promptPreview']),
      transient: true,
    };
  }
  if (type === 'token.cost_estimate_unavailable')
    return {
      severity: 'info',
      text: `Cost estimate unavailable for ${str(payload['model']) || 'this model'}.`,
      hint: 'Its price is not in the model catalog; token counts are still recorded.',
      once: true,
      transient: true,
    };
  if (type === 'trust.persisted') {
    const label = `${str(payload['tool'])}: ${str(payload['displayPattern']) || str(payload['pattern'])}`;
    return payload['decision'] === 'always'
      ? { severity: 'info', text: `Always allowed ${label}.`, transient: true }
      : { severity: 'warning', text: `Denied ${label}.`, transient: true };
  }
  if (type === 'delegation.delivery_pending') {
    const delegations = ids(payload['delegationIds']);
    return {
      severity: 'info',
      text: formatDeliveryPendingNotice(
        delegations,
        num(payload['count']) ?? (delegations.length || 1),
      ),
    };
  }
  if (type === 'delegation.auto_wake_started')
    return {
      severity: 'info',
      text: formatAutoWakeNotice(ids(payload['delegationIds']), num(payload['chain']) ?? undefined),
    };
  if (type === 'delegation.auto_wake_suppressed' && payload['reason'] === 'chain_cap')
    return { severity: 'info', text: formatAutoWakeSuppressedNotice(num(payload['pending']) ?? 1) };
  if (type === 'mcp.server.disconnected' && payload['terminal'] === true && str(payload['name']))
    return {
      severity: 'warning',
      text: `MCP server "${str(payload['name'])}" is not connected (${str(payload['reason']).split('\n')[0] || 'unknown'}); its tools are unavailable.`,
      hint: 'Settings > Connected tools can reconnect it.',
    };
  if (type === 'mcp.server.reconnected' && str(payload['name']))
    return {
      severity: 'info',
      text: `MCP server "${str(payload['name'])}" is connected again.`,
      transient: true,
    };
  return null;
}

/** The notice an engine frame warrants, or null for frames that need none. */
export function conversationNotice(
  type: string,
  payload: Record<string, unknown>,
  id: string,
  at = Date.now(),
): ConversationNotice | null {
  const notice = (severity: ConversationNotice['severity'], text: string, hint = '') => ({
    id,
    severity,
    text,
    hint,
    at,
  });
  if (type === 'model.tier_proposed') {
    const target = payload['target'] as Record<string, unknown> | undefined;
    const provider = str(target?.['provider']),
      model = str(target?.['model']),
      tier = str(payload['toTier']);
    if (!provider || !model || !tier) return null;
    const savings = num(payload['projectedSavingsUsd']);
    return {
      ...notice(
        'info',
        `WrongStack proposes the ${tier} tier: ${provider}/${model}.`,
        [
          str(payload['reason']),
          savings !== null && savings > 0 ? `Projected saving about $${savings.toFixed(4)}.` : '',
        ]
          .filter(Boolean)
          .join(' '),
      ),
      action: { label: `Switch to ${tier}`, type: 'model.switch', payload: { provider, model } },
    };
  }
  if (type === 'run.result' && payload['status'] === 'max_iterations') {
    const turns = num(payload['iterations']);
    return notice(
      'warning',
      `The run stopped at its iteration limit${turns === null ? '' : ` after ${turns} turns`}.`,
      'Send a message to continue from here. The limit is the tools.maxIterations setting.',
    );
  }
  if (type === 'tool.loop_detected' && payload['action'] !== 'steer') {
    const tools = str(payload['tools']);
    const repeats = num(payload['repeatCount']);
    return notice(
      'warning',
      `The engine ended the turn: ${tools ? `repeated ${tools} calls` : 'a repeating reply'}${repeats === null ? '' : ` (${repeats} repeats)`}.`,
      'Rephrase the request or give the missing information before continuing.',
    );
  }
  if (type === 'session.damaged')
    return notice(
      'error',
      `This conversation's journal is damaged${str(payload['detail']) ? `: ${str(payload['detail'])}` : '.'}`,
      'History & recovery shows what the journal still holds.',
    );
  if (type === 'compaction.failed')
    return notice(
      'warning',
      `Context compaction failed${str(payload['message']) ? `: ${str(payload['message'])}` : '.'}`,
      'The context was not reduced; Context & instructions shows its current size.',
    );
  if (type === 'provider.model_rerouted') {
    const served = str(payload['served']),
      requested = str(payload['requested']);
    if (!served || served === requested) return null;
    return notice(
      'info',
      `${str(payload['providerId']) || 'The provider'} answered with ${served} instead of ${requested || 'the requested model'}${str(payload['reason']) ? ` (${str(payload['reason'])})` : ''}.`,
    );
  }
  const runNotice = runEventNotice(type, payload);
  if (runNotice)
    return {
      ...notice(runNotice.severity, runNotice.text, runNotice.hint ?? ''),
      ...(runNotice.once ? { once: true } : {}),
      ...(runNotice.transient ? { transient: true } : {}),
    };
  if (type === 'provider.active_blocked') {
    const fallback = [str(payload['fallbackProviderId']), str(payload['fallbackModel'])]
      .filter(Boolean)
      .join('/');
    return notice(
      'warning',
      `${[str(payload['providerId']), str(payload['model'])].filter(Boolean).join('/') || 'The provider'} is blocked${str(payload['lastError']) ? `: ${str(payload['lastError'])}` : ''}.`,
      fallback ? `The engine tries ${fallback} instead.` : '',
    );
  }
  return null;
}

/** Appends a notice, dropping an identical text that is already the newest, within the bound. */
export function appendNotice(notices: ConversationNotice[], notice: ConversationNotice) {
  if (notices.at(-1)?.text === notice.text) return notices;
  if (notice.once && notices.some((item) => item.text === notice.text)) return notices;
  return [...notices, notice].slice(-NOTICE_LIMIT);
}

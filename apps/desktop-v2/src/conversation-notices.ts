import { displayDecimal } from './display-dates';
import english from './locales/en/desktop.json';

/**
 * Notice wording kept apart from the display language: engine text shown as it came, a catalog
 * line under `notices` with its values (themselves wording or numbers), or parts read in turn.
 */
export type NoticeText =
  | string
  | { key: string; values?: Record<string, NoticeText | number> }
  | NoticeText[];

/** Looks up one `notices` catalog line with its values filled in. */
export type NoticeTranslate = (key: string, values: Record<string, string | number>) => string;

/**
 * Engine reports about a conversation that change what the user should know or do next, but
 * that do not belong to a message: why a run stopped early, a damaged journal, a failed
 * compaction, a model the provider substituted or a blocked provider.
 */
export interface ConversationNotice {
  id: string;
  severity: 'error' | 'warning' | 'info';
  /** The notice in English, which is also what a repeat is recognised by. */
  text: string;
  hint: string;
  /** The text and hint as wording, shown in the display language. */
  message?: NoticeText | undefined;
  detail?: NoticeText | undefined;
  at: number;
  /** An engine request the user can make from the notice, such as accepting a proposal. */
  action?:
    | {
        label: string;
        labelText?: NoticeText | undefined;
        type: string;
        payload: Record<string, unknown>;
      }
    | undefined;
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

const englishLines = english.notices as Record<string, string>;
const inEnglish: NoticeTranslate = (key, values) =>
  (englishLines[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
    String(values[name] ?? ''),
  );

/** Renders notice wording through a catalog lookup, in English when none is given. */
export function noticeText(text: NoticeText | undefined, translate = inEnglish): string {
  if (text === undefined) return '';
  if (typeof text === 'string') return text;
  if (Array.isArray(text))
    return text
      .map((part) => noticeText(part, translate))
      .filter(Boolean)
      .join(' ');
  const values: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(text.values ?? {}))
    values[name] = typeof value === 'number' ? value : noticeText(value, translate);
  return translate(text.key, values);
}

const line = (key: string, values?: Record<string, NoticeText | number>): NoticeText =>
  values ? { key, values } : { key };

const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const num = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const route = (value: unknown) => {
  const target = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return [str(target['providerId']), str(target['model'])].filter(Boolean).join('/');
};
const ids = (value: unknown) =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
/** The delegation ids a notice names after its subject, or nothing. */
const idSuffix = (delegations: string[]): NoticeText =>
  delegations.length ? line('idsSuffix', { ids: delegations.join(', ') }) : '';

interface NoticeWords {
  severity: ConversationNotice['severity'];
  message: NoticeText;
  detail?: NoticeText;
  once?: boolean;
  transient?: boolean;
}

/**
 * What the WebUI tells the user about a run as it happens, in a toast or a system line: a stream
 * warning, a model switch, a checkpoint, a cost that cannot be estimated, a persisted approval,
 * background delegation results, and an MCP server that dropped or came back.
 */
function runEventNotice(type: string, payload: Record<string, unknown>): NoticeWords | null {
  // The engine read a newer WrongStack release than the one it runs: once per conversation.
  if (
    type === 'session.start' &&
    payload['updateAvailable'] === true &&
    str(payload['latestVersion']) &&
    str(payload['appVersion'])
  )
    return {
      severity: 'info',
      message: line('updateAvailable', {
        latest: str(payload['latestVersion']),
        current: str(payload['appVersion']),
      }),
      detail: line('updateAvailableHint'),
      once: true,
    };
  if (type === 'provider.stream_error')
    return {
      severity: 'warning',
      message: line('streamWarning', {
        event: str(payload['eventType']) || line('unknownEvent'),
        message: str(payload['message']) || line('noDetail'),
      }),
      detail: line('streamWarningHint'),
    };
  if (type === 'provider.model_switched') {
    const from = route(payload['from']),
      to = route(payload['to']);
    if (!to || from === to) return null;
    return {
      severity: 'info',
      message: from ? line('modelSwitchedFrom', { to, from }) : line('modelSwitched', { to }),
      transient: true,
    };
  }
  if (type === 'checkpoint.written') {
    const index = num(payload['promptIndex']),
      files = num(payload['fileCount']) ?? 0;
    const key = `checkpoint${index === null ? '' : 'Numbered'}${files === 1 ? 'OneFile' : 'Files'}`;
    return {
      severity: 'info',
      message: line(key, { ...(index === null ? {} : { index }), files }),
      detail: str(payload['promptPreview']),
      transient: true,
    };
  }
  if (type === 'token.cost_estimate_unavailable')
    return {
      severity: 'info',
      message: line('costUnavailable', { model: str(payload['model']) || line('thisModel') }),
      detail: line('costUnavailableHint'),
      once: true,
      transient: true,
    };
  if (type === 'trust.persisted') {
    const label = `${str(payload['tool'])}: ${str(payload['displayPattern']) || str(payload['pattern'])}`;
    return payload['decision'] === 'always'
      ? { severity: 'info', message: line('alwaysAllowed', { label }), transient: true }
      : { severity: 'warning', message: line('denied', { label }), transient: true };
  }
  if (type === 'delegation.delivery_pending') {
    const delegations = ids(payload['delegationIds']);
    const count = num(payload['count']) ?? (delegations.length || 1);
    return {
      severity: 'info',
      message:
        count === 1
          ? line('deliveryPendingOne', { ids: idSuffix(delegations) })
          : line('deliveryPendingMany', { total: count, ids: idSuffix(delegations) }),
    };
  }
  if (type === 'delegation.auto_wake_started') {
    const delegations = ids(payload['delegationIds']),
      notices = ids(payload['notices']),
      chain = num(payload['chain']);
    // A wake carrying only timer/watch/process notices the agent asked for
    // must not read as "delegation results arrived".
    const noticeOnly = delegations.length === 0 && notices.length > 0;
    return {
      severity: 'info',
      message: line('autoWake', {
        results: noticeOnly
          ? line(notices.length === 1 ? 'autoWakeOneNotice' : 'autoWakeNotices')
          : line(delegations.length === 1 ? 'autoWakeOneResult' : 'autoWakeResults'),
        ids: idSuffix(noticeOnly ? notices : delegations),
        chain: chain !== null && chain > 0 ? line('autoWakeChain', { chain }) : '',
      }),
    };
  }
  if (type === 'delegation.auto_wake_suppressed' && payload['reason'] === 'chain_cap') {
    const pending = num(payload['pending']) ?? 1;
    return {
      severity: 'info',
      message: pending === 1 ? line('autoWakePausedOne') : line('autoWakePaused', { pending }),
    };
  }
  if (type === 'mcp.server.disconnected' && payload['terminal'] === true && str(payload['name']))
    return {
      severity: 'warning',
      message: line('mcpDisconnected', {
        name: str(payload['name']),
        reason: str(payload['reason']).split('\n')[0] || line('unknownReason'),
      }),
      detail: line('mcpDisconnectedHint'),
    };
  if (type === 'mcp.server.reconnected' && str(payload['name']))
    return {
      severity: 'info',
      message: line('mcpReconnected', { name: str(payload['name']) }),
      transient: true,
    };
  return null;
}

/** The notice for the engine frames that change what to do next, other than run events. */
function stopNotice(type: string, payload: Record<string, unknown>): NoticeWords | null {
  if (type === 'run.result' && payload['status'] === 'max_iterations') {
    const turns = num(payload['iterations']);
    return {
      severity: 'warning',
      message: turns === null ? line('iterationLimit') : line('iterationLimitTurns', { turns }),
      detail: line('iterationLimitHint'),
    };
  }
  if (type === 'tool.loop_detected' && payload['action'] !== 'steer') {
    const tools = str(payload['tools']);
    const repeats = num(payload['repeatCount']);
    return {
      severity: 'warning',
      message: line('loopEnded', {
        what: tools ? line('repeatedCalls', { tools }) : line('repeatingReply'),
        repeats: repeats === null ? '' : line('repeatsSuffix', { repeats }),
      }),
      detail: line('loopEndedHint'),
    };
  }
  if (type === 'session.damaged') {
    const detail = str(payload['detail']);
    return {
      severity: 'error',
      message: detail ? line('journalDamagedDetail', { detail }) : line('journalDamaged'),
      detail: line('journalDamagedHint'),
    };
  }
  if (type === 'compaction.failed') {
    const message = str(payload['message']);
    return {
      severity: 'warning',
      message: message ? line('compactionFailedDetail', { message }) : line('compactionFailed'),
      detail: line('compactionFailedHint'),
    };
  }
  if (type === 'provider.model_rerouted') {
    const served = str(payload['served']),
      requested = str(payload['requested']),
      reason = str(payload['reason']);
    if (!served || served === requested) return null;
    return {
      severity: 'info',
      message: line('modelRerouted', {
        provider: str(payload['providerId']) || line('theProvider'),
        served,
        requested: requested || line('requestedModel'),
        reason: reason ? line('reasonSuffix', { reason }) : '',
      }),
    };
  }
  if (type === 'provider.active_blocked') {
    const fallback = [str(payload['fallbackProviderId']), str(payload['fallbackModel'])]
      .filter(Boolean)
      .join('/');
    const provider =
      [str(payload['providerId']), str(payload['model'])].filter(Boolean).join('/') ||
      line('theProvider');
    const error = str(payload['lastError']);
    return {
      severity: 'warning',
      message: error
        ? line('providerBlockedError', { provider, error })
        : line('providerBlocked', { provider }),
      detail: fallback ? line('providerFallback', { fallback }) : '',
    };
  }
  return null;
}

/** The notice an engine frame warrants, or null for frames that need none. */
export function conversationNotice(
  type: string,
  payload: Record<string, unknown>,
  id: string,
  at = Date.now(),
): ConversationNotice | null {
  const notice = (
    severity: ConversationNotice['severity'],
    message: NoticeText,
    detail: NoticeText = '',
  ) => ({
    id,
    severity,
    text: noticeText(message),
    hint: noticeText(detail),
    message,
    detail,
    at,
  });
  if (type === 'model.tier_proposed') {
    const target = payload['target'] as Record<string, unknown> | undefined;
    const provider = str(target?.['provider']),
      model = str(target?.['model']),
      tier = str(payload['toTier']);
    if (!provider || !model || !tier) return null;
    const savings = num(payload['projectedSavingsUsd']);
    const labelText = line('switchTier', { tier });
    return {
      ...notice('info', line('tierProposed', { tier, route: `${provider}/${model}` }), [
        str(payload['reason']),
        savings !== null && savings > 0
          ? line('projectedSaving', { amount: displayDecimal(savings, 4) })
          : '',
      ]),
      action: {
        label: noticeText(labelText),
        labelText,
        type: 'model.switch',
        payload: { provider, model },
      },
    };
  }
  const words = stopNotice(type, payload) ?? runEventNotice(type, payload);
  if (!words) return null;
  return {
    ...notice(words.severity, words.message, words.detail),
    ...(words.once ? { once: true } : {}),
    ...(words.transient ? { transient: true } : {}),
  };
}

/** Appends a notice, dropping an identical text that is already the newest, within the bound. */
export function appendNotice(notices: ConversationNotice[], notice: ConversationNotice) {
  if (notices.at(-1)?.text === notice.text) return notices;
  if (notice.once && notices.some((item) => item.text === notice.text)) return notices;
  return [...notices, notice].slice(-NOTICE_LIMIT);
}

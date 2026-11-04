import type { ReasoningEffort } from '@wrongstack/contracts/types';
import type { WSUserMessageImage } from '@wrongstack/webui-protocol';
import { validateAttachmentPayload, validateAttachments } from './composer-attachments';
import { englishText } from './desktop-text';
import type { EngineCommand, EngineSend } from './engine-operations';
import { type EngineState, entries } from './engine-state';

export type SubmitMode = 'btw' | 'queue' | 'steer';
export const effortNames: Record<ReasoningEffort, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Maximum',
};
export function sessionEffort(state: EngineState, suppressLeader = false) {
  const snapshot = state.results['session.start'];
  const start =
    snapshot?.['provider'] === state.provider && snapshot?.['model'] === state.model
      ? snapshot
      : {};
  const catalog = state.results['provider.models'];
  const model =
    catalog?.['provider'] === state.provider
      ? entries(catalog['models']).find((row) => row['id'] === state.model)
      : undefined;
  const support = model?.['effortSupported'] ?? start['effortSupported'];
  const advertised = model?.['reasoningEffortLevels'] ?? start['reasoningEffortLevels'];
  const levels = Array.isArray(advertised)
    ? advertised.filter(
        (value): value is ReasoningEffort =>
          typeof value === 'string' && Object.hasOwn(effortNames, value),
      )
    : [];
  const current = String(state.results['prefs.updated']?.['reasoningEffort'] ?? 'auto');
  const options = levels.length ? [...levels] : (Object.keys(effortNames) as ReasoningEffort[]);
  if (Object.hasOwn(effortNames, current) && !options.includes(current as ReasoningEffort))
    options.push(current as ReasoningEffort);
  const leader = state.results['leader.effort_changed'];
  return {
    hidden: support === false,
    current,
    options,
    unsupported:
      current !== 'auto' && levels.length > 0 && !levels.includes(current as ReasoningEffort),
    /** The project's effort that `auto` follows, when the engine reports a known level. */
    projectEffort:
      typeof start['projectReasoningEffort'] === 'string' &&
      Object.hasOwn(effortNames, start['projectReasoningEffort'])
        ? (start['projectReasoningEffort'] as ReasoningEffort)
        : null,
    /** The effort the leader chose for its own turns, shown beside the control. */
    leaderEffort: !suppressLeader && typeof leader?.['effort'] === 'string' ? leader['effort'] : '',
    reason: String(leader?.['reason'] ?? ''),
  };
}
export function supportsQueue(state: EngineState): boolean {
  const capabilities = state.results['session.start']?.['protocolCapabilities'];
  return Array.isArray(capabilities) && capabilities.includes('session.prompt-queue');
}
export async function dispatchComposer(
  text: string,
  mode: SubmitMode,
  ports: {
    current: () => EngineState;
    send: EngineSend;
    command: EngineCommand;
    waitForIdle: () => Promise<void>;
    /** Receives the mailbox id of a BTW note so its receipts can be followed. */
    onBtwSaved?: (messageId: string, text: string) => void;
  },
  journalRaw?: string,
  images: WSUserMessageImage[] = [],
  freshContext = false,
): Promise<string> {
  const content = text.trim();
  const state = ports.current();
  if (state.hydrating) throw Error(englishText('composerMessage', 'hydrating'));
  if (!content && !images.length) throw Error(englishText('composerMessage', 'empty'));
  const delivery = mode === 'btw' && state.running && images.length ? 'queue' : mode;
  validateAttachments(images, delivery === 'queue');
  const media = images.length ? { images } : {};
  validateAttachmentPayload({ content, journalRaw, ...media }, delivery === 'queue');
  const capabilities = state.results['session.start']?.['protocolCapabilities'];
  if (
    freshContext &&
    (delivery !== 'btw' ||
      state.running ||
      !Array.isArray(capabilities) ||
      !capabilities.includes('context.topic-boundary'))
  )
    throw Error(englishText('composerMessage', 'freshContext'));
  if (
    images.length &&
    delivery !== 'queue' &&
    (!Array.isArray(capabilities) || !capabilities.includes('session.user-ack'))
  )
    throw Error(englishText('composerMessage', 'noUserAck'));
  if (!state.connected || state.needsSetup)
    throw Error(englishText('composerMessage', 'noProvider'));
  if (state.inputs.length) throw Error(englishText('composerMessage', 'pendingQuestions'));
  if (delivery === 'btw' && state.running) {
    const saved = await ports.command(
      'mailbox.send',
      {
        to: 'leader',
        from: 'desktop',
        type: 'btw',
        subject: 'BTW from Desktop',
        body: content,
        priority: 'normal',
        audience: 'all',
      },
      ['mailbox.sent'],
    );
    if (typeof saved['messageId'] === 'string') ports.onBtwSaved?.(saved['messageId'], content);
    return englishText('composerMessage', 'btwSaved');
  }
  if (delivery === 'steer' && state.running) {
    if (state.queue.length) {
      if (!Array.isArray(capabilities) || !capabilities.includes('session.prompt-queue-front'))
        throw Error(englishText('composerMessage', 'steerQueue'));
      validateAttachments(images, true);
      validateAttachmentPayload({ content, journalRaw, ...media }, true);
      // The engine places the instruction first in its queue, then the run stops: the queue
      // starts it when the turn ends, ahead of the prompts already waiting.
      await ports.command(
        'queue.add',
        {
          text: content,
          ...media,
          ...(journalRaw !== undefined && journalRaw !== content ? { journalRaw } : {}),
          front: true,
        },
        ['queue.state'],
      );
      try {
        await ports.send('abort');
      } catch (failure) {
        return englishText('composerMessage', 'steerNotStopped', {
          error: failure instanceof Error ? failure.message : String(failure),
        });
      }
      return englishText('composerMessage', 'steerPlaced');
    }
    await ports.send('abort');
    await ports.waitForIdle();
  }
  const latest = ports.current();
  if (!latest.connected || latest.inputs.length)
    throw Error(englishText('composerMessage', 'sessionChanged'));
  if (freshContext && latest.running) throw Error(englishText('composerMessage', 'turnStarted'));
  if (delivery === 'queue' && supportsQueue(latest)) {
    await ports.command(
      'queue.add',
      {
        text: content,
        ...media,
        ...(journalRaw !== undefined && journalRaw !== content ? { journalRaw } : {}),
      },
      ['queue.state'],
    );
    return englishText('composerMessage', latest.running ? 'queued' : 'accepted');
  }
  if (delivery === 'queue' || latest.running)
    throw Error(englishText('composerMessage', 'noQueue'));
  const payload = {
    id: crypto.randomUUID(),
    content,
    timestamp: Date.now(),
    ...(freshContext ? { freshContext: true } : {}),
    ...media,
    ...(journalRaw !== undefined && journalRaw !== content ? { journalRaw } : {}),
  };
  const caps = latest.results['session.start']?.['protocolCapabilities'];
  if (Array.isArray(caps) && caps.includes('session.user-ack'))
    await ports.command('user_message', payload, ['key.operation_result']);
  else await ports.send('user_message', payload);
  return '';
}
export function refinementText(
  result: Record<string, unknown>,
  variant: 'original' | 'refined' | 'english',
  original: string,
): string {
  if (variant === 'original') return original;
  const text = result[variant];
  if (typeof text !== 'string' || !text.trim())
    throw Error(englishText('composerMessage', 'refinerMissing'));
  return text;
}
/**
 * Session reasoning controls the catalog documents for the current model. Unknown policy
 * (no `reasoningControls`) offers nothing: support is never assumed.
 */
export function sessionReasoning(state: EngineState) {
  const catalog = state.results['provider.models'];
  const model =
    catalog?.['provider'] === state.provider
      ? entries(catalog['models']).find((row) => row['id'] === state.model)
      : undefined;
  const controls = model?.['reasoningControls'];
  const prefs = state.results['prefs.updated'] ?? {};
  if (!controls || typeof controls !== 'object') return null;
  const row = controls as Record<string, unknown>;
  const preserve = row['preserveThinking'];
  return {
    mode: ['on', 'off'].includes(String(prefs['reasoningMode']))
      ? String(prefs['reasoningMode'])
      : 'auto',
    canDisable: row['disableSupported'] === true,
    alwaysOn: row['default'] === 'always_on',
    preserve:
      preserve === 'optional' || preserve === 'always_on' || preserve === 'unsupported'
        ? preserve
        : 'unsupported',
    preserveOn: prefs['reasoningPreserve'] === true,
  };
}

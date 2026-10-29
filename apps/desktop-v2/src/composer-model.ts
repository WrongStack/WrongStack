import type { ReasoningEffort } from '@wrongstack/contracts/types';
import type { WSUserMessageImage } from '@wrongstack/webui-protocol';
import { validateAttachmentPayload, validateAttachments } from './composer-attachments';
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
    hint:
      !suppressLeader && typeof leader?.['effort'] === 'string'
        ? `Leader: ${leader['effort']}`
        : current === 'auto' && start['projectReasoningEffort']
          ? `Project: ${start['projectReasoningEffort']}`
          : '',
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
  if (state.hydrating) throw Error('The session history is still syncing. Your draft is kept.');
  if (!content && !images.length) throw Error('Write a message or attach a file first.');
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
    throw Error(
      'A fresh topic context requires an idle conversation on a supporting engine. Your draft is kept.',
    );
  if (
    images.length &&
    delivery !== 'queue' &&
    (!Array.isArray(capabilities) || !capabilities.includes('session.user-ack'))
  )
    throw Error(
      'This older engine cannot confirm file acceptance. Keep the draft and open a session on the current build.',
    );
  if (!state.connected || state.needsSetup)
    throw Error('Connect a provider before sending. Your draft is kept.');
  if (state.inputs.length)
    throw Error('Answer the pending questions before sending. Your draft is kept.');
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
    return 'BTW saved for this session’s leader. Delivery does not mean it has been read.';
  }
  if (delivery === 'steer' && state.running) {
    if (state.queue.length) {
      if (!Array.isArray(capabilities) || !capabilities.includes('session.prompt-queue-front'))
        throw Error(
          'Remove pending queued prompts before steering, so another prompt cannot start ahead of your instruction. Your draft is kept.',
        );
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
        return `Your instruction is first in the queue, but the current run could not be stopped (${failure instanceof Error ? failure.message : String(failure)}). It runs when the turn ends.`;
      }
      return 'Instruction placed ahead of the queued prompts; the current run is stopping.';
    }
    await ports.send('abort');
    await ports.waitForIdle();
  }
  const latest = ports.current();
  if (!latest.connected || latest.inputs.length)
    throw Error('The session changed. Your draft is kept.');
  if (freshContext && latest.running)
    throw Error(
      'A turn started while choosing the topic context. Your draft is kept; review it before sending.',
    );
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
    return latest.running
      ? 'Prompt accepted by the engine queue.'
      : 'Prompt accepted by the engine.';
  }
  if (delivery === 'queue' || latest.running)
    throw Error(
      'This engine does not support the persistent prompt queue. Reopen this session on the current build.',
    );
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
    throw Error('The refiner did not return this version. Your original draft is kept.');
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

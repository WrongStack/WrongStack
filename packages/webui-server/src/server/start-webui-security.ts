import type { Context } from '@wrongstack/core/agent';
import { getSharedProjectMailbox, resolveProjectDir } from '@wrongstack/core/coordination';
import type { EventBus } from '@wrongstack/core/kernel';
import { wstackGlobalRoot } from '@wrongstack/core/utils';
import type { SecurityRejectionEvent } from './connection-lifecycle.js';

export function handleWebuiSecurityRejection(
  context: Context,
  events: EventBus,
  session: { id: string },
  ev: SecurityRejectionEvent,
): void {
  const mailbox = getSharedProjectMailbox(
    resolveProjectDir(context.projectRoot, wstackGlobalRoot()),
    events,
  );
  const sub = 'Security rejection: ' + ev.issueCode;
  const lines = [
    'Decoder tripwire ' + ev.issueCode + ': ' + ev.issueMessage,
    '',
    'connectionId: ' + (ev.connectionId ?? '?'),
    'sessionId: ' + (ev.sessionId ?? '?'),
    'agentId: ' + (ev.agentId ?? '?'),
    'projectRoot: ' + (ev.projectRoot ?? '?'),
  ];
  void mailbox
    .send({
      from: context.agentId,
      to: '*',
      type: 'note',
      audience: 'leaders',
      subject: sub,
      body: lines.join('\n'),
      priority: 'high',
      senderSessionId: session.id,
    })
    .catch((err: unknown) => {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'webui.security_rejection_mailbox_note_failed',
          message: String(err),
          timestamp: new Date().toISOString(),
        }),
      );
    });
}

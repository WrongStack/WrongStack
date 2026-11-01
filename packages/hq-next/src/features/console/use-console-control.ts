'use client';

/**
 * The Console's control channel: sending steer / btw / queue messages and
 * interrupting a run, plus the local receipts that show a sent message before
 * its echo arrives in the transcript.
 *
 * Behaviour is carried over unchanged from the original console:
 *  - a command is addressed to a CLIENT and names the session, because one
 *    client process can hold several sessions;
 *  - a read-only client still accepts mailbox delivery when a `mailbox serve`
 *    owner is active for its project;
 *  - an interrupt is never sent without a confirmed dialog (see the view).
 */
import { postCommand, postMailboxSend } from '@hq/data/api';
import { setHqConsolePrefs, useHqLocalPrefs } from '@hq/data/local-prefs';
import { useHqStore } from '@hq/data/store/index';
import type { ConsoleControlTarget } from '@hq/domain/console-target';
import type { HqTranscriptEntry } from '@wrongstack/hq';
import { useEffect, useMemo, useState } from 'react';
import { errorText } from '@/lib/error-text';
import {
  type CommandReceipt,
  channelState,
  type DeliveryMode,
  MAX_RECEIPTS,
  pendingReceipts,
} from './model';

export type { ChannelState, CommandReceipt, DeliveryMode } from './model';

export function useConsoleControl(
  target: ConsoleControlTarget | null,
  entries: readonly HqTranscriptEntry[],
) {
  const prefs = useHqLocalPrefs().console;
  const [delivery, setDeliveryState] = useState<DeliveryMode>(prefs.delivery);
  const [subject, setSubjectState] = useState(prefs.subject);
  const [body, setBodyState] = useState(prefs.body);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [receipts, setReceipts] = useState<CommandReceipt[]>([]);

  const channel = channelState(target);
  const isLeader = target?.recipient === 'leader';
  const targetLabel =
    target?.agent?.name ?? (isLeader ? 'Leader agent' : (target?.recipient ?? 'agent'));

  // A receipt or an error from the previous conversation would be misleading here.
  const clientId = target?.client?.clientId;
  const sessionId = target?.session.sessionId;
  const recipient = target?.recipient;
  useEffect(() => {
    if (clientId !== undefined) useHqStore.getState().selectClient(clientId);
    setStatus(null);
    setReceipts([]);
  }, [clientId, sessionId, recipient]);

  const visibleReceipts = useMemo(() => pendingReceipts(receipts, entries), [receipts, entries]);

  const addReceipt = (receipt: CommandReceipt): void =>
    setReceipts((current) => [...current, receipt].slice(-MAX_RECEIPTS));

  const setDelivery = (next: DeliveryMode): void => {
    setDeliveryState(next);
    setHqConsolePrefs({ delivery: next });
  };
  const setSubject = (next: string): void => {
    setSubjectState(next);
    setHqConsolePrefs({ subject: next });
  };
  const setBody = (next: string): void => {
    setBodyState(next);
    setHqConsolePrefs({ body: next });
  };

  const send = async (): Promise<void> => {
    const text = body.trim();
    if (target === null || text.length === 0 || (channel !== 'live' && channel !== 'mailbox'))
      return;
    setBusy(true);
    setStatus(null);
    const message = {
      subject: subject.trim() || `HQ ${delivery}`,
      body: text,
      priority: delivery === 'steer' ? 'high' : 'normal',
    } as const;
    try {
      if (channel === 'mailbox' || target.client === null) {
        await postMailboxSend({
          projectId: target.session.projectId,
          sessionId: target.session.sessionId,
          type: delivery,
          to: target.recipient,
          ...message,
        });
        setStatus({ tone: 'ok', text: `Delivered to ${targetLabel} through the mailbox.` });
      } else {
        const result = await postCommand(target.client.clientId, delivery, {
          sessionId: target.session.sessionId,
          to: target.recipient,
          ...message,
        });
        addReceipt({
          commandId: result.commandId,
          type: delivery,
          target: targetLabel,
          preview: text,
          createdAt: new Date().toISOString(),
        });
        setStatus({ tone: 'ok', text: `Queued for ${targetLabel}.` });
      }
      setBody('');
    } catch (cause) {
      setStatus({ tone: 'error', text: errorText(cause) });
    } finally {
      setBusy(false);
    }
  };

  /** Only ever called from the confirmed interrupt dialog. */
  const interrupt = async (includeSubagents: boolean): Promise<boolean> => {
    const client = target?.client;
    if (target === null || client === null || client === undefined) return false;
    setBusy(true);
    setStatus(null);
    try {
      const primary = await postCommand(client.clientId, 'abort', {
        sessionId: target.session.sessionId,
        target: target.recipient,
      });
      addReceipt({
        commandId: primary.commandId,
        type: 'abort',
        target: targetLabel,
        preview: `Interrupt ${targetLabel}`,
        createdAt: new Date().toISOString(),
      });
      if (isLeader && includeSubagents) {
        const fleet = await postCommand(client.clientId, 'abort', {
          sessionId: target.session.sessionId,
          target: 'fleet',
        });
        addReceipt({
          commandId: fleet.commandId,
          type: 'abort',
          target: 'all subagents',
          preview: 'Interrupt every subagent on this client',
          createdAt: new Date().toISOString(),
        });
      }
      setStatus({
        tone: 'ok',
        text:
          isLeader && includeSubagents
            ? 'Interrupt queued for the leader and every subagent.'
            : `Interrupt queued for ${targetLabel}.`,
      });
      return true;
    } catch (cause) {
      setStatus({ tone: 'error', text: errorText(cause) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  return {
    channel,
    isLeader,
    targetLabel,
    delivery,
    setDelivery,
    subject,
    setSubject,
    body,
    setBody,
    busy,
    status,
    visibleReceipts,
    send,
    interrupt,
  };
}

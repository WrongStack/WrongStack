import type { AcpSessionTarget } from '@wrongstack/acp';
import type { SessionStore, SessionWriter, SlashCommand } from '@wrongstack/contracts/types';
import { sanitizeTerminalPreview, toErrorMessage } from '@wrongstack/core/utils';

interface Companion {
  sessionId?: string | undefined;
  running: boolean;
}

type RunTurn = (
  agentId: string,
  task: string,
  sessionTarget: AcpSessionTarget | undefined,
  remember: (sessionId: string) => Promise<void>,
) => Promise<{ message: string }>;

const byConversation = new WeakMap<SessionWriter, Promise<Map<string, Companion>>>();

function validId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 2000 &&
    !/\p{Cc}/u.test(value)
  );
}

async function readCompanions(
  session: SessionWriter,
  store: Pick<SessionStore, 'load'> | undefined,
): Promise<Map<string, Companion>> {
  const links = new Map<string, Companion>();
  if (!store) return links;
  const { events } = await store.load(session.id);
  for (const event of events) {
    if (
      event.type !== 'acp_companion_link' ||
      event.ownerSessionId !== session.id ||
      !validId(event.agentId)
    )
      continue;
    if (event.externalSessionId === null) links.delete(event.agentId);
    else if (validId(event.externalSessionId))
      links.set(event.agentId, { sessionId: event.externalSessionId, running: false });
  }
  return links;
}

export async function acpCompanionCommand(
  input: string,
  ctx: Parameters<SlashCommand['run']>[1],
  store: Pick<SessionStore, 'load'> | undefined,
  runTurn: RunTurn,
): Promise<{ message: string }> {
  const session = ctx?.session;
  if (!session?.id) return { message: 'ACP companions require an open conversation.' };

  const parts = /^(\S+)\s*(.*)$/su.exec(input);
  const [, agentId = '', task = ''] = parts ?? [];
  let reading = byConversation.get(session);
  if (!reading) {
    reading = readCompanions(session, store);
    byConversation.set(session, reading);
  }
  let companions: Map<string, Companion>;
  try {
    companions = await reading;
  } catch (error) {
    if (byConversation.get(session) === reading) byConversation.delete(session);
    return { message: `ACP companion links could not be read: ${toErrorMessage(error)}` };
  }

  const recordLink = async (agent: string, externalSessionId: string | null) => {
    if (store) {
      await session.append({
        type: 'acp_companion_link',
        ts: new Date().toISOString(),
        ownerSessionId: session.id,
        agentId: agent,
        externalSessionId,
      });
    }
  };
  if (!agentId) {
    return {
      message: companions.size
        ? [...companions]
            .map(([id, companion]) => {
              const status = companion.running ? ' (running)' : '';
              const reference = companion.sessionId
                ? ` · ${sanitizeTerminalPreview(JSON.stringify(companion.sessionId), { maxLines: 1 }).text}`
                : '';
              return `${sanitizeTerminalPreview(id, { maxLines: 1 }).text}${reference}${status}`;
            })
            .join('\n')
        : 'No ACP companions in this conversation.',
    };
  }

  if (agentId === 'forget') {
    if (!task || /\s/u.test(task)) return { message: 'Usage: /acp companion forget <agent-id>' };
    const link = companions.get(task);
    if (!link) return { message: 'This conversation has no link to that ACP companion.' };
    if (link.running) return { message: 'Wait for the current ACP companion turn to finish.' };
    link.running = true;
    try {
      await recordLink(task, null);
      companions.delete(task);
      return { message: 'ACP companion unlinked from this conversation.' };
    } catch (error) {
      return { message: `ACP companion link could not be removed: ${toErrorMessage(error)}` };
    } finally {
      link.running = false;
    }
  }
  if (!task) return { message: 'Usage: /acp companion <agent-id> <task>' };
  if (!validId(agentId)) return { message: 'Invalid ACP agent id.' };
  const companion = companions.get(agentId) ?? { running: false };
  if (companion.running) return { message: 'This ACP companion already has a turn running.' };

  companion.running = true;
  companions.set(agentId, companion);
  try {
    return await runTurn(
      agentId,
      task,
      companion.sessionId ? { action: 'resume', sessionId: companion.sessionId } : undefined,
      async (id) => {
        if (companion.sessionId === id) return;
        if (!validId(id)) throw Error('Invalid ACP session id.');
        await recordLink(agentId, id);
        companion.sessionId = id;
      },
    );
  } finally {
    companion.running = false;
    if (!companion.sessionId) companions.delete(agentId);
  }
}

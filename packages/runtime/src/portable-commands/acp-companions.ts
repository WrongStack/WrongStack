import type { AcpSessionTarget } from '@wrongstack/acp';
import type { SlashCommand } from '@wrongstack/contracts/types';
import { sanitizeTerminalPreview } from '@wrongstack/core/utils';

interface Companion {
  sessionId?: string | undefined;
  running: boolean;
}

type RunTurn = (
  agentId: string,
  task: string,
  sessionTarget: AcpSessionTarget | undefined,
  remember: (sessionId: string) => void,
) => Promise<{ message: string }>;

// The writer's lifetime bounds the links. A new WrongStack conversation,
// including a fork, never inherits another conversation's external session.
const byConversation = new WeakMap<object, Map<string, Companion>>();

export async function acpCompanionCommand(
  input: string,
  ctx: Parameters<SlashCommand['run']>[1],
  runTurn: RunTurn,
): Promise<{ message: string }> {
  const session = ctx?.session;
  if (!session?.id) return { message: 'ACP companions require an open conversation.' };

  const parts = /^(\S+)\s*(.*)$/su.exec(input);
  const [, agentId = '', task = ''] = parts ?? [];
  let companions = byConversation.get(session);
  if (!agentId) {
    return {
      message: companions?.size
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
    if (companions?.get(task)?.running)
      return { message: 'Wait for the current ACP companion turn to finish.' };
    return {
      message: companions?.delete(task)
        ? 'ACP companion unlinked from this conversation.'
        : 'This conversation has no link to that ACP companion.',
    };
  }
  if (!task) return { message: 'Usage: /acp companion <agent-id> <task>' };
  if (!companions) {
    companions = new Map();
    byConversation.set(session, companions);
  }
  const companion = companions.get(agentId) ?? { running: false };
  if (companion.running) return { message: 'This ACP companion already has a turn running.' };

  companion.running = true;
  companions.set(agentId, companion);
  try {
    return await runTurn(
      agentId,
      task,
      companion.sessionId ? { action: 'resume', sessionId: companion.sessionId } : undefined,
      (id) => {
        companion.sessionId = id;
      },
    );
  } finally {
    companion.running = false;
    if (!companion.sessionId) companions.delete(agentId);
  }
}

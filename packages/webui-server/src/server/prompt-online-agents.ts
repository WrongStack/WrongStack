import { getSharedProjectMailbox, type MailboxAgentStatus } from '@wrongstack/coordination';

/** The agents online in this project's shared mailbox, for the boot system prompt. */
export async function readPromptOnlineAgents(projectDir: string): Promise<MailboxAgentStatus[]> {
  try {
    return await getSharedProjectMailbox(projectDir).getAgentStatuses();
  } catch {
    // Non-fatal: a mailbox error must not block building the prompt.
    return [];
  }
}

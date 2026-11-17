import { getSharedProjectMailbox, type MailboxAgentStatus } from '@wrongstack/coordination';

/**
 * How long boot waits for the online-agents list. The list only decorates the system prompt, but
 * reading it connects to the project's mailbox server, and a server that does not answer held the
 * whole engine boot for the connection's 10 s start window. Past the deadline the prompt is built
 * without the list; the connection keeps trying in the background.
 */
export const PROMPT_ONLINE_AGENTS_DEADLINE_MS = 1_000;

/** The agents online in this project's shared mailbox, for the boot system prompt. */
export async function readPromptOnlineAgents(
  projectDir: string,
  options: {
    deadlineMs?: number | undefined;
    mailbox?:
      | ((
          projectDir: string,
        ) => Pick<ReturnType<typeof getSharedProjectMailbox>, 'getAgentStatuses'>)
      | undefined;
  } = {},
): Promise<MailboxAgentStatus[]> {
  const mailbox = options.mailbox ?? getSharedProjectMailbox;
  // Non-fatal: a mailbox error must not block building the prompt.
  const read = Promise.resolve()
    .then(() => mailbox(projectDir).getAgentStatuses())
    .catch((): MailboxAgentStatus[] => []);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<MailboxAgentStatus[]>((resolve) => {
    timer = setTimeout(() => resolve([]), options.deadlineMs ?? PROMPT_ONLINE_AGENTS_DEADLINE_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([read, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

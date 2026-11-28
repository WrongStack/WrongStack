import type { ComponentType } from 'react';

/** Where a prepared agent prompt goes once the user picked a hand-off. */
export interface GitHubHandOffProps {
  prompt: string;
  /** Closes the hand-off once the prompt is placed (or the user gives up). */
  onDone(): void;
}

/**
 * What the GitHub surface needs from its application. The prompts it hands
 * over name only the repository and the item number; the agent reads the
 * content itself, so nothing a third party wrote enters the conversation.
 */
export interface GitHubHost {
  /**
   * The conversation whose project the `/api/github*` requests name, or null
   * when the transport names it itself (the desktop bridge adds its engine's).
   */
  useSessionId(): string | null;
  /** Puts a prompt straight into the conversation (the WebUI's composer). */
  handOff?: ((prompt: string) => void) | undefined;
  /** Or lets the user choose where the prompt goes (the desktop's conversation picker). */
  HandOff?: ComponentType<GitHubHandOffProps> | undefined;
}

export interface PromptOption {
  key: string;
  label: string;
  value: string;
}

export interface ReadKeyOptions {
  /**
   * Abandon the read and resolve with the empty string.
   *
   * `readKey` holds stdin in raw mode with a `data` listener until a matching
   * key arrives, so a caller that simply stops awaiting it leaves the terminal
   * in raw mode and the listener eating the user's next keystroke. That
   * matters now that the same prompt can be answered somewhere else entirely
   * — from the HQ dashboard — and the terminal copy has to be taken down
   * cleanly when it is.
   *
   * Implementations MUST restore whatever terminal state they changed.
   */
  signal?: AbortSignal | undefined;
}

export interface InputReader {
  readLine(prompt?: string): Promise<string>;
  readKey(prompt: string, options: PromptOption[], opts?: ReadKeyOptions): Promise<string>;
  close(): Promise<void>;
}

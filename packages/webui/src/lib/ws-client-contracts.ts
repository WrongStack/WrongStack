export interface WSSendOptions {
  /**
   * Inspect-style responses normally render a summary in chat. UI surfaces
   * that consume the response themselves can suppress that echo.
   */
  echoToChat?: boolean | undefined;
  /** Reject one-shot actions instead of replaying them after a reconnect. */
  queueIfDisconnected?: boolean | undefined;
}

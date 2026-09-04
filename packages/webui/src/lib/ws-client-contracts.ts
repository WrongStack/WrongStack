export interface WSSendOptions {
  /**
   * Inspect-style responses normally render a summary in chat. UI surfaces
   * that consume the response themselves can suppress that echo.
   */
  echoToChat?: boolean | undefined;
  /** Reject one-shot actions instead of replaying them after a reconnect. */
  queueIfDisconnected?: boolean | undefined;
  /**
   * Caller-supplied correlation id. When `echoToChat: false` and the request
   * type has a known response counterpart, the client will mint one if you
   * don't. The id is stamped on the outgoing payload so the server can echo
   * it back, and the response suppression is keyed by it (B-04).
   *
   * Supply one when the same call is made in a loop and you need to tell
   * which response belongs to which call.
   */
  requestId?: string | undefined;
}

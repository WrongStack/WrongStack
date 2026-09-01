import type { WrongStackWebSocketClient } from '@/lib/ws-client';

/**
 * Shared launcher for the one-click built-in rounds (Bug Hunter, Performance
 * Ratchet).
 *
 * Both cards do the same four-step dance: optionally flip the session to solo,
 * ask the server for a builtin prompt body, compose the message, and send it —
 * with a single timeout and a single settle path so a half-finished launch can
 * never leave the button spinning forever. Extracting it means a fix to the
 * settle logic lands for both cards instead of one.
 */

/**
 * The slice of the WS client these launchers use.
 *
 * Derived from the real client rather than restated structurally: `send` takes
 * a discriminated union of message shapes, and a hand-written `{type: string}`
 * signature would silently accept a message type the server does not handle.
 */
export type RoundLauncherClient = Pick<
  WrongStackWebSocketClient,
  'isConnected' | 'on' | 'send' | 'sendMessage'
>;

export interface LaunchBuiltinRoundOptions {
  client: RoundLauncherClient;
  /** Builtin prompt slug to fetch. */
  slug: string;
  /**
   * Force the session solo before starting. A round that attributes one
   * outcome to one change cannot be fanned out across subagents.
   */
  requireSoloSession: boolean;
  subagentsAllowed: boolean;
  sessionId?: string | undefined;
  setPrefs(patch: { subagentsAllowed: boolean }): void;
  /** Wrap the fetched prompt body into the message that gets sent. */
  compose(content: string): string;
  /** Called with the sent message id and text, to mirror it into the transcript. */
  onSent(id: string, text: string): void;
  onSettle(state: 'idle' | 'error'): void;
  /** Defaults to 8s — long enough for a cold prompt store, short enough to notice. */
  timeoutMs?: number;
}

export function launchBuiltinRound(options: LaunchBuiltinRoundOptions): void {
  const { client, slug } = options;

  let settled = false;
  let policyOff = () => {};
  let contentOff = () => {};
  const finish = (next: 'idle' | 'error') => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    policyOff();
    contentOff();
    options.onSettle(next);
  };
  const timeout = setTimeout(() => finish('error'), options.timeoutMs ?? 8_000);

  const requestPrompt = () => {
    contentOff = client.on('prompts.content', (message) => {
      const payload = message.payload as
        | { slug?: string; found?: boolean; content?: string }
        | null
        | undefined;
      // The channel is shared: another card's fetch must not settle this one.
      if (payload?.slug !== slug) return;
      const content = payload.content?.trim() ?? '';
      if (!payload.found || !content) {
        finish('error');
        return;
      }
      const text = options.compose(content);
      const id = client.sendMessage(text);
      options.onSent(id, text);
      client.send({ type: 'prompts.used', payload: { slug } });
      finish('idle');
    });
    client.send({ type: 'prompts.content', payload: { slug } });
  };

  if (!options.requireSoloSession || !options.subagentsAllowed) {
    requestPrompt();
    return;
  }

  policyOff = client.on('prefs.updated', (message) => {
    const payload = message.payload as Record<string, unknown>;
    if (options.sessionId && payload['sessionId'] !== options.sessionId) return;
    if (typeof payload['subagentsAllowed'] !== 'boolean') return;
    if (payload['subagentsAllowed'] !== false) {
      finish('error');
      return;
    }
    policyOff();
    policyOff = () => {};
    requestPrompt();
  });
  options.setPrefs({ subagentsAllowed: false });
  client.send({
    type: 'prefs.update',
    payload: { subagentsAllowed: false, ...(options.sessionId ? { sessionId: options.sessionId } : {}) },
  });
}

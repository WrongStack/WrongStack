import type { WebSocket } from 'ws';
import type { EmbeddedMessageRouterDeps } from './embedded-message-router-types.js';
import type { WSClientMessage } from './types.js';

export function createEmbeddedSessionAccess(deps: EmbeddedMessageRouterDeps) {
  const { opts, send } = deps;

  const guardedTypes = new Set([
    'user_message',
    'queue.add',
    'queue.remove',
    'queue.clear',
    'queue.get',
    'topic.advice',
    'abort',
    'tool.confirm_result',
    'session.new',
    'session.resume',
    'session.save',
    'session.checkpoints',
    'session.rewind',
    'session.redo',
    'context.clear',
    'context.compact',
    'context.repair',
    'context.debug',
    'context.editor.open',
    'context.editor.validate',
    'context.editor.apply',
    'context.modes.list',
    'context.mode.switch',
    'context.mode.create',
    'context.mode.update',
    'context.mode.delete',
    'todos.get',
    'todos.clear',
    'todos.remove',
    'todo.update',
    'tasks.get',
    'task.update',
    'plan.get',
    'plan.template_use',
    'plan.item.update',
  ]);

  /**
   * Can this host SERVE the named session, whichever tab is in front?
   *
   * Same rule `createEmbeddedConversationRoutes` applies: a session the
   * registry already knows, or the leader's own. `peekAgent` is non-creating,
   * so asking never materialises an agent for an id a client invented. Hosts
   * with no registry keep the strict "must be the current session" answer.
   */
  /**
   * The context that belongs to a session — the leader's when it is unknown.
   *
   * `opts.agent.ctx` is the LEADER, i.e. the boot tab's runtime. Reading it to
   * answer "this tab's" question is the single most common way a fix lands on
   * the wrong conversation once four tabs are open. `peekAgent` never creates.
   */
  const sessionContextOf = (sessionId?: string) => {
    if (!sessionId) return opts.agent.ctx;
    const peek = deps.sessionCtx.peekAgent ?? deps.conversationCtx.peekAgent;
    return (peek?.(sessionId) ?? deps.sessionCtx.getAgent?.(sessionId))?.ctx ?? opts.agent.ctx;
  };

  const canServeSession = (sessionId: string): boolean => {
    if (sessionId === opts.agent.ctx.session?.id) return true;
    const peek = deps.sessionCtx.peekAgent ?? deps.conversationCtx.peekAgent;
    // No non-creating lookup means no way to answer without materialising an
    // agent for whatever id arrived — and a stale id that materialises an agent
    // can evict a LIVE tab's. A gate must not widen past what it can verify, so
    // a host with no `peekAgent` keeps the strict answer.
    return peek ? peek(sessionId) !== undefined : false;
  };

  // `session.focus` is deliberately NOT guarded. The guard's job is to refuse
  // a request aimed at a session this runtime cannot serve — but a focus IS
  // the request to start serving it. A focus is sent after the client has
  // already moved its pointer, so both payload fields name the same session.
  // Guarding it would reject exactly the case it exists for: a page that
  // outlived its process, clicking a restored tab.
  const guardSession = (ws: WebSocket, message: WSClientMessage): boolean => {
    if (!guardedTypes.has(message.type)) return true;
    const payload = message.payload;
    const requested =
      payload &&
      typeof payload === 'object' &&
      typeof (payload as { sessionId?: unknown }).sessionId === 'string'
        ? (payload as { sessionId: string }).sessionId
        : undefined;
    const current = deps.currentSessionId();
    if (!requested || requested === current) return true;
    // A request that TARGETS the session it is stamped with is that session
    // asking to be opened, and refusing it is refusing the only message that
    // could ever make the answer "yes".
    //
    // This is what broke Resume from the session list. The client moves its
    // foreground pointer onto the session first (the pane has to exist before
    // the transcript can land in it), so `withSession` stamps the payload with
    // the very id the resume is asking for — a session this runtime has never
    // heard of. `canServeSession` said no, the refusal came back as an error
    // frame the client discards as session-swap noise, and the tab sat there
    // empty with no transcript and no error: "Resume never resumes".
    // Scoped to `session.resume`, the only guarded type whose `id` IS a
    // session id — everywhere else `id` names a todo, a mode, a checkpoint or
    // a confirmation, and widening the exemption to those would let a stale
    // tab act on a session this host cannot serve.
    const target =
      message.type === 'session.resume' &&
      payload &&
      typeof payload === 'object' &&
      typeof (payload as { id?: unknown }).id === 'string'
        ? (payload as { id: string }).id
        : undefined;
    if (target && target === requested) return true;
    // Four tabs share one socket, so "the session the runtime is on" is only
    // ever ONE of them. Refusing every other named session turned every
    // background tab into a dead tab on this host: its `user_message`, its
    // `abort`, its answer to its OWN permission prompt and its worklist reads
    // were all rejected here, before the handlers that were carefully taught
    // to serve the asking session ever ran. The conversation routes have
    // carried this exemption since the four-tab work; the router-level gate in
    // front of them did not, which made that fix unreachable.
    if (canServeSession(requested)) return true;
    send(ws, {
      type: 'error',
      payload: deps.sessionPayload({
        phase: message.type,
        message: `Request targeted session ${requested}, but this WebUI runtime is currently on ${current}.`,
        requestedSessionId: requested,
      }),
    });
    return false;
  };
  return { sessionContextOf, guardSession };
}

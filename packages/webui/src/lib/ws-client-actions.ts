import type { WSClientMessage, WSCompletionRequest } from '../types';
import type { WSSendOptions } from './ws-client-contracts';

export interface WsClientActionHost {
  send(message: WSClientMessage, options?: WSSendOptions): void;
  withSession<T extends Record<string, unknown>>(payload: T): T & { sessionId?: string };
}

export interface WsClientActionMethods {
  listTools(options?: WSSendOptions): void;
  listMemory(options?: WSSendOptions): void;
  listSageMemories(options?: WSSendOptions): void;
  listSageMemoriesPage(
    params?: {
      statuses?: string[];
      kind?: string;
      query?: string;
      limit?: number;
      cursor?: string;
    },
    options?: WSSendOptions,
  ): void;
  listMemoryCandidates(params?: { includeResolved?: boolean }, options?: WSSendOptions): void;
  /**
   * Search SAGE memory and return the per-channel score breakdown
   * (lexical / vector / RRF final / source attribution). Used by the
   * Memory panel to surface WHY a memory matched.
   */
  searchSageBreakdown(
    params: { query: string; limit?: number; includeStale?: boolean },
    options?: WSSendOptions,
  ): void;
  getSage(id: string, options?: WSSendOptions): void;
  getSageGraph(
    query: string,
    params?: { maxDepth?: number; limit?: number },
    options?: WSSendOptions,
  ): void;
  updateSage(id: string, patch: Record<string, unknown>, options?: WSSendOptions): void;
  deleteSage(id: string, reason?: string): void;
  rememberSage(
    opts: Extract<WSClientMessage, { type: 'memory.sage.remember' }>['payload'],
    options?: WSSendOptions,
  ): void;
  findMemoriesForFile(
    opts: Extract<WSClientMessage, { type: 'memory.sage.forFile' }>['payload'],
    options?: WSSendOptions,
  ): void;
  recoverSage(
    opts: Extract<WSClientMessage, { type: 'memory.sage.recover' }>['payload'],
    options?: WSSendOptions,
  ): void;
  resolveMemoryCandidate(
    opts: Extract<WSClientMessage, { type: 'memory.sage.candidateResolve' }>['payload'],
    options?: WSSendOptions,
  ): void;
  backfillRecoverable(
    opts: Extract<WSClientMessage, { type: 'memory.sage.backfillRecoverable' }>['payload'],
    options?: WSSendOptions,
  ): void;
  listMcpServers(): void;
  addMcpServer(config: {
    name: string;
    transport: string;
    description?: string;
    enabled?: boolean;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    allowedTools?: string[];
    url?: string;
    headers?: Record<string, string>;
    lazy?: boolean;
  }): void;
  removeMcpServer(name: string): void;
  updateMcpServer(config: {
    name: string;
    transport?: string;
    description?: string;
    enabled?: boolean;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    allowedTools?: string[];
    url?: string;
    headers?: Record<string, string>;
    lazy?: boolean;
  }): void;
  wakeMcpServer(name: string): void;
  sleepMcpServer(name: string): void;
  discoverMcpServer(name: string): void;
  listMcpResources(name: string, refresh?: boolean): void;
  listMcpPrompts(name: string, refresh?: boolean): void;
  readMcpResource(name: string, uri: string): void;
  getMcpPrompt(name: string, prompt: string, args?: Record<string, string>): void;
  enableMcpServer(name: string): void;
  disableMcpServer(name: string): void;
  restartMcpServer(name: string): void;
  listSkills(options?: WSSendOptions): void;
  getSkillContent(name: string, source: string): void;
  installSkill(ref: string, global?: boolean): void;
  uninstallSkill(name: string, global?: boolean): void;
  checkForUpdates(name?: string, global?: boolean): void;
  createSkill(name: string, description: string, scope: 'project' | 'global'): void;
  editSkill(name: string, body: string): void;
  exportAllSkills(): void;
  getDiag(options?: WSSendOptions): void;
  getStats(options?: WSSendOptions): void;
  saveSession(): void;
  resumeSessionById(id: string): void;
  listModes(): void;
  switchMode(id: string): void;
  listFiles(query?: string, limit?: number, path?: string): void;
  requestCompletion(payload: WSCompletionRequest['payload']): void;
  getTodos(): void;
  clearTodos(): void;
  removeTodo(idOrIndex: string | number): void;
  updateTodoStatus(id: string, status: 'pending' | 'in_progress' | 'completed'): void;
  getTasks(): void;
  updateTaskStatus(id: string, status: string): void;
  getPlan(): void;
  updatePlanItem(target: string, status: 'open' | 'in_progress' | 'done'): void;
  listSessions(limit?: number): void;
  deleteSession(id: string): void;
  renameSession(id: string, name: string): void;
  inspectSession(id: string): void;
  setWorkingDir(path: string): void;
  resumeSession(sessionId: string): void;
  ping(): void;
  refineModel(
    text: string,
    opts?: {
      timeoutMs?: number | undefined;
      provider?: string | undefined;
      model?: string | undefined;
      previousRefined?: string | undefined;
      previousEnglish?: string | undefined;
      retryFeedback?: string | undefined;
    },
  ): void;
}

const actionMethods = {
  listTools(this: WsClientActionHost, options?: WSSendOptions) {
    this.send({ type: 'tools.list' }, options);
  },

  listMemory(this: WsClientActionHost, options?: WSSendOptions) {
    this.send({ type: 'memory.list' }, options);
  },

  listSageMemories(this: WsClientActionHost, options?: WSSendOptions) {
    this.send({ type: 'memory.sage.list' }, options);
  },

  listSageMemoriesPage(
    this: WsClientActionHost,
    params?: {
      statuses?: string[];
      kind?: string;
      query?: string;
      limit?: number;
      cursor?: string;
    },
    options?: WSSendOptions,
  ) {
    this.send({ type: 'memory.sage.listPage', payload: { ...params } }, options);
  },

  listMemoryCandidates(
    this: WsClientActionHost,
    params?: { includeResolved?: boolean },
    options?: WSSendOptions,
  ) {
    this.send({ type: 'memory.sage.listCandidates', payload: { ...params } }, options);
  },

  searchSageBreakdown(
    this: WsClientActionHost,
    params: { query: string; limit?: number; includeStale?: boolean },
    options?: WSSendOptions,
  ) {
    this.send(
      {
        type: 'memory.sage.searchBreakdown',
        payload: {
          query: params.query,
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
          ...(params.includeStale !== undefined ? { includeStale: params.includeStale } : {}),
        },
      },
      options,
    );
  },

  getSage(this: WsClientActionHost, id: string, options?: WSSendOptions) {
    this.send({ type: 'memory.sage.get', payload: { id } }, options);
  },

  getSageGraph(
    this: WsClientActionHost,
    query: string,
    params?: { maxDepth?: number; limit?: number },
    options?: WSSendOptions,
  ) {
    this.send({ type: 'memory.sage.graph', payload: { query, ...params } }, options);
  },

  updateSage(
    this: WsClientActionHost,
    id: string,
    patch: Record<string, unknown>,
    options?: WSSendOptions,
  ) {
    this.send({ type: 'memory.sage.update', payload: { id, ...patch } }, options);
  },

  deleteSage(this: WsClientActionHost, id: string, reason?: string) {
    this.send({
      type: 'memory.sage.delete',
      payload: { id, force: true, ...(reason !== undefined ? { reason } : {}) },
    });
  },

  rememberSage(
    this: WsClientActionHost,
    opts: Extract<WSClientMessage, { type: 'memory.sage.remember' }>['payload'],
    options?: WSSendOptions,
  ) {
    this.send({ type: 'memory.sage.remember', payload: opts }, options);
  },

  findMemoriesForFile(
    this: WsClientActionHost,
    opts: Extract<WSClientMessage, { type: 'memory.sage.forFile' }>['payload'],
    options?: WSSendOptions,
  ) {
    this.send({ type: 'memory.sage.forFile', payload: opts }, options);
  },

  recoverSage(
    this: WsClientActionHost,
    opts: Extract<WSClientMessage, { type: 'memory.sage.recover' }>['payload'],
    options?: WSSendOptions,
  ) {
    this.send({ type: 'memory.sage.recover', payload: opts }, options);
  },

  resolveMemoryCandidate(
    this: WsClientActionHost,
    opts: Extract<WSClientMessage, { type: 'memory.sage.candidateResolve' }>['payload'],
    options?: WSSendOptions,
  ) {
    this.send({ type: 'memory.sage.candidateResolve', payload: opts }, options);
  },

  backfillRecoverable(
    this: WsClientActionHost,
    opts: Extract<WSClientMessage, { type: 'memory.sage.backfillRecoverable' }>['payload'],
    options?: WSSendOptions,
  ) {
    this.send({ type: 'memory.sage.backfillRecoverable', payload: opts }, options);
  },

  listMcpServers(this: WsClientActionHost) {
    this.send({ type: 'mcp.list' });
  },

  addMcpServer(
    this: WsClientActionHost,
    config: Parameters<WsClientActionMethods['addMcpServer']>[0],
  ) {
    this.send({ type: 'mcp.add', payload: config });
  },

  removeMcpServer(this: WsClientActionHost, name: string) {
    this.send({ type: 'mcp.remove', payload: { name } });
  },

  updateMcpServer(
    this: WsClientActionHost,
    config: Parameters<WsClientActionMethods['updateMcpServer']>[0],
  ) {
    this.send({ type: 'mcp.update', payload: config });
  },

  wakeMcpServer(this: WsClientActionHost, name: string) {
    this.send({ type: 'mcp.wake', payload: { name } });
  },

  sleepMcpServer(this: WsClientActionHost, name: string) {
    this.send({ type: 'mcp.sleep', payload: { name } });
  },

  discoverMcpServer(this: WsClientActionHost, name: string) {
    this.send({ type: 'mcp.discover', payload: { name } });
  },

  listMcpResources(this: WsClientActionHost, name: string, refresh = false) {
    this.send({ type: 'mcp.resources', payload: { name, refresh } });
  },

  listMcpPrompts(this: WsClientActionHost, name: string, refresh = false) {
    this.send({ type: 'mcp.prompts', payload: { name, refresh } });
  },

  readMcpResource(this: WsClientActionHost, name: string, uri: string) {
    this.send({ type: 'mcp.resource.read', payload: { name, uri } });
  },

  getMcpPrompt(
    this: WsClientActionHost,
    name: string,
    prompt: string,
    args?: Record<string, string>,
  ) {
    this.send({
      type: 'mcp.prompt.get',
      payload: { name, prompt, ...(args === undefined ? {} : { arguments: args }) },
    });
  },

  enableMcpServer(this: WsClientActionHost, name: string) {
    this.send({ type: 'mcp.enable', payload: { name } });
  },

  disableMcpServer(this: WsClientActionHost, name: string) {
    this.send({ type: 'mcp.disable', payload: { name } });
  },

  restartMcpServer(this: WsClientActionHost, name: string) {
    this.send({ type: 'mcp.restart', payload: { name } });
  },

  listSkills(this: WsClientActionHost, options?: WSSendOptions) {
    this.send({ type: 'skills.list' }, options);
  },

  getSkillContent(this: WsClientActionHost, name: string, source: string) {
    this.send({ type: 'skills.content', payload: { name, source } });
  },

  installSkill(this: WsClientActionHost, ref: string, global?: boolean) {
    this.send({ type: 'skills.install', payload: { ref, global } });
  },

  uninstallSkill(this: WsClientActionHost, name: string, global?: boolean) {
    this.send({ type: 'skills.uninstall', payload: { name, global } });
  },

  checkForUpdates(this: WsClientActionHost, name?: string, global?: boolean) {
    this.send({ type: 'skills.update', payload: { name, global } });
  },

  createSkill(
    this: WsClientActionHost,
    name: string,
    description: string,
    scope: 'project' | 'global',
  ) {
    this.send({ type: 'skills.create', payload: { name, description, scope } });
  },

  editSkill(this: WsClientActionHost, name: string, body: string) {
    this.send({ type: 'skills.edit', payload: { name, body } });
  },

  exportAllSkills(this: WsClientActionHost) {
    this.send({ type: 'skills.export' });
  },

  getDiag(this: WsClientActionHost, options?: WSSendOptions) {
    this.send({ type: 'diag.get', payload: this.withSession({}) }, options);
  },

  getStats(this: WsClientActionHost, options?: WSSendOptions) {
    this.send({ type: 'stats.get', payload: this.withSession({}) }, options);
  },

  saveSession(this: WsClientActionHost) {
    this.send({ type: 'session.save', payload: this.withSession({}) });
  },

  resumeSessionById(this: WsClientActionHost, id: string) {
    this.send({ type: 'session.resume', payload: this.withSession({ id }) });
  },

  listModes(this: WsClientActionHost) {
    this.send({ type: 'modes.list' });
  },

  switchMode(this: WsClientActionHost, id: string) {
    // Stamped with the active session: the mode belongs to this tab only.
    this.send({ type: 'mode.switch', payload: this.withSession({ id }) });
  },

  listFiles(this: WsClientActionHost, query?: string, limit?: number, path?: string) {
    this.send({ type: 'files.list', payload: { query, limit, path } });
  },

  requestCompletion(this: WsClientActionHost, payload: WSCompletionRequest['payload']) {
    this.send({ type: 'completion.request', payload });
  },

  getTodos(this: WsClientActionHost) {
    this.send({ type: 'todos.get', payload: this.withSession({}) });
  },

  clearTodos(this: WsClientActionHost) {
    this.send({ type: 'todos.clear', payload: this.withSession({}) });
  },

  removeTodo(this: WsClientActionHost, idOrIndex: string | number) {
    const payload = typeof idOrIndex === 'number' ? { index: idOrIndex } : { id: idOrIndex };
    this.send({ type: 'todos.remove', payload: this.withSession(payload) });
  },

  updateTodoStatus(
    this: WsClientActionHost,
    id: string,
    status: 'pending' | 'in_progress' | 'completed',
  ) {
    this.send({ type: 'todo.update', payload: this.withSession({ id, status }) });
  },

  getTasks(this: WsClientActionHost) {
    this.send({ type: 'tasks.get', payload: this.withSession({}) });
  },

  updateTaskStatus(this: WsClientActionHost, id: string, status: string) {
    this.send({ type: 'task.update', payload: this.withSession({ id, status }) });
  },

  getPlan(this: WsClientActionHost) {
    this.send({ type: 'plan.get', payload: this.withSession({}) });
  },

  updatePlanItem(
    this: WsClientActionHost,
    target: string,
    status: 'open' | 'in_progress' | 'done',
  ) {
    this.send({ type: 'plan.item.update', payload: this.withSession({ target, status }) });
  },

  listSessions(this: WsClientActionHost, limit = 50) {
    this.send({ type: 'sessions.list', payload: this.withSession({ limit }) });
  },

  deleteSession(this: WsClientActionHost, id: string) {
    // Tagged with the session in front: when the delete targets the runtime's
    // CURRENT session (a tab that just closed), the tag names the live
    // session the server should move the runtime onto before deleting.
    this.send({ type: 'session.delete', payload: this.withSession({ id }) });
  },

  renameSession(this: WsClientActionHost, id: string, name: string) {
    this.send({ type: 'session.rename', payload: { id, name } });
  },

  inspectSession(this: WsClientActionHost, id: string) {
    this.send({ type: 'session.inspect', payload: { id } });
  },

  setWorkingDir(this: WsClientActionHost, path: string) {
    this.send({ type: 'working_dir.set', payload: { path } });
  },

  resumeSession(this: WsClientActionHost, sessionId: string) {
    this.send({
      type: 'session.resume',
      payload: this.withSession({ id: sessionId }),
    });
  },

  ping(this: WsClientActionHost) {
    this.send({ type: 'ping' });
  },

  refineModel(
    this: WsClientActionHost,
    text: string,
    opts?: {
      timeoutMs?: number | undefined;
      provider?: string | undefined;
      model?: string | undefined;
      previousRefined?: string | undefined;
      previousEnglish?: string | undefined;
      retryFeedback?: string | undefined;
    },
  ) {
    this.send({
      type: 'model.refine',
      // Stamped with the foreground tab: refinement must run in — and its
      // result return to — the session that typed the prompt. The reply is
      // only lane-routable when it echoes this stamp.
      payload: this.withSession({
        text,
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts?.provider !== undefined ? { provider: opts.provider } : {}),
        ...(opts?.model !== undefined ? { model: opts.model } : {}),
        ...(opts?.previousRefined !== undefined ? { previousRefined: opts.previousRefined } : {}),
        ...(opts?.previousEnglish !== undefined ? { previousEnglish: opts.previousEnglish } : {}),
        ...(opts?.retryFeedback !== undefined ? { retryFeedback: opts.retryFeedback } : {}),
      }),
    });
  },
} satisfies WsClientActionMethods;

export function installWsClientActionMethods(ctor: { prototype: WsClientActionHost }): void {
  Object.assign(ctor.prototype, actionMethods);
}

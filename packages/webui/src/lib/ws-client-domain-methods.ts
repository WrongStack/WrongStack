import { safeId } from '@/lib/utils';
import type {
  WSClientMessage,
  WSServerMessage,
  WSModelSwitchResult,
} from '../types';
import type { ProviderCustomModelWire } from '../types/client-message';
import type { ContextEditorMessage, ContextEditorRemoval } from '../types/runtime';
import type { WSSendOptions } from './ws-client-contracts';
import {
  buildClearModelsMessage,
  buildProviderUpdateMessage,
  buildUndoClearMessage,
} from './ws-client-helpers';

export interface WsClientDomainHost {
  send(message: WSClientMessage, options?: WSSendOptions): boolean;
  withSession<T extends Record<string, unknown>>(payload: T): T & { sessionId?: string };
}

export const domainMethods = {
  getGitInfo(this: WsClientDomainHost) {
    this.send({ type: 'git.info' });
  },

  getGitChanges(this: WsClientDomainHost) {
    this.send({ type: 'git.changes' });
  },

  getGitDiff(this: WsClientDomainHost, path: string) {
    this.send({ type: 'git.diff', payload: { path } });
  },

  stageGit(this: WsClientDomainHost, paths: string | string[]) {
    const p = Array.isArray(paths) ? paths : [paths];
    this.send({ type: 'git.stage', payload: { paths: p } });
  },

  unstageGit(this: WsClientDomainHost, paths: string | string[]) {
    const p = Array.isArray(paths) ? paths : [paths];
    this.send({ type: 'git.unstage', payload: { paths: p } });
  },

  discardGit(this: WsClientDomainHost, paths: string | string[]) {
    const p = Array.isArray(paths) ? paths : [paths];
    this.send({ type: 'git.discard', payload: { paths: p } });
  },

  commitGit(this: WsClientDomainHost, message: string) {
    this.send({ type: 'git.commit', payload: { message } });
  },

  getProviderStatus(this: WsClientDomainHost) {
    this.send({ type: 'provider.status.get' });
  },

  retryProviderModel(this: WsClientDomainHost, providerId: string, model: string) {
    this.send({ type: 'provider.status.retry', payload: { providerId, model } });
  },

  clearProviderStatus(this: WsClientDomainHost, providerId: string, model: string) {
    this.send({ type: 'provider.status.clear', payload: { providerId, model } });
  },

  newSession(this: WsClientDomainHost) {
    this.send({ type: 'abort', payload: this.withSession({}) });
    this.send({ type: 'session.new', payload: this.withSession({}) });
  },

  /** Ask for the identity-prompt catalogue (variants, token estimates, current). */
  getSystemPrompt(this: WsClientDomainHost) {
    this.send({ type: 'system_prompt.get' });
  },

  /**
   * Switch the identity-prompt size. Rides `prefs.update` because the variant is
   * an ordinary persisted preference on the server; the server answers with a
   * fresh `system_prompt.info` broadcast once the live prompt is rebuilt.
   */
  setSystemPromptVariant(this: WsClientDomainHost, variant: 'lite' | 'default' | 'pro') {
    this.send({ type: 'prefs.update', payload: { systemPromptVariant: variant } });
  },

  listProviders(this: WsClientDomainHost) {
    this.send({ type: 'providers.list' });
  },

  listProviderModels(this: WsClientDomainHost, providerId: string) {
    this.send({ type: 'provider.models', payload: { providerId } });
  },

  listSavedProviders(this: WsClientDomainHost) {
    this.send({ type: 'providers.saved' });
  },

  searchProviderModels(this: WsClientDomainHost, query: string, limit?: number) {
    this.send({
      type: 'provider.models.search',
      payload: { query, ...(limit !== undefined ? { limit } : {}) },
    });
  },

  addKey(this: WsClientDomainHost, providerId: string, label: string, apiKey: string) {
    this.send({ type: 'key.add', payload: { providerId, label, apiKey } });
  },

  updateKey(this: WsClientDomainHost, providerId: string, label: string, apiKey: string) {
    this.send({ type: 'key.update', payload: { providerId, label, apiKey } });
  },

  deleteKey(this: WsClientDomainHost, providerId: string, label: string) {
    this.send({ type: 'key.delete', payload: { providerId, label } });
  },

  setActiveKey(this: WsClientDomainHost, providerId: string, label: string) {
    this.send({ type: 'key.set_active', payload: { providerId, label } });
  },

  addProvider(
    this: WsClientDomainHost,
    id: string,
    family: string,
    baseUrl?: string | undefined,
    apiKey?: string,
    models?: string[] | undefined,
    customModels?: Record<string, ProviderCustomModelWire> | undefined,
  ) {
    this.send({
      type: 'provider.add',
      payload: {
        id,
        family,
        baseUrl,
        apiKey,
        ...(models ? { models } : {}),
        ...(customModels ? { customModels } : {}),
      },
    });
  },

  removeProvider(this: WsClientDomainHost, providerId: string) {
    this.send({ type: 'provider.remove', payload: { providerId } });
  },

  startOAuth(this: WsClientDomainHost, kind: 'chatgpt' | 'claude' | 'copilot', providerId?: string) {
    this.send({
      type: 'auth.oauth.start',
      payload: providerId ? { kind, providerId } : { kind },
    });
  },

  submitOAuthCode(this: WsClientDomainHost, kind: 'chatgpt' | 'claude' | 'copilot', input: string) {
    this.send({ type: 'auth.oauth.code', payload: { kind, input } });
  },

  cancelOAuth(this: WsClientDomainHost, kind: 'chatgpt' | 'claude' | 'copilot') {
    this.send({ type: 'auth.oauth.cancel', payload: { kind } });
  },

  probeProvider(this: WsClientDomainHost, providerId: string, timeoutMs?: number) {
    this.send({
      type: 'provider.probe',
      payload: timeoutMs !== undefined ? { providerId, timeoutMs } : { providerId },
    });
  },

  clearProviderModels(this: WsClientDomainHost, providerId: string) {
    this.send(buildClearModelsMessage(providerId));
  },

  undoProviderClear(this: WsClientDomainHost, providerId: string, previousModels: string[]) {
    this.send(buildUndoClearMessage(providerId, previousModels));
  },

  setCustomModel(
    this: WsClientDomainHost,
    providerId: string,
    modelId: string,
    customModel: ProviderCustomModelWire,
  ) {
    this.send({
      type: 'provider.custom_models.set',
      payload: { providerId, modelId, customModel },
    });
  },

  removeCustomModel(this: WsClientDomainHost, providerId: string, modelId: string) {
    this.send({
      type: 'provider.custom_models.remove',
      payload: { providerId, modelId },
    });
  },

  updateProvider(
    this: WsClientDomainHost,
    payload: {
      id: string;
      family?: string | undefined;
      baseUrl?: string | undefined;
      envVars?: string[] | undefined;
      models?: string[] | undefined;
      customModels?: Record<string, ProviderCustomModelWire> | undefined;
    },
  ) {
    this.send(buildProviderUpdateMessage(payload));
  },

  clearContext(this: WsClientDomainHost) {
    this.send({ type: 'context.clear', payload: this.withSession({}) });
  },

  compactContext(this: WsClientDomainHost, aggressive = false) {
    this.send({ type: 'context.compact', payload: this.withSession({ aggressive }) });
  },

  repairContext(this: WsClientDomainHost) {
    this.send({ type: 'context.repair', payload: this.withSession({}) });
  },

  openContextEditor(this: WsClientDomainHost) {
    this.send({ type: 'context.editor.open', payload: this.withSession({}) });
  },

  validateContextEditor(
    this: WsClientDomainHost,
    baseRevision: string,
    messages: ContextEditorMessage[],
    removals: ContextEditorRemoval[],
    allowRepair: boolean,
  ) {
    this.send({
      type: 'context.editor.validate',
      payload: this.withSession({ baseRevision, messages, removals, allowRepair }),
    });
  },

  applyContextEditor(
    this: WsClientDomainHost,
    baseRevision: string,
    messages: ContextEditorMessage[],
    removals: ContextEditorRemoval[],
    allowRepair: boolean,
  ) {
    this.send({
      type: 'context.editor.apply',
      payload: this.withSession({ baseRevision, messages, removals, allowRepair }),
    });
  },

  debugContext(this: WsClientDomainHost, options?: WSSendOptions) {
    this.send({ type: 'context.debug', payload: this.withSession({}) }, options);
  },

  listContextModes(this: WsClientDomainHost) {
    this.send({ type: 'context.modes.list', payload: this.withSession({}) });
  },

  switchContextMode(this: WsClientDomainHost, id: string) {
    this.send({ type: 'context.mode.switch', payload: this.withSession({ id }) });
  },

  createContextMode(
    this: WsClientDomainHost,
    mode: {
      id: string;
      name: string;
      description: string;
      thresholds: { warn: number; soft: number; hard: number };
      preserveK: number;
      eliseThreshold: number;
    },
  ) {
    this.send({ type: 'context.mode.create', payload: this.withSession(mode) });
  },

  updateContextMode(
    this: WsClientDomainHost,
    id: string,
    patch: {
      name?: string | undefined;
      description?: string | undefined;
      thresholds?:
        | { warn?: number | undefined; soft?: number | undefined; hard?: number | undefined }
        | undefined;
      preserveK?: number | undefined;
      eliseThreshold?: number | undefined;
    },
  ) {
    this.send({ type: 'context.mode.update', payload: this.withSession({ id, ...patch }) });
  },

  deleteContextMode(this: WsClientDomainHost, id: string) {
    this.send({ type: 'context.mode.delete', payload: this.withSession({ id }) });
  },

  switchAutonomy(this: WsClientDomainHost, mode: string) {
    this.send({ type: 'autonomy.switch', payload: { mode } });
  },

  updatePrefs(this: WsClientDomainHost, prefs: Record<string, unknown>) {
    this.send({ type: 'prefs.update', payload: prefs });
  },

  getPrefs(this: WsClientDomainHost) {
    this.send({ type: 'prefs.get' });
  },
};

export function installWsClientDomainMethods(
  ctor: { prototype: any },
): void {
  Object.assign(ctor.prototype, domainMethods);
}

export type WsClientDomainMethods = typeof domainMethods;


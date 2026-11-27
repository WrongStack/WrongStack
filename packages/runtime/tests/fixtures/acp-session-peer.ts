import { join } from 'node:path';
import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin });
const original = 'original-session';
let active: string | undefined;
const elicit = process.argv.includes('elicit');
const sendPlans = process.argv.includes('plans');
const sendChildren = process.argv.includes('children');
let planSupported = false;
let subagentsSupported = false;
const modeProtocol = process.argv.includes('mode-modern')
  ? 'modern'
  : process.argv.includes('mode-legacy')
    ? 'legacy'
    : undefined;
let mode = 'auto';
const modeIds = ['auto', 'default', 'plan', 'acceptEdits', 'bypassPermissions', 'dontAsk'];
const modeOptions = () => [
  {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: mode,
    options: modeIds.map((value) => ({ value, name: value })),
  },
  {
    id: 'toString',
    name: 'Other mode',
    category: 'mode',
    type: 'select',
    currentValue: 'inspect',
    options: [{ value: 'inspect', name: 'Inspect' }],
  },
];
let formSupported = false;
let promptId: string | number | undefined;
const formId = 900;
const childPermissionId = 901;

function send(message: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function update(update: Record<string, unknown>, sessionId = active) {
  send({ method: 'session/update', params: { sessionId, update } });
}

lines.on('line', (line) => {
  const { id, method, params, result: response } = JSON.parse(line);
  if (id === undefined) return;
  if (id === childPermissionId && promptId !== undefined) {
    const denied = response?.outcome?.optionId === 'deny';
    update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Parent response' },
    });
    send({ id: promptId, result: { stopReason: 'end_turn' } });
    update({
      sessionUpdate: 'subagent_update',
      sessionId: 'review-child',
      state: { state: 'idle', stopReason: denied ? 'cancelled' : 'error' },
    });
    promptId = undefined;
    return;
  }
  if (id === formId && promptId !== undefined) {
    send({
      method: 'session/update',
      params: {
        sessionId: active,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: JSON.stringify(response) },
        },
      },
    });
    send({ id: promptId, result: { stopReason: 'end_turn' } });
    promptId = undefined;
    return;
  }
  const result = (value: unknown) => send({ id, result: value });
  const error = (message: string) => send({ id, error: { code: -32602, message } });
  switch (method) {
    case 'initialize':
      formSupported = params.clientCapabilities?.elicitation?.form !== undefined;
      planSupported = params.clientCapabilities?.plan !== undefined;
      subagentsSupported = params.clientCapabilities?.subagents !== undefined;
      return result({
        protocolVersion: 1,
        authMethods: [],
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: process.argv.includes('load-only')
            ? {}
            : { list: {}, resume: {}, fork: {}, close: {} },
        },
      });
    case 'session/list':
      return result({
        sessions: [
          { sessionId: original, cwd: process.cwd(), title: params.cursor || 'Existing thread' },
          { sessionId: 'unrelated', cwd: join(process.cwd(), 'other') },
        ],
        ...(!params.cursor ? { nextCursor: 'page-2==' } : {}),
      });
    case 'session/resume':
    case 'session/load':
    case 'session/fork':
      if (params.sessionId !== original) return error('Session not found');
      active = method === 'session/fork' ? 'forked-session' : original;
      return result({ sessionId: active });
    case 'session/new':
      active = 'fresh-session';
      return result({
        sessionId: active,
        ...(modeProtocol === 'modern' ? { configOptions: modeOptions() } : {}),
        ...(modeProtocol === 'legacy'
          ? {
              modes: {
                currentModeId: mode,
                availableModes: modeIds.map((id) => ({ id, name: id })),
              },
            }
          : {}),
      });
    case 'session/set_mode':
      if (
        modeProtocol !== 'legacy' ||
        params.sessionId !== active ||
        !modeIds.includes(params.modeId)
      )
        return error('Unexpected legacy mode switch');
      mode = params.modeId;
      return result({});
    case 'session/set_config_option':
      if (
        modeProtocol !== 'modern' ||
        params.sessionId !== active ||
        params.configId !== 'mode' ||
        !modeIds.includes(params.value)
      ) {
        return error('Unexpected config mode switch');
      }
      mode = params.value;
      return result({ configOptions: modeOptions() });
    case 'session/prompt':
      if (params.sessionId !== active) return error('Unexpected session');
      if (sendChildren) {
        if (!subagentsSupported) return error('Expected the subagents capability');
        promptId = id;
        update({
          sessionUpdate: 'subagent_update',
          sessionId: 'review-child',
          title: 'Reviewer',
          state: { state: 'running' },
        });
        update(
          {
            sessionUpdate: 'subagent_update',
            sessionId: 'nested-child',
            title: 'Reader',
          },
          'review-child',
        );
        update(
          {
            sessionUpdate: 'session_message',
            messageId: 'instruction',
            senderSessionId: active,
            content: [{ type: 'text', text: 'Look over the proposed changes.' }],
          },
          'review-child',
        );
        update(
          {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Child response' },
          },
          'review-child',
        );
        send({
          id: childPermissionId,
          method: 'session/request_permission',
          params: {
            sessionId: 'review-child',
            toolCall: {
              toolCallId: 'edit-1',
              kind: 'edit',
              rawInput: { path: join(process.cwd(), 'fixture.md'), content: '' },
            },
            options: [{ optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
          },
        });
        return;
      }
      if (sendPlans) {
        if (!planSupported) return error('Expected the plan capability');
        const text = params.prompt.map((block: { text?: string }) => block.text).join(' ');
        if (text.includes('Drop the checklist')) {
          update({ sessionUpdate: 'plan_removed', planId: 'checklist' });
        } else {
          update({
            sessionUpdate: 'plan_update',
            plan: {
              type: 'items',
              planId: 'checklist',
              entries: [
                { content: 'Read workspace structure', priority: 'high', status: 'pending' },
              ],
            },
          });
          update({
            sessionUpdate: 'plan_update',
            plan: {
              type: 'items',
              planId: 'checklist',
              entries: [
                { content: 'Read workspace structure', priority: 'high', status: 'in_progress' },
              ],
            },
          });
          update({
            sessionUpdate: 'plan_update',
            plan: {
              type: 'markdown',
              planId: 'draft',
              content: '# Approach\nCompare the results.',
            },
          });
          update({ sessionUpdate: 'plan_removed', planId: 'checklist' }, 'foreign-session');
        }
      }
      if (elicit) {
        if (!formSupported) return error('Expected the form capability');
        promptId = id;
        send({
          id: formId,
          method: 'elicitation/create',
          params: {
            mode: 'form',
            sessionId: active,
            message: 'Choose a strategy and retry count.',
            requestedSchema: {
              type: 'object',
              properties: {
                strategy: { type: 'string', enum: ['conservative', 'aggressive'] },
                retries: { type: 'integer', minimum: 1, maximum: 5 },
              },
              required: ['strategy', 'retries'],
            },
          },
        });
        return;
      }
      send({
        method: 'session/update',
        params: {
          sessionId: active,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: modeProtocol ? `Mode ${mode} on ${active}` : `Task reached ${active}`,
            },
          },
        },
      });
      return result({ stopReason: 'end_turn' });
    case 'session/close':
      active = undefined;
      return result({});
    default:
      return error(`Unexpected method: ${method}`);
  }
});

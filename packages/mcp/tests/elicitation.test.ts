/**
 * MCP elicitation (`elicitation/create`): the responder every transport shares,
 * the mapping onto the structured user-input form, and the round trip over
 * real stdio, Streamable HTTP and SSE servers — including the request timeout
 * holding while the user is still answering.
 */
import { unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger, UserInputRequest, UserInputResponse } from '@wrongstack/contracts/types';
import { ToolRegistry } from '@wrongstack/core/registry';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCPClient } from '../src/client.js';
import {
  type ElicitationField,
  type MCPElicitationRequest,
  ServerRequestResponder,
} from '../src/elicitation.js';
import { elicitViaUserInput } from '../src/elicitation-form.js';
import { MCPRegistry } from '../src/registry.js';

const silentLog = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => silentLog,
} as never as Logger;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * Request timeout vs. how long the "user" takes to answer. The answer outlasts
 * the timeout by more than two windows, so only a held timeout lets the call
 * finish — and the window is wide enough that a loaded machine still gets the
 * server's request out before it.
 */
const TIMEOUT_MS = 1_500;
const USER_MS = 3_500;

const DEPLOY_SCHEMA = {
  type: 'object',
  properties: {
    env: { type: 'string', title: 'Environment', enum: ['staging', 'prod'] },
    replicas: { type: 'integer', minimum: 1, maximum: 10 },
    notify: { type: 'boolean', default: true },
  },
  required: ['env'],
};

function elicitRequest(id: number | string, params: unknown = {}) {
  return {
    id,
    method: 'elicitation/create',
    params: { message: 'Deploy?', requestedSchema: DEPLOY_SCHEMA, ...(params as object) },
  };
}

describe('ServerRequestResponder', () => {
  it('declares elicitation only when it can answer it', () => {
    expect(new ServerRequestResponder().capabilities()).toEqual({});
    expect(new ServerRequestResponder(async () => ({ action: 'cancel' })).capabilities()).toEqual({
      elicitation: { form: {}, url: {} },
    });
  });

  it('answers ping, refuses sampling by policy and anything unknown', async () => {
    const r = new ServerRequestResponder(async () => ({ action: 'cancel' }));
    expect(await r.answer({ id: 1, method: 'ping' })).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {},
    });
    expect(await r.answer({ id: 2, method: 'sampling/createMessage' })).toMatchObject({
      error: { code: -32601, message: 'Client sampling is disabled by policy' },
    });
    expect(await r.answer({ id: 3, method: 'roots/list' })).toMatchObject({
      error: { code: -32601 },
    });
    // Not declared → not a method this client has.
    expect(await new ServerRequestResponder().answer(elicitRequest(4))).toMatchObject({
      error: { code: -32601, message: 'Method not found: elicitation/create' },
    });
  });

  it('refuses a schema that is not a flat form of primitives', async () => {
    const handler = vi.fn();
    const r = new ServerRequestResponder(handler);
    const nested = {
      message: 'x',
      requestedSchema: {
        type: 'object',
        properties: { address: { type: 'object', properties: {} } },
      },
    };
    expect(await r.answer({ id: 1, method: 'elicitation/create', params: nested })).toMatchObject({
      error: { code: -32602, message: expect.stringContaining('"address"') },
    });
    expect(
      await r.answer({ id: 2, method: 'elicitation/create', params: { requestedSchema: {} } }),
    ).toMatchObject({ error: { code: -32602 } });
    // URL mode needs an id, and only a web page is ever handed to the browser.
    expect(
      await r.answer({
        id: 3,
        method: 'elicitation/create',
        params: { mode: 'url', message: 'Sign in', url: 'https://x.example' },
      }),
    ).toMatchObject({ error: { code: -32602, message: expect.stringContaining('elicitationId') } });
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'not a url']) {
      expect(
        await r.answer({
          id: 4,
          method: 'elicitation/create',
          params: { mode: 'url', message: 'Sign in', url, elicitationId: 'e1' },
        }),
      ).toMatchObject({ error: { code: -32602 } });
    }
    expect(
      await r.answer({
        id: 5,
        method: 'elicitation/create',
        params: { mode: 'sms', message: 'x' },
      }),
    ).toMatchObject({ error: { code: -32602, message: expect.stringContaining('"sms"') } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('parses every field shape the spec revisions use', async () => {
    let fields: ElicitationField[] = [];
    const r = new ServerRequestResponder(async (form) => {
      if (form.mode !== 'url') fields = form.fields;
      return { action: 'cancel' };
    });
    await r.answer({
      id: 1,
      method: 'elicitation/create',
      params: {
        message: 'm',
        requestedSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 2, format: 'email', default: 'a@b.c' },
            size: { type: 'string', oneOf: [{ const: 's', title: 'Small' }, { const: 'l' }] },
            legacy: { type: 'string', enum: ['x', 'y'], enumNames: ['Ex', 'Why'] },
            tags: {
              type: 'array',
              items: { anyOf: [{ const: 'a', title: 'A' }] },
              maxItems: 1,
              default: ['a'],
            },
            ratio: { type: 'number', maximum: 1 },
          },
          required: ['name'],
        },
      },
    });
    expect(fields).toEqual([
      expect.objectContaining({
        name: 'name',
        kind: 'string',
        required: true,
        minLength: 2,
        format: 'email',
        default: 'a@b.c',
      }),
      expect.objectContaining({
        name: 'size',
        kind: 'enum',
        options: [
          { value: 's', label: 'Small' },
          { value: 'l', label: 'l' },
        ],
      }),
      expect.objectContaining({
        name: 'legacy',
        kind: 'enum',
        options: [
          { value: 'x', label: 'Ex' },
          { value: 'y', label: 'Why' },
        ],
      }),
      expect.objectContaining({ name: 'tags', kind: 'multi-enum', maxItems: 1, default: ['a'] }),
      expect.objectContaining({ name: 'ratio', kind: 'number', maximum: 1, required: false }),
    ]);
  });

  // NV-1 (security-check 2026-09-26): this text is drawn in the TUI under a
  // host-authored header. Escapes could clear/overwrite that header or write
  // the clipboard (OSC 52); a CR returns to column 0 and overdraws the line.
  it('drops terminal controls from every string it will display, not from values', async () => {
    let seen: { message: string; fields: ElicitationField[] } | undefined;
    const r = new ServerRequestResponder(async (form) => {
      if (form.mode !== 'url') seen = { message: form.message, fields: form.fields };
      return { action: 'cancel' };
    });
    const ESC = '\u001b';
    await r.answer({
      id: 1,
      method: 'elicitation/create',
      params: {
        message: `${ESC}[2J${ESC}[HWrongStack needs your API key${ESC}]52;c;ZXZpbA==\u0007\rOK`,
        requestedSchema: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              title: `${ESC}[1mProvider key${ESC}[0m`,
              description: 'paste‮ here',
            },
            plan: { type: 'string', enum: ['a'], enumNames: [`${ESC}[31mBasic`] },
            [`raw${ESC}[8m`]: { type: 'boolean' },
          },
        },
      },
    });
    expect(seen?.message).toBe('WrongStack needs your API keyOK');
    expect(seen?.fields[0]).toMatchObject({ title: 'Provider key', description: 'paste here' });
    expect(seen?.fields[1]).toMatchObject({ options: [{ value: 'a', label: 'Basic' }] });
    // The key the answer goes back under is the server's own, untouched.
    expect(seen?.fields[2]?.name).toBe(`raw${ESC}[8m`);
    for (const text of [
      seen?.message,
      ...(seen?.fields ?? []).flatMap((f) => [f.title, f.description]),
    ]) {
      expect(text ?? '').not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f‮]/);
    }
  });

  it('checks accepted content against the schema, coercing numeric text', async () => {
    const answer = vi.fn();
    const r = new ServerRequestResponder(async () => answer());

    answer.mockReturnValueOnce({
      action: 'accept',
      content: { env: 'prod', replicas: '3', notify: false, extra: 'dropped' },
    });
    expect(await r.answer(elicitRequest(1))).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { action: 'accept', content: { env: 'prod', replicas: 3, notify: false } },
    });

    for (const content of [
      { replicas: 2 }, // required env missing
      { env: 'dev' }, // not an offered choice
      { env: 'prod', replicas: 11 }, // above maximum
      { env: 'prod', replicas: 1.5 }, // not an integer
      { env: 'prod', notify: 'yes' }, // not a boolean
    ]) {
      answer.mockReturnValueOnce({ action: 'accept', content });
      expect(await r.answer(elicitRequest(2))).toMatchObject({ error: { code: -32602 } });
    }

    answer.mockReturnValueOnce({ action: 'decline' });
    expect(await r.answer(elicitRequest(3))).toMatchObject({ result: { action: 'decline' } });
    answer.mockImplementationOnce(() => {
      throw new Error('surface crashed');
    });
    expect(await r.answer(elicitRequest(4))).toMatchObject({ result: { action: 'cancel' } });
  });

  it('treats an empty string as an answer, not as an unanswered field', async () => {
    // `checkValue` owns the bounds contract and admits '' for a declared
    // `{ type: 'string' }` — with no `minLength`, or with `minLength: 0`, which
    // `optionalCount` accepts. So '' must reach it. Classifying '' as omitted
    // first made a required plain string field unsatisfiable (every answer came
    // back "is required") and dropped the key on an optional one, so the server
    // got `{}` where the user had given `{ note: '' }`.
    const answer = vi.fn();
    const r = new ServerRequestResponder(async () => answer());
    const noteSchema = (required: string[], note: Record<string, unknown>) => ({
      type: 'object',
      properties: { note: { type: 'string', title: 'Note', ...note } },
      required,
    });

    // Required plain string field: '' is a valid answer and is forwarded.
    answer.mockReturnValueOnce({ action: 'accept', content: { note: '' } });
    expect(await r.answer(elicitRequest(1, { requestedSchema: noteSchema(['note'], {}) }))).toEqual(
      {
        jsonrpc: '2.0',
        id: 1,
        result: { action: 'accept', content: { note: '' } },
      },
    );

    // Optional field: the key must reach the server rather than vanish.
    answer.mockReturnValueOnce({ action: 'accept', content: { note: '' } });
    expect(await r.answer(elicitRequest(2, { requestedSchema: noteSchema([], {}) }))).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { action: 'accept', content: { note: '' } },
    });

    // minLength: 0 says the empty string is in bounds.
    answer.mockReturnValueOnce({ action: 'accept', content: { note: '' } });
    expect(
      await r.answer(elicitRequest(3, { requestedSchema: noteSchema(['note'], { minLength: 0 }) })),
    ).toMatchObject({ result: { content: { note: '' } } });

    // A real bound still rejects '', and now names the bound that rejected it.
    answer.mockReturnValueOnce({ action: 'accept', content: { note: '' } });
    expect(
      await r.answer(elicitRequest(4, { requestedSchema: noteSchema(['note'], { minLength: 3 }) })),
    ).toMatchObject({ error: { code: -32602, message: expect.stringMatching(/at least 3/) } });

    // A genuine omission is still "required" — only the empty string changed.
    answer.mockReturnValueOnce({ action: 'accept', content: {} });
    expect(
      await r.answer(elicitRequest(5, { requestedSchema: noteSchema(['note'], {}) })),
    ).toMatchObject({ error: { code: -32602, message: expect.stringMatching(/required/) } });

    // The other valid falsy answers were already handled and stay that way.
    answer.mockReturnValueOnce({ action: 'accept', content: { note: 'x' } });
    expect(
      await r.answer(elicitRequest(6, { requestedSchema: noteSchema(['note'], {}) })),
    ).toMatchObject({ result: { content: { note: 'x' } } });
  });

  it('holds one form at a time, and stops waiting on server cancel or dispose', async () => {
    let seen: AbortSignal | undefined;
    const r = new ServerRequestResponder(
      (form) =>
        new Promise((resolve) => {
          seen = form.signal;
          form.signal.addEventListener('abort', () => resolve({ action: 'decline' }));
        }),
    );

    const first = r.answer(elicitRequest('a'));
    expect(r.awaitingUser).toBe(true);
    expect(await r.answer(elicitRequest('b'))).toMatchObject({
      error: { code: -32602, message: expect.stringContaining('still waiting') },
    });
    r.cancel({ requestId: 'a' });
    // A form the server gave up on is reported as cancelled, whatever the surface said.
    expect(await first).toMatchObject({ id: 'a', result: { action: 'cancel' } });
    expect(seen?.aborted).toBe(true);
    expect(r.awaitingUser).toBe(false);

    const second = r.answer(elicitRequest('c'));
    r.dispose();
    expect(await second).toMatchObject({ result: { action: 'cancel' } });
  });

  for (const id of [1, 'reused-id']) {
    it(`keeps a new form pending when an old disposed form settles with reused id ${id}`, async () => {
      const finish: Array<() => void> = [];
      const responder = new ServerRequestResponder(
        () =>
          new Promise((resolve) => {
            finish.push(() => resolve({ action: 'decline' }));
          }),
      );
      const old = responder.answer(elicitRequest(id));
      responder.dispose();
      const next = responder.answer(elicitRequest(id));
      try {
        finish[0]?.();
        await old;
        expect(responder.awaitingUser).toBe(true);
        await expect(responder.answer(elicitRequest('another'))).resolves.toMatchObject({
          error: { code: -32602 },
        });
        responder.cancel({ requestId: id });
        finish[1]?.();
        await expect(next).resolves.toMatchObject({ result: { action: 'cancel' } });
        expect(responder.awaitingUser).toBe(false);
      } finally {
        responder.dispose();
        for (const resolve of finish) resolve();
        await Promise.all([old, next]);
      }
    });
  }
});

function formRequest(
  fields: ElicitationField[],
  requester?: MCPElicitationRequest['requester'],
): MCPElicitationRequest {
  return {
    server: 'deployer',
    message: 'Pick a target',
    fields,
    requester,
    signal: new AbortController().signal,
  };
}

const DEPLOY_FIELDS: ElicitationField[] = [
  {
    name: 'env',
    title: 'Environment',
    required: true,
    kind: 'enum',
    options: [
      { value: 'staging', label: 'staging' },
      { value: 'prod', label: 'Production' },
    ],
    default: 'staging',
  },
  { name: 'replicas', required: false, kind: 'integer', minimum: 1 },
  { name: 'notify', required: false, kind: 'boolean', default: true },
  {
    name: 'regions',
    required: false,
    kind: 'multi-enum',
    options: [
      { value: 'eu', label: 'EU' },
      { value: 'us', label: 'US' },
    ],
  },
];

function answering(...responses: Array<(req: UserInputRequest) => UserInputResponse | undefined>) {
  const requests: UserInputRequest[] = [];
  const requestUserInput = vi.fn(async (req: UserInputRequest) => {
    requests.push(req);
    return responses[requests.length - 1]?.(req);
  });
  return { requestUserInput, requests };
}

describe('elicitViaUserInput', () => {
  it('renders the fields as questions and turns the answers into typed content', async () => {
    const user = answering((req) => ({
      requestId: req.id,
      status: 'submitted',
      answers: [
        { questionId: 'f0', selectedOptionIds: ['o1'], usedRecommendation: false },
        { questionId: 'f1', selectedOptionIds: [], text: ' 4 ', usedRecommendation: false },
        { questionId: 'f2', selectedOptionIds: ['no'], usedRecommendation: false },
        { questionId: 'f3', selectedOptionIds: ['o0', 'o1'], usedRecommendation: false },
      ],
    }));

    const result = await elicitViaUserInput(formRequest(DEPLOY_FIELDS, user));

    expect(result).toEqual({
      action: 'accept',
      content: { env: 'prod', replicas: 4, notify: false, regions: ['eu', 'us'] },
    });
    const form = user.requests[0]!;
    expect(form.title).toContain('"deployer"');
    expect(form.description).toContain('Pick a target');
    expect(form.description).toContain('comfortable sending to "deployer"');
    expect(form.tabs[0]?.questions).toEqual([
      expect.objectContaining({
        id: 'f0',
        prompt: 'Environment',
        kind: 'single_select',
        required: true,
        recommendedOptionIds: ['o0'],
        options: [
          { id: 'o0', label: 'staging' },
          { id: 'o1', label: 'Production' },
        ],
      }),
      expect.objectContaining({
        id: 'f1',
        kind: 'text',
        description: 'A whole number. At least 1.',
      }),
      expect.objectContaining({ id: 'f2', kind: 'single_select', recommendedOptionIds: ['yes'] }),
      expect.objectContaining({ id: 'f3', kind: 'multi_select' }),
    ]);
  });

  it('asks again with the reason when an answer does not fit, then accepts', async () => {
    const reply =
      (text: string) =>
      (req: UserInputRequest): UserInputResponse => ({
        requestId: req.id,
        status: 'submitted',
        answers: [
          { questionId: 'f0', selectedOptionIds: ['o0'], usedRecommendation: true },
          { questionId: 'f1', selectedOptionIds: [], text, usedRecommendation: false },
        ],
      });
    const user = answering(reply('zero'), reply('2'));

    const result = await elicitViaUserInput(formRequest(DEPLOY_FIELDS, user));

    expect(result).toEqual({ action: 'accept', content: { env: 'staging', replicas: 2 } });
    expect(user.requests).toHaveLength(2);
    expect(user.requests[1]?.description).toContain('not accepted: replicas must be a number');
  });

  it('carries a blank answer to a required string field through to the server', async () => {
    // A blank box answered for a REQUIRED field is a real answer, not a
    // skipped one — the field's own bounds decide whether '' is acceptable.
    // Folding it into `undefined` invented an omission the user never made, so
    // the form was re-asked until it cancelled even when '' was valid, and
    // every re-ask blamed "is required" instead of naming the real bound.
    const REQUIRED_NOTE: ElicitationField = {
      name: 'note',
      title: 'Note',
      required: true,
      kind: 'string',
    };
    const MIN_ZERO: ElicitationField = { ...REQUIRED_NOTE, minLength: 0 };
    const MIN_THREE: ElicitationField = { ...REQUIRED_NOTE, minLength: 3 };
    const OPTIONAL_NOTE: ElicitationField = { ...REQUIRED_NOTE, required: false };

    const blank = (req: UserInputRequest): UserInputResponse => ({
      requestId: req.id,
      status: 'submitted',
      answers: [{ questionId: 'f0', selectedOptionIds: [], text: '', usedRecommendation: false }],
    });

    // No lower bound: '' is in bounds, so it is accepted on the first prompt.
    const plain = answering(blank);
    expect(await elicitViaUserInput(formRequest([REQUIRED_NOTE], plain))).toEqual({
      action: 'accept',
      content: { note: '' },
    });
    expect(plain.requests).toHaveLength(1);

    // minLength: 0 states outright that the empty string is in bounds.
    const zero = answering(blank);
    expect(await elicitViaUserInput(formRequest([MIN_ZERO], zero))).toEqual({
      action: 'accept',
      content: { note: '' },
    });

    // A real lower bound still rejects the blank, and the re-ask names THAT
    // bound rather than claiming the field was never answered.
    const bounded = answering(blank, blank);
    await elicitViaUserInput(formRequest([MIN_THREE], bounded));
    expect(bounded.requests[1]?.description).toContain('not accepted: Note needs at least 3');

    // An OPTIONAL field the user skipped is a genuine omission, still omitted.
    const optional = answering(blank);
    expect(await elicitViaUserInput(formRequest([OPTIONAL_NOTE], optional))).toEqual({
      action: 'accept',
      content: {},
    });
    expect(optional.requests).toHaveLength(1);

    // And a typed answer is still forwarded exactly as entered.
    const typed = answering(
      (req: UserInputRequest): UserInputResponse => ({
        requestId: req.id,
        status: 'submitted',
        answers: [
          { questionId: 'f0', selectedOptionIds: [], text: '  hello  ', usedRecommendation: false },
        ],
      }),
    );
    expect(await elicitViaUserInput(formRequest([REQUIRED_NOTE], typed))).toEqual({
      action: 'accept',
      content: { note: '  hello  ' },
    });
  });

  it('declines when the user dismisses it, and cancels when no one can be asked', async () => {
    const dismissed = answering((req) => ({ requestId: req.id, status: 'cancelled', answers: [] }));
    expect(await elicitViaUserInput(formRequest(DEPLOY_FIELDS, dismissed))).toEqual({
      action: 'decline',
    });

    const headless = answering(() => undefined);
    expect(await elicitViaUserInput(formRequest(DEPLOY_FIELDS, headless))).toEqual({
      action: 'cancel',
    });
    expect(await elicitViaUserInput(formRequest(DEPLOY_FIELDS))).toEqual({ action: 'cancel' });
  });

  it('falls back to the host session when the server asks outside a tool call', async () => {
    const root = answering((req) => ({
      requestId: req.id,
      status: 'submitted',
      answers: [{ questionId: 'confirm', selectedOptionIds: ['yes'], usedRecommendation: false }],
    }));
    // No fields: a plain go-ahead question.
    expect(await elicitViaUserInput(formRequest([]), root)).toEqual({
      action: 'accept',
      content: {},
    });
    expect(root.requests[0]?.tabs[0]?.questions[0]).toMatchObject({
      id: 'confirm',
      required: true,
    });
  });
});

describe('elicitViaUserInput in URL mode', () => {
  const page = (
    requester?: { requestUserInput: never },
    url = 'https://auth.example.com/connect?elicitationId=e1',
  ): MCPElicitationRequest => ({
    mode: 'url',
    message: 'Connect your calendar',
    url,
    elicitationId: 'e1',
    server: 'calendar',
    requester,
    signal: new AbortController().signal,
  });
  const choose = (option: string) =>
    answering((req) => ({
      requestId: req.id,
      status: 'submitted',
      answers: [{ questionId: 'url', selectedOptionIds: [option], usedRecommendation: false }],
    }));

  it('shows the full URL and the site, and opens it only when the user picks that', async () => {
    const openUrl = vi.fn();
    const user = choose('open');
    expect(await elicitViaUserInput(page(user as never), undefined, { openUrl })).toEqual({
      action: 'accept',
      content: {},
    });
    expect(openUrl).toHaveBeenCalledWith('https://auth.example.com/connect?elicitationId=e1');
    const form = user.requests[0]!;
    expect(form.title).toBe('MCP server "calendar" asks you to open auth.example.com');
    expect(form.description).toContain('Page: https://auth.example.com/connect?elicitationId=e1');
    expect(form.description).toContain('Site: auth.example.com');
    expect(form.tabs[0]?.questions[0]?.options?.map((o) => o.id)).toEqual([
      'open',
      'self',
      'decline',
    ]);
  });

  it('agrees without opening when the user opens it, and declines or cancels otherwise', async () => {
    const openUrl = vi.fn();
    expect(await elicitViaUserInput(page(choose('self') as never), undefined, { openUrl })).toEqual(
      { action: 'accept', content: {} },
    );
    expect(
      await elicitViaUserInput(page(choose('decline') as never), undefined, { openUrl }),
    ).toEqual({ action: 'decline' });
    const dismissed = answering((req) => ({ requestId: req.id, status: 'cancelled', answers: [] }));
    expect(await elicitViaUserInput(page(dismissed as never), undefined, { openUrl })).toEqual({
      action: 'decline',
    });
    // Nobody to ask (or nobody answering in an unattended run): never opened.
    expect(await elicitViaUserInput(page(answering() as never), undefined, { openUrl })).toEqual({
      action: 'cancel',
    });
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('offers no "open" when the host cannot open a browser, and warns about lookalike or plain-http sites', async () => {
    const user = choose('self');
    await elicitViaUserInput(page(user as never, 'http://xn--pple-43d.com/login'));
    const form = user.requests[0]!;
    expect(form.tabs[0]?.questions[0]?.options?.map((o) => o.id)).toEqual(['self', 'decline']);
    expect(form.description).toContain('punycode');
    expect(form.description).toContain('not served over HTTPS');
  });
});

// ── Real servers ───────────────────────────────────────────────────────────

/**
 * A stdio MCP server whose `ask` tool elicits the deploy form mid-call and
 * returns what it got back, plus the capabilities the client declared.
 */
function writeStdioServer(): string {
  const script = `'use strict';
const rl = require('readline');
let caps = null;
let pendingCall = null;
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.createInterface({ input: process.stdin, terminal: false }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    caps = m.params.capabilities;
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'elicit', version: '1' } } });
  } else if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'ask', inputSchema: { type: 'object' } }, { name: 'open_page', inputSchema: { type: 'object' } }, { name: 'needs_page', inputSchema: { type: 'object' } }] } });
  } else if (m.method === 'tools/call' && m.params.name === 'needs_page') {
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32042, message: 'This request requires more information.', data: { elicitations: [{ mode: 'url', elicitationId: 'e-9', url: 'https://example.com/connect?elicitationId=e-9', message: 'Authorize Example Co' }] } } });
  } else if (m.method === 'tools/call' && m.params.name === 'open_page') {
    pendingCall = m.id;
    send({ jsonrpc: '2.0', id: 'srv-1', method: 'elicitation/create', params: { mode: 'url', elicitationId: 'e-1', url: 'https://example.com/connect?elicitationId=e-1', message: 'Connect Example Co' } });
  } else if (m.method === 'tools/call') {
    pendingCall = m.id;
    send({ jsonrpc: '2.0', id: 'srv-1', method: 'elicitation/create', params: { message: 'Deploy?', requestedSchema: ${JSON.stringify(DEPLOY_SCHEMA)} } });
  } else if (m.id === 'srv-1') {
    send({ jsonrpc: '2.0', id: pendingCall, result: { content: [{ type: 'text', text: JSON.stringify({ caps, reply: m.result ?? m.error }) }] } });
  }
});
`;
  const path = join(
    tmpdir(),
    `elicit-mcp-${process.pid}-${Math.random().toString(36).slice(2)}.cjs`,
  );
  writeFileSync(path, script, 'utf8');
  return path;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function deployAnswer(req: UserInputRequest): UserInputResponse {
  return {
    requestId: req.id,
    status: 'submitted',
    answers: [
      { questionId: 'f0', selectedOptionIds: ['o1'], usedRecommendation: false },
      { questionId: 'f1', selectedOptionIds: [], text: '3', usedRecommendation: false },
      { questionId: 'f2', selectedOptionIds: ['yes'], usedRecommendation: true },
    ],
  };
}

describe('elicitation over stdio', () => {
  async function startRegistry(withHandler: boolean) {
    const scriptPath = writeStdioServer();
    cleanups.push(() => unlinkSync(scriptPath));
    const toolRegistry = new ToolRegistry();
    const registry = new MCPRegistry({
      toolRegistry,
      events: new EventBus(),
      log: silentLog,
      ...(withHandler ? { elicitationHandler: (request) => elicitViaUserInput(request) } : {}),
    });
    cleanups.push(() => registry.stopAll());
    await registry.start({
      name: 'deployer',
      transport: 'stdio',
      command: process.execPath,
      args: [scriptPath],
      startupTimeoutMs: 30_000,
      // Far shorter than the user takes to answer: the timeout must hold.
      requestTimeoutMs: TIMEOUT_MS,
    });
    const tool = toolRegistry.list().find((t) => t.name === 'mcp__deployer__ask');
    if (!tool) throw new Error('tool not registered');
    return tool;
  }

  it('asks the run that made the call, holding the request timeout while the user types', {
    timeout: 30_000,
  }, async () => {
    const tool = await startRegistry(true);
    const slowUser = vi.fn(async (req: UserInputRequest) => {
      await sleep(USER_MS);
      return deployAnswer(req);
    });
    const ctx = { requestUserInput: slowUser, signal: new AbortController().signal };

    const out = JSON.parse(
      String(await tool.execute({}, ctx as never, { signal: ctx.signal })),
    ) as { caps: unknown; reply: unknown };

    expect(out.caps).toEqual({ elicitation: { form: {}, url: {} } });
    expect(out.reply).toEqual({
      action: 'accept',
      content: { env: 'prod', replicas: 3, notify: true },
    });
    expect(slowUser).toHaveBeenCalledOnce();
    expect(slowUser.mock.calls[0]?.[0].title).toContain('"deployer"');
  });

  it('puts a URL-mode request to the user and answers with their consent only', {
    timeout: 30_000,
  }, async () => {
    const scriptPath = writeStdioServer();
    cleanups.push(() => unlinkSync(scriptPath));
    const toolRegistry = new ToolRegistry();
    const opened: string[] = [];
    const registry = new MCPRegistry({
      toolRegistry,
      events: new EventBus(),
      log: silentLog,
      elicitationHandler: (request) =>
        elicitViaUserInput(request, undefined, { openUrl: (url) => opened.push(url) }),
    });
    cleanups.push(() => registry.stopAll());
    await registry.start({
      name: 'pages',
      transport: 'stdio',
      command: process.execPath,
      args: [scriptPath],
      startupTimeoutMs: 30_000,
    });
    const tool = (name: string) => {
      const found = toolRegistry.list().find((t) => t.name === `mcp__pages__${name}`);
      if (!found) throw new Error(`${name} not registered`);
      return found;
    };
    const user = answering(
      (req) => ({
        requestId: req.id,
        status: 'submitted',
        answers: [{ questionId: 'url', selectedOptionIds: ['open'], usedRecommendation: false }],
      }),
      (req) => ({
        requestId: req.id,
        status: 'submitted',
        answers: [{ questionId: 'url', selectedOptionIds: ['self'], usedRecommendation: false }],
      }),
    );
    const ctx = { requestUserInput: user.requestUserInput, signal: new AbortController().signal };

    const out = JSON.parse(
      String(await tool('open_page').execute({}, ctx as never, { signal: ctx.signal })),
    ) as { reply: unknown };
    // Consent only: no content crosses the protocol in URL mode.
    expect(out.reply).toEqual({ action: 'accept' });
    expect(opened).toEqual(['https://example.com/connect?elicitationId=e-1']);

    // A call the server refuses with -32042 puts its page to the same user,
    // and the model is told what they chose and whether to call again.
    await expect(
      tool('needs_page').execute({}, ctx as never, { signal: ctx.signal }),
    ).rejects.toThrow(
      /needs the user to finish a step in the browser[\s\S]*example\.com: Authorize Example Co \(the user agreed to open it\)[\s\S]*call the tool again/,
    );
    expect(user.requests.map((r) => r.title)).toEqual([
      'MCP server "pages" asks you to open example.com',
      'MCP server "pages" asks you to open example.com',
    ]);
    expect(opened).toHaveLength(1);
  });

  it('declares nothing and refuses the request when the host cannot ask', {
    timeout: 30_000,
  }, async () => {
    const tool = await startRegistry(false);
    const ctx = { requestUserInput: vi.fn(), signal: new AbortController().signal };

    const out = JSON.parse(
      String(await tool.execute({}, ctx as never, { signal: ctx.signal })),
    ) as { caps: unknown; reply: unknown };

    expect(out.caps).toEqual({});
    expect(out.reply).toMatchObject({ code: -32601 });
    expect(ctx.requestUserInput).not.toHaveBeenCalled();
  });
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return JSON.parse(body) as Record<string, unknown>;
}

const INIT_RESULT = {
  protocolVersion: '2024-11-05',
  capabilities: { tools: {} },
  serverInfo: { name: 'elicit-http', version: '1' },
};
const TOOLS = { tools: [{ name: 'ask', inputSchema: { type: 'object' } }] };
const ELICIT = {
  jsonrpc: '2.0',
  id: 'srv-1',
  method: 'elicitation/create',
  params: {
    message: 'Name?',
    requestedSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
};
const sse = (message: unknown) => `event: message\ndata: ${JSON.stringify(message)}\n\n`;

describe('elicitation over Streamable HTTP', () => {
  it('answers a request that arrives inside the tool call stream', {
    timeout: 20_000,
  }, async () => {
    let declared: unknown;
    let replyHeaders: IncomingMessage['headers'] | undefined;
    let openCall: { id: unknown; res: ServerResponse } | undefined;
    const url = await listen(async (req, res) => {
      const msg = await readJson(req);
      const json = (body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(200, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };
      if (msg['method'] === 'initialize') {
        declared = (msg['params'] as { capabilities: unknown }).capabilities;
        json(
          { jsonrpc: '2.0', id: msg['id'], result: INIT_RESULT },
          { 'mcp-session-id': 'sess-7' },
        );
      } else if (msg['method'] === 'notifications/initialized') {
        res.writeHead(202).end();
      } else if (msg['method'] === 'tools/list') {
        json({ jsonrpc: '2.0', id: msg['id'], result: TOOLS });
      } else if (msg['method'] === 'tools/call') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          sse({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } }),
        );
        res.write(sse(ELICIT));
        openCall = { id: msg['id'], res };
      } else if (msg['id'] === 'srv-1') {
        replyHeaders = req.headers;
        res.writeHead(202).end();
        const text = JSON.stringify(msg['result']);
        openCall?.res.end(
          sse({ jsonrpc: '2.0', id: openCall.id, result: { content: [{ type: 'text', text }] } }),
        );
      }
    });

    const handler = vi.fn(async () => {
      await sleep(USER_MS);
      return { action: 'accept' as const, content: { name: 'Ada' } };
    });
    const client = new MCPClient({
      protocolMode: 'legacy',
      name: 'http-elicit',
      transport: 'streamable-http',
      url: `${url}/mcp`,
      requestTimeoutMs: TIMEOUT_MS,
      elicitation: handler,
    });
    cleanups.push(() => client.close());
    await client.connect();

    const result = await client.callTool('ask', {});

    expect(declared).toEqual({ elicitation: { form: {}, url: {} } });
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.content)).toContain(
      JSON.stringify(JSON.stringify({ action: 'accept', content: { name: 'Ada' } })).slice(1, -1),
    );
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Name?',
        fields: [expect.objectContaining({ name: 'name' })],
      }),
    );
    // The reply rides the session like any other client message.
    expect(replyHeaders?.['mcp-session-id']).toBe('sess-7');
  });
});

describe('elicitation over SSE', () => {
  it('answers a request pushed on the event stream by POSTing to the endpoint', {
    timeout: 20_000,
  }, async () => {
    let stream: ServerResponse | undefined;
    let declared: unknown;
    let callId: unknown;
    const url = await listen(async (req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: endpoint\ndata: /messages\n\n');
        stream = res;
        return;
      }
      const msg = await readJson(req);
      res.writeHead(202).end();
      const push = (m: unknown) => stream?.write(sse(m));
      if (msg['method'] === 'initialize') {
        declared = (msg['params'] as { capabilities: unknown }).capabilities;
        push({ jsonrpc: '2.0', id: msg['id'], result: INIT_RESULT });
      } else if (msg['method'] === 'tools/list') {
        push({ jsonrpc: '2.0', id: msg['id'], result: TOOLS });
      } else if (msg['method'] === 'tools/call') {
        callId = msg['id'];
        push(ELICIT);
      } else if (msg['id'] === 'srv-1') {
        const text = JSON.stringify(msg['result']);
        push({ jsonrpc: '2.0', id: callId, result: { content: [{ type: 'text', text }] } });
      }
    });

    const client = new MCPClient({
      protocolMode: 'legacy',
      name: 'sse-elicit',
      transport: 'sse',
      url: `${url}/sse`,
      requestTimeoutMs: TIMEOUT_MS,
      elicitation: async () => {
        await sleep(USER_MS);
        return { action: 'decline' };
      },
    });
    cleanups.push(() => client.close());
    await client.connect();

    const result = await client.callTool('ask', {});

    expect(declared).toEqual({ elicitation: { form: {}, url: {} } });
    expect(JSON.stringify(result.content)).toContain('decline');
  });
});

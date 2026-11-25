import { expect, it, vi } from 'vitest';
import { ACPSession } from '../src/client/acp-session.js';
import type { AcpFormElicitationHandler } from '../src/client/acp-session-types.js';
import type { ACPMessage } from '../src/types/acp-messages.js';
import { FakeClientTransport } from './helpers/fake-client-transport.js';

const schema = { type: 'object', properties: { strategy: { type: 'string' } } };
const params = {
  sessionId: 'own',
  mode: 'form',
  message: 'Choose an approach',
  requestedSchema: schema,
};

async function connectFixture(elicitForm: AcpFormElicitationHandler) {
  const transport = new FakeClientTransport();
  const clientMessages: ACPMessage[] = [];
  transport.send.mockImplementation(async (rpc) => {
    clientMessages.push(rpc);
    if (rpc.method === 'initialize') {
      transport.emit({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: 1 } });
    } else if (rpc.method === 'session/new') {
      transport.emit({ jsonrpc: '2.0', id: rpc.id, result: { sessionId: 'own' } });
    }
  });
  const session = await ACPSession.connect(transport, {
    command: 'fixture',
    projectRoot: '/p',
    timeoutMs: 500,
    elicitForm,
  });
  return { transport, session, clientMessages };
}

it('advertises form elicitation and returns the user answer to the requesting session', async () => {
  const elicitForm = vi.fn(async () => ({
    action: 'accept' as const,
    content: { strategy: 'small' },
  }));
  const { transport, session, clientMessages } = await connectFixture(elicitForm);
  try {
    expect(clientMessages[0]?.params).toMatchObject({
      clientCapabilities: { elicitation: { form: {} } },
    });
    await session.openSession();
    transport.emit({
      jsonrpc: '2.0',
      id: 45,
      method: 'elicitation/create',
      params,
    });
    await vi.waitFor(() => {
      expect(clientMessages).toContainEqual({
        jsonrpc: '2.0',
        id: 45,
        result: { action: 'accept', content: { strategy: 'small' } },
      });
    });
    expect(elicitForm).toHaveBeenCalledWith(
      { message: 'Choose an approach', requestedSchema: schema },
      expect.any(AbortSignal),
    );
  } finally {
    await session.close();
  }
});

it.each([{ sessionId: 'other' }, { requestId: 123 }, { mode: 'url' }])(
  'rejects an elicitation outside the supported scope or mode (%j)',
  async (override) => {
    const elicitForm = vi.fn(async () => ({ action: 'cancel' as const }));
    const { transport, session, clientMessages } = await connectFixture(elicitForm);
    try {
      await session.openSession();
      transport.emit({
        jsonrpc: '2.0',
        id: 46,
        method: 'elicitation/create',
        params: { ...params, ...override },
      });
      await vi.waitFor(() => {
        expect(clientMessages).toContainEqual(
          expect.objectContaining({ id: 46, error: expect.objectContaining({ code: -32602 }) }),
        );
      });
      expect(elicitForm).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  },
);

it('aborts the form when the agent cancels the corresponding request', async () => {
  const elicitForm = vi.fn<AcpFormElicitationHandler>(
    (_form, signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ action: 'cancel' }), { once: true });
      }),
  );
  const { transport, session, clientMessages } = await connectFixture(elicitForm);
  try {
    await session.openSession();
    transport.emit({ jsonrpc: '2.0', id: 47, method: 'elicitation/create', params });
    await vi.waitFor(() => expect(elicitForm).toHaveBeenCalledTimes(1));
    transport.emit({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 48 } });
    expect(elicitForm.mock.calls[0]?.[1].aborted).toBe(false);
    transport.emit({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 47 } });
    await vi.waitFor(() => {
      expect(clientMessages).toContainEqual({
        jsonrpc: '2.0',
        id: 47,
        result: { action: 'cancel' },
      });
    });
    expect(elicitForm.mock.calls[0]?.[1].aborted).toBe(true);
  } finally {
    await session.close();
  }
});

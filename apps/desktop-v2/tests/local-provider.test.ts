import { expect, it } from 'vitest';
// The test fixture speaks to the actual native engine; keep its wire assumptions explicit.
import { fixtureKey, fixtureModel, startLocalProvider } from './local-provider.mjs';

it('observes real tool answers even when the engine appends a user-role context note', async () => {
  const provider = await startLocalProvider();
  try {
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fixtureKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: fixtureModel,
        stream: false,
        messages: [
          { role: 'user', content: '[native-clarify-submit] Ask for native decisions.' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'desktop-clarify-submit',
                type: 'function',
                function: { name: 'clarify', arguments: '{}' },
              },
            ],
          },
          {
            role: 'tool',
            tool_call_id: 'desktop-clarify-submit',
            content: 'answered: React, Terminal, Chat',
          },
          { role: 'user', content: 'Continue with the tool results above.' },
        ],
      }),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(200);
    expect(provider.toolResults).toEqual([
      { challenge: 'submit', content: 'answered: React, Terminal, Chat' },
    ]);
  } finally {
    await provider.close();
  }
});

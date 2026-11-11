import { describe, expect, it } from 'vitest';
import { WfHttpError, wrongForgeCall } from '../src/wrongforge-client.js';

const endpoint = { url: 'http://wrongforge.invalid', apiKey: 'test-only' };

function client(body: string, status: number) {
  return wrongForgeCall(endpoint, async () => new Response(body, { status }));
}

describe('WrongForge HTTP error responses', () => {
  it('preserves structured server error details', async () => {
    const request = client('{"error":{"code":"busy","message":"queue full"}}', 503)(
      'GET',
      '/v1/tasks/t1',
    );
    await expect(request).rejects.toBeInstanceOf(WfHttpError);
    await expect(request).rejects.toMatchObject({
      status: 503,
      code: 'busy',
      message: 'queue full',
    });
  });

  it.each(['null', '{}', '[]', 'false', '42', '"busy"', '', 'not JSON'])(
    'preserves the HTTP status for an unstructured error body %j',
    async (body) => {
      const request = client(body, 503)('GET', '/v1/tasks/t1');
      await expect(request).rejects.toBeInstanceOf(WfHttpError);
      await expect(request).rejects.toMatchObject({
        status: 503,
        code: 'http_503',
        message: body,
      });
    },
  );

  it('still returns successful JSON null responses', async () => {
    await expect(client('null', 200)('GET', '/v1/info')).resolves.toBeNull();
  });

  it('still decodes successful task responses', async () => {
    await expect(client('{"task":{"id":"t1"}}', 200)('GET', '/v1/tasks/t1')).resolves.toEqual({
      task: { id: 't1' },
    });
  });
});

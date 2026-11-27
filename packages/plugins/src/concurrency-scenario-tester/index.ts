import { isDeepStrictEqual } from 'node:util';
import { localRequest, localUrl } from '../workflow-runtime/http.js';
import {
  described,
  integer,
  object,
  str,
  stringField,
  workflowPlugin,
} from '../workflow-runtime/index.js';
export default workflowPlugin({
  name: 'concurrency-scenario-tester',
  description:
    'Issues synchronized loopback HTTP requests and verifies an explicit allowed-success count plus an optional final-state JSON invariant',
  tools: [
    {
      name: 'concurrency_test',
      mutating: true,
      capabilities: ['net.outbound'],
      description:
        'Send count identical requests concurrently. expectedSuccesses is required; optional invariant {url,expectedJson} checks final state. Use only a disposable local test service.',
      properties: {
        url: described(
          stringField,
          'Loopback URL (127.0.0.1 or [::1]) to send the concurrent requests to.',
        ),
        method: described(stringField, 'HTTP method (default POST).'),
        body: { description: 'JSON body sent with every request (optional).' },
        count: {
          type: 'integer',
          minimum: 2,
          maximum: 32,
          description: 'Number of concurrent requests.',
        },
        expectedSuccesses: {
          type: 'integer',
          minimum: 0,
          maximum: 32,
          description: 'How many requests must get a 2xx status; any other count fails.',
        },
        invariant: {
          type: 'object',
          description:
            '{url, expectedJson}: a same-origin GET after the burst whose listed top-level JSON keys must match.',
        },
      },
      required: ['url', 'count', 'expectedSuccesses'],
      async run(input, context) {
        const url = localUrl(input.url);
        const count = integer(input.count, 2, 2, 32);
        const expected = integer(input.expectedSuccesses, 1, 0, count);
        const results = await Promise.all(
          Array.from({ length: count }, async (_, index) => {
            try {
              const response = await localRequest(
                url,
                {
                  method: str(input.method ?? 'POST'),
                  headers: { 'content-type': 'application/json' },
                  ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
                },
                context.signal,
              );
              return {
                index,
                status: response.status,
                durationMs: response.durationMs,
                error: null,
              };
            } catch (error) {
              context.signal.throwIfAborted();
              return { index, status: null, durationMs: null, error: String(error) };
            }
          }),
        );
        const successes = results.filter(
          (result) => result.status !== null && result.status >= 200 && result.status < 300,
        ).length;
        let invariant: boolean | null = null;
        if (input.invariant !== undefined) {
          const spec = object(input.invariant);
          const target = localUrl(spec.url);
          if (target.origin !== url.origin) throw new Error('Invariant must use the same origin');
          const response = await localRequest(target, {}, context.signal);
          try {
            const actual = object(JSON.parse(response.body));
            invariant =
              response.status >= 200 &&
              response.status < 300 &&
              Object.entries(object(spec.expectedJson)).every(([key, value]) =>
                isDeepStrictEqual(actual[key], value),
              );
          } catch {
            invariant = false;
          }
        }
        return {
          passed:
            successes === expected &&
            invariant !== false &&
            results.every((result) => result.error === null),
          successes,
          expectedSuccesses: expected,
          invariant,
          results,
        };
      },
    },
  ],
});

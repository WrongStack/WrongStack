import { isDeepStrictEqual } from 'node:util';
import { localRequest, localUrl } from '../workflow-runtime/http.js';
import {
  described,
  integer,
  object,
  rows,
  str,
  stringField,
  workflowPlugin,
} from '../workflow-runtime/index.js';
export default workflowPlugin({
  name: 'api-consumer-replay',
  description:
    'Replays explicit consumer HTTP fixtures against a loopback API and compares status and selected JSON fields without following redirects',
  tools: [
    {
      name: 'api_consumer_replay',
      mutating: true,
      capabilities: ['net.outbound'],
      description:
        'Replay cases [{path,method?,body?,expectedStatus,expectedJson?}] against baseUrl on 127.0.0.1/[::1]. Mutating methods require the normal tool approval.',
      properties: {
        baseUrl: described(
          stringField,
          'Loopback base URL (127.0.0.1 or [::1]) that the case paths resolve against.',
        ),
        cases: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: { type: 'object' },
          description:
            'Up to 100 cases {path, method?, body?, expectedStatus?, expectedJson?}. method defaults to GET, expectedStatus to 200; expectedJson compares only the listed top-level keys.',
        },
      },
      required: ['baseUrl', 'cases'],
      async run(input, context) {
        const base = localUrl(input.baseUrl);
        const cases = rows(input.cases);
        if (!cases.length || cases.length > 100) throw new Error('Provide 1..100 replay cases');
        const results = [];
        for (const item of cases) {
          const url = localUrl(new URL(str(item.path), base).href);
          if (url.origin !== base.origin) throw new Error('Replay path changes the target origin');
          const method = str(item.method ?? 'GET').toUpperCase();
          if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method))
            throw new Error('Unsupported HTTP method');
          const expectedStatus = integer(item.expectedStatus, 200, 100, 599);
          const response = await localRequest(
            url,
            {
              method,
              ...(item.body === undefined
                ? {}
                : {
                    body: JSON.stringify(item.body),
                    headers: { 'content-type': 'application/json' },
                  }),
            },
            context.signal,
          );
          const mismatches = [];
          if (response.status !== expectedStatus)
            mismatches.push({ field: 'status', expected: expectedStatus, actual: response.status });
          if (item.expectedJson !== undefined) {
            let actual: Record<string, unknown>;
            try {
              actual = object(JSON.parse(response.body));
            } catch {
              actual = {};
              mismatches.push({ field: 'body', expected: 'JSON object', actual: 'invalid' });
            }
            for (const [key, value] of Object.entries(object(item.expectedJson)))
              if (!isDeepStrictEqual(actual[key], value))
                mismatches.push({ field: key, expected: value, actual: actual[key] });
          }
          results.push({
            path: item.path,
            method,
            passed: !mismatches.length,
            status: response.status,
            mismatches,
            durationMs: response.durationMs,
          });
        }
        return { passed: results.every((result) => result.passed), results };
      },
    },
  ],
});

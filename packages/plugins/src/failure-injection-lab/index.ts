import { createServer } from 'node:http';
import {
  commandField,
  described,
  integer,
  object,
  run,
  str,
  strings,
  workflowPlugin,
} from '../workflow-runtime/index.js';
export default workflowPlugin({
  name: 'failure-injection-lab',
  description:
    'Runs a caller-supplied recovery test against a temporary loopback endpoint injecting HTTP 429, malformed JSON, disconnects or delayed responses',
  tools: [
    {
      name: 'failure_inject',
      mutating: true,
      description:
        'Run command with {faultUrl} in an argv element replaced by the temporary endpoint. scenario: rate-limit, malformed-json, disconnect, delay. The test must assert recovery itself.',
      properties: {
        command: described(
          commandField,
          'Recovery test command. One args element must contain {faultUrl}, which is replaced with the temporary endpoint URL.',
        ),
        scenario: {
          type: 'string',
          enum: ['rate-limit', 'malformed-json', 'disconnect', 'delay'],
          description:
            'Fault the endpoint serves: rate-limit (HTTP 429), malformed-json, disconnect (socket closed) or delay.',
        },
        delayMs: {
          type: 'integer',
          minimum: 1,
          maximum: 10000,
          description: 'Response delay for the delay scenario, in milliseconds (default 500).',
        },
      },
      required: ['command', 'scenario'],
      async run(input, context) {
        const scenario = str(input.scenario);
        if (!['rate-limit', 'malformed-json', 'disconnect', 'delay'].includes(scenario))
          throw new Error('Unknown fault scenario');
        const delayMs = integer(input.delayMs, 500, 1, 10000);
        const command = object(input.command);
        const args = strings(command.args);
        if (!args.some((arg) => arg.includes('{faultUrl}')))
          throw new Error('Command args must contain {faultUrl}');
        let requests = 0;
        const timers = new Set<ReturnType<typeof setTimeout>>();
        const server = createServer((_request, response) => {
          requests++;
          if (scenario === 'disconnect') {
            response.destroy();
            return;
          }
          if (scenario === 'rate-limit') {
            response.writeHead(429, { 'retry-after': '1' });
            response.end('rate limited');
            return;
          }
          if (scenario === 'malformed-json') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end('{broken');
            return;
          }
          const timer = setTimeout(() => {
            timers.delete(timer);
            response.end('delayed');
          }, delayMs);
          timers.add(timer);
        });
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', resolve);
        });
        try {
          const address = server.address();
          if (!address || typeof address === 'string')
            throw new Error('Fault endpoint unavailable');
          const url = `http://127.0.0.1:${address.port}`;
          const execution = await run(
            { ...command, args: args.map((arg) => arg.replaceAll('{faultUrl}', url)) },
            context,
          );
          return {
            scenario,
            requests,
            exercised: requests > 0,
            passed: requests > 0 && execution.passed,
            execution,
            limitation:
              'A passing command proves only the recovery assertions implemented by the supplied test.',
          };
        } finally {
          for (const timer of timers) clearTimeout(timer);
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
    },
  ],
});

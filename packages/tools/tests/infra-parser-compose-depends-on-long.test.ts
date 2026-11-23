import { expect, it } from 'vitest';
import { parseInfraArtifact } from '../src/codebase-index/infra-parser.js';

// F1349: every `key:` under `depends_on:` became a dependency edge except the
// literal `condition`, so the Compose long syntax's `restart:` / `required:`
// attributes were indexed as services. `docker compose config` lists only the
// dependency names.
it('indexes only dependency names from the long depends_on syntax (F1349)', () => {
  const head = [
    'services:',
    '  db:',
    '    image: postgres:16',
    '  cache:',
    '    image: redis:7',
    '  api:',
    '    image: myapp/api',
    '    depends_on:',
  ];
  const deps = (lines: string[]) =>
    parseInfraArtifact({ file: 'docker-compose.yml', content: [...head, ...lines].join('\n') })
      .refs.filter((r) => r.callType === 'call')
      .map((r) => r.toName)
      .sort();
  expect(
    deps([
      '      db:',
      '        condition: service_healthy',
      '        restart: true',
      '      cache:',
      '        condition: service_started',
      '        required: false',
      '    ports:',
      '      - "8080:8080"',
    ]),
  ).toEqual(['cache', 'db']);
  expect(deps(['      - db', '      - cache'])).toEqual(['cache', 'db']);
});

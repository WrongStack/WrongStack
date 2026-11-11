import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as api from './src/index.js';

// HARD_SENTINEL_config-refactor

const {
  createConfig,
  loadConfig,
  serverSettings,
  workerSettings,
  SERVER_DEFAULTS,
  WORKER_DEFAULTS,
} = api;
const src = (file) => readFileSync(new URL(`./src/${file}`, import.meta.url), 'utf8');

assert.equal(typeof createConfig, 'function', 'src/index.js must export createConfig');
assert.equal(typeof loadConfig, 'function', 'loadConfig must remain exported');

// ---- Behavior of the call sites must not change ----
const serverEnv = {
  APP_PORT: '0x1F',
  APP_TLS: ' YES ',
  APP_DB__HOST: 'db.internal',
  APP_DB__POOL__MAX: ' 25 ',
  APP_CORS: 'https://a.com, ,https://b.com,',
  APP_DB: 'ignored-object-default',
  APP_NOPE: 'ignored-unknown',
  APP_DB__: 'ignored-empty-segment',
  APP_HOST__X: 'ignored-through-string',
  app_host: 'ignored-wrong-case',
  OTHER_PORT: '1',
  APP_LABEL: undefined,
};
assert.deepEqual(serverSettings(serverEnv), {
  listen: 'https://127.0.0.1:31',
  dbUrl: 'postgres://db.internal:5432',
  poolMax: 25,
  cors: ['https://a.com', 'https://b.com'],
});
assert.deepEqual(serverSettings({}), {
  listen: 'http://127.0.0.1:8080',
  dbUrl: 'postgres://localhost:5432',
  poolMax: 10,
  cors: ['http://localhost:3000'],
});
assert.deepEqual(
  serverSettings({ APP_TLS: '', APP_PORT: '1e3', APP_CORS: '' }).listen,
  'http://127.0.0.1:1000',
);
assert.deepEqual(serverSettings({ APP_CORS: '' }).cors, []);
{
  const s = serverSettings({});
  s.cors.push('https://extra.example');
  assert.deepEqual(
    serverSettings({}).cors,
    ['http://localhost:3000'],
    'callers may mutate the returned cors array',
  );
}
assert.throws(
  () => serverSettings({ APP_PORT: 'abc' }),
  (e) => e instanceof TypeError && /APP_PORT/.test(e.message),
);
assert.throws(() => serverSettings({ APP_PORT: '   ' }), TypeError);
assert.throws(
  () => serverSettings({ APP_TLS: 'maybe' }),
  (e) => e instanceof TypeError && /APP_TLS/.test(e.message),
);

assert.deepEqual(workerSettings({}), {
  queue: 'jobs',
  concurrency: 2,
  attempts: 3,
  backoffMs: 250,
  label: 'jobs-worker',
});
assert.deepEqual(
  workerSettings({
    WORKER_QUEUE: 'emails',
    WORKER_RETRY__ATTEMPTS: '5',
    WORKER_RETRY__BACKOFFMS: '999',
    APP_CONCURRENCY: '9',
  }),
  { queue: 'emails', concurrency: 2, attempts: 5, backoffMs: 250, label: 'emails-worker' },
);
assert.equal(workerSettings({ WORKER_LABEL: '' }).label, '', 'an empty-string label is kept');
assert.equal(workerSettings({ WORKER_LABEL: 'blue' }).label, 'blue');

// ---- Call sites are migrated ----
for (const file of ['server.js', 'worker.js']) {
  assert.ok(!src(file).includes('loadConfig'), `${file} must not use loadConfig any more`);
  assert.ok(src(file).includes('createConfig'), `${file} must use createConfig`);
  assert.match(src(file), /\bget\(\s*['"`]/, `${file} must read values through get()`);
}
assert.equal(
  src('config.js').split('expected a boolean').length - 1,
  1,
  'keep a single coercion implementation',
);

// ---- loadConfig compatibility ----
{
  const cfg = loadConfig({ APP_DB__PORT: '6000' }, SERVER_DEFAULTS);
  assert.equal(cfg.db.port, 6000);
  assert.equal(Object.isFrozen(cfg), false);
  assert.equal(Object.isFrozen(cfg.db), false);
  cfg.db.port = 1;
  cfg.cors.push('x');
  assert.equal(SERVER_DEFAULTS.db.port, 5432);
  assert.deepEqual(SERVER_DEFAULTS.cors, ['http://localhost:3000']);
  assert.equal(loadConfig({ X_QUEUE: 'q' }, WORKER_DEFAULTS, 'X_').queue, 'q');
}

// ---- createConfig ----
{
  const { values, get } = createConfig({
    env: { APP_DB__POOL__MAX: '3', APP_CORS: 'a,b' },
    defaults: SERVER_DEFAULTS,
  });
  assert.deepEqual(values, {
    host: '127.0.0.1',
    port: 8080,
    tls: false,
    db: { host: 'localhost', port: 5432, pool: { max: 3 } },
    cors: ['a', 'b'],
  });
  assert.ok(Object.isFrozen(values));
  assert.ok(Object.isFrozen(values.db));
  assert.ok(Object.isFrozen(values.db.pool));
  assert.ok(Object.isFrozen(values.cors));
  assert.equal(Object.isFrozen(SERVER_DEFAULTS), false, 'defaults must not be frozen');
  assert.equal(Object.isFrozen(SERVER_DEFAULTS.db.pool), false);
  assert.equal(Object.isFrozen(SERVER_DEFAULTS.cors), false);

  assert.equal(get('db.pool.max'), 3);
  assert.equal(get('db.pool.max', 99), 3);
  assert.equal(get('db.nope', 7), 7);
  assert.equal(get('db.pool.max.deeper', 'fb'), 'fb');
  assert.equal(get('host.length', 'fb'), 'fb', 'cannot walk into a string');
  assert.equal(get('toString', 1), 1, 'inherited properties are not config keys');
  assert.equal(get('missing'), undefined);
  assert.deepEqual(get('cors'), ['a', 'b']);
}
{
  const { get } = createConfig({ defaults: WORKER_DEFAULTS, prefix: 'WORKER_' });
  assert.equal(
    get('label', 'fallback'),
    null,
    'an existing null value is returned, not the fallback',
  );
  assert.equal(get('retry.backoffMs'), 250);
  const custom = createConfig({ env: { W_QUEUE: 'z' }, defaults: WORKER_DEFAULTS, prefix: 'W_' });
  assert.equal(custom.get('queue'), 'z');
  const defaultPrefix = createConfig({ env: { APP_QUEUE: 'p' }, defaults: WORKER_DEFAULTS });
  assert.equal(defaultPrefix.get('queue'), 'p');
}
assert.throws(
  () => createConfig({ env: { APP_PORT: 'x1' }, defaults: SERVER_DEFAULTS }),
  TypeError,
);

console.log('config-refactor: all assertions passed');

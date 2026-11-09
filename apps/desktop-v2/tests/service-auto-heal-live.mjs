// Real test-owned catalog authentication fault; real collector, watchdog and restart.
// Refusal uses an explicit denying host boundary; no native default policy denial is implied.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const directory = resolve(
    import.meta.dir,
    '../../../.temp_files/desktop-parity-acceptance/service-auto-heal',
  ),
  fixture = join(directory, 'cases', Date.now().toString()),
  project = join(fixture, 'project');
await mkdir(project, { recursive: true });
process.env.WRONGSTACK_HOME = join(fixture, 'home');
process.env.WRONGSTACK_AUTO_HEAL_SERVICES = '1';
const { resolveWstackPaths } = await import('@wrongstack/core/utils'),
  { SessionCatalogProjectClient, sessionCatalogProjectServerMetadataPath } = await import(
    '@wrongstack/core/session-catalog'
  ),
  { createCompatibilityTrustBoundary } = await import('@wrongstack/core/security'),
  { createAutoHealer } = await import(
    '../../../packages/webui-server/src/server/connections/auto-healer.ts'
  ),
  { emptyEngineState, reduceEngine } = await import('../src/engine-state.ts'),
  { healingBusy } = await import('../src/service-healing.ts');
let nativeState = emptyEngineState;
const { sessionCatalogHealth } = await import(
    '../../../packages/webui-server/src/server/connections/collector.ts'
  ),
  paths = resolveWstackPaths({ projectRoot: project }),
  metadataPath = sessionCatalogProjectServerMetadataPath(paths.projectDir),
  owner = new SessionCatalogProjectClient({ projectDir: paths.projectDir, projectRoot: project }),
  events = [],
  nativeObservations = [],
  results = [];
let passed = false;
let cleanupComplete = false;
let original = '',
  initialPid = 0;
const health = () => sessionCatalogHealth(project),
  wait = async (fn, message) => {
    const start = Date.now();
    while (Date.now() - start < 20000) {
      if (await fn()) return;
      await Bun.sleep(25);
    }
    throw Error(message);
  };
try {
  const initial = await owner.call('ping', {}, { timeoutMs: 10000 });
  initialPid = initial.pid;
  assert.notEqual(initial.pid, process.pid);
  assert.equal((await health()).status, 'healthy', 'valid daemon control');
  original = await readFile(metadataPath, 'utf8');
  const bad = { ...JSON.parse(original), authToken: 'invalid-fixture-token' };
  await writeFile(metadataPath, JSON.stringify(bad));
  assert.equal(
    (await health()).status,
    'error',
    'real metadata authentication fault reaches error',
  );
  for (const scenario of ['refused', 'failed', 'restarted']) {
    await writeFile(metadataPath, JSON.stringify(bad));
    const collected = [],
      boundary =
        scenario === 'refused'
          ? {
              async evaluate() {
                return {
                  kind: 'deny',
                  reason: 'Fixture policy denies automatic service restart',
                  policyId: 'fixture-deny-restart',
                };
              },
            }
          : createCompatibilityTrustBoundary(),
      healer = createAutoHealer({
        projectRoot: () => project,
        indexDir: () => undefined,
        trustBoundary: boundary,
        intervalMs: 60000,
        cooldownMs: 0,
        maxAttempts: 1,
        onStatus: (event) => {
          if (event.serviceId !== 'session-catalog') return;
          collected.push(event);
          events.push(event);
          nativeState = reduceEngine(nativeState, {
            type: 'connections.auto_heal_status',
            payload: { ...event },
          });
          // Assertions run outside onStatus: production deliberately isolates a
          // throwing subscriber, so assertions inside it would be swallowed.
          nativeObservations.push({
            phase: event.phase,
            nativePhase: nativeState.serviceHealing['session-catalog']?.phase,
            busy: healingBusy(nativeState.serviceHealing['session-catalog'], Date.now()),
          });
          if (scenario === 'restarted' && event.phase === 'restarting')
            writeFileSync(metadataPath, original);
        },
      });
    try {
      healer.start();
      await wait(
        () => collected.some((e) => e.phase === scenario),
        'No ' + scenario + ' status from real watchdog',
      );
      if (scenario === 'refused')
        assert.deepEqual(
          collected.map((e) => e.phase),
          ['refused'],
        );
      else assert.deepEqual(collected.map((e) => e.phase).slice(0, 2), ['restarting', scenario]);
      results.push({
        scenario,
        phases: collected.map((e) => e.phase),
        status: (await health()).status,
      });
    } finally {
      await healer.dispose();
    }
  }
  assert.equal((await health()).status, 'healthy', 'restored token permits a healthy replacement');
  const replacement = new SessionCatalogProjectClient({
    projectDir: paths.projectDir,
    projectRoot: project,
  });
  try {
    const current = await replacement.callExisting('ping', {});
    assert.notEqual(current.pid, initial.pid, 'restart actually replaced daemon PID');
  } finally {
    await replacement.close();
  }
  assert.equal(nativeObservations.length, events.length);
  for (const observation of nativeObservations) {
    assert.equal(
      observation.nativePhase,
      observation.phase,
      'native reducer consumes real watchdog events',
    );
    assert.equal(
      observation.busy,
      observation.phase === 'restarting',
      'native control gating follows actual phases',
    );
  }
  passed = true;
} finally {
  if (original) {
    const current = await readFile(metadataPath, 'utf8')
      .then(JSON.parse)
      .catch(() => null);
    if (!current || current.pid === initialPid) await writeFile(metadataPath, original);
  }
  const control = new SessionCatalogProjectClient({
    projectDir: paths.projectDir,
    projectRoot: project,
  });
  try {
    const stopped = await control.shutdown('auto-heal-proof-complete');
    if (stopped.pid) {
      await wait(() => {
        try {
          process.kill(stopped.pid, 0);
          return false;
        } catch {
          return true;
        }
      }, 'Test-owned daemon did not exit');
    }
    cleanupComplete = true;
  } finally {
    await control.close();
    await owner.close();
  }
  await writeFile(
    join(directory, 'result.json'),
    JSON.stringify(
      {
        result: passed && cleanupComplete ? 'PASS' : 'FAIL',
        fixture,
        results,
        events,
        nativeObservations,
        cleanupComplete,
      },
      null,
      2,
    ),
  );
}
console.log(
  JSON.stringify({
    result: passed && cleanupComplete ? 'PASS' : 'FAIL',
    fixture,
    results,
    cleanupComplete,
  }),
);

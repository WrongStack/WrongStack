import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'wrongstack-live-heal-'));
assert(
  resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
    basename(directory).startsWith('wrongstack-live-heal-'),
);
const project = join(directory, 'project');
await mkdir(project);
process.env.WRONGSTACK_HOME = join(directory, 'home');
process.env.WRONGSTACK_KANBAN_SERVER = '1';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const artifacts = join(repo, '.temp_files', 'desktop-parity-acceptance', 'service-crash');
await mkdir(artifacts, { recursive: true });
const { getKanbanServerConnection, closeKanbanServerConnections } = await import(
  '@wrongstack/kanban'
);
const { kanbanHealth } = await import(
  '../../../packages/webui-server/src/server/connections/collector.ts'
);
const { executeServiceAction } = await import(
  '../../../packages/webui-server/src/server/connections/service-actions.ts'
);
let record;
let failure;
let removed = false;
async function removeFixture() {
  assert(
    resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
      basename(directory).startsWith('wrongstack-live-heal-'),
  );
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      await rm(directory, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code) || attempt === 79) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return false;
}
try {
  const initial = await getKanbanServerConnection(project);
  assert(initial, 'Project Kanban daemon is available');
  const first = await initial.request('ping', {}, { timeoutMs: 15000 });
  const pid = first.pid;
  assert(
    Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid,
    'Daemon reports its own process',
  );
  const control = await kanbanHealth(project);
  assert.equal(control.status, 'healthy');
  // Resolve and kill only the daemon whose command line names this test-owned project.
  // Its full command line never leaves PowerShell.
  const code = [
    '$ErrorActionPreference="Stop"',
    '$healingPid=[int]$env:WRONGSTACK_HEAL_PID',
    '$process=Get-CimInstance Win32_Process -Filter ("ProcessId = "+$healingPid)',
    'if(-not $process -or -not ([string]$process.CommandLine).Contains($env:WRONGSTACK_HEAL_PROJECT)){throw "Daemon ownership check failed"}',
    'Stop-Process -Id $healingPid -Force',
    '"Killed test-owned daemon"',
  ].join('; ');
  const stopped = spawnSync(
    join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', code],
    {
      windowsHide: true,
      encoding: 'utf8',
      env: { ...process.env, WRONGSTACK_HEAL_PID: String(pid), WRONGSTACK_HEAL_PROJECT: project },
    },
  );
  assert.equal(stopped.status, 0, stopped.stderr);
  await closeKanbanServerConnections();
  const offline = await kanbanHealth(project);
  assert.equal(offline.status, 'offline', 'A crashed on-demand daemon is reported offline');
  const recovered = await getKanbanServerConnection(project);
  assert(recovered);
  const next = await recovered.request('ping', {}, { timeoutMs: 15000 });
  assert.notEqual(next.pid, pid, 'Next use starts a new project daemon');
  const healthy = await kanbanHealth(project);
  assert.equal(healthy.status, 'healthy');
  record = {
    result: 'PASS',
    scenario: 'real project Kanban crash and on-demand recovery',
    previousPid: pid,
    recoveredPid: next.pid,
    control: control.status,
    afterCrash: offline.status,
    recovered: healthy.status,
    automaticHealerBoundary: 'offline is intentionally not an auto-heal trigger',
    verifiedAt: new Date().toISOString(),
  };
} catch (error) {
  failure = error;
} finally {
  await executeServiceAction('kanban', 'shutdown', project).catch(() => {});
  await closeKanbanServerConnections();
  removed = await removeFixture().catch((error) => {
    failure ??= error;
    return false;
  });
  await writeFile(
    join(artifacts, 'result.json'),
    JSON.stringify(
      {
        ...record,
        result: failure ? 'FAIL' : record && removed ? 'PASS' : 'INCOMPLETE',
        ...(failure ? { error: String(failure) } : {}),
        cleanupComplete: removed,
      },
      null,
      2,
    ) + '\n',
  );
}
if (failure) throw failure;
console.log(
  'PASS: real test-owned Kanban daemon killed; health reports offline; next use starts a different healthy process',
);

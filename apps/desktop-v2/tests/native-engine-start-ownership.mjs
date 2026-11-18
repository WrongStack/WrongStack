import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run with Bun and a built Windows session host. An optional argument selects the executable.
assert.equal(process.platform, 'win32');
const executable = process.argv[2]
  ? resolve(process.argv[2])
  : fileURLToPath(
      new URL('../src-tauri/target/debug/wrongstack-desktop-native.exe', import.meta.url),
    );
const temp = resolve(tmpdir());
const fixture = await mkdtemp(join(temp, 'wrongstack-engine-start-'));
const data = join(fixture, 'desktop');
const project = join(fixture, 'project');
const entry = join(fixture, 'engine.ts');
await mkdir(data);
await mkdir(project);
await writeFile(
  entry,
  `setInterval(() => {
    try { process.kill(Number(process.env.WRONGSTACK_DESKTOP_HOST_PID), 0); }
    catch { process.exit(0); }
  }, 100);`,
);
const host = spawn(executable, ['--session-host'], {
  env: {
    ...process.env,
    WRONGSTACK_DESKTOP_DATA: data,
    WRONGSTACK_DESKTOP_BUN: process.execPath,
    WRONGSTACK_DESKTOP_ENTRY: entry,
  },
  stdio: 'ignore',
  windowsHide: true,
});
const exited = once(host, 'exit');
const engineName = basename(process.execPath);
const children = () =>
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${host.pid}' | Where-Object Name -eq $env:QA_ENGINE_IMAGE).ProcessId`,
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      env: { ...process.env, QA_ENGINE_IMAGE: engineName },
    },
  ).trim();

try {
  const endpointFile = join(data, 'host.json');
  const deadline = Date.now() + 10000;
  let endpoint;
  while (!endpoint && Date.now() < deadline) {
    await Bun.sleep(50);
    endpoint = await readFile(endpointFile, 'utf8')
      .then(JSON.parse)
      .catch(() => null);
  }
  assert.equal(endpoint?.pid, host.pid, 'The dedicated host owns the fixture endpoint');
  const rpc = (method, params) =>
    new Promise((resolveReply, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: endpoint.port });
      let pending = '';
      socket.setTimeout(5000, () => socket.destroy(Error('Fixture RPC timed out')));
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.write(`${JSON.stringify({ token: endpoint.token, method, params })}\n`);
      });
      socket.on('data', (chunk) => {
        pending += chunk;
        if (!pending.includes('\n')) return;
        socket.end();
        const reply = JSON.parse(pending);
        if (reply.error) reject(Error(reply.error));
        else resolveReply(reply.result);
      });
    });

  const { id: projectId } = await rpc('project.register', { root: project });
  const logs = join(data, 'transcripts');
  const savedLogs = join(data, 'original-transcripts');
  await rename(logs, savedLogs);
  await writeFile(logs, 'The fixture blocks creation of the engine log files.');
  assert.equal((await rpc('project.open', { projectId })).status, 'error');
  assert.equal(children(), '', 'A failed log setup must not launch an engine');

  await rename(logs, join(data, 'blocked-transcripts'));
  await rename(savedLogs, logs);
  assert.equal((await rpc('project.open', { projectId, retry: true })).status, 'starting');
  assert.match(
    children(),
    /^\d+$/,
    'The same project starts exactly one engine after log recovery',
  );
  console.log('PASS: invalid logs spawn no engine and retry starts one owned child');
} finally {
  host.kill();
  await exited;
  const deadline = Date.now() + 5000;
  while (children() && Date.now() < deadline) await Bun.sleep(100);
  if (dirname(fixture) === temp) {
    await rm(fixture, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
}

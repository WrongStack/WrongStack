import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stagePortable } from '../scripts/portable.ts';
import { fixtureKey, fixtureModel, startLocalProvider } from './local-provider.mjs';

/**
 * Windows acceptance for "wrongstack-engine.exe is in use" on update, through the real release
 * application and the host protocol: a conversation's engine is running while the bundled
 * `wrongstack-engine.exe` beside the application is overwritten, as the installer does.
 *
 * Everything runs in one isolated folder under `.temp_files/desktop-v2-native`; only processes
 * whose executable or command line lives there are ever stopped, so an installed WrongStack
 * Desktop on this machine is never touched.
 *
 *   legacy  - WRONGSTACK_DESKTOP_ENGINE pins the engine where it is installed, the behaviour
 *             before the fix: the replacement must FAIL (this proves the check can fail).
 *   staged  - the shipped behaviour: the engine runs from a private copy, the replacement must
 *             succeed, and the next launch removes the copies the exited host left.
 */
const root = fileURLToPath(new URL('../../../', import.meta.url));
const appDir = resolve(root, 'apps/desktop-v2');
const work = resolve(root, '.temp_files/desktop-v2-native', `engine-update-${Date.now()}`);
const portable = stagePortable(appDir);
const sourceEngine = join(portable, 'wrongstack-engine.exe');
const app = join(work, 'app');
const exe = join(app, 'wrongstack-desktop-native.exe');
const installedEngine = join(app, 'wrongstack-engine.exe');
const results = [];
const pass = (message) => {
  results.push({ status: 'PASS', message });
  console.log(`PASS: ${message}`);
};

const powershell = (command) =>
  spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
  }).stdout;
const insideWork = `($_.ExecutablePath -and $_.ExecutablePath.StartsWith('${work}', [StringComparison]::OrdinalIgnoreCase)) -or ($_.CommandLine -and $_.CommandLine.Contains('${work}'))`;
const processes = () =>
  JSON.parse(
    powershell(
      `@(Get-CimInstance Win32_Process | Where-Object { ${insideWork} } | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; name = $_.Name; path = $_.ExecutablePath } }) | ConvertTo-Json -Compress -AsArray`,
    ).trim() || '[]',
  );
const stopEverything = async () => {
  powershell(
    `Get-CimInstance Win32_Process | Where-Object { ${insideWork} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  );
  for (let attempt = 0; attempt < 50 && processes().length > 0; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 200));
};

const call = (endpoint, method, params = {}) =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: endpoint.port });
    let text = '';
    const timer = setTimeout(() => socket.destroy(new Error(`${method} timed out`)), 20000);
    socket.setEncoding('utf8');
    socket.on('connect', () =>
      socket.write(`${JSON.stringify({ token: endpoint.token, method, params })}\n`),
    );
    socket.on('data', (chunk) => (text += chunk));
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      try {
        const reply = JSON.parse(text);
        if (reply.error) reject(new Error(`${method}: ${reply.error}`));
        else resolve(reply.result);
      } catch (error) {
        reject(new Error(`${method}: unreadable reply ${JSON.stringify(text)}: ${error}`));
      }
    });
  });
const until = async (check, what, timeoutMs = 90000) => {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out: ${what}${last ? ` (${last.message})` : ''}`);
};

const provider = await startLocalProvider();
const environment = (name) => {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(key)) delete env[key];
  for (const key of [
    'WRONGSTACK_DESKTOP_BUN',
    'WRONGSTACK_DESKTOP_ENTRY',
    'WRONGSTACK_DESKTOP_ENGINE',
  ])
    delete env[key];
  const dir = join(work, name);
  return {
    ...env,
    WRONGSTACK_HOME: join(dir, 'home'),
    WRONGSTACK_DESKTOP_DATA: join(dir, 'data'),
    WEBVIEW2_USER_DATA_FOLDER: join(dir, 'webview'),
  };
};

async function launch(name, { legacy }) {
  const dir = join(work, name);
  const home = join(dir, 'home');
  await mkdir(join(home, 'profiles/default'), { recursive: true });
  await mkdir(join(dir, 'data'), { recursive: true });
  await mkdir(join(dir, 'project'), { recursive: true });
  await writeFile(join(home, 'config.json'), JSON.stringify({ activeProfile: 'default' }));
  await writeFile(
    join(home, 'profiles/default/config.json'),
    JSON.stringify({
      provider: 'desktop-local',
      model: fixtureModel,
      providers: {
        'desktop-local': {
          type: 'openai-compatible',
          family: 'openai-compatible',
          baseUrl: provider.baseUrl,
          models: [fixtureModel],
          customModels: {
            [fixtureModel]: { name: fixtureModel, capabilities: { streaming: true, tools: true } },
          },
          apiKeys: [{ label: 'default', apiKey: fixtureKey }],
          activeKey: 'default',
        },
      },
    }),
  );
  const env = environment(name);
  if (legacy) env.WRONGSTACK_DESKTOP_ENGINE = installedEngine;
  const child = spawn(exe, [], { cwd: dir, env, stdio: 'ignore', windowsHide: false });
  child.unref();
  const previous = await readFile(join(dir, 'data', 'host.json'), 'utf8').catch(() => null);
  const endpoint = await until(async () => {
    const text = await readFile(join(dir, 'data', 'host.json'), 'utf8').catch(() => null);
    if (!text || text === previous) return null;
    const candidate = JSON.parse(text);
    const pong = await call(candidate, 'ping');
    return pong.protocol === 1 && pong.pid === candidate.pid ? candidate : null;
  }, `${name}: the session host answers`);
  return { dir, endpoint };
}

async function startConversationEngine({ dir, endpoint }) {
  const project = await call(endpoint, 'project.register', { root: join(dir, 'project') });
  await call(endpoint, 'project.open', { projectId: project.id });
  const status = await until(async () => {
    const current = await call(endpoint, 'project.status', { projectId: project.id });
    if (current.status === 'error') throw new Error(`engine failed: ${current.error}`);
    return current.status === 'running' ? current : null;
  }, 'the project engine reports running');
  assert.equal(status.status, 'running');
  return processes().filter((entry) => entry.name === 'wrongstack-engine.exe');
}

const replaceInstalledEngine = () =>
  copyFile(sourceEngine, installedEngine).then(
    () => 'replaced',
    (error) => error.code ?? String(error),
  );

try {
  await mkdir(app, { recursive: true });
  await copyFile(join(portable, 'wrongstack-desktop-native.exe'), exe);
  await copyFile(sourceEngine, installedEngine);

  // 1. Before the fix: the engine runs where it is installed, so the installer cannot replace it.
  const legacy = await launch('legacy', { legacy: true });
  const legacyEngines = await startConversationEngine(legacy);
  assert.ok(legacyEngines.length > 0, 'legacy: an engine is running');
  assert.ok(
    legacyEngines.every((entry) => entry.path.toLowerCase() === installedEngine.toLowerCase()),
    `legacy: the engine runs from the install folder (${JSON.stringify(legacyEngines)})`,
  );
  const legacyOutcome = await replaceInstalledEngine();
  assert.notEqual(legacyOutcome, 'replaced', 'legacy: a running installed engine is locked');
  pass(`legacy: the installed engine is locked while its conversation runs (${legacyOutcome})`);
  await stopEverything();

  // 2. The shipped behaviour: the same conversation, the engine staged privately.
  const staged = await launch('staged', { legacy: false });
  const stagedEngines = await startConversationEngine(staged);
  const hosts = join(staged.dir, 'data', 'hosts').toLowerCase();
  assert.ok(stagedEngines.length > 0, 'staged: an engine is running');
  assert.ok(
    stagedEngines.every((entry) => entry.path.toLowerCase().startsWith(hosts)),
    `staged: the engine runs from a private copy (${JSON.stringify(stagedEngines)})`,
  );
  const hostCopies = processes().filter((entry) => entry.name === 'wrongstack-session-host.exe');
  assert.ok(
    hostCopies.length === 1 && hostCopies[0].path.toLowerCase().startsWith(hosts),
    `staged: the session host runs from a private copy (${JSON.stringify(hostCopies)})`,
  );
  pass('staged: the engine and the session host run from private copies');
  const outcome = await replaceInstalledEngine();
  assert.equal(outcome, 'replaced', `staged: the installed engine is replaceable (${outcome})`);
  pass('staged: the installed engine is replaced while its conversation runs');
  const firstCopies = await readdir(join(staged.dir, 'data', 'hosts'));
  assert.equal(firstCopies.length, 1, 'staged: one private folder for the one host');

  // 3. The host exits (sessions end, machine restarts): the next launch removes its copies.
  await stopEverything();
  const relaunched = await launch('staged', { legacy: false });
  const secondCopies = await readdir(join(relaunched.dir, 'data', 'hosts'));
  assert.equal(
    secondCopies.length,
    1,
    `staged: only the new host's folder remains (${secondCopies})`,
  );
  assert.notEqual(secondCopies[0], firstCopies[0], 'staged: the exited host folder is gone');
  pass('staged: a new host removes the copies the exited host left');
} catch (error) {
  console.error(`FAIL: ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  await stopEverything();
  await provider.close?.();
  await writeFile(join(work, 'results.json'), JSON.stringify(results, null, 2)).catch(() => {});
  console.log(`Artifacts: ${work}`);
}
process.exit(process.exitCode ?? 0);

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { portableDirectory } from '../scripts/portable.ts';
import { fixtureKey, fixtureModel, startLocalProvider } from './local-provider.mjs';

// Real NSIS and the shipped engine, with no product registration or shortcuts. The production
// hook must allow an unlocked install, refuse an unwritable image, and release every process
// holding the installed engine before replacement. A hook-free copy is the failing control.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const app = resolve(root, 'apps/desktop-v2');
const portable = process.env.WRONGSTACK_DESKTOP_TEST_PORTABLE ?? portableDirectory(app);
const previous = join(portable, 'wrongstack-engine.exe');
const work = resolve(root, '.temp_files/desktop-v2-native', `installer-release-${Date.now()}`);
const target = join(work, 'output/wrongstack-engine.exe');
const source = join(work, 'next-engine.exe');
const nsis = join(process.env.LOCALAPPDATA, 'tauri/NSIS');
// Match the existing full installer fixture's 200 x 250 ms startup allowance. This is a
// functional setup budget; startup performance is measured separately by native-performance.
const ENGINE_STARTUP_TIMEOUT_MS = 50000;
const results = [];
const engineExits = [];
const engineLogs = [];
await mkdir(join(work, 'output'), { recursive: true });
await mkdir(join(work, 'project'), { recursive: true });
await mkdir(join(work, 'empty'), { recursive: true });
await mkdir(join(work, 'home/profiles/default'), { recursive: true });
await writeFile(source, Buffer.concat([await readFile(previous), Buffer.from([0])]));
const provider = await startLocalProvider();
const ps = (command) =>
  spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
  });
const insideWork = `$_.ExecutablePath -and $_.ExecutablePath.StartsWith('${work}\\', [StringComparison]::OrdinalIgnoreCase)`;
const owned = () => {
  const result = ps(
    `@(Get-CimInstance Win32_Process | Where-Object { ${insideWork} } | Select-Object ProcessId,Name) | ConvertTo-Json -Compress -AsArray`,
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim() || '[]');
};
const stopOwned = async () => {
  const result = ps(
    `Get-CimInstance Win32_Process | Where-Object { ${insideWork} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  );
  assert.equal(result.status, 0, result.stderr);
  const deadline = Date.now() + 20000;
  while (owned().length > 0) {
    assert.ok(Date.now() < deadline, 'The owned fixture processes must finish exiting');
    await new Promise((done) => setTimeout(done, 100));
  }
};
const hashFile = async (path) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 65536 })) hash.update(chunk);
  return hash.digest('hex');
};
const run = (exe) =>
  new Promise((done, reject) => {
    const child = spawn(exe, ['/S'], { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('The fixture installer timed out'));
    }, 90000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      done(code);
    });
  });
const pass = (name, details = {}) => {
  results.push({ result: 'PASS', name, ...details });
  console.log(`PASS: ${name}`);
};

try {
  await writeFile(join(work, 'home/config.json'), JSON.stringify({ activeProfile: 'default' }));
  await writeFile(
    join(work, 'home/profiles/default/config.json'),
    JSON.stringify({
      provider: 'desktop-local',
      model: fixtureModel,
      providers: {
        'desktop-local': {
          type: 'openai-compatible',
          family: 'openai-compatible',
          baseUrl: provider.baseUrl,
          models: [fixtureModel],
          apiKeys: [{ label: 'fixture', apiKey: fixtureKey }],
          activeKey: 'fixture',
        },
      },
    }),
  );
  const setups = {};
  for (const hook of [false, true]) {
    const name = hook ? 'hook' : 'nohook';
    const exe = join(work, `${name}-setup.exe`);
    const script = join(work, `${name}.nsi`);
    await writeFile(
      script,
      `Unicode true
Name "WrongStack workspace engine release acceptance"
RequestExecutionLevel user
SetCompress off
!include "LogicLib.nsh"
!include "Win\\RestartManager.nsh"
!include "${join(app, 'src-tauri/target/release/nsis/x64/utils.nsh')}"
!include "${join(app, 'src-tauri/windows/installer-hooks.nsh')}"
!addplugindir "${join(nsis, 'Plugins/x86-unicode/additional')}"
Var PassiveMode
LangString appRunning 1033 "Engine is running"
LangString appRunningOkKill 1033 "Close engine"
LangString failedToKillApp 1033 "Failed to close engine"
OutFile "${exe}"
Section Install
  StrCpy $INSTDIR "$EXEDIR\\output"
  SetOutPath $INSTDIR
  ${hook ? '!insertmacro NSIS_HOOK_PREINSTALL' : ''}
  File /a "/oname=wrongstack-engine.exe" "${source}"
SectionEnd
`,
    );
    const build = spawnSync(join(nsis, 'makensis.exe'), ['/V2', script], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(build.status, 0, build.stdout + build.stderr);
    setups[name] = exe;
  }
  const nextHash = await hashFile(source);
  assert.equal(await run(setups.hook), 0);
  assert.equal(await hashFile(target), nextHash);
  pass('a first install without an existing engine writes the exact new bytes');

  await copyFile(previous, target);
  const oldHash = await hashFile(target);
  await chmod(target, 0o444);
  try {
    assert.equal(await run(setups.hook), 2, 'An unwritable engine must report installer refusal');
    assert.equal(await hashFile(target), oldHash, 'Refusal preserves the installed engine');
    pass('an unwritable engine aborts the installer and preserves the old bytes');
  } finally {
    await chmod(target, 0o666);
  }

  for (const name of ['nohook', 'hook']) {
    await copyFile(previous, target);
    const probe = createServer();
    await new Promise((done) => probe.listen(0, '127.0.0.1', done));
    const port = probe.address().port;
    await new Promise((done) => probe.close(done));
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(key),
      ),
    );
    Object.assign(env, {
      WRONGSTACK_HOME: join(work, 'home'),
      WRONGSTACK_DESKTOP: '1',
      WRONGSTACK_DESKTOP_USE_CWD_AS_PROJECT_ROOT: '1',
      WRONGSTACK_DESKTOP_EMPTY_DIST: join(work, 'empty'),
      WEBUI_STRICT_PORT: '1',
      WEBUI_TOKEN: 'local-engine-release-acceptance',
    });
    const log = await open(join(work, `${name}-engine.log`), 'w');
    engineLogs.push(log);
    const engine = spawn(
      'pwsh',
      [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        join(app, 'tests/native-engine-launch.ps1'),
        '-Executable',
        target,
        '-Project',
        join(work, 'project'),
        '-Port',
        String(port),
        '-PidFile',
        join(work, `${name}-pid.txt`),
      ],
      {
        cwd: join(work, 'project'),
        env,
        stdio: ['ignore', log.fd, log.fd],
        windowsHide: true,
      },
    );
    const engineClosed = new Promise((done) => engine.once('close', done));
    engineExits.push(engineClosed);
    let ready = false;
    const startupStarted = Date.now();
    const startupDeadline = startupStarted + ENGINE_STARTUP_TIMEOUT_MS;
    while (Date.now() < startupDeadline) {
      assert.equal(engine.exitCode, null, 'The engine stays running before the update');
      ready = await new Promise((done) => {
        const socket = createConnection({ host: '127.0.0.1', port });
        socket.once('connect', () => {
          socket.destroy();
          done(true);
        });
        socket.once('error', () => done(false));
      });
      if (ready) break;
      await new Promise((done) => setTimeout(done, 100));
    }
    console.log(`READY: ${name} engine ${Date.now() - startupStarted}ms`);
    assert.ok(ready, 'The fixture engine is serving before the update');
    const enginePid = Number(await readFile(join(work, `${name}-pid.txt`), 'utf8'));
    assert.ok(Number.isSafeInteger(enginePid) && enginePid > 0, 'The real engine PID is recorded');
    const consoleProbe = ps(
      `& '${join(app, 'tests/native-engine-console.ps1')}' -EnginePid ${enginePid}`,
    );
    assert.equal(consoleProbe.status, 0, consoleProbe.stderr);
    const consoleState = JSON.parse(consoleProbe.stdout);
    // The compiled engine can allocate its own console after CREATE_NO_WINDOW. It must
    // never inherit the controller's: Restart Manager closes a console's process group.
    if (consoleState.attached) {
      assert.ok(
        consoleState.consolePids.includes(enginePid),
        'The probe reached the actual engine',
      );
    } else {
      assert.equal(
        consoleState.error,
        6,
        'A running engine without a console returns invalid handle',
      );
    }
    assert.equal(
      consoleState.consolePids.includes(process.pid),
      false,
      'The engine console must be isolated from the test controller',
    );
    pass(`${name} engine console is isolated from the test controller`);
    const code = await run(setups[name]);
    const processes = owned();
    const replaced = (await hashFile(target)) === nextHash;
    if (name === 'nohook') {
      assert.equal(replaced, false, 'The control cannot replace a running engine');
      assert.ok(processes.length > 0, 'The control leaves the engine running');
      pass('without the hook, a running engine prevents replacement', { code });
    } else {
      assert.equal(code, 0);
      assert.deepEqual(processes, [], 'Every process holding the engine must be closed');
      assert.equal(replaced, true, 'The update writes the exact next engine');
      pass('the hook releases the engine and its daemons before copying the exact new bytes');
    }
    await stopOwned();
    await engineClosed;
  }
} catch (error) {
  results.push({ result: 'FAIL', message: String(error.stack ?? error) });
  console.error(error);
  process.exitCode = 1;
} finally {
  await stopOwned();
  await Promise.all(engineExits);
  await Promise.all(engineLogs.map((log) => log.close()));
  await chmod(target, 0o666).catch(() => {});
  await provider.close?.();
  await writeFile(join(work, 'results.json'), JSON.stringify({ portable, results }, null, 2));
  console.log(`Artifacts: ${work}`);
}
process.exit(process.exitCode ?? 0);

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureKey, fixtureModel, startLocalProvider } from './local-provider.mjs';

/**
 * Acceptance for the installer's engine check, with the real generated NSIS script: an installed
 * `wrongstack-engine.exe` is still running (what a 1.5.2-or-earlier session host leaves behind)
 * and the installer is run silently over it.
 *
 *   without the hook - Tauri's own check: the application is not running, so the installer goes
 *                      ahead and cannot replace the engine. It must FAIL (proves the check).
 *   with the hook    - the installer closes the engine and finishes.
 *
 * The product name, publisher and bundle identifier of the script copy are renamed, so its
 * registry keys and shortcuts cannot collide with an installed WrongStack Desktop, whose
 * registration is compared before and after. The script installs into a folder under
 * `.temp_files/desktop-v2-native`, never into an existing installation.
 */
const root = fileURLToPath(new URL('../../../', import.meta.url));
const generated = resolve(root, 'apps/desktop-v2/src-tauri/target/release/nsis/x64');
const makensis = join(process.env.LOCALAPPDATA, 'tauri/NSIS/makensis.exe');
const work = resolve(root, '.temp_files/desktop-v2-native', `installer-hook-${Date.now()}`);
const script = join(work, 'nsis');
const inst = join(work, 'inst');
const PRODUCT = 'WrongStack Acceptance';
const uninstallKey = (name) =>
  `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${name}`;
const results = [];
const pass = (message) => {
  results.push({ status: 'PASS', message });
  console.log(`PASS: ${message}`);
};
const powershell = (command) =>
  spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
  }).stdout.trim();
const registration = (name) =>
  powershell(
    `Get-ItemProperty -LiteralPath '${uninstallKey(name)}' -ErrorAction SilentlyContinue | Select-Object DisplayVersion,InstallLocation,UninstallString | ConvertTo-Json -Compress`,
  );
const shortcuts = () =>
  powershell(
    `@("$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs","$([Environment]::GetFolderPath('Desktop'))") | ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter '${PRODUCT}*.lnk' -ErrorAction SilentlyContinue } | ForEach-Object { $_.FullName }`,
  );
const alive = (pid) =>
  powershell(
    `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`,
  ) === 'yes';
const listening = (port) =>
  new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

/** Silent install: `/D` must be the last argument and unquoted. */
const install = (setup) =>
  spawnSync(setup, ['/S', `/D=${inst}`], { encoding: 'utf8', timeout: 240000, windowsHide: true });

const realBefore = registration('WrongStack Desktop');
let engine;
let provider;
const stopEngine = () => {
  if (engine?.pid && alive(engine.pid))
    powershell(`Stop-Process -Id ${engine.pid} -Force -ErrorAction SilentlyContinue`);
};

try {
  // The script copies: the generated one with the hook, and one without it.
  await cp(generated, script, { recursive: true });
  const original = await readFile(join(script, 'installer.nsi'), 'utf8');
  const renamed = original
    .replace('!define MANUFACTURER "WrongStack"', '!define MANUFACTURER "WrongStackAcceptance"')
    .replace('!define PRODUCTNAME "WrongStack Desktop"', `!define PRODUCTNAME "${PRODUCT}"`)
    .replace(
      '!define BUNDLEID "com.wrongstack.desktop.v2"',
      '!define BUNDLEID "com.wrongstack.acceptance"',
    );
  assert.notEqual(renamed, original, 'the script copy is renamed');
  assert.ok(renamed.includes(`!define PRODUCTNAME "${PRODUCT}"`), 'product renamed');
  const hookLine = /^!include ".*installer-hooks\.nsh"\r?$/m;
  assert.match(renamed, hookLine, 'the generated installer includes the hooks');
  // A silent install skips a file identical to the one on disk, so the update must carry a
  // different engine, as a new release does: the sidecar with one byte appended.
  const engineLine = original.match(/^\s*File \/a "\/oname=wrongstack-engine\.exe" "(.+)"\r?$/m);
  assert.ok(engineLine, 'the generated installer copies the engine sidecar');
  const nextEngine = join(work, 'next', 'wrongstack-engine-next.exe');
  await mkdir(join(work, 'next'), { recursive: true });
  await writeFile(nextEngine, Buffer.concat([await readFile(engineLine[1]), Buffer.from([0])]));
  const withNextEngine = (text) => text.replace(engineLine[1], nextEngine);
  const variants = {
    previous: renamed.replace(hookLine, ''), // the release being updated: no hook
    nohook: withNextEngine(renamed.replace(hookLine, '')), // an update with Tauri's own check
    hook: withNextEngine(renamed), // an update with the hook
  };
  const setups = {};
  for (const [name, text] of Object.entries(variants)) {
    setups[name] = join(work, `${name}-setup.exe`);
    await writeFile(
      join(script, `${name}.nsi`),
      text.replace('!define OUTFILE "nsis-output.exe"', `!define OUTFILE "${setups[name]}"`),
    );
    const build = spawnSync(makensis, ['/V1', `${name}.nsi`], {
      cwd: script,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.ok(existsSync(setups[name]), `${name} installer built: ${build.stdout}${build.stderr}`);
  }
  pass('the installer builds with and without the hook (renamed product)');
  assert.equal(registration(PRODUCT), '', 'no leftover acceptance registration');

  // 1. Install, as the previous release's installer would have (no hook).
  const first = install(setups.previous);
  assert.equal(
    first.status,
    0,
    `first install exit ${first.status}: ${first.stdout}${first.stderr}`,
  );
  assert.ok(existsSync(join(inst, 'wrongstack-engine.exe')), 'the engine is installed');
  assert.ok(
    existsSync(join(inst, 'wrongstack-desktop-native.exe')),
    'the application is installed',
  );
  assert.ok(
    registration(PRODUCT).includes(inst.replaceAll('\\', '\\\\')),
    'the product is registered',
  );
  pass('a silent install into the sandbox folder registers the renamed product');

  // 2. A session host from 1.5.2 or earlier: an engine running from the install folder.
  provider = await startLocalProvider();
  const home = join(work, 'home');
  await mkdir(join(home, 'profiles/default'), { recursive: true });
  await mkdir(join(work, 'project'), { recursive: true });
  await mkdir(join(work, 'empty'), { recursive: true });
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
          apiKeys: [{ label: 'default', apiKey: fixtureKey }],
          activeKey: 'default',
        },
      },
    }),
  );
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(key)) delete env[key];
  const freePort = () =>
    new Promise((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    });
  const port = await freePort();
  engine = spawn(
    join(inst, 'wrongstack-engine.exe'),
    ['--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: join(work, 'project'),
      env: {
        ...env,
        WRONGSTACK_HOME: home,
        WRONGSTACK_DESKTOP: '1',
        WEBUI_TOKEN: 'installer-hook-acceptance',
        WEBUI_STRICT_PORT: '1',
        WRONGSTACK_DESKTOP_EMPTY_DIST: join(work, 'empty'),
      },
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  for (let attempt = 0; attempt < 200 && !(await listening(port)); attempt++) {
    assert.equal(engine.exitCode, null, 'the engine stays up');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(await listening(port), 'the installed engine is serving');
  pass(`an installed engine is running (pid ${engine.pid})`);

  // 3. Control: without the hook the installer cannot replace the running engine.
  const installedSize = () => statSync(join(inst, 'wrongstack-engine.exe')).size;
  const previousSize = installedSize();
  const control = install(setups.nohook);
  assert.ok(alive(engine.pid), 'without the hook the engine is left running');
  assert.equal(
    installedSize(),
    previousSize,
    `without the hook the running engine is not replaced (exit ${control.status})`,
  );
  pass(
    `without the hook the update cannot replace a running engine (installer exit ${control.status}, engine unchanged)`,
  );

  // 4. With the hook: the engine is closed and the install finishes.
  const fixed = install(setups.hook);
  assert.equal(
    fixed.status,
    0,
    `with the hook the install succeeds (exit ${fixed.status}): ${fixed.stdout}${fixed.stderr}`,
  );
  for (let attempt = 0; attempt < 40 && alive(engine.pid); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(!alive(engine.pid), 'with the hook the running engine is closed');
  assert.equal(installedSize(), previousSize + 1, 'with the hook the new engine is installed');
  pass('with the hook the installer closes the running engine and installs the new one');

  // 5. Uninstall, with the hook in place and an engine running again.
  const secondPort = await freePort();
  const second = spawn(
    join(inst, 'wrongstack-engine.exe'),
    ['--host', '127.0.0.1', '--port', String(secondPort)],
    {
      cwd: join(work, 'project'),
      env: {
        ...env,
        WRONGSTACK_HOME: home,
        WRONGSTACK_DESKTOP: '1',
        WEBUI_TOKEN: 'installer-hook-acceptance',
        WEBUI_STRICT_PORT: '1',
        WRONGSTACK_DESKTOP_EMPTY_DIST: join(work, 'empty'),
      },
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  for (let attempt = 0; attempt < 200 && !(await listening(secondPort)); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(await listening(secondPort), 'the second installed engine is serving');
  const uninstall = () =>
    spawnSync(join(inst, 'uninstall.exe'), ['/S', `_?=${inst}`], {
      encoding: 'utf8',
      timeout: 240000,
      windowsHide: true,
    });
  let removal = uninstall();
  if (removal.status !== 0) {
    // Seen once in eight runs, never in six repeats of this step alone: the installer's
    // Restart Manager shutdown of a just-started engine gave up (machine under load) and the
    // uninstaller aborted with exit 2, leaving the engine running. A retry finishes the removal.
    console.log(`NOTE: the first uninstall exited ${removal.status}; retrying once`);
    results.push({ status: 'NOTE', message: `first uninstall exited ${removal.status}` });
    removal = uninstall();
  }
  assert.equal(
    removal.status,
    0,
    `the uninstall succeeds over a running engine (exit ${removal.status})`,
  );
  assert.ok(!alive(second.pid), 'the uninstaller closed the running engine');
  assert.ok(!existsSync(join(inst, 'wrongstack-engine.exe')), 'the engine is removed');
  assert.equal(registration(PRODUCT), '', 'the acceptance registration is removed');
  assert.equal(shortcuts(), '', 'the acceptance shortcuts are removed');
  pass(
    'the uninstaller closes a running engine, then removes the product, registration and shortcuts',
  );

  assert.equal(
    registration('WrongStack Desktop'),
    realBefore,
    'an installed WrongStack Desktop is untouched',
  );
  pass('an installed WrongStack Desktop registration is unchanged');
} catch (error) {
  console.error(`FAIL: ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  stopEngine();
  // An engine can outlive its spawned handle (an orphan of the same executable): stop whatever
  // still runs from the sandbox before the uninstaller needs its files.
  powershell(
    `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${work}', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  );
  if (existsSync(join(inst, 'uninstall.exe')) && registration(PRODUCT) !== '')
    spawnSync(join(inst, 'uninstall.exe'), ['/S', `_?=${inst}`], {
      timeout: 240000,
      windowsHide: true,
    });
  // The installer keeps the publisher key after an uninstall that does not delete app data.
  powershell(
    "Remove-Item -LiteralPath 'HKCU:\\Software\\WrongStackAcceptance' -Recurse -Force -ErrorAction SilentlyContinue",
  );
  await provider?.close?.();
  await writeFile(join(work, 'results.json'), JSON.stringify(results, null, 2)).catch(() => {});
  console.log(`Artifacts: ${work}`);
}
process.exit(process.exitCode ?? 0);

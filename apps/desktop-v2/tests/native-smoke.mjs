import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createSqliteMemoryPort, getSageSurface } from '../../../packages/sage/dist/index.js';
import { portableDirectory } from '../scripts/portable.ts';
import { fixtureKey, fixtureModel, fixtureText, startLocalProvider } from './local-provider.mjs';
import { configureRosterProvider, exerciseNativeAgentRoster } from './native-agent-roster.mjs';
import { exerciseNativeAppearance } from './native-appearance.mjs';
import { exerciseNativeApprovals } from './native-approvals.mjs';
import { exerciseNativeAtlas } from './native-atlas.mjs';
import { exerciseNativeAttachments } from './native-attachments.mjs';
import { exerciseNativeAutomationManagement } from './native-automation-management.mjs';
import { exerciseNativeBrainPolicy } from './native-brain-policy.mjs';
import { exerciseNativeChimera } from './native-chimera.mjs';
import { exerciseNativeChronicleExport } from './native-chronicle-export.mjs';
import { seedNativeChronicle } from './native-chronicle-fixture.mjs';
import { exerciseNativeChronicleInsights } from './native-chronicle-insights.mjs';
import { exerciseNativeComposer } from './native-composer.mjs';
import { exerciseNativeComposerResources } from './native-composer-resources.mjs';
import { exerciseNativeConversation } from './native-conversation.mjs';
import { exerciseNativeDeadCode } from './native-dead-code.mjs';
import { exerciseNativeDesignStudio } from './native-design-studio.mjs';
import { exerciseNativeDraftConflict } from './native-draft-conflict.mjs';
import { exerciseNativeEvidence } from './native-evidence.mjs';
import { exerciseNativeExecutionPolicy } from './native-execution-policy.mjs';
import { exerciseNativeFiles } from './native-files.mjs';
import { exerciseNativeFleetPolicy } from './native-fleet-policy.mjs';
import { exerciseNativeGoals } from './native-goals.mjs';
import { exerciseNativeTaskExecution } from './native-kanban-execution.mjs';
import { exerciseNativeLiveFleet } from './native-live-fleet.mjs';
import { exerciseNativeMailbox } from './native-mailbox.mjs';
import { exerciseNativeMcpComposer, exerciseNativeMcpContent } from './native-mcp-content.mjs';
import { exerciseNativeMcpTasks } from './native-mcp-tasks.mjs';
import { exerciseNativeModelCatalog } from './native-model-catalog.mjs';
import { exerciseNativeModelDraftRestart } from './native-model-draft-restart.mjs';
import { exerciseNativeModelProfiles } from './native-model-profiles.mjs';
import { exerciseNativeNextSteps } from './native-next-steps.mjs';
import { exerciseNativeProcesses } from './native-processes.mjs';
import { exerciseNativeProjectHistory } from './native-project-history.mjs';
import { exerciseNativeProjectKit } from './native-project-kit.mjs';
import { exerciseNativeProjects } from './native-projects.mjs';
import { exerciseNativeProviderHealth } from './native-provider-health.mjs';
import { exerciseNativeRefinementPolicy } from './native-refinement-policy.mjs';
import { exerciseNativeReviewPolicy } from './native-review-policy.mjs';
import { exerciseNativeSage } from './native-sage.mjs';
import { exerciseNativeSageValidity } from './native-sage-validity.mjs';
import { exerciseNativeSdd } from './native-sdd.mjs';
import { exerciseNativeSessionRecovery } from './native-session-recovery.mjs';
import { exerciseNativeSessionUsage } from './native-session-usage.mjs';
import { exerciseNativeSettingsManagement } from './native-settings-management.mjs';
import { exerciseNativeSettingsPolicy } from './native-settings-policy.mjs';
import { exerciseNativeSkills } from './native-skills.mjs';
import { exerciseNativeTechStack } from './native-techstack.mjs';

// Real Tauri + WebView2 + ConPTY + existing WrongStack engine. No external LLM calls.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const companion = process.argv.includes('--companion');
const composerOnly = process.argv.includes('--composer');
const chronicleOnly = process.argv.includes('--chronicle');
const goalsOnly = process.argv.includes('--goals');
const sddOnly = process.argv.includes('--sdd');
const modelsOnly = process.argv.includes('--models');
const modelDraftRestartOnly = process.argv.includes('--model-draft-restart');
const modelProfilesOnly = process.argv.includes('--model-profiles');
const mailboxOnly = process.argv.includes('--mailbox');
const kitOnly = process.argv.includes('--kit');
const skillsOnly = process.argv.includes('--skills');
const techstackOnly = process.argv.includes('--techstack');
const deadCodeOnly = process.argv.includes('--deadcode');
const designOnly = process.argv.includes('--design');
const chimeraOnly = process.argv.includes('--chimera');
const recoveryOnly = process.argv.includes('--recovery');
const historyOnly = process.argv.includes('--history');
const settingsOnly = process.argv.includes('--settings');
const filesOnly = process.argv.includes('--files');
const rosterOnly = process.argv.includes('--roster');
const automationOnly = process.argv.includes('--automation');
const mcpOnly = process.argv.includes('--mcp');
const mcpTasksOnly = process.argv.includes('--mcp-tasks');
const processesOnly = process.argv.includes('--processes');
const fleetOnly = process.argv.includes('--fleet');
const atlasOnly = process.argv.includes('--atlas');
const fleetPolicyOnly = process.argv.includes('--fleet-policy');
const brainPolicyOnly = process.argv.includes('--brain-policy');
const executionPolicyOnly = process.argv.includes('--execution-policy');
const refinementPolicyOnly = process.argv.includes('--refinement-policy');
const sageOnly = process.argv.includes('--sage');
const usageOnly = process.argv.includes('--usage');
const artifactDir = resolve(
  root,
  '.temp_files/desktop-v2-native',
  skillsOnly
    ? 'skills'
    : modelProfilesOnly
      ? 'model-profiles'
      : modelDraftRestartOnly
        ? 'model-draft-restart'
        : usageOnly
          ? 'session-usage'
          : sageOnly
            ? 'sage-validity'
            : refinementPolicyOnly
              ? 'refinement-policy'
              : executionPolicyOnly
                ? 'execution-policy'
                : brainPolicyOnly
                  ? 'brain-policy'
                  : fleetPolicyOnly
                    ? 'fleet-policy'
                    : atlasOnly
                      ? 'atlas-boundaries'
                      : fleetOnly
                        ? 'fleet'
                        : processesOnly
                          ? 'processes'
                          : mcpTasksOnly
                            ? 'mcp-tasks'
                            : mcpOnly
                              ? 'mcp'
                              : automationOnly
                                ? 'automation'
                                : rosterOnly
                                  ? 'roster'
                                  : filesOnly
                                    ? 'files'
                                    : settingsOnly
                                      ? 'settings'
                                      : historyOnly
                                        ? companion
                                          ? 'history-companion'
                                          : 'history'
                                        : recoveryOnly
                                          ? 'recovery'
                                          : chimeraOnly
                                            ? 'chimera'
                                            : designOnly
                                              ? 'design'
                                              : deadCodeOnly
                                                ? 'deadcode'
                                                : techstackOnly
                                                  ? 'techstack'
                                                  : kitOnly
                                                    ? 'kit'
                                                    : mailboxOnly
                                                      ? 'mailbox'
                                                      : modelsOnly
                                                        ? 'models'
                                                        : sddOnly
                                                          ? 'sdd'
                                                          : goalsOnly
                                                            ? 'goals'
                                                            : chronicleOnly
                                                              ? 'chronicle'
                                                              : composerOnly
                                                                ? companion
                                                                  ? 'composer-companion'
                                                                  : 'composer'
                                                                : companion
                                                                  ? 'companion'
                                                                  : '.',
);
await mkdir(artifactDir, { recursive: true });
if (modelDraftRestartOnly || modelProfilesOnly)
  await rm(join(artifactDir, 'native-result.json'), { force: true });
const dir = await mkdtemp(join(tmpdir(), 'wrongstack-desktop-v2-'));
const release = process.argv.includes('--release');
const bundled = process.argv.includes('--bundled');
const gitExecutable = Bun.which('git');
assert.ok(gitExecutable, 'Native repository checks require Git');
let portableIdentity;
let expectedEngineBuild;
const builtExecutable = resolve(
  root,
  `apps/desktop-v2/src-tauri/target/${release ? 'release' : 'debug'}/wrongstack-desktop-native.exe`,
);
const portableDir = join(dir, 'Portable Desktop');
if (bundled && !release) throw new Error('--bundled requires --release');
if (bundled) {
  await mkdir(portableDir);
  const source =
    process.env.WRONGSTACK_DESKTOP_TEST_PORTABLE ??
    portableDirectory(resolve(root, 'apps/desktop-v2'));
  portableIdentity = source.split(/[/\\]/).at(-1);
  const manifest = (await readFile(join(source, 'SHA256SUMS'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => {
      const match = line.match(/^([a-f0-9]{64}) {2}(.+)$/);
      assert.ok(match, 'Valid portable checksum entry');
      return { hash: match[1], name: match[2] };
    });
  assert.deepEqual(manifest.map((entry) => entry.name).sort(), [
    'wrongstack-desktop-native.exe',
    'wrongstack-engine.exe',
  ]);
  expectedEngineBuild = manifest.find((entry) => entry.name === 'wrongstack-engine.exe').hash;
  for (const entry of manifest) {
    assert.equal(
      createHash('sha256')
        .update(await readFile(join(source, entry.name)))
        .digest('hex'),
      entry.hash,
      `Portable checksum: ${entry.name}`,
    );
    await copyFile(join(source, entry.name), join(portableDir, entry.name));
  }
}
const executable = bundled ? join(portableDir, 'wrongstack-desktop-native.exe') : builtExecutable;
const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise((r) => server.close(r));
let child;
let browser;
let endpoint;
let page;
let nativeLog = '';
let launchCount = 0;
const errors = [];
const sessions = [];
let result;
let providerFixture;
const env = {
  ...process.env,
  WRONGSTACK_DESKTOP_DATA: dir,
  WRONGSTACK_HOME: join(dir, 'wrongstack'),
  WRONGSTACK_DESKTOP_BUN: process.execPath,
  WRONGSTACK_DESKTOP_ENTRY: resolve(root, 'apps/desktop-v2/engine/main.ts'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
};
await mkdir(join(dir, 'wrongstack/profiles/default'), { recursive: true });
await writeFile(
  join(dir, 'wrongstack/profiles/default/config.json'),
  JSON.stringify({
    skills: { readClaudeSkills: false, foreignSources: false },
    ...(executionPolicyOnly
      ? {
          autonomy: {
            yolo: false,
            yoloPlus: false,
            yoloConfirm: { 'bulk-delete': false, 'git-history': false },
          },
        }
      : {}),
    ...(brainPolicyOnly
      ? {
          brain: {
            maxAutoRisk: 'low',
            mode: 'headless',
            decisionTimeoutMs: 54321,
            monitor: {
              cooldownMs: 123456,
              signals: { toolFailureStreak: false, agentStall: false },
            },
            trace: { maxOpenRecords: 777 },
            rules: [
              {
                id: 'native-brain-rule',
                when: { source: 'system', question: 'native fixture decision' },
                // biome-ignore lint/suspicious/noThenProperty: BrainRule's canonical action field is named then.
                then: { action: 'defer' },
              },
            ],
          },
        }
      : {}),
    ...(fleetPolicyOnly
      ? {
          fleet: {
            memoryCompanion: { enabled: true },
            exploreCompanion: {
              enabled: true,
              maxToolCallsPerProbe: 600000,
              probeTimeoutMs: 18000000,
              signals: { editUnreadFile: false },
            },
            skillCompanion: { enabled: true, maxCandidates: 256, enforce: 'off' },
            lifecycle: { idleTimeoutMs: 900000, retireOnTaskComplete: true },
          },
        }
      : {}),
  }),
);
if (modelsOnly) {
  const now = Date.now();
  await writeFile(
    join(dir, 'wrongstack/profiles/default/provider-status.json'),
    JSON.stringify({
      version: 1,
      statuses: [
        {
          providerId: 'native-health-fixture',
          model: 'blocked-model',
          state: 'blocked',
          stateExpiresAt: now + 3600000,
          lastFailureAt: now,
          firstFailureAt: now,
          consecutiveFailures: 1,
          totalFailures: 1,
          rateLimitHits: 1,
          lastErrorKind: 'quota_exhausted',
          lastErrorStatus: 429,
          lastErrorMessage: 'Native recorded quota failure',
          recentErrors: [],
        },
      ],
    }),
  );
}
if (companion) env.WRONGSTACK_DESKTOP_USE_COMPANION_HOST = '1';
// Never inherit provider credentials from the developer's shell into this isolated test.
for (const name of Object.keys(env)) {
  if (/(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(name)) delete env[name];
}
if (bundled) {
  delete env.WRONGSTACK_DESKTOP_BUN;
  delete env.WRONGSTACK_DESKTOP_ENTRY;
  delete env.WRONGSTACK_DESKTOP_ENGINE;
  delete env.BUN_BE_BUN;
  env.PATH = `${dirname(gitExecutable)};${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`;
}
const waitFor = async (fn, label, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${label} timed out${last ? `: ${last.message}` : ''}`);
};
const bounded = async (promise, label, timeout = 5000) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const rpc = (method, params = {}, token = endpoint.token) =>
  new Promise((resolvePromise, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: endpoint.port });
    let body = '';
    socket.setTimeout(15000, () => socket.destroy(new Error('RPC timed out')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`${JSON.stringify({ token, method, params })}\n`));
    socket.on('data', (data) => {
      body += data;
      if (body.includes('\n')) {
        socket.end();
        const response = JSON.parse(body);
        if (response.error) reject(new Error(response.error));
        else resolvePromise(response.result);
      }
    });
    socket.on('end', () => {
      if (!body) reject(new Error('Unauthorized or closed connection'));
    });
  });
const launch = async () => {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const debugPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  child = spawn(executable, [], {
    cwd: bundled ? portableDir : root,
    env: {
      ...env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
      WEBVIEW2_USER_DATA_FOLDER: join(dir, `webview-${++launchCount}`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stderr.on('data', (data) => {
    nativeLog += String(data);
    if (String(data).includes('panicked')) errors.push(String(data));
  });
  await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
    return r.ok;
  }, 'WebView2 debugging endpoint');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  page = await waitFor(
    () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) =>
          release
            ? /^https?:\/\/tauri\.localhost/.test(p.url()) ||
              p.url().startsWith('tauri://localhost')
            : p.url().includes(':1420'),
        ),
    'Tauri shell page',
  );
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(30000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('.main-content').waitFor();
  await page.getByText('Local engine connected', { exact: true }).waitFor();
  endpoint = JSON.parse(await readFile(join(dir, 'host.json'), 'utf8'));
  return browser;
};
const stopUi = async () => {
  if (child && child.exitCode === null) {
    const stopped = new Promise((r) => child.once('exit', r));
    child.kill();
    await bounded(stopped, 'Test UI shutdown').catch(() => {});
  }
  // A CDP connection can keep an old WebView2 profile alive after its owner exits.
  if (browser) await bounded(browser.close(), 'CDP shutdown').catch(() => {});
  browser = undefined;
};
const cleanupOwnedProcesses = async () => {
  assert.equal(dirname(resolve(dir)).toLowerCase(), resolve(tmpdir()).toLowerCase());
  assert.ok(basename(dir).startsWith('wrongstack-desktop-v2-'));
  const code =
    "$pattern=[regex]::Escape($env:WRONGSTACK_DESKTOP_TEST_DIR); Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe' OR Name='wrongstack-engine.exe' OR Name='wrongstack-session-host.exe'\" | Where-Object { $_.CommandLine -match $pattern } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  const cleanup = spawn(
    join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', code],
    {
      env: { ...process.env, WRONGSTACK_DESKTOP_TEST_DIR: dir },
      windowsHide: true,
      stdio: 'ignore',
    },
  );
  await bounded(
    new Promise((resolve, reject) => {
      cleanup.once('exit', (code) =>
        code === 0 ? resolve() : reject(Error(`Owned process cleanup failed: ${code}`)),
      );
      cleanup.once('error', reject);
    }),
    'Owned native process cleanup',
  );
};
const restartForModelDrafts = async (cold, beforeLaunch) => {
  const previous = { uiPid: child.pid, hostPid: (await rpc('snapshot')).hostPid };
  const previousToken = endpoint.token;
  assert.equal(previous.hostPid, endpoint.pid);
  await stopUi();
  assert.ok(
    Number.isInteger(child.exitCode) || !!child.signalCode,
    'The old Tauri process exited before relaunch',
  );
  previous.uiExitCode = child.exitCode;
  previous.uiSignal = child.signalCode;
  if (cold) {
    // This authenticated endpoint belongs to this test's unique data directory.
    const kill = spawn('taskkill', ['/PID', String(previous.hostPid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    await bounded(
      new Promise((resolve, reject) => {
        kill.once('exit', (code) =>
          code === 0 ? resolve() : reject(Error(`Owned host termination failed: ${code}`)),
        );
        kill.once('error', reject);
      }),
      'Owned host termination',
    );
    await cleanupOwnedProcesses();
    await assert.rejects(rpc('ping'), 'Old host endpoint is closed');
  }
  if (beforeLaunch) {
    assert.ok(cold, 'Profile bootstrap changes require a stopped host');
    await beforeLaunch();
  }
  await launch();
  const current = { uiPid: child.pid, hostPid: (await rpc('snapshot')).hostPid };
  assert.notEqual(current.uiPid, previous.uiPid, 'A new Tauri process owns the restored editor');
  if (cold) {
    assert.notEqual(current.hostPid, previous.hostPid, 'Cold restart opens a fresh native host');
    assert.ok(
      endpoint.token !== previousToken,
      'Cold restart replaces the host authentication identity',
    );
  } else assert.equal(current.hostPid, previous.hostPid, 'UI restart preserves the existing host');
  if (expectedEngineBuild) assert.equal((await rpc('ping')).engineBuild, expectedEngineBuild);
  return { cold, previous, current };
};

try {
  providerFixture = await startLocalProvider(
    refinementPolicyOnly
      ? { models: [fixtureModel, 'profile/refiner', 'explicit/refiner'] }
      : { models: [fixtureModel, 'alternate-refiner'] },
  );
  await launch();
  console.log('PASS: native shell boot');
  const initialPid = (await rpc('snapshot')).hostPid;
  if (expectedEngineBuild)
    assert.equal(
      (await rpc('ping')).engineBuild,
      expectedEngineBuild,
      'Native host identifies the exact bundled engine',
    );
  await assert.rejects(rpc('snapshot', {}, 'wrong-token'), /Unauthorized|closed/);
  await assert.rejects(rpc('unknown-method'), /Unknown method/);
  const workspaceRpc = (method, params = {}) =>
    method.startsWith('project.') || method.startsWith('profile.')
      ? page.evaluate(
          ({ method, params }) =>
            window.__TAURI_INTERNALS__.invoke('host_request', { method, params }),
          { method, params },
        )
      : rpc(method, params);
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'WrongStack settings', exact: true })
    .click();
  await waitFor(
    async () => (await workspaceRpc('profile.status')).status === 'running',
    'Profile runtime startup (native 90-second deadline)',
    100000,
  );
  await page.getByRole('heading', { name: 'Default model', exact: true }).waitFor();
  if (expectedEngineBuild)
    assert.equal(
      (await workspaceRpc('profile.status')).engineBuild,
      expectedEngineBuild,
      'Profile services use the exact current bundled engine',
    );
  assert.equal((await rpc('snapshot')).projects.length, 0, 'Profile settings need no project');
  assert.equal((await rpc('snapshot')).sessions.length, 0, 'Profile settings need no session');
  if (mcpOnly)
    await exerciseNativeMcpContent({
      page,
      rpc: workspaceRpc,
      waitFor,
      artifactDir,
      configPath: join(dir, 'wrongstack/profiles/default/config.json'),
    });
  if (fleetPolicyOnly)
    await exerciseNativeFleetPolicy({
      page,
      rpc: workspaceRpc,
      waitFor,
      artifactDir,
      configPath: join(dir, 'wrongstack/profiles/default/config.json'),
    });
  if (refinementPolicyOnly) {
    await configureRosterProvider({ rpc: workspaceRpc, waitFor, providerFixture });
    await exerciseNativeRefinementPolicy({
      page,
      rpc: workspaceRpc,
      waitFor,
      artifactDir,
      configPath: join(dir, 'wrongstack/profiles/default/config.json'),
      providerFixture,
    });
  }
  if (executionPolicyOnly)
    await exerciseNativeExecutionPolicy({
      page,
      rpc: workspaceRpc,
      waitFor,
      artifactDir,
      configPath: join(dir, 'wrongstack/profiles/default/config.json'),
      providerFixture,
    });
  if (brainPolicyOnly) {
    await configureRosterProvider({ rpc: workspaceRpc, waitFor, providerFixture });
    await exerciseNativeBrainPolicy({
      page,
      rpc: workspaceRpc,
      waitFor,
      artifactDir,
      configPath: join(dir, 'wrongstack/profiles/default/config.json'),
      providerFixture,
    });
  }
  if (rosterOnly || automationOnly || mcpTasksOnly || processesOnly || fleetOnly || usageOnly)
    await configureRosterProvider({ rpc: workspaceRpc, waitFor, providerFixture });
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Mission control', exact: true })
    .click();
  const repo1 = join(dir, 'Project Alpha');
  const repo2 = join(dir, 'Project Beta');
  await mkdir(repo1);
  await mkdir(repo2);
  await writeFile(join(repo1, 'README.md'), 'Native desktop fixture: all screens stay in Tauri.');
  await writeFile(
    join(repo1, 'native-notes.md'),
    'Native Markdown links read project files through the engine.',
  );
  const a = await rpc('project.register', { root: repo1 });
  const b = await rpc('project.register', { root: repo2 });
  for (const [name, source] of [
    [
      'alpha',
      "import { shared } from '@fixture/beta';\nexport function feature() { return shared(); }\n",
    ],
    ['beta', "export function shared() { return 'native atlas'; }\n"],
  ]) {
    await mkdir(join(repo1, 'packages', name, 'src'), { recursive: true });
    await writeFile(
      join(repo1, 'packages', name, 'package.json'),
      JSON.stringify({
        name: `@fixture/${name}`,
        version: '1.0.0',
        ...(name === 'alpha' ? { dependencies: { '@fixture/beta': 'workspace:*' } } : {}),
      }),
    );
    await writeFile(join(repo1, 'packages', name, 'src/index.ts'), source);
  }
  await writeFile(
    join(repo1, 'package.json'),
    JSON.stringify({ name: 'desktop-atlas-fixture', private: true, workspaces: ['packages/*'] }),
  );
  await mkdir(join(repo1, 'packages/large/src'), { recursive: true });
  await writeFile(
    join(repo1, 'packages/large/package.json'),
    JSON.stringify({ name: '@fixture/large', version: '1.0.0' }),
  );
  await Promise.all(
    Array.from({ length: 181 }, (_, i) =>
      writeFile(
        join(repo1, `packages/large/src/late-${String(i).padStart(3, '0')}.ts`),
        `export const item${i} = ${i};\n`,
      ),
    ),
  );
  assert.equal((await rpc('project.register', { root: repo1 })).id, a.id);
  await writeFile(join(repo1, '.gitignore'), '.wrongstack/\n');
  await writeFile(join(repo1, 'review-fixture.ts'), 'export const reviewed = 1;\n');
  for (const args of [
    ['init', '--initial-branch=main'],
    ['config', 'user.name', 'Desktop Native Fixture'],
    ['config', 'user.email', 'fixture@example.invalid'],
    ['config', 'commit.gpgSign', 'false'],
    ['config', 'core.hooksPath', '.git/hooks'],
    ['add', '.'],
    ['commit', '-m', 'Native file review baseline'],
  ]) {
    const result = spawnSync(gitExecutable, args, {
      cwd: repo1,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
  }
  await writeFile(join(repo1, 'review-fixture.ts'), 'export const reviewed = 2;\n');
  const memoryPort = createSqliteMemoryPort({ projectRoot: repo1 });
  try {
    const sage = getSageSurface(memoryPort);
    assert.ok(sage);
    const stale = await sage.rememberSage({
      text: 'A SAGE decision awaiting revalidation.',
      kind: 'decision',
      scope: 'project',
      tags: ['desktop', 'lifecycle'],
    });
    await sage.updateSage(stale.id, { status: 'stale' });
    await memoryPort.addGraphEdge(
      `mem:${stale.id}`,
      'file:packages/alpha/src/index.ts',
      'about_file',
      1,
    );
    for (const [text, tags] of [
      ['Native SAGE proposal keeps file boundaries explicit.', ['desktop', 'sage-review']],
      ['Native SAGE proposal that should be rejected.', ['desktop', 'sage-rejected']],
    ])
      await sage.createCandidate({
        text,
        kind: 'convention',
        scope: 'project',
        confidence: 0.9,
        importance: 0.8,
        tags,
        anchors: [{ type: 'file', path: 'packages/alpha/src/index.ts' }],
        audience: { roles: ['reviewer'] },
      });
  } finally {
    await memoryPort.dispose();
  }
  await assert.rejects(
    rpc('session.open', { projectId: a.id, kind: 'terminal', workdir: '..' }),
    /inside/,
  );
  await page.locator('.project-item').filter({ hasText: a.name }).click();
  await page.getByRole('button', { name: 'Prompt library', exact: true }).click();
  const sessionFreeLibrary = page.getByRole('dialog', { name: 'Prompt library', exact: true });
  await sessionFreeLibrary
    .getByRole('button', { name: 'New template', exact: true })
    .waitFor({ timeout: 100000 });
  assert.equal(
    (await rpc('snapshot')).sessions.length,
    0,
    'Project prompt library works before creating any desktop conversation',
  );
  await page.screenshot({
    path: join(artifactDir, 'native-project-prompt-library.png'),
    fullPage: true,
  });
  await sessionFreeLibrary
    .getByRole('button', { name: 'Close prompt workspace', exact: true })
    .click();
  console.log('PASS: project-owned prompt library without a desktop conversation');
  if (refinementPolicyOnly) {
    assert.deepEqual(errors, []);
    result = {
      result: 'PASS',
      scope: 'refinement-policy',
      portableIdentity,
      bundledEngine: bundled,
      portableChecksumsVerified: bundled,
      artifacts: artifactDir,
    };
  } else if (executionPolicyOnly) {
    assert.deepEqual(errors, []);
    result = {
      result: 'PASS',
      scope: 'execution-policy',
      portableIdentity,
      bundledEngine: bundled,
      portableChecksumsVerified: bundled,
      artifacts: artifactDir,
    };
  } else if (brainPolicyOnly) {
    assert.deepEqual(errors, []);
    result = {
      result: 'PASS',
      scope: 'brain-policy',
      portableIdentity,
      bundledEngine: bundled,
      portableChecksumsVerified: bundled,
      artifacts: artifactDir,
    };
  } else if (fleetPolicyOnly) {
    assert.deepEqual(errors, []);
    result = {
      result: 'PASS',
      scope: 'fleet-policy',
      portableIdentity,
      bundledEngine: bundled,
      portableChecksumsVerified: bundled,
      artifacts: artifactDir,
    };
  } else if (atlasOnly) {
    await page
      .getByRole('navigation', { name: `${a.name} workspace` })
      .getByRole('button', { name: 'Code Atlas', exact: true })
      .click();
    await page.getByRole('button', { name: 'Index project', exact: true }).click();
    await waitFor(
      async () => {
        const value = await workspaceRpc('project.http', {
          projectId: a.id,
          method: 'GET',
          resource: '/api/codemap/status',
        });
        if (value.data.status === 'error') throw new Error(value.data.error);
        return value.data.status === 'ready';
      },
      'Actual project index ready for boundary exploration',
      120000,
    );
    await exerciseNativeAtlas({
      page,
      rpc: workspaceRpc,
      project: a,
      waitFor,
      artifactDir,
      boundariesOnly: true,
    });
    assert.deepEqual(errors, []);
    result = {
      result: 'PASS',
      scope: 'atlas-boundaries',
      portableIdentity,
      bundledEngine: bundled,
      portableChecksumsVerified: bundled,
      artifacts: artifactDir,
    };
  } else if (fleetOnly) {
    await exerciseNativeLiveFleet({
      page,
      rpc: workspaceRpc,
      waitFor,
      project: a,
      otherProject: b,
      artifactDir,
      configPath: join(dir, 'wrongstack/profiles/default/config.json'),
      sessionIds: sessions,
    });
    assert.deepEqual(errors, []);
    result = {
      result: 'PASS',
      scope: 'fleet',
      portableIdentity,
      bundledEngine: bundled,
      portableChecksumsVerified: bundled,
      artifacts: artifactDir,
    };
  } else if (processesOnly) {
    await exerciseNativeProcesses({
      page,
      rpc: workspaceRpc,
      waitFor,
      project: a,
      artifactDir,
      configPath: join(dir, 'wrongstack/profiles/default/config.json'),
      sessionIds: sessions,
    });
    assert.deepEqual(errors, []);
    result = {
      result: 'PASS',
      scope: 'processes',
      portableIdentity,
      bundledEngine: bundled,
      portableChecksumsVerified: bundled,
      artifacts: artifactDir,
    };
  } else if (mcpTasksOnly) {
    await exerciseNativeMcpTasks({
      page,
      rpc: workspaceRpc,
      waitFor,
      project: a,
      artifactDir,
      configPath: join(dir, 'wrongstack/profiles/default/config.json'),
      sessionIds: sessions,
    });
    assert.deepEqual(errors, []);
    result = {
      result: 'PASS',
      scope: 'mcp-tasks',
      portableIdentity,
      bundledEngine: bundled,
      portableChecksumsVerified: bundled,
      artifacts: artifactDir,
    };
  } else if (mcpOnly) {
    await exerciseNativeMcpComposer({
      page,
      rpc: workspaceRpc,
      waitFor,
      artifactDir,
      project: a,
      sessionIds: sessions,
    });
    assert.deepEqual(errors, []);
    result = {
      result: 'PASS',
      scope: 'mcp',
      portableIdentity,
      bundledEngine: bundled,
      portableChecksumsVerified: bundled,
      artifacts: artifactDir,
    };
  } else if (automationOnly) {
    await exerciseNativeAutomationManagement({
      page,
      rpc: workspaceRpc,
      waitFor,
      artifactDir,
      project: a,
      otherProject: b,
      configPath: join(dir, 'wrongstack/profiles/default/config.json'),
      wrongstackHome: env.WRONGSTACK_HOME,
    });
    assert.deepEqual(errors, []);
    result = {
      result: 'PASS',
      scope: 'automation',
      portableIdentity,
      bundledEngine: bundled,
      portableChecksumsVerified: bundled,
      artifacts: artifactDir,
    };
  } else if (rosterOnly) {
    await exerciseNativeAgentRoster({
      page,
      rpc: workspaceRpc,
      waitFor,
      artifactDir,
      project: a,
      otherProject: b,
      configPath: join(dir, 'wrongstack/profiles/default/config.json'),
      providerFixture,
    });
    assert.deepEqual(errors, []);
    result = {
      result: 'PASS',
      scope: 'roster',
      portableIdentity,
      bundledEngine: bundled,
      portableChecksumsVerified: bundled,
      artifacts: artifactDir,
    };
  } else if (historyOnly) {
    await exerciseNativeProjectHistory({
      page,
      rpc: workspaceRpc,
      waitFor,
      project: a,
      otherProject: b,
      wrongstackHome: env.WRONGSTACK_HOME,
      artifactDir,
      sessionIds: sessions,
    });
    assert.deepEqual(errors, []);
    result = {
      result: 'PASS',
      scope: companion ? 'history-companion' : 'history',
      portableIdentity,
      bundledEngine: bundled,
      portableChecksumsVerified: bundled,
      artifacts: artifactDir,
    };
  } else if (filesOnly) {
    await seedNativeChronicle({ rpc: workspaceRpc, project: a, waitFor });
    await page
      .getByRole('navigation', { name: `${a.name} workspace` })
      .getByRole('button', { name: 'Memory', exact: true })
      .click();
    await page
      .getByRole('navigation', { name: 'SAGE workspace' })
      .getByRole('button', { name: 'Review queue', exact: true })
      .click();
    const proposal = page
      .locator('.sage-candidate-card')
      .filter({ hasText: 'Native SAGE proposal keeps file boundaries explicit.' });
    await proposal.getByRole('button', { name: 'Review & accept', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Accept SAGE proposal' })
      .getByRole('button', { name: 'Confirm action' })
      .click();
    await proposal.waitFor({ state: 'detached' });
    await exerciseNativeFiles({ page, waitFor, artifactDir, project: a, rpc: workspaceRpc });
    assert.deepEqual(errors, []);
    result = {
      result: 'PASS',
      scope: 'files',
      portableIdentity,
      bundledEngine: bundled,
      portableChecksumsVerified: bundled,
      artifacts: artifactDir,
    };
  } else if (settingsOnly) {
    await exerciseNativeSettingsManagement({
      page,
      rpc: workspaceRpc,
      waitFor,
      artifactDir,
      instructionsPath: join(dir, 'wrongstack/AGENTS.md'),
      configPath: join(dir, 'wrongstack/profiles/default/config.json'),
    });
    assert.deepEqual(errors, []);
    result = {
      result: 'PASS',
      scope: 'settings',
      portableIdentity,
      bundledEngine: bundled,
      artifacts: artifactDir,
    };
  } else if (recoveryOnly) {
    await exerciseNativeSessionRecovery({
      page,
      rpc: workspaceRpc,
      waitFor,
      project: a,
      wrongstackHome: env.WRONGSTACK_HOME,
      artifactDir,
      sessionIds: sessions,
      providerFixture,
      configPath: join(dir, 'wrongstack/profiles/default/config.json'),
    });
    assert.deepEqual(errors, []);
    result = {
      result: 'PASS',
      scope: 'recovery',
      portableIdentity,
      bundledEngine: bundled,
      portableChecksumsVerified: bundled,
      artifacts: artifactDir,
    };
  } else if (chimeraOnly) {
    await exerciseNativeReviewPolicy({
      page,
      rpc: workspaceRpc,
      waitFor,
      artifactDir,
      configPath: join(dir, 'wrongstack/profiles/default/config.json'),
    });
    await exerciseNativeChimera({
      page,
      rpc: workspaceRpc,
      project: a,
      otherProject: b,
      wrongstackHome: env.WRONGSTACK_HOME,
      waitFor,
      artifactDir,
      sessionIds: sessions,
    });
    assert.deepEqual(errors, []);
    result = {
      result: 'PASS',
      scope: 'chimera',
      portableIdentity,
      bundledEngine: bundled,
      portableChecksumsVerified: bundled,
      artifacts: artifactDir,
    };
  } else if (designOnly) {
    await exerciseNativeDesignStudio({
      page,
      rpc: workspaceRpc,
      project: a,
      otherProject: b,
      root: repo1,
      waitFor,
      artifactDir,
    });
    assert.deepEqual(errors, []);
    result = {
      result: 'PASS',
      scope: 'design',
      portableIdentity,
      bundledEngine: bundled,
      portableChecksumsVerified: bundled,
      artifacts: artifactDir,
    };
  } else if (deadCodeOnly) {
    await exerciseNativeDeadCode({
      page,
      rpc: workspaceRpc,
      project: a,
      otherProject: b,
      root: repo1,
      waitFor,
      artifactDir,
    });
    assert.deepEqual(errors, []);
    result = {
      result: 'PASS',
      scope: 'deadcode',
      portableIdentity,
      bundledEngine: bundled,
      portableChecksumsVerified: bundled,
      artifacts: artifactDir,
    };
  } else if (techstackOnly) {
    await exerciseNativeTechStack({
      page,
      rpc: workspaceRpc,
      project: a,
      otherProject: b,
      wrongstackHome: env.WRONGSTACK_HOME,
      waitFor,
      artifactDir,
    });
    assert.deepEqual(errors, []);
    result = {
      result: 'PASS',
      scope: 'techstack',
      portableIdentity,
      bundledEngine: bundled,
      portableChecksumsVerified: bundled,
      artifacts: artifactDir,
    };
  } else if (skillsOnly) {
    await page.locator('.project-item').filter({ hasText: a.name }).click();
    await exerciseNativeSkills({ page, waitFor, artifactDir, project: a, rpc: workspaceRpc });
    assert.deepEqual(errors, []);
    result = {
      result: 'PASS',
      scope: 'skills',
      portableIdentity,
      bundledEngine: bundled,
      portableChecksumsVerified: bundled,
      artifacts: artifactDir,
    };
  } else if (kitOnly) {
    await exerciseNativeProjectKit({
      page,
      rpc: workspaceRpc,
      project: a,
      otherProject: b,
      root: repo1,
      waitFor,
      artifactDir,
      sessionIds: sessions,
    });
    assert.deepEqual(errors, []);
    result = {
      result: 'PASS',
      scope: 'kit',
      portableIdentity,
      bundledEngine: bundled,
      portableChecksumsVerified: bundled,
      artifacts: artifactDir,
    };
  } else if (mailboxOnly) {
    await exerciseNativeMailbox({
      page,
      rpc: workspaceRpc,
      project: a,
      otherProject: b,
      waitFor,
      artifactDir,
      wrongstackHome: env.WRONGSTACK_HOME,
    });
    assert.deepEqual(errors, []);
    result = {
      result: 'PASS',
      scope: 'mailbox',
      portableIdentity,
      bundledEngine: bundled,
      portableChecksumsVerified: bundled,
      artifacts: artifactDir,
    };
  } else if (modelProfilesOnly) {
    const profileProof = await exerciseNativeModelProfiles({
      getPage: () => page,
      rpc: workspaceRpc,
      waitFor,
      restart: restartForModelDrafts,
      artifactDir,
      wrongstackHome: env.WRONGSTACK_HOME,
    });
    assert.deepEqual(errors, []);
    result = {
      result: 'PASS',
      scope: 'model-profiles',
      portableIdentity,
      bundledEngine: bundled,
      portableChecksumsVerified: bundled,
      profileProof,
      artifacts: artifactDir,
    };
  } else if (modelDraftRestartOnly) {
    const restartProof = await exerciseNativeModelDraftRestart({
      getPage: () => page,
      rpc: workspaceRpc,
      waitFor,
      restart: restartForModelDrafts,
      artifactDir,
      configPath: join(dir, 'wrongstack/profiles/default/config.json'),
    });
    assert.deepEqual(errors, []);
    result = {
      result: 'PASS',
      scope: 'model-draft-restart',
      portableIdentity,
      bundledEngine: bundled,
      portableChecksumsVerified: bundled,
      restartProof,
      artifacts: artifactDir,
    };
  } else if (modelsOnly) {
    await exerciseNativeModelCatalog({
      page,
      rpc: workspaceRpc,
      waitFor,
      artifactDir,
      configPath: join(dir, 'wrongstack/profiles/default/config.json'),
    });
    await exerciseNativeProviderHealth({
      page,
      rpc: workspaceRpc,
      waitFor,
      artifactDir,
      configPath: join(dir, 'wrongstack/profiles/default/config.json'),
      expectWaitingRoom: true,
    });
    assert.deepEqual(errors, []);
    result = {
      result: 'PASS',
      scope: 'models',
      portableIdentity,
      bundledEngine: bundled,
      portableChecksumsVerified: bundled,
      artifacts: artifactDir,
    };
  } else if (sddOnly) {
    await exerciseNativeSdd({
      page,
      rpc: workspaceRpc,
      project: a,
      waitFor,
      artifactDir,
      wrongstackHome: env.WRONGSTACK_HOME,
      otherProject: b,
      restartUi: async () => {
        await stopUi();
        await launch();
        return page;
      },
    });
    assert.deepEqual(errors, []);
    result = {
      result: 'PASS',
      scope: 'sdd',
      portableIdentity,
      bundledEngine: bundled,
      portableChecksumsVerified: bundled,
      artifacts: artifactDir,
    };
  } else if (goalsOnly) {
    await exerciseNativeGoals({
      page,
      rpc: workspaceRpc,
      project: a,
      waitFor,
      artifactDir,
      wrongstackHome: env.WRONGSTACK_HOME,
    });
    assert.deepEqual(errors, []);
    result = {
      result: 'PASS',
      scope: 'goals',
      portableIdentity,
      bundledEngine: bundled,
      portableChecksumsVerified: bundled,
      artifacts: artifactDir,
    };
  } else if (usageOnly) {
    await exerciseNativeSessionUsage({
      page,
      rpc: workspaceRpc,
      project: a,
      waitFor,
      artifactDir,
      configPath: join(dir, 'wrongstack/profiles/default/config.json'),
      providerFixture,
      sessionIds: sessions,
    });
    assert.deepEqual(errors, []);
    result = {
      result: 'PASS',
      scope: 'session-usage',
      portableIdentity,
      bundledEngine: bundled,
      portableChecksumsVerified: bundled,
      artifacts: artifactDir,
    };
  } else if (sageOnly) {
    await exerciseNativeSageValidity({
      page,
      rpc: workspaceRpc,
      project: a,
      otherProject: b,
      projectRoot: repo1,
      waitFor,
      artifactDir,
    });
    assert.deepEqual(errors, []);
    result = {
      result: 'PASS',
      scope: 'sage-validity',
      portableIdentity,
      bundledEngine: bundled,
      portableChecksumsVerified: bundled,
      artifacts: artifactDir,
    };
  } else if (chronicleOnly) {
    await seedNativeChronicle({ rpc: workspaceRpc, project: a, waitFor });
    await exerciseNativeChronicleInsights({ page, rpc: workspaceRpc, project: a, artifactDir });
    await exerciseNativeChronicleExport({ page, waitFor, artifactDir });
    assert.deepEqual(errors, []);
    result = {
      result: 'PASS',
      scope: 'chronicle',
      portableIdentity,
      bundledEngine: bundled,
      portableChecksumsVerified: bundled,
      artifacts: artifactDir,
    };
  } else {
    if (!composerOnly) {
      await exerciseNativeProjects({
        page,
        rpc: workspaceRpc,
        waitFor,
        artifactDir,
        project: a,
        otherProject: b,
      });
      await seedNativeChronicle({ rpc: workspaceRpc, project: a, waitFor });
      await exerciseNativeSettingsPolicy({ page, rpc: workspaceRpc, waitFor, artifactDir });
      await exerciseNativeSettingsManagement({
        page,
        rpc: workspaceRpc,
        waitFor,
        artifactDir,
        instructionsPath: join(dir, 'wrongstack/AGENTS.md'),
        configPath: join(dir, 'wrongstack/profiles/default/config.json'),
      });
      await exerciseNativeSage({ page, waitFor, artifactDir, project: a, rpc: workspaceRpc });
      await exerciseNativeModelCatalog({
        page,
        rpc: workspaceRpc,
        waitFor,
        artifactDir,
        configPath: join(dir, 'wrongstack/profiles/default/config.json'),
      });
      await exerciseNativeFiles({ page, waitFor, artifactDir, project: a, rpc: workspaceRpc });
      await exerciseNativeAtlas({ page, waitFor, artifactDir, project: a, rpc: workspaceRpc });
      await exerciseNativeEvidence({ page, waitFor, artifactDir, project: a, rpc: workspaceRpc });
      await exerciseNativeSkills({ page, waitFor, artifactDir, project: a, rpc: workspaceRpc });
      await page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('button', { name: 'Mission control', exact: true })
        .click();
    }
    // Exercise the visible create-session flow against the real native commands.
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    await page.getByRole('button', { name: 'Terminal A persistent native shell' }).click();
    await page.getByLabel('Session name').fill('Native UI terminal');
    await page.getByRole('button', { name: 'Create terminal session' }).click();
    await page
      .locator('.breadcrumb-session')
      .getByText('Native UI terminal', { exact: true })
      .waitFor();
    const first = (await rpc('snapshot')).sessions.find((s) => s.title === 'Native UI terminal');
    sessions.push(first.id);
    const second = await rpc('session.open', {
      projectId: a.id,
      kind: 'terminal',
      title: 'Concurrent terminal',
    });
    sessions.push(second.id);
    const third = await rpc('session.open', {
      projectId: b.id,
      kind: 'terminal',
      title: 'Other project terminal',
    });
    sessions.push(third.id);
    for (const id of sessions) {
      await rpc('session.resize', { id, rows: 40, cols: 120 });
      await assert.rejects(rpc('session.resize', { id, rows: 0, cols: 80 }), /between 1 and 500/);
      await rpc('session.write', { id, data: "Write-Output ('WRONGSTACK_'+'NATIVE_READY')\r" });
    }
    const output = async (id) =>
      Buffer.from((await rpc('session.read', { id, offset: 0 })).bytes).toString();
    await waitFor(
      async () =>
        (await Promise.all(sessions.map(output))).every((s) =>
          s.includes('WRONGSTACK_NATIVE_READY'),
        ),
      'Three real terminal outputs',
    );
    await page.locator('.xterm-screen').waitFor();
    await page.screenshot({ path: join(artifactDir, 'native-sessions.png'), fullPage: true });
    await page.reload();
    await page.getByText('Local engine connected', { exact: true }).waitFor();
    assert.equal(
      (await rpc('snapshot')).sessions.filter(
        (s) => s.kind === 'terminal' && s.status === 'running',
      ).length,
      3,
    );
    // Kill only the disposable UI process, then relaunch: the host and PTYs must be identical.
    await stopUi();
    assert.equal((await rpc('snapshot')).hostPid, initialPid);
    await launch();
    assert.equal((await rpc('snapshot')).hostPid, initialPid);
    await rpc('session.write', { id: first.id, data: "Write-Output ('REATTACH_'+'PASSED')\r" });
    await waitFor(
      async () => (await output(first.id)).includes('REATTACH_PASSED'),
      'Terminal reattach after UI restart',
    );
    console.log('PASS: three PTYs, reload, and UI restart');
    // Real WrongStack backend; every project/session screen stays in the native shell.
    const agent = await rpc('session.open', {
      projectId: a.id,
      kind: 'agent',
      title: 'WrongStack engine proof',
    });
    sessions.push(agent.id);
    await waitFor(
      async () => {
        const s = (await rpc('snapshot')).sessions.find((s) => s.id === agent.id);
        if (s.status === 'error') throw new Error(s.error);
        return s.status === 'running';
      },
      'WrongStack engine readiness',
      100000,
    );
    const identity = await waitFor(async () => {
      const info = await rpc('engine.identity', { id: agent.id });
      return info.sessionId ? info : null;
    }, 'Native core session identity');
    await page.locator('.tree-session').filter({ hasText: 'WrongStack engine proof' }).click();
    await page.locator('[data-engine-session="' + identity.sessionId + '"]').waitFor();
    await page.getByRole('textbox', { name: 'Message WrongStack' }).waitFor();
    assert.equal(
      await page.getByRole('button', { name: 'Send message', exact: true }).isEnabled(),
      false,
    );
    await page.getByRole('button', { name: 'Configure provider', exact: true }).waitFor();
    await page
      .getByRole('textbox', { name: 'Message WrongStack' })
      .fill('Keep this native session draft.');
    await page.getByRole('button', { name: 'Fleet', exact: true }).click();
    await page.locator('.session-card-main').filter({ hasText: 'Concurrent terminal' }).click();
    await page.locator('.session-tab-label').filter({ hasText: 'WrongStack engine proof' }).click();
    assert.equal(
      await page.getByRole('textbox', { name: 'Message WrongStack' }).inputValue(),
      'Keep this native session draft.',
    );
    await waitFor(
      async () =>
        (
          await page.evaluate(
            (id) =>
              window.__TAURI_INTERNALS__.invoke('host_request', {
                method: 'draft.get',
                params: { id },
              }),
            agent.id,
          )
        ).text === 'Keep this native session draft.',
      'Draft committed in native storage',
    );
    await page.reload();
    await page.locator('.tree-session').filter({ hasText: 'WrongStack engine proof' }).click();
    await page
      .locator('[data-engine-session="' + identity.sessionId + '"]')
      .waitFor({ timeout: 60000 });
    assert.equal(
      await page.getByRole('textbox', { name: 'Message WrongStack' }).inputValue(),
      'Keep this native session draft.',
      'Unsent text survives a desktop renderer reload',
    );
    await stopUi();
    await launch();
    await page.locator('.tree-session').filter({ hasText: 'WrongStack engine proof' }).click();
    await page
      .locator('[data-engine-session="' + identity.sessionId + '"]')
      .waitFor({ timeout: 60000 });
    assert.equal(
      await page.getByRole('textbox', { name: 'Message WrongStack' }).inputValue(),
      'Keep this native session draft.',
      'Unsent text survives a desktop UI restart',
    );
    await page.getByRole('textbox', { name: 'Message WrongStack' }).fill('');
    await waitFor(
      async () =>
        (
          await page.evaluate(
            (id) =>
              window.__TAURI_INTERNALS__.invoke('host_request', {
                method: 'draft.get',
                params: { id },
              }),
            agent.id,
          )
        ).text === '',
      'Cleared draft removed from native storage',
    );
    await exerciseNativeAppearance({ page, rpc, waitFor, artifactDir });
    assert.equal(
      page.context().pages().length,
      1,
      'Agent must stay inside the desktop, without a WebUI window',
    );
    await assert.rejects(rpc('session.endpoint', { id: agent.id }), /Unknown method/);
    await rpc('engine.send', { id: agent.id, message: { type: 'stats.get', payload: {} } });
    await waitFor(
      async () =>
        (await rpc('engine.events', { id: agent.id, offset: 0 })).events.some(
          (e) => e.type === 'stats.get',
        ),
      'Real core stats response',
    );
    await page
      .getByRole('navigation', { name: 'Agent workspace views' })
      .getByRole('button', { name: 'Files', exact: true })
      .click();
    await page.getByRole('treeitem', { name: 'README.md', exact: true }).click();
    await page
      .locator('.native-file-content')
      .getByText('Native desktop fixture: all screens stay in Tauri.', { exact: true })
      .waitFor();
    assert.equal(
      (await rpc('engine.events', { id: agent.id, offset: 0 })).events.some(
        (event) => event.type === 'files.read',
      ),
      false,
      'Files opened beside a conversation use project services, preserving older conversation engines',
    );
    await page
      .getByRole('navigation', { name: 'Agent workspace views' })
      .getByRole('button', { name: 'Settings', exact: true })
      .click();
    await page.getByRole('heading', { name: 'Default model' }).waitFor();
    await page
      .getByLabel('Credential provider', { exact: true })
      .locator('option[value="openai"]')
      .waitFor({ state: 'attached' });
    // Configure the real backend exclusively through the desktop-owned settings.
    await page.getByRole('button', { name: 'Custom endpoint', exact: true }).click();
    const fillConnection = async () => {
      await page.getByLabel('Custom provider ID', { exact: true }).fill('desktop-local');
      await page.getByLabel('Provider base URL', { exact: true }).fill(providerFixture.baseUrl);
      await page.getByLabel('Custom model ID', { exact: true }).fill(fixtureModel);
      await page.getByLabel('Provider API key', { exact: true }).fill(fixtureKey);
      await page
        .getByRole('checkbox', { name: 'This model supports tool calls', exact: true })
        .check();
      await page
        .getByRole('checkbox', { name: 'This model supports image input', exact: true })
        .check();
    };
    await fillConnection();
    await page.screenshot({ path: join(artifactDir, 'native-provider-setup.png'), fullPage: true });
    await page.getByRole('button', { name: 'Save and use provider', exact: true }).click();
    await page.locator('.model-selector').getByText(fixtureModel, { exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Message WrongStack' }).waitFor();
    // Configure the ordinary chat cases explicitly; the composer exercise below
    // separately verifies the profile's automatic refinement workflow.
    await page.locator('.composer-options').getByLabel('Composer options', { exact: true }).click();
    await page.getByRole('checkbox', { name: 'Refine before sending', exact: true }).uncheck();
    await waitFor(
      async () =>
        !(await page
          .getByRole('checkbox', { name: 'Refine before sending', exact: true })
          .isChecked()),
      'Explicit direct-send preference',
    );
    await page.locator('.composer-options').getByLabel('Composer options', { exact: true }).click();
    assert.equal(
      await page.getByRole('button', { name: 'Configure provider', exact: true }).count(),
      0,
    );
    await page
      .getByRole('textbox', { name: 'Message WrongStack' })
      .fill('Reply with the native connection verification sentence. Do not call tools.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page
      .locator('.chat-message.assistant')
      .filter({ hasText: fixtureText })
      .first()
      .waitFor({ timeout: 60000 });
    await waitFor(
      async () => !(await page.getByRole('button', { name: 'Stop run', exact: true }).count()),
      'Native streamed run completion',
      60000,
    );
    assert.ok(providerFixture.calls.some((call) => call.authorized && call.stream === true));
    await waitFor(
      async () =>
        (
          await page.evaluate(
            (id) =>
              window.__TAURI_INTERNALS__.invoke('host_request', {
                method: 'draft.get',
                params: { id },
              }),
            agent.id,
          )
        ).text === '',
      'Initial sent draft cleared',
      60000,
    );
    await exerciseNativeDraftConflict({
      page,
      project: a,
      agent,
      identity,
      waitFor,
      providerFixture,
      artifactDir,
    });
    await exerciseNativeConversation({ page, identity, artifactDir, waitFor, providerFixture });
    await exerciseNativeComposer({
      page,
      configPath: join(dir, 'wrongstack/profiles/default/config.json'),
      identity,
      agent,
      rpc,
      artifactDir,
      waitFor,
      providerFixture,
    });
    await exerciseNativeComposerResources({
      page,
      project: a,
      otherProject: b,
      identity,
      agent,
      rpc: workspaceRpc,
      engineRpc: rpc,
      artifactDir,
      waitFor,
      providerFixture,
    });
    await exerciseNativeAttachments({
      page,
      agent,
      rpc,
      artifactDir,
      waitFor,
      providerFixture,
      identity,
      restartUi: async () => {
        await stopUi();
        await launch();
        return page;
      },
    });
    await exerciseNativeApprovals({ page, agent, rpc, artifactDir, waitFor, providerFixture });
    await exerciseNativeNextSteps({ page, artifactDir, waitFor, providerFixture });
    if (!composerOnly) {
      const views = () => page.getByRole('navigation', { name: 'Agent workspace views' });
      const assistSessions = (await rpc('snapshot')).sessions.length;
      await views().getByRole('button', { name: 'Files', exact: true }).click();
      await page.getByRole('treeitem', { name: 'README.md', exact: true }).click();
      if (await page.getByRole('button', { name: 'Expand file details', exact: true }).count())
        await page.getByRole('button', { name: 'Expand file details', exact: true }).click();
      await page
        .locator('.file-evidence-drawer')
        .getByRole('button', { name: 'Ask AI', exact: true })
        .click();
      await page.getByLabel('Code analysis preset', { exact: true }).selectOption('overview');
      const assistCalls = providerFixture.calls.length;
      await page.getByRole('button', { name: 'Run analysis', exact: true }).click();
      await page
        .locator('.code-assist-answer')
        .filter({ hasText: fixtureText })
        .waitFor({ timeout: 60000 });
      assert.ok(
        providerFixture.calls.length > assistCalls,
        'Code Assist makes a real authenticated provider call',
      );
      assert.equal(
        (await rpc('snapshot')).sessions.length,
        assistSessions,
        'Code Assist does not create a desktop conversation',
      );
      await page.screenshot({ path: join(artifactDir, 'native-code-assist.png'), fullPage: true });
      console.log(
        'PASS: desktop Code Assist runs through the real provider without creating a conversation',
      );
      await page.locator('.project-item').filter({ hasText: a.name }).click();
      await page
        .getByRole('navigation', { name: `${a.name} workspace` })
        .getByRole('button', { name: 'Files', exact: true })
        .click();
      await page.getByRole('treeitem', { name: 'README.md', exact: true }).click();
      if (await page.getByRole('button', { name: 'Expand file details', exact: true }).count())
        await page.getByRole('button', { name: 'Expand file details', exact: true }).click();
      await page
        .locator('.file-evidence-drawer')
        .getByRole('button', { name: 'Ask AI', exact: true })
        .click();
      await page.getByRole('button', { name: 'Run analysis', exact: true }).click();
      await page
        .locator('.code-assist-answer')
        .filter({ hasText: fixtureText })
        .waitFor({ timeout: 60000 });
      assert.equal(
        (await rpc('snapshot')).sessions.length,
        assistSessions,
        'Project Code Assist stays session-free',
      );
      await page.locator('.tree-session').filter({ hasText: 'WrongStack engine proof' }).click();
      console.log(
        'PASS: project Code Assist uses saved profile configuration without a conversation',
      );
      await exerciseNativeTaskExecution({
        page,
        rpc: workspaceRpc,
        project: a,
        waitFor,
        artifactDir,
        providerFixture,
      });
      await page.locator('.tree-session').filter({ hasText: 'WrongStack engine proof' }).click();
      await views().getByRole('button', { name: 'Settings', exact: true }).click();
      await page
        .locator(`#native-model-catalog option[value="${fixtureModel}"]`)
        .waitFor({ state: 'attached' });
      assert.equal(
        await page.getByLabel('Default provider', { exact: true }).inputValue(),
        'desktop-local',
        'Provider selection hydrates after settings remount',
      );
      assert.equal(
        await page.getByLabel('Default model', { exact: true }).inputValue(),
        fixtureModel,
        'Saved model survives asynchronous journal replay',
      );
      assert.equal(await page.getByLabel('Provider API key', { exact: true }).inputValue(), '');
      await page.locator('.saved-key code').filter({ hasText: '…7654' }).waitFor();
      assert.ok(
        !(await page.content()).includes(fixtureKey),
        'The saved credential is never reflected in renderer markup',
      );
      // A duplicate is a real backend refusal, not a client-only validation error.
      await page.getByRole('button', { name: 'Custom endpoint', exact: true }).click();
      await fillConnection();
      await page.getByRole('button', { name: 'Save and use provider', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'already exists' }).waitFor();
      assert.equal(await page.getByLabel('Provider API key', { exact: true }).inputValue(), '');
      // Exercise the vault-backed key.add route as well as provider.add.
      await page.getByRole('button', { name: 'Provider API key', exact: true }).click();
      await page.getByLabel('Credential provider', { exact: true }).selectOption('desktop-local');
      await page.getByLabel('Provider API key', { exact: true }).fill(fixtureKey);
      await page.getByLabel('Key label', { exact: true }).fill('desktop');
      await page.getByRole('button', { name: 'Save API key', exact: true }).click();
      await page.locator('.provider-result.saved').waitFor();
      assert.equal(await page.getByLabel('Provider API key', { exact: true }).inputValue(), '');
      await page.setViewportSize({ width: 800, height: 640 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.screenshot({
        path: join(artifactDir, 'native-provider-compact.png'),
        fullPage: true,
      });
      await page.setViewportSize({ width: 1480, height: 960 });
      const profileDirs = (
        await readdir(join(dir, 'wrongstack/profiles'), { withFileTypes: true })
      ).filter((entry) => entry.isDirectory());
      assert.equal(profileDirs.length, 1, 'A single isolated test profile');
      const savedConfig = await readFile(
        join(dir, 'wrongstack/profiles', profileDirs[0].name, 'config.json'),
        'utf8',
      );
      assert.ok(savedConfig.includes('desktop-local'), 'Provider configuration is persisted');
      assert.ok(!savedConfig.includes(fixtureKey), 'Provider keys must be encrypted at rest');
      const journal = await readFile(join(dir, 'transcripts', `${agent.id}.events.jsonl`), 'utf8');
      assert.ok(
        !journal.includes(fixtureKey),
        'Provider credentials must never enter the engine journal',
      );
      console.log(
        'PASS: native provider onboarding, encrypted vault, streamed local chat, and backend failure handling',
      );
      await page.getByRole('button', { name: 'Back to conversation', exact: true }).click();
      await page
        .getByRole('navigation', { name: 'Agent workspace views' })
        .getByRole('button', { name: 'Chat', exact: true })
        .click();
      await page.screenshot({ path: join(artifactDir, 'native-agent.png'), fullPage: true });
      await waitFor(async () => {
        const saved = JSON.parse((await rpc('snapshot')).layout ?? '{}');
        return (
          saved.section === 'fleet' &&
          saved.selected === agent.id &&
          saved.openSessionIds?.includes(agent.id) &&
          saved.openSessionIds?.includes(second.id)
        );
      }, 'Persisted native session tabs');
      await stopUi();
      await launch();
      assert.equal(
        (await rpc('engine.identity', { id: agent.id })).sessionId,
        identity.sessionId,
        'UI restart must retain the same core session',
      );
      await page
        .locator('.session-tab-label')
        .filter({ hasText: 'WrongStack engine proof' })
        .click();
      assert.equal(await page.locator('.session-tab').count(), 3);
      await page.locator('[data-engine-session="' + identity.sessionId + '"]').waitFor();
      await page.locator('.model-selector').getByText(fixtureModel, { exact: true }).waitFor();
      await waitFor(
        () =>
          page.evaluate(
            () =>
              document.documentElement.dataset.mode === 'light' &&
              document.documentElement.dataset.accent === 'blue-navy',
          ),
        'Appearance survives UI restart',
      );
      await page
        .locator('.chat-message.assistant')
        .filter({ hasText: fixtureText })
        .first()
        .waitFor();
      await page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('button', { name: 'Mission control' })
        .click();
      await page.getByRole('heading', { name: 'Mission control.' }).waitFor();
      assert.equal(await page.locator('.session-card').count(), 4);
      await page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('button', { name: 'Projects' })
        .click();
      await page.getByRole('heading', { name: 'Your projects.' }).waitFor();
      assert.equal(await page.locator('.project-card').count(), 3);
      await page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('button', { name: 'Activity' })
        .click();
      assert.equal(await page.locator('.timeline > button').count(), 4);
      await page.keyboard.press('Control+k');
      await page.getByRole('dialog').waitFor();
      await page.getByLabel('Search projects and sessions').fill('Project Beta');
      await page.getByRole('dialog').getByRole('button', { name: 'Project Beta' }).click();
      await page.getByRole('heading', { name: 'Project Beta.' }).waitFor();
      await page.setViewportSize({ width: 800, height: 640 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.screenshot({ path: join(artifactDir, 'native-compact.png'), fullPage: true });
      await page.setViewportSize({ width: 1480, height: 960 });
      await page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('button', { name: 'Mission control' })
        .click();
      await page.screenshot({ path: join(artifactDir, 'native-fleet.png'), fullPage: true });
      // A new engine process must decrypt and use the saved connection, without setup.
      const fresh = await rpc('session.open', {
        projectId: a.id,
        kind: 'agent',
        title: 'Saved provider proof',
      });
      sessions.push(fresh.id);
      const freshIdentity = await waitFor(
        async () => {
          const info = await rpc('engine.identity', { id: fresh.id });
          return info.sessionId && info.provider === 'desktop-local' && !info.needsSetup
            ? info
            : null;
        },
        'New engine loads the encrypted provider',
        100000,
      );
      await page.locator('.session-card-main').filter({ hasText: 'Saved provider proof' }).click();
      await page.locator(`[data-engine-session="${freshIdentity.sessionId}"]`).waitFor();
      await page
        .getByRole('textbox', { name: 'Message WrongStack' })
        .fill('Confirm the saved native provider connection. Do not call tools.');
      const previousCalls = providerFixture.calls.length;
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await page
        .locator('.chat-message.assistant')
        .filter({ hasText: fixtureText })
        .first()
        .waitFor({ timeout: 60000 });
      assert.ok(
        providerFixture.calls.length > previousCalls,
        'Fresh engine made an authenticated provider request',
      );
      console.log('PASS: new engine process decrypts and uses the saved provider');
      assert.deepEqual(errors, []);
      result = {
        result: 'PASS',
        binary: release ? 'release' : 'debug',
        bundledEngine: bundled,
        portableChecksumsVerified: bundled,
        portableIdentity,
        noBunOnPath: bundled,
        nativeUi: true,
        concurrentPtys: 3,
        multiProject: true,
        reload: true,
        appRestart: true,
        nativeEngineSession: true,
        noWebuiWindow: true,
        nativeFileRead: true,
        coreSessionReattach: true,
        persistentSessionTabs: true,
        sessionDraftIsolation: true,
        engineEndpointNotExposed: true,
        workspaceNavigation: true,
        nativeCompactLayout: true,
        nativeProviderOnboarding: true,
        encryptedProviderVault: true,
        providerCredentialNotJournaled: true,
        localProviderStream: true,
        providerFailureAcknowledged: true,
        savedProviderNewEngine: true,
        nativeMarkdown: true,
        nativeCopy: true,
        nativeProjectLinks: true,
        realClarifySubmitAndCancel: true,
        pendingInputReload: true,
        inputDraftIsolation: true,
        nativeAppearance: true,
        appearancePersistence: true,
        multiProjectNavigation: true,
        nativeWorkspaceManagement: true,
        projectWorkspacesWithoutSessions: true,
        companionHostCompatibility: companion,
        projectMemoryGraph: true,
        sageStructuredLibraryAndLifecycleFilter: true,
        projectKanbanDrag: true,
        kanbanBoardListAndTaskDetails: true,
        codeAtlasIndexAndDrilldown: true,
        atlasSubsystemMatrixAndImpactViews: true,
        projectAutomationWithoutSessions: true,
        separateWrongStackSettings: true,
        nativeFileManager: true,
        nativeFileEvidenceDrawer: true,
        nativeFileMutationsAndConflict: true,
        nativeFileDraftRecovery: true,
        nativeFileContentSearch: true,
        nativeGitStageUnstageReview: true,
        sageReviewDoctorAudienceRetrieval: true,
        atlasDetailedAnalysis: true,
        projectChronicleEvidence: true,
        repositoryCommitHistory: true,
        nativeCodeAssist: true,
        nativeSkillLibrary: true,
        artifacts: artifactDir,
      };
    } else {
      assert.deepEqual(errors, []);
      result = {
        result: 'PASS',
        scope: 'composer',
        portableIdentity,
        bundledEngine: bundled,
        portableChecksumsVerified: bundled,
        nativeComposer: true,
        nativeAttachments: true,
        nativeToolApprovals: true,
        nativeNextSteps: true,
        projectPromptResources: true,
        nativeFileAndSkillMentions: true,
        sessionContextInspector: true,
        nativeConversationForms: true,
        sessionModelAndEffort: true,
        sessionAgentModelPlan: true,
        topicBoundaryChoice: true,
        persistentPromptQueue: true,
        btwMailbox: true,
        stopAndSteer: true,
        refinementPreviewAndApproval: true,
        refinerRequestModelAndRecovery: true,
        compactComposer: true,
        companionHostCompatibility: companion,
        artifacts: artifactDir,
      };
    }
  }
} catch (error) {
  console.error('Native smoke failure:', error);
  await writeFile(
    join(artifactDir, 'native-process-state.json'),
    JSON.stringify(
      {
        uiPid: child?.pid,
        uiExitCode: child?.exitCode,
        uiSignal: child?.signalCode,
        debugPort: port,
        launchCount,
        browserConnected: browser?.isConnected(),
        pageClosed: page?.isClosed(),
        ownedDirectory: dir,
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(artifactDir, 'native-failure.txt'),
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  console.error('Native renderer errors:', errors);
  if (providerFixture)
    await writeFile(
      join(artifactDir, 'native-provider-call-metadata.json'),
      JSON.stringify(
        providerFixture.calls.map((call, index) => ({
          index,
          model: call.model,
          stream: call.stream,
          refiner: call.refiner,
          topicAdvisor: call.topicAdvisor,
          instructionMarkers: call.instructionMarkers,
          kanbanContext: call.kanbanContext,
        })),
        null,
        2,
      ),
    );
  await writeFile(join(artifactDir, 'native-errors.json'), JSON.stringify(errors, null, 2));
  if (page && !page.isClosed()) {
    await bounded(
      page.screenshot({
        path: join(artifactDir, 'native-failure.png'),
        fullPage: true,
        timeout: 5000,
      }),
      'Failure screenshot',
    ).catch(() => {});
    console.error(
      'Native provider status:',
      await bounded(
        page.locator('.provider-result').allTextContents(),
        'Failure provider status',
      ).catch(() => []),
    );
  }
  await writeFile(join(artifactDir, 'native-launch.log'), nativeLog);
  try {
    await writeFile(join(artifactDir, 'native-host.log'), await readFile(join(dir, 'host.log')));
  } catch {}
  const versionedScopes = (
    await readdir(join(dir, 'project-services-v1'), { withFileTypes: true }).catch(() => [])
  )
    .filter((entry) => entry.isDirectory() && /^(?:[a-f0-9]{64}|development)$/.test(entry.name))
    .map((entry) => join('project-services-v1', entry.name));
  for (const scope of ['', 'project-services-v1', ...versionedScopes]) {
    const transcriptDirectory = join(dir, scope, 'transcripts');
    for (const file of await readdir(transcriptDirectory).catch(() => [])) {
      if (!file.endsWith('.bin')) continue;
      await copyFile(
        join(transcriptDirectory, file),
        join(artifactDir, `${scope ? 'service' : 'primary'}-${file}.log`),
      ).catch(() => {});
    }
  }
  if (endpoint) {
    const snapshot = await rpc('snapshot');
    await writeFile(join(artifactDir, 'failed-state.json'), JSON.stringify(snapshot, null, 2));
    for (const id of sessions) {
      const result = await rpc('session.read', { id, offset: 0 });
      await writeFile(join(artifactDir, `${id}.log`), Buffer.from(result.bytes));
      try {
        await copyFile(
          join(dir, 'transcripts', `${id}.events.jsonl`),
          join(artifactDir, `${id}.events.jsonl`),
        );
      } catch {}
    }
  }
  throw error;
} finally {
  if (endpoint) {
    for (const id of sessions) {
      try {
        await rpc('session.kill', { id });
      } catch {}
    }
    // This PID belongs to this test's unique isolated data directory.
    try {
      const kill = spawn('taskkill', ['/PID', String(endpoint.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      await new Promise((r) => kill.once('exit', r));
    } catch {}
  }
  await stopUi();
  if (providerFixture) await providerFixture.close();
  // WebView2 can outlive a forcibly terminated UI. Terminate only browser
  // processes and detached engine daemons whose command lines name this test's unique directory.
  await cleanupOwnedProcesses();
  await rm(dir, { recursive: true, force: true, maxRetries: 25, retryDelay: 200 });
}
await writeFile(
  join(artifactDir, 'native-result.json'),
  JSON.stringify({ ...result, verifiedAt: new Date().toISOString() }, null, 2),
);
console.log(JSON.stringify(result));

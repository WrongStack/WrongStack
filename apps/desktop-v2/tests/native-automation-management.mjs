import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { editableAutomationJob } from '@wrongstack/webui-protocol';
import { fixtureModel } from './local-provider.mjs';

export async function exerciseNativeAutomationManagement({
  page,
  rpc,
  waitFor,
  project,
  otherProject,
  artifactDir,
  configPath,
  wrongstackHome,
}) {
  const profileBefore = await readFile(configPath, 'utf8');
  const workspace = () => page.locator('.automation-workspace');
  const open = async (owner) => {
    await page.locator('.project-item').filter({ hasText: owner.name }).click();
    await page.locator('.project-home-button').click();
    await page
      .locator('.project-secondary-links button')
      .filter({ hasText: 'Automations' })
      .click();
    await workspace().getByRole('button', { name: 'New automation', exact: true }).waitFor();
    await waitFor(async () => (await state(owner)).jobs !== undefined, 'Project automation state');
  };
  const http = async (owner, resource, method = 'GET', body = null) => {
    const result = await rpc('project.http', {
      projectId: owner.id,
      resource: `/api/automation/${resource}`,
      method,
      body,
      ...(method === 'POST' ? { operationId: crypto.randomUUID() } : {}),
    });
    assert.equal(result.ok, true, JSON.stringify(result.data));
    return result.data;
  };
  const state = (owner) => http(owner, 'state');
  const save = async () => {
    await workspace().getByRole('button', { name: 'Save automation', exact: true }).click();
    await workspace().getByRole('status').filter({ hasText: 'engine saved' }).waitFor();
    await waitFor(
      async () =>
        !(await workspace().getByRole('button', { name: 'Queue run', exact: true }).isDisabled()),
      'Saved automation has no unsaved changes',
    );
  };
  await open(project);
  assert.equal((await rpc('snapshot')).sessions.length, 0);
  await workspace()
    .locator('.automation-templates button')
    .filter({ hasText: 'Test triage' })
    .click();
  const template = page.getByRole('dialog', { name: 'Use automation template', exact: true });
  await template.getByRole('button', { name: 'Use template in draft', exact: true }).click();
  await template.waitFor({ state: 'hidden' });
  assert.equal(
    await workspace().getByLabel('Automation name', { exact: true }).inputValue(),
    'Test triage',
  );
  assert.equal((await state(project)).jobs.length, 0, 'Templates only update the draft');
  await workspace().getByLabel('Automation name', { exact: true }).fill('Native environment proof');
  await workspace().getByLabel('Automation image', { exact: true }).fill('trusted:1');
  await workspace().getByRole('button', { name: 'Choose automation model', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Choose automation model', exact: true });
  await picker.getByLabel('Session model provider', { exact: true }).selectOption('desktop-local');
  await picker.locator('.composer-model-list button').filter({ hasText: fixtureModel }).click();
  await picker.waitFor({ state: 'hidden' });
  await workspace().getByRole('button', { name: 'Configure environment', exact: true }).click();
  const environment = page.getByRole('dialog', { name: 'Automation environment', exact: true });
  await environment.getByLabel('Environment profile name', { exact: true }).fill('native-proof');
  await environment.getByLabel('Environment setup timeout', { exact: true }).fill('90');
  await environment
    .getByLabel('Environment setup commands', { exact: true })
    .fill('bun install --frozen-lockfile\nbun run build');
  await environment.getByRole('button', { name: 'Add service', exact: true }).click();
  await environment.getByLabel('Service 1 name', { exact: true }).fill('db');
  await environment.getByLabel('Service 1 image', { exact: true }).fill('postgres:18');
  await environment.getByLabel('Service 1 health', { exact: true }).fill('pg_isready -U test');
  await environment.getByLabel('Service 1 envNames', { exact: true }).fill('DB_PASSWORD');
  await environment.getByRole('button', { name: 'Add cache', exact: true }).click();
  await environment.getByLabel('Cache 1 name', { exact: true }).fill('bun');
  await environment.getByRole('button', { name: 'Add port', exact: true }).click();
  await environment.getByLabel('Port 1 name', { exact: true }).fill('preview');
  await environment.getByLabel('Port 1 port', { exact: true }).fill('3000');
  assert.equal(
    (await state(project)).jobs.length,
    0,
    'Environment editing never creates or launches a job',
  );
  await page.screenshot({
    path: join(artifactDir, 'native-automation-environment.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 800, height: 640 });
  const bounds = await environment.boundingBox();
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 640);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: join(artifactDir, 'native-automation-environment-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  await environment
    .getByRole('button', { name: 'Close automation environment', exact: true })
    .click();
  await environment.getByRole('button', { name: 'Keep editing environment', exact: true }).click();
  // Unapplied environment edits are kept natively per job and restored after a reload.
  const environmentKey = `automation-environment:${createHash('sha256')
    .update(JSON.stringify(['automation-environment', project.id, '@new']))
    .digest('hex')}`;
  const storedEnvironment = () =>
    page.evaluate(
      (params) =>
        window.__TAURI_INTERNALS__.invoke('host_request', { method: 'form-draft.get', params }),
      { projectId: project.id, formKey: environmentKey },
    );
  await waitFor(
    async () => (await storedEnvironment()).value?.draft?.setup?.includes('bun run build'),
    'Environment dialog draft saved natively',
  );
  await page.reload();
  await open(project);
  await workspace().getByRole('button', { name: 'Configure environment', exact: true }).click();
  await environment.getByText(/Restored unapplied environment edits/).waitFor();
  assert.equal(
    await environment.getByLabel('Environment setup commands', { exact: true }).inputValue(),
    'bun install --frozen-lockfile\nbun run build',
  );
  assert.equal(await environment.getByLabel('Port 1 port', { exact: true }).inputValue(), '3000');
  await environment.getByLabel('Cache 1 target', { exact: true }).fill('/workspace');
  await environment
    .getByRole('button', { name: 'Apply environment to draft', exact: true })
    .click();
  await environment.getByRole('alert').filter({ hasText: 'package-cache' }).waitFor();
  assert.equal((await state(project)).jobs.length, 0);
  await environment
    .getByLabel('Cache 1 target', { exact: true })
    .fill('/home/node/.bun/install/cache');
  await environment
    .getByRole('button', { name: 'Apply environment to draft', exact: true })
    .click();
  await environment.waitFor({ state: 'hidden' });
  assert.equal(
    (await state(project)).jobs.length,
    0,
    'Applying an environment only updates the local job draft',
  );
  await waitFor(
    async () => (await storedEnvironment()).value === null,
    'Applied environment edits leave native storage',
  );
  assert.equal(
    await workspace().getByLabel('Automation image', { exact: true }).getAttribute('readonly'),
    '',
  );
  assert.equal(await workspace().getByLabel('Automation name', { exact: true }).isEditable(), true);
  await workspace().getByRole('button', { name: 'Add credential reference', exact: true }).click();
  await workspace().getByLabel('Credential 1 envName', { exact: true }).fill('NATIVE_PROVIDER_KEY');
  await workspace().getByLabel('Credential 1 provider', { exact: true }).fill('desktop-local');
  await workspace().getByLabel('Credential 1 keyLabel', { exact: true }).fill('fixture');
  await workspace()
    .getByLabel('Automation environment names', { exact: true })
    .fill('NATIVE_MISSING_ENV');
  await workspace().getByLabel('Use GitHub automation trigger', { exact: true }).check();
  await workspace()
    .getByLabel('Automation GitHub repository', { exact: true })
    .fill('fixture/native-proof');
  await workspace()
    .getByLabel('Automation GitHub events', { exact: true })
    .fill('issue_comment.created, pull_request.opened');
  await workspace().getByText('Event filters', { exact: true }).click();
  await workspace().getByLabel('Automation GitHub mention', { exact: true }).fill('@wrongstack');
  await workspace().getByLabel('Automation GitHub branch', { exact: true }).fill('main');
  await workspace().getByLabel('Automation GitHub exclude bots', { exact: true }).check();
  await workspace()
    .getByLabel('Automation GitHub draft filter', { exact: true })
    .selectOption('false');
  await workspace()
    .getByLabel('Automation verification commands', { exact: true })
    .fill('bun run typecheck\nbun run test');
  await workspace().getByLabel('Automation verification timeout', { exact: true }).fill('45');
  await workspace().getByRole('button', { name: 'Preview', exact: true }).click();
  await workspace().getByRole('heading', { name: 'Launch preview', exact: true }).waitFor();
  await workspace()
    .getByText(/Missing references:.*NATIVE_MISSING_ENV/)
    .waitFor();
  await save();
  const stored = (await state(project)).jobs.find((job) => job.name === 'Native environment proof');
  assert.ok(stored);
  assert.equal(stored.template.id, 'test-triage');
  assert.equal(stored.enabled, false);
  assert.equal(stored.provider, 'desktop-local');
  assert.equal(stored.model, fixtureModel);
  assert.deepEqual(stored.environment.setupCommands, [
    ['bun', 'install', '--frozen-lockfile'],
    ['bun', 'run', 'build'],
  ]);
  assert.deepEqual(stored.environment.services[0], {
    name: 'db',
    image: 'postgres:18',
    command: [],
    healthCommand: ['pg_isready', '-U', 'test'],
    envNames: ['DB_PASSWORD'],
  });
  assert.deepEqual(stored.environment.caches, [
    { name: 'bun', target: '/home/node/.bun/install/cache' },
  ]);
  assert.equal(stored.environment.ports[0].port, 3000);
  assert.equal(stored.environment.setupTimeoutMs, 90000);
  assert.equal(stored.verification.timeoutMs, 45000);
  assert.deepEqual(stored.credentials, [
    {
      envName: 'NATIVE_PROVIDER_KEY',
      profile: 'default',
      provider: 'desktop-local',
      keyLabel: 'fixture',
    },
  ]);
  assert.equal(stored.github.filters.excludeBots, true);
  assert.equal(stored.github.filters.draft, false);
  assert.deepEqual(stored.github.events, ['issue_comment.created', 'pull_request.opened']);
  assert.equal((await state(project)).runs.length, 0);
  await workspace()
    .getByLabel('Automation instructions', { exact: true })
    .fill('Keep this unsaved Alpha job draft.');
  assert.equal(
    await workspace().getByRole('button', { name: 'Queue run', exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await workspace().getByRole('button', { name: 'Enable', exact: true }).isDisabled(),
    true,
  );
  await workspace().getByRole('button', { name: 'New automation', exact: true }).click();
  await workspace().getByLabel('Automation name', { exact: true }).fill('Unsent second job');
  await workspace()
    .getByRole('region', { name: 'Automation jobs' })
    .getByRole('button')
    .filter({ hasText: 'Native environment proof' })
    .click();
  assert.equal(
    await workspace().getByLabel('Automation instructions', { exact: true }).inputValue(),
    'Keep this unsaved Alpha job draft.',
  );
  await open(otherProject);
  assert.equal(await workspace().getByLabel('Automation name', { exact: true }).inputValue(), '');
  assert.equal((await state(otherProject)).jobs.length, 0);
  await workspace().getByLabel('Automation name', { exact: true }).fill('Beta unsaved draft');
  await open(project);
  assert.equal(
    await workspace().getByLabel('Automation instructions', { exact: true }).inputValue(),
    'Keep this unsaved Alpha job draft.',
  );
  // Unsaved job drafts are saved natively per project and restored after a renderer reload.
  const storedDrafts = (owner) =>
    page.evaluate(
      (params) =>
        window.__TAURI_INTERNALS__.invoke('host_request', { method: 'form-draft.get', params }),
      { projectId: owner.id, formKey: 'automation-drafts' },
    );
  await waitFor(async () => {
    const saved = (await storedDrafts(project)).value;
    return (
      saved?.active === stored.id &&
      saved.drafts[stored.id]?.draft.prompt === 'Keep this unsaved Alpha job draft.' &&
      saved.drafts['@new']?.draft.name === 'Unsent second job'
    );
  }, 'Automation drafts saved natively');
  await waitFor(
    async () =>
      (await storedDrafts(otherProject)).value?.drafts['@new']?.draft.name === 'Beta unsaved draft',
    'Other project keeps its own automation draft',
  );
  await page.reload();
  await open(project);
  await workspace()
    .getByText(/Recovered an unsaved automation draft/)
    .waitFor();
  assert.equal(
    await workspace().getByLabel('Automation instructions', { exact: true }).inputValue(),
    'Keep this unsaved Alpha job draft.',
  );
  const peer = await http(project, `jobs/${stored.id}`, 'PUT', {
    expectedRevision: stored.revision,
    spec: { ...editableAutomationJob(stored), prompt: 'Peer revision must survive stale UI save.' },
  });
  await workspace().getByRole('button', { name: 'Save automation', exact: true }).click();
  await workspace()
    .getByRole('alert')
    .filter({ hasText: /revision|changed|stale/i })
    .waitFor();
  assert.equal(
    await workspace().getByLabel('Automation instructions', { exact: true }).inputValue(),
    'Keep this unsaved Alpha job draft.',
  );
  assert.equal((await state(project)).jobs.find((job) => job.id === stored.id).prompt, peer.prompt);
  await workspace()
    .getByRole('button', { name: 'Discard draft / reload saved', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Reload automation draft', exact: true })
    .getByRole('button', { name: 'Discard and reload automation', exact: true })
    .click();
  await waitFor(
    async () =>
      (await workspace().getByLabel('Automation instructions', { exact: true }).inputValue()) ===
      peer.prompt,
    'Explicit automation reload',
  );
  await waitFor(
    async () => !(await storedDrafts(project)).value?.drafts[stored.id],
    'Discarded job draft leaves native storage',
  );
  await workspace().getByRole('button', { name: 'New automation', exact: true }).click();
  assert.equal(
    await workspace().getByLabel('Automation name', { exact: true }).inputValue(),
    'Unsent second job',
  );
  await workspace()
    .getByRole('region', { name: 'Automation jobs' })
    .getByRole('button')
    .filter({ hasText: 'Native environment proof' })
    .click();
  await page.screenshot({
    path: join(artifactDir, 'native-automation-management.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
  await page.screenshot({ path: join(artifactDir, 'native-automation-dark.png'), fullPage: true });
  await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
  await workspace().getByRole('button', { name: 'Enable', exact: true }).click();
  await workspace().getByRole('button', { name: 'Disable', exact: true }).waitFor();
  await workspace().getByRole('button', { name: 'Queue run', exact: true }).click();
  await workspace().getByText('The engine queued this run.', { exact: true }).waitFor();
  await workspace().getByRole('button', { name: 'Cancel run', exact: true }).click();
  await waitFor(
    async () =>
      !(await workspace().getByRole('button', { name: 'Cancel run', exact: true }).count()),
    'Offline automation queue cancellation',
  );
  const run = (await state(project)).runs.find((entry) => entry.jobId === stored.id);
  assert.equal(run.status, 'cancelled');
  assert.equal(run.result, undefined, 'Cancelled offline run has no fabricated execution result');
  await workspace().getByRole('button', { name: 'Inspect run', exact: true }).click();
  const inspector = page.getByRole('dialog', { name: `Automation run ${run.id}`, exact: true });
  await inspector.getByText(/This run has no structured execution result/).waitFor();
  await inspector.getByRole('button', { name: 'Execution log', exact: true }).click();
  await inspector.getByRole('alert').filter({ hasText: 'has not been recorded' }).waitFor();
  const evidenceRoot = join(wrongstackHome, 'automation', 'runs', run.id);
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(
    join(evidenceRoot, 'verification.json'),
    JSON.stringify({ status: 'passed', evidence: [], checks: [{ argv: null }] }),
  );
  await inspector.getByRole('button', { name: 'Independent verification', exact: true }).click();
  await inspector.getByRole('alert').filter({ hasText: 'expected report' }).waitFor();
  const binding = {
    schemaVersion: 1,
    checkId: 'fixture.check',
    evidenceKind: 'test',
    handlerVersion: 'fixture-v1',
    handlerFingerprint: 'b'.repeat(64),
    registryFingerprint: 'c'.repeat(64),
    executionClass: 'trusted_deterministic',
  };
  await writeFile(
    join(evidenceRoot, 'verification.json'),
    JSON.stringify({
      status: 'failed',
      evidence: ['verification.json'],
      reason: 'Presentation fixture only; no Docker checks were executed.',
      checks: [
        {
          argv: ['bun', 'run', 'fixture-check'],
          exitCode: 7,
          durationMs: 125,
          outputSha256: 'a'.repeat(64),
          binding,
        },
      ],
    }),
  );
  await inspector.getByRole('button', { name: 'Refresh evidence', exact: true }).click();
  await inspector
    .getByRole('heading', { name: 'Independent checks · failed', exact: true })
    .waitFor();
  await inspector.getByText('Exit 7 · 125 ms', { exact: true }).waitFor();
  await page.screenshot({
    path: join(artifactDir, 'native-automation-verification-presentation.png'),
    fullPage: true,
  });
  await writeFile(
    join(evidenceRoot, 'environment.json'),
    JSON.stringify({
      version: 1,
      name: 'native-presentation',
      fingerprint: 'f'.repeat(64),
      phase: 'candidate',
      status: 'unverified',
      network: null,
      services: [],
      caches: [
        {
          name: 'bun',
          target: '/home/node/.bun/install/cache',
          persistent: true,
          volume: 'fixture-volume',
        },
      ],
      ports: [{ name: 'preview', port: 3000, hostPort: 43123, protocol: 'http' }],
      setup: [
        {
          argv: ['bun', 'install'],
          exitCode: 7,
          durationMs: 125,
          outputSha256: 'a'.repeat(64),
          output: 'Presentation fixture only; no container was started.',
        },
      ],
    }),
  );
  await inspector.getByRole('button', { name: 'Environment receipt', exact: true }).click();
  await inspector
    .getByRole('heading', { name: 'native-presentation · candidate', exact: true })
    .waitFor();
  await inspector.getByText('Environment: unverified', { exact: true }).waitFor();
  await inspector
    .getByText('preview · container 3000 → loopback 43123 (http)', { exact: true })
    .waitFor();
  await page.screenshot({
    path: join(artifactDir, 'native-automation-environment-receipt.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 800, height: 640 });
  const inspectorBounds = await inspector.boundingBox();
  assert.ok(inspectorBounds.y >= 0 && inspectorBounds.y + inspectorBounds.height <= 640);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: join(artifactDir, 'native-automation-inspector-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  await inspector.getByRole('button', { name: 'Review publication state', exact: true }).click();
  await inspector
    .getByRole('button', { name: 'Prepare reviewed publication plan', exact: true })
    .waitFor();
  assert.equal(
    await inspector
      .getByRole('button', { name: 'Prepare reviewed publication plan', exact: true })
      .isDisabled(),
    true,
    'Cancelled run cannot prepare a publication plan',
  );
  assert.equal(
    await inspector.getByRole('button', { name: 'Publish reviewed plan', exact: true }).count(),
    0,
  );
  await inspector.getByRole('button', { name: 'Close automation run', exact: true }).click();
  await workspace().getByRole('button', { name: 'Disable', exact: true }).click();
  await workspace().getByRole('button', { name: 'Enable', exact: true }).waitFor();
  assert.equal((await rpc('snapshot')).sessions.length, 0);
  assert.equal(
    await readFile(configPath, 'utf8'),
    profileBefore,
    'Job model and credential references do not change profile settings',
  );
  assert.equal(page.context().pages().length, 1);
  console.log(
    'PASS: native automation management, per-job/project drafts and stale-save refusal; actual offline queue/cancel, missing/malformed evidence handling, seeded verification and environment presentation, and ineligible publication guard; no sessions, Docker execution or external publication',
  );
}

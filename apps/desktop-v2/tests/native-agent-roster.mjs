import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildProviderSave } from '../src/provider-settings-model.ts';
import { fixtureKey, fixtureModel } from './local-provider.mjs';
import { revealProjectTools } from './native-project-navigation.mjs';
import {
  exerciseNativeRosterCreateDraft,
  exerciseNativeRosterDocumentDrafts,
  exerciseNativeRosterRuntimeDraft,
} from './native-roster-document-drafts.mjs';

function protocol({ rpc, waitFor }) {
  const offsets = new Map();
  return async (projectId, type, payload = {}) => {
    const requestId = crypto.randomUUID(),
      scope = projectId === '@profile' ? 'profile' : 'project';
    await rpc(`${scope}.send`, {
      ...(scope === 'project' ? { projectId } : {}),
      message: { type, payload: { ...payload, requestId } },
    });
    return waitFor(
      async () => {
        const batch = await rpc(`${scope}.events`, {
          ...(scope === 'project' ? { projectId } : {}),
          offset: offsets.get(projectId) ?? 0,
        });
        offsets.set(projectId, batch.offset);
        const frame = batch.events.find((event) => event.payload?.requestId === requestId);
        if (!frame) return null;
        if (
          frame.type === 'error' ||
          frame.payload?.error ||
          frame.payload?.success === false ||
          frame.payload?.ok === false
        )
          throw Error(frame.payload.error ?? frame.payload.message ?? type);
        return frame.payload;
      },
      `Roster fixture ${type}`,
      90000,
    );
  };
}
export async function configureRosterProvider({ rpc, waitFor, providerFixture }) {
  const call = protocol({ rpc, waitFor });
  const save = buildProviderSave({
    mode: 'custom',
    id: 'desktop-local',
    label: 'fixture',
    apiKey: fixtureKey,
    baseUrl: providerFixture.baseUrl,
    model: fixtureModel,
    supportsTools: true,
    supportsVision: false,
  });
  await call('@profile', save.type, save.payload);
  await call('@profile', 'model.switch', { provider: 'desktop-local', model: fixtureModel });
  assert.equal(
    (await rpc('snapshot')).sessions.length,
    0,
    'Roster provider setup creates no conversation',
  );
}

export async function exerciseNativeAgentRoster({
  page,
  rpc,
  waitFor,
  artifactDir,
  project,
  otherProject,
  configPath,
  providerFixture,
}) {
  const call = protocol({ rpc, waitFor });
  const role = 'desktop-roster-proof',
    childRole = 'desktop-roster-child';
  const directory = join(project.root, '.wrongstack/agents', role);
  const configFile = join(directory, 'config.json');
  const profileConfig = await readFile(configPath, 'utf8');
  const catalog = () => page.getByRole('region', { name: 'Project agent roster', exact: true });
  const card = (id) =>
    catalog()
      .locator('.roster-catalog-card')
      .filter({ has: page.locator('code', { hasText: new RegExp(`^${id}$`) }) });
  const open = async (owner) => {
    await page.locator('.project-item').filter({ hasText: owner.name }).click();
    await revealProjectTools(page, owner);
    await page
      .getByRole('navigation', { name: `${owner.name} workspace` })
      .getByRole('button', { name: 'Agent Roster', exact: true })
      .click();
    await page.getByRole('heading', { name: 'Agent roster.', exact: true }).waitFor();
    await catalog().getByLabel('Search project agent roles', { exact: true }).fill('');
    await catalog().getByLabel('Agent role filter', { exact: true }).selectOption('all');
    await waitFor(
      async () => (await catalog().locator('.roster-catalog-card').count()) > 20,
      'Real built-in roster catalog',
      90000,
    );
  };
  const createRole = async (id, name, base = 'generic') => {
    await catalog().getByRole('button', { name: 'Create project role', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create project roster role', exact: true });
    await dialog.getByLabel('New role name', { exact: true }).fill(name);
    await dialog.getByLabel('New role role', { exact: true }).fill(id);
    await dialog
      .getByLabel('New role purpose', { exact: true })
      .fill(`Verify project ownership and native runtime policy for ${name}.`);
    await dialog
      .getByLabel('New role taskTypes', { exact: true })
      .fill('native-desktop, verification');
    await dialog.getByLabel('New role base', { exact: true }).selectOption(base);
    await dialog.getByRole('button', { name: 'Create project role', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await catalog().locator('.roster-role-header h2').filter({ hasText: name }).waitFor();
    await waitFor(
      async () =>
        await catalog()
          .getByRole('button', { name: 'Edit runtime policy', exact: true })
          .isEnabled(),
      'Role detail metadata loaded',
    );
  };
  const runtime = () =>
    page.getByRole('dialog', { name: `Runtime policy for ${role}`, exact: true });
  const openRuntime = async () => {
    await catalog().getByRole('button', { name: 'Edit runtime policy', exact: true }).click();
    await runtime().getByLabel('Role Tool calls', { exact: true }).waitFor();
  };
  const saveRuntime = async () => {
    await runtime().getByRole('button', { name: 'Save role runtime', exact: true }).click();
    await runtime().waitFor({ state: 'hidden' });
  };
  const pick = async (title) => {
    const picker = page.getByRole('dialog', { name: title, exact: true });
    await picker
      .getByLabel('Session model provider', { exact: true })
      .selectOption('desktop-local');
    await picker.locator('.composer-model-list button').filter({ hasText: fixtureModel }).click();
    await picker.waitFor({ state: 'hidden' });
  };
  await open(project);
  assert.equal((await rpc('snapshot')).sessions.length, 0);
  await assert.rejects(
    rpc('profile.send', {
      message: { type: 'agent-roster.create', payload: { name: 'Wrong namespace' } },
    }),
    /project workspace/,
  );
  await createRole(role, 'Desktop roster proof');
  const definition = JSON.parse(await readFile(join(directory, 'profile.json'), 'utf8'));
  assert.equal(definition.role, role);
  await openRuntime();
  await runtime().getByLabel('Role Tool calls', { exact: true }).fill('125000');
  await runtime().getByLabel('Role Total timeout (ms)', { exact: true }).fill('3600000');
  await runtime().getByLabel('Role Iterations', { exact: true }).fill('600');
  await runtime().getByLabel('Role Cost (USD)', { exact: true }).fill('12.5');
  await runtime().getByLabel('Role working directory', { exact: true }).fill('packages/alpha');
  await runtime().getByLabel('Role checkout strategy', { exact: true }).selectOption('off');
  await runtime().getByRole('button', { name: 'Choose role model', exact: true }).click();
  await pick(`Choose ${role} model`);
  await runtime().getByLabel('Override inherited tool grants', { exact: true }).check();
  await runtime().getByLabel('Search Tool grants', { exact: true }).fill('read');
  await runtime().getByLabel('read', { exact: true }).check();
  await runtime().getByLabel('Override inherited role skills', { exact: true }).check();
  await runtime().getByLabel('Search Role skills', { exact: true }).fill('testing');
  if (await runtime().getByLabel('testing', { exact: true }).count())
    await runtime().getByLabel('testing', { exact: true }).check();
  else await runtime().getByRole('button', { name: 'Add “testing”', exact: true }).click();
  await runtime().getByLabel('Use an explicit allowed-model policy', { exact: true }).check();
  await runtime().getByRole('button', { name: 'Add allowed model', exact: true }).click();
  await pick(`Choose ${role} allowed model`);
  await runtime().getByLabel('Fallback', { exact: true }).check();
  await runtime()
    .getByLabel('Enforce the allowed list for this custom role', { exact: true })
    .check();
  await runtime().getByLabel('Set a role availability window', { exact: true }).check();
  await runtime().getByLabel('Role availability start', { exact: true }).fill('22:00');
  await runtime().getByLabel('Role availability end', { exact: true }).fill('06:00');
  await runtime().getByLabel('Role availability policy', { exact: true }).selectOption('enforce');
  await saveRuntime();
  let stored = JSON.parse(await readFile(configFile, 'utf8'));
  assert.equal(stored.budget.maxToolCalls, 125000);
  assert.equal(stored.budget.timeoutMs, 3600000);
  assert.equal(stored.budget.maxIterations, 600);
  assert.deepEqual(stored.tools, ['read']);
  assert.deepEqual(stored.skillNames, ['testing']);
  assert.equal(stored.worktree, 'off');
  assert.equal(stored.availability.start, '22:00');
  assert.deepEqual(stored.modelPolicy.allowed, [
    { provider: 'desktop-local', model: fixtureModel },
  ]);
  assert.equal(stored.modelPolicy.strict, true);
  await page.screenshot({
    path: join(artifactDir, 'native-agent-roster-runtime.png'),
    fullPage: true,
  });
  await openRuntime();
  await runtime().getByLabel('Role Tool calls', { exact: true }).fill('200000');
  await writeFile(
    configFile,
    JSON.stringify({ ...stored, budget: { ...stored.budget, timeoutMs: 4200000 } }, null, 2),
  );
  await saveRuntime();
  stored = JSON.parse(await readFile(configFile, 'utf8'));
  assert.equal(stored.budget.maxToolCalls, 200000);
  assert.equal(stored.budget.timeoutMs, 4200000, 'Unrelated peer runtime fields survive');
  await openRuntime();
  await runtime().getByLabel('Role Tool calls', { exact: true }).fill('300000');
  const peer = { ...stored, budget: { ...stored.budget, maxToolCalls: 77 } };
  await writeFile(configFile, JSON.stringify(peer, null, 2));
  await runtime().getByRole('button', { name: 'Save role runtime', exact: true }).click();
  await runtime().getByRole('alert').filter({ hasText: 'changed elsewhere' }).waitFor();
  assert.equal(
    await runtime().getByLabel('Role Tool calls', { exact: true }).inputValue(),
    '300000',
  );
  assert.equal(JSON.parse(await readFile(configFile, 'utf8')).budget.maxToolCalls, 77);
  await runtime().getByRole('button', { name: 'Close role runtime', exact: true }).click();
  await runtime().getByRole('button', { name: 'Keep draft and close', exact: true }).click();
  await openRuntime();
  await runtime()
    .getByText(/Your unsaved runtime draft has been recovered/)
    .waitFor();
  assert.equal(
    await runtime().getByLabel('Role Tool calls', { exact: true }).inputValue(),
    '300000',
  );
  await runtime().getByRole('button', { name: 'Close role runtime', exact: true }).click();
  await runtime().getByRole('button', { name: 'Reload stored runtime', exact: true }).click();
  await waitFor(
    async () =>
      (await runtime().getByLabel('Role Tool calls', { exact: true }).inputValue()) === '77',
    'Explicit roster runtime reload',
  );
  await runtime().getByRole('button', { name: 'Close role runtime', exact: true }).click();

  await catalog().getByRole('button', { name: 'Read identity', exact: true }).click();
  const document = page.getByRole('dialog', {
    name: `Identity instructions for ${role}`,
    exact: true,
  });
  await document.getByRole('button', { name: 'Edit project text', exact: true }).click();
  const identity =
    '# Native roster identity\n\nKeep project ownership explicit and verify every saved runtime field.\n';
  await document.getByLabel('Role document Markdown', { exact: true }).fill(identity);
  await document.getByRole('button', { name: 'Save project document', exact: true }).click();
  await document.getByRole('status').filter({ hasText: 'saved and read back' }).waitFor();
  assert.equal(await readFile(join(directory, 'identity.md'), 'utf8'), identity);
  await document.getByRole('button', { name: 'Edit project text', exact: true }).click();
  await document
    .getByLabel('Role document Markdown', { exact: true })
    .fill('# Kept local identity');
  await writeFile(join(directory, 'identity.md'), '# Peer stored identity\n');
  await document.getByRole('button', { name: 'Save project document', exact: true }).click();
  await document.getByLabel('Current stored role document', { exact: true }).waitFor();
  assert.equal(
    await document.getByLabel('Role document Markdown', { exact: true }).inputValue(),
    '# Kept local identity',
  );
  await document.getByRole('button', { name: 'Use stored text', exact: true }).click();
  await document.getByRole('button', { name: 'Close role document', exact: true }).click();
  await exerciseNativeRosterDocumentDrafts({
    page,
    project,
    role,
    directory,
    open,
    card,
    catalog,
    waitFor,
  });
  await exerciseNativeRosterRuntimeDraft({ page, project, role, open, card, catalog, waitFor });
  await exerciseNativeRosterCreateDraft({ page, project, open, catalog, waitFor });
  await card(role).click();
  await writeFile(configFile, '{invalid runtime');
  await catalog().getByRole('button', { name: 'Refresh roster', exact: true }).click();
  await catalog().getByRole('alert').filter({ hasText: 'invalid or unreadable' }).waitFor();
  assert.equal(await readFile(configFile, 'utf8'), '{invalid runtime');
  assert.equal(
    await catalog().getByRole('button', { name: 'Edit runtime policy', exact: true }).isEnabled(),
    false,
  );
  await writeFile(configFile, JSON.stringify(peer, null, 2));
  await catalog().getByRole('button', { name: 'Refresh roster', exact: true }).click();
  await waitFor(
    async () =>
      await catalog().getByRole('button', { name: 'Edit runtime policy', exact: true }).isEnabled(),
    'Repaired roster config readback',
  );
  assert.equal(
    await readFile(configPath, 'utf8'),
    profileConfig,
    'Roster runtime and documents do not alter profile defaults',
  );

  await catalog().getByRole('button', { name: 'Learning & evidence', exact: true }).click();
  await waitFor(
    async () =>
      await catalog().getByRole('button', { name: 'Pause learning', exact: true }).isEnabled(),
    'Role learning metadata',
  );
  // The role's knowledge checklist is edited here and stored in the project's role directory.
  const knowledge = catalog().getByRole('region', { name: /^Knowledge checklist for / });
  await knowledge.getByLabel('Knowledge checklist items', { exact: true }).waitFor();
  await knowledge
    .getByLabel('Knowledge checklist items', { exact: true })
    .fill('Check the lockfile before upgrading.\nVerify the engines field.');
  await knowledge.getByRole('button', { name: 'Save checklist', exact: true }).click();
  await knowledge
    .getByRole('status')
    .filter({ hasText: 'Knowledge checklist saved for this project.' })
    .waitFor();
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, 'knowledge.json'), 'utf8')).checklist,
    ['Check the lockfile before upgrading.', 'Verify the engines field.'],
  );
  const beforeEmpty = providerFixture.calls.filter((call) => call.model === fixtureModel).length;
  await catalog().getByRole('button', { name: 'Optimize learning', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Optimize role learning', exact: true })
    .getByRole('button', { name: 'Confirm roster action', exact: true })
    .click();
  await catalog().getByRole('status').filter({ hasText: 'No pending directives' }).waitFor();
  assert.equal(
    providerFixture.calls.filter((call) => call.model === fixtureModel).length,
    beforeEmpty,
    'Empty learning never calls the model',
  );
  for (const instruction of [
    'Always verify native roster changes with bun run typecheck before reporting completion.',
    'Keep role configuration writes scoped to .wrongstack/agents/ and retain unrelated project files.',
    'Use SQL parameter binding when changing project task and memory records.',
  ]) {
    await catalog().getByLabel('Teach role instruction', { exact: true }).fill(instruction);
    await catalog().getByRole('button', { name: 'Add project instruction', exact: true }).click();
    await waitFor(
      async () =>
        (await catalog().getByLabel('Teach role instruction', { exact: true }).inputValue()) === '',
      'Teaching directive acknowledged',
    );
  }
  await waitFor(
    async () => (await catalog().locator('.roster-directives > details').count()) === 3,
    'Three actual structured directives',
  );
  const learned = await readFile(join(directory, 'learned.md'), 'utf8');
  await catalog().getByRole('button', { name: 'Pause learning', exact: true }).click();
  await catalog().getByRole('button', { name: 'Enable learning', exact: true }).waitFor();
  assert.equal(await readFile(join(directory, 'learned.md'), 'utf8'), learned);
  await catalog().getByRole('button', { name: 'Enable learning', exact: true }).click();
  await catalog().getByRole('button', { name: 'Pause learning', exact: true }).waitFor();
  await catalog().locator('.roster-capture summary').click();
  await catalog()
    .getByLabel('Role capture output', { exact: true })
    .fill(
      '## LEARNED\nAlways preserve focused test evidence under docs/desktop-v2-validation.md after changing native desktop behavior.',
    );
  await catalog()
    .getByRole('button', { name: 'Capture project instructions', exact: true })
    .click();
  await catalog()
    .locator('.roster-capture')
    .getByRole('status')
    .filter({ hasText: 'captured' })
    .waitFor();
  await page.screenshot({
    path: join(artifactDir, 'native-agent-roster-learning.png'),
    fullPage: true,
  });
  await catalog()
    .getByLabel('Teach role instruction', { exact: true })
    .fill('Keep this unsent Alpha role instruction.');
  await open(otherProject);
  await catalog().getByLabel('Search project agent roles', { exact: true }).fill(role);
  assert.equal(await card(role).count(), 0, 'Alpha custom role does not appear in Beta');
  await catalog().getByLabel('Search project agent roles', { exact: true }).fill('');
  await createRole(role, 'Beta roster proof');
  await catalog().getByRole('button', { name: 'Learning & evidence', exact: true }).click();
  assert.equal(
    await catalog().getByLabel('Teach role instruction', { exact: true }).inputValue(),
    '',
  );
  await catalog()
    .getByLabel('Teach role instruction', { exact: true })
    .fill('Beta-only: verify this project role in its own checkout using bun run typecheck.');
  await catalog().getByRole('button', { name: 'Add project instruction', exact: true }).click();
  await waitFor(
    async () =>
      (await catalog().getByLabel('Teach role instruction', { exact: true }).inputValue()) === '',
    'Beta directive persisted',
  );
  await open(project);
  await card(role).click();
  await catalog().getByRole('button', { name: 'Learning & evidence', exact: true }).click();
  assert.equal(
    await catalog().getByLabel('Teach role instruction', { exact: true }).inputValue(),
    'Keep this unsent Alpha role instruction.',
  );
  assert.equal(
    (await readFile(join(directory, 'learned.md'), 'utf8')).includes('Beta-only'),
    false,
  );
  // Unsent role text also survives a renderer reload through native project storage.
  const unsentInputs = () =>
    page.evaluate(
      (params) =>
        window.__TAURI_INTERNALS__.invoke('host_request', { method: 'form-draft.get', params }),
      { projectId: project.id, formKey: 'roster-inputs' },
    );
  await waitFor(
    async () =>
      (await unsentInputs()).value?.inputs?.[role]?.teach ===
      'Keep this unsent Alpha role instruction.',
    'Unsent role instruction acknowledged',
  );
  await page.reload();
  await open(project);
  await card(role).click();
  await catalog().getByRole('button', { name: 'Learning & evidence', exact: true }).click();
  await waitFor(
    async () =>
      (await catalog().getByLabel('Teach role instruction', { exact: true }).inputValue()) ===
      'Keep this unsent Alpha role instruction.',
    'Unsent role instruction restored after reload',
  );
  await catalog().getByLabel('Teach role instruction', { exact: true }).fill('');
  await waitFor(
    async () => !(await unsentInputs()).value?.inputs?.[role]?.teach,
    'Cleared role instruction leaves no unsent copy',
  );
  await catalog().getByRole('button', { name: 'Skill layer', exact: true }).click();
  const skill = catalog()
    .locator('.roster-skill-layer article')
    .filter({ has: page.getByRole('heading', { name: 'testing', exact: true }) });
  await skill.waitFor();
  await skill.getByRole('button', { name: 'Pin skill', exact: true }).click();
  await skill.getByRole('button', { name: 'Unpin skill', exact: true }).waitFor();
  await skill.getByRole('button', { name: 'Read / edit addendum', exact: true }).click();
  const addendum = page.getByRole('dialog', { name: `Skill addendum for ${role}`, exact: true });
  await addendum.getByRole('button', { name: 'Edit project text', exact: true }).click();
  await addendum
    .getByLabel('Role document Markdown', { exact: true })
    .fill(
      '# Testing addendum\n\nRun the focused native fixture before changing the roster runtime editor.\n',
    );
  await addendum.getByRole('button', { name: 'Save project document', exact: true }).click();
  await addendum.getByRole('status').filter({ hasText: 'saved and read back' }).waitFor();
  await addendum.getByRole('button', { name: 'Close role document', exact: true }).click();
  assert.ok(
    (await readFile(join(directory, 'skills/testing.md'), 'utf8')).includes(
      'focused native fixture',
    ),
  );
  await page.screenshot({
    path: join(artifactDir, 'native-agent-roster-skills.png'),
    fullPage: true,
  });
  await catalog().getByRole('button', { name: 'Identity & runtime', exact: true }).click();
  await createRole(childRole, 'Inherited native role', role);
  const listed = await call(project.id, 'agent-roster.list');
  const child = listed.catalog.find((entry) => entry.role === childRole);
  assert.equal(child.tools, 1);
  assert.equal(child.budget.maxToolCalls, 77);
  await catalog().getByRole('button', { name: 'Inheritance map', exact: true }).click();
  await page.getByRole('region', { name: 'Project role inheritance graph', exact: true }).waitFor();
  assert.equal(await page.locator('.roster-inheritance .react-flow__edge').count(), 2);
  await page.screenshot({
    path: join(artifactDir, 'native-agent-roster-inheritance.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 800, height: 640 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: join(artifactDir, 'native-agent-roster-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
  await page.screenshot({
    path: join(artifactDir, 'native-agent-roster-dark.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
  await card(role).click();
  await catalog().getByRole('button', { name: 'Learning & evidence', exact: true }).click();
  const originalCount = (await call(project.id, 'agent-roster.stats', { role })).entryCount;
  assert.equal(originalCount, 4);
  const bufferBefore = await readFile(join(directory, 'learned.md'), 'utf8');
  await catalog().getByRole('button', { name: 'Optimize learning', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Optimize role learning', exact: true })
    .getByRole('button', { name: 'Confirm roster action', exact: true })
    .click();
  await catalog()
    .getByRole('status')
    .filter({ hasText: `Optimized ${originalCount} buffered directives` })
    .waitFor({ timeout: 120000 });
  assert.ok(
    providerFixture.calls.some((entry) => entry.model === fixtureModel),
    'Headless roster optimization uses the real configured provider',
  );
  const consolidated = await call(project.id, 'agent-roster.read-consolidated', { role });
  // This canonical field snapshots the remaining buffer after pruning for freshness checks.
  assert.equal(consolidated.metadata.sourceEntryCount, 0);
  assert.equal(consolidated.metadata.pruned, true);
  await access(consolidated.metadata.archivePath);
  assert.equal(
    (await readFile(consolidated.metadata.archivePath, 'utf8')).trim(),
    bufferBefore.trim(),
    'All consumed directives are archived exactly',
  );
  assert.equal((await call(project.id, 'agent-roster.stats', { role })).entryCount, 0);
  assert.ok(consolidated.content.includes('Native provider'));
  await catalog().getByRole('button', { name: 'Clear consolidated document', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Clear project role document', exact: true })
    .getByRole('button', { name: 'Confirm roster action', exact: true })
    .click();
  await waitFor(
    async () => !(await call(project.id, 'agent-roster.read-consolidated', { role })).content,
    'Consolidated document clear readback',
  );
  await open(otherProject);
  await card(role).click();
  await catalog()
    .getByRole('button', { name: "Reset this role's project files", exact: true })
    .click();
  const reset = page.getByRole('dialog', { name: 'Reset project roster files', exact: true });
  await reset.getByLabel('Confirm roster reset name', { exact: true }).fill(role);
  await reset.getByRole('button', { name: 'Confirm roster action', exact: true }).click();
  await reset.waitFor({ state: 'hidden' });
  await assert.rejects(access(join(otherProject.root, '.wrongstack/agents', role)));
  await access(configFile);
  await open(project);
  await catalog().getByRole('button', { name: 'Reset project roster files', exact: true }).click();
  await reset.getByLabel('Confirm roster reset name', { exact: true }).fill(project.name);
  await reset.getByRole('button', { name: 'Confirm roster action', exact: true }).click();
  await reset.waitFor({ state: 'hidden' });
  await assert.rejects(access(join(project.root, '.wrongstack/agents')));
  await access(join(project.root, 'packages/alpha/src/index.ts'));
  assert.equal(
    (await rpc('snapshot')).sessions.length,
    0,
    'Complete roster administration creates no desktop conversations',
  );
  assert.equal(page.context().pages().length, 1, 'Roster remains inside the native desktop');
  console.log(
    'PASS: project roster catalog/create/inheritance, typed runtime policy and real files, budget preservation/merge/conflict, identity read/write/conflict, unreadable config preservation, structured directives/learning pause/capture, role and project draft isolation, skill pins/addenda, actual headless optimization/archive/clear, and scoped reset without desktop sessions',
  );
}

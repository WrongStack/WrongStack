import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveSemanticTune } from '../../../packages/core/src/execution/design-tune.ts';
import { exerciseNativeDesignDrafts } from './native-design-drafts.mjs';
import { openProjectView, revealProjectTools } from './native-project-navigation.mjs';

export async function exerciseNativeDesignStudio({
  page,
  rpc,
  project,
  otherProject,
  root,
  waitFor,
  artifactDir,
}) {
  const offsets = new Map();
  const call = async (type, payload = {}, owner = project) => {
    const requestId = crypto.randomUUID();
    await rpc('project.send', {
      projectId: owner.id,
      message: { type, payload: { ...payload, requestId } },
    });
    const reply = await waitFor(
      async () => {
        const batch = await rpc('project.events', {
          projectId: owner.id,
          offset: offsets.get(owner.id) ?? 0,
        });
        offsets.set(owner.id, batch.offset);
        return batch.events.find((event) => event.payload?.requestId === requestId)?.payload;
      },
      `Native ${type}`,
      60000,
    );
    if (reply.ok === false || reply.error)
      throw Error(String(reply.error ?? 'Design request refused'));
    return reply;
  };
  const open = async (owner) => {
    await page.locator('.project-item').filter({ hasText: owner.name }).click();
    await revealProjectTools(page, owner);
    await openProjectView(page, owner, 'Design Studio');
    await page.getByRole('region', { name: 'Project Design Studio', exact: true }).waitFor();
  };
  const count = (await rpc('snapshot')).sessions.length;
  await open(project);
  let screen = page.getByRole('region', { name: 'Project Design Studio', exact: true });
  const catalog = await call('design.list');
  const kit = catalog.kits.find((item) => item.id === 'minimal-clarity');
  assert.ok(kit, 'The bundled native engine contains the curated design kit catalog');
  await screen.getByRole('textbox', { name: 'Search design kits', exact: true }).fill(kit.id);
  await screen.getByRole('button', { name: `Preview ${kit.name}`, exact: true }).click();
  await screen.getByRole('button', { name: 'Use kit for project', exact: true }).click();
  await screen.getByRole('button', { name: 'Keep current kit', exact: true }).click();
  assert.equal((await call('design.list')).activeKit, null);
  await screen.getByRole('button', { name: 'Use kit for project', exact: true }).click();
  await screen.getByRole('button', { name: 'Confirm project kit', exact: true }).click();
  await screen.getByText('Project design kit saved.', { exact: true }).waitFor();
  assert.equal((await call('design.list')).activeKit, kit.id);
  const primary = screen.getByRole('textbox', { name: 'Design light primary', exact: true });
  await primary.fill('not-a-color');
  assert.equal(
    await screen.getByRole('button', { name: 'Save project colors', exact: true }).isDisabled(),
    true,
  );
  await primary.fill('#3355aa');
  await screen.getByRole('button', { name: 'Save project colors', exact: true }).click();
  await screen.getByText('Project color overrides saved and verified.', { exact: true }).waitFor();
  assert.equal((await call('design.list')).overrides['light.primary'], '#3355aa');
  await screen.getByRole('button', { name: 'Dark colors', exact: true }).click();
  await screen.getByRole('textbox', { name: 'Design dark primary', exact: true }).fill('#88aaff');
  await screen.getByRole('button', { name: 'Save project colors', exact: true }).click();
  await waitFor(
    async () => (await call('design.list')).overrides['dark.primary'] === '#88aaff',
    'Native dark theme save',
  );
  await screen.getByRole('combobox', { name: 'Design radius', exact: true }).selectOption('lg');
  await screen
    .getByRole('combobox', { name: 'Design density', exact: true })
    .selectOption('compact');
  await screen.getByRole('combobox', { name: 'Design motion', exact: true }).selectOption('none');
  await screen
    .getByRole('textbox', { name: 'Design font family', exact: true })
    .fill('Geist, system-ui, sans-serif');
  await screen.getByRole('button', { name: 'Save project tuning', exact: true }).click();
  await screen
    .getByText('Project shape, spacing and typography settings saved.', { exact: true })
    .waitFor();
  const tuned = (await call('design.list')).overrides;
  const expectedTune = resolveSemanticTune({
    radius: 'lg',
    density: 'compact',
    motion: 'none',
    font: 'Geist, system-ui, sans-serif',
  });
  for (const [key, value] of Object.entries(expectedTune))
    assert.equal(tuned[key], value, `Canonical tuning ${key}`);
  assert.equal(tuned['light.primary'], '#3355aa');
  assert.equal(tuned['dark.primary'], '#88aaff');
  await screen
    .getByRole('textbox', { name: 'Design output path', exact: true })
    .fill('../outside-native-theme.css');
  await screen.getByRole('button', { name: 'Review theme output', exact: true }).click();
  await screen.getByRole('button', { name: 'Write project theme', exact: true }).click();
  await screen.getByRole('alert').waitFor();
  assert.equal(await Bun.file(join(root, '..', 'outside-native-theme.css')).exists(), false);
  const output = 'src/native-design-theme.css';
  await screen.getByRole('textbox', { name: 'Design output path', exact: true }).fill(output);
  await screen.getByRole('button', { name: 'Review theme output', exact: true }).click();
  await screen.getByRole('button', { name: 'Keep reviewing output', exact: true }).click();
  assert.equal(await Bun.file(join(root, output)).exists(), false);
  await screen.getByRole('button', { name: 'Review theme output', exact: true }).click();
  await screen.getByRole('button', { name: 'Write project theme', exact: true }).click();
  await screen.getByText(`Theme written and read back: ${output}`, { exact: true }).waitFor();
  const css = await readFile(join(root, output), 'utf8');
  assert.ok(css.includes('#3355aa'));
  assert.ok(css.includes('#88aaff'));
  await writeFile(
    join(root, 'native-design-drift.tsx'),
    'export function Drift() { return <div style={{color: "#123abc"}}>Native drift</div>; }',
  );
  await writeFile(
    join(root, 'native-design-plain.tsx'),
    'export function Plain() { return <div>Native no signal</div>; }',
  );
  await screen.getByRole('button', { name: 'Scan project design', exact: true }).click();
  await screen.getByText('The engine returned the project design scan.', { exact: true }).waitFor();
  const scan = await call('design.verify');
  assert.equal(scan.source, 'kit');
  assert.ok(scan.filesScanned >= 2);
  assert.ok(scan.filesWithNoSignal >= 1);
  await screen.getByText(/files had no matching UI signals/).waitFor();
  await screen
    .getByRole('heading', { name: 'Design Studio.', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifactDir, 'native-design-studio.png'), fullPage: true });
  await page.setViewportSize({ width: 800, height: 640 });
  assert.equal(
    await screen.evaluate((element) => element.scrollWidth > element.clientWidth),
    false,
    'Compact design workspace stays within its width',
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: join(artifactDir, 'native-design-studio-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  await open(otherProject);
  assert.equal((await call('design.list', {}, otherProject)).activeKit, null);
  await open(project);
  screen = page.getByRole('region', { name: 'Project Design Studio', exact: true });
  await screen.getByRole('button', { name: /Active: / }).waitFor();
  await screen.getByRole('button', { name: 'Reset kit overrides', exact: true }).click();
  await screen.getByRole('button', { name: 'Keep current kit', exact: true }).click();
  assert.equal((await call('design.list')).overrides['light.primary'], '#3355aa');
  await screen.getByRole('button', { name: 'Reset kit overrides', exact: true }).click();
  await screen.getByRole('button', { name: 'Confirm reset overrides', exact: true }).click();
  await screen
    .getByText('Project kit replaced and saved overrides reset.', { exact: true })
    .waitFor();
  assert.deepEqual((await call('design.list')).overrides, {});
  assert.equal(
    await readFile(join(root, output), 'utf8'),
    css,
    'Resetting metadata does not rewrite the exported theme',
  );
  await exerciseNativeDesignDrafts({ page, project, open, kitId: kit.id });
  assert.equal(
    (await rpc('snapshot')).sessions.length,
    count,
    'Design studio works without conversations',
  );
  console.log(
    'PASS: native curated design gallery, light/dark color saves, semantic tuning, invalid-color/path refusal, confirmed theme output with disk readback, signal-qualified verification, reset and project isolation without conversations',
  );
}

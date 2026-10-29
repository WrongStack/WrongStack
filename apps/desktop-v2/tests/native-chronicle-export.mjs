import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The loaded Chronicle timeline exports as real files: JSONL as returned and a Markdown table. */
export async function exerciseNativeChronicleExport({ page, waitFor, artifactDir }) {
  await page.setViewportSize({ width: 1480, height: 960 });
  const heading = page.locator('.chronicle-list-heading');
  await heading
    .getByRole('button', { name: 'Export JSONL', exact: true })
    .waitFor({ timeout: 60000 });
  const loaded = Number((await heading.locator('span').first().innerText()).split(' ')[0]);
  assert.ok(loaded > 0, 'The timeline has loaded events');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: artifactDir });
  const before = new Set(await readdir(artifactDir));
  const exported = (extension) =>
    waitFor(
      async () => {
        const file = (await readdir(artifactDir)).find(
          (name) =>
            !before.has(name) &&
            name.startsWith('wrongstack-chronicle-') &&
            name.endsWith(extension),
        );
        return file ? readFile(join(artifactDir, file), 'utf8') : null;
      },
      `Chronicle ${extension} download`,
      15000,
    );
  await heading.getByRole('button', { name: 'Export JSONL', exact: true }).click();
  const events = (await exported('.jsonl'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(events.length, loaded, 'Every loaded event is exported once');
  assert.ok(events.every((event) => typeof event.eventId === 'string'));
  await page
    .getByRole('status')
    .filter({ hasText: `Export requested for the ${loaded} loaded` })
    .waitFor();
  await heading.getByRole('button', { name: 'Export Markdown', exact: true }).click();
  const markdown = (await exported('.md')).trimEnd().split('\n');
  assert.equal(markdown[0], '# WrongStack Chronicle');
  assert.equal(markdown.filter((line) => line.startsWith('| 20')).length, loaded);
  // A traced lineage exports as the engine returned it and as readable tables.
  await page.locator('.chronicle-events > button').first().click();
  await page.getByRole('button', { name: 'Trace related events', exact: true }).click();
  await heading
    .getByRole('button', { name: 'Export lineage JSON', exact: true })
    .waitFor({ timeout: 60000 });
  const lineageFile = (extension) =>
    waitFor(
      async () => {
        const file = (await readdir(artifactDir)).find(
          (name) =>
            !before.has(name) &&
            name.startsWith('wrongstack-chronicle-lineage-') &&
            name.endsWith(extension),
        );
        return file ? readFile(join(artifactDir, file), 'utf8') : null;
      },
      `Chronicle lineage ${extension} download`,
      15000,
    );
  await heading.getByRole('button', { name: 'Export lineage JSON', exact: true }).click();
  const lineage = JSON.parse(await lineageFile('.json'));
  assert.ok(Array.isArray(lineage.nodes) && lineage.nodes.length > 0, 'Lineage nodes exported');
  await heading.getByRole('button', { name: 'Export lineage Markdown', exact: true }).click();
  assert.match(await lineageFile('.md'), /^# WrongStack Chronicle lineage/);
  await cdp.detach();
  console.log(
    'PASS: Chronicle timeline and lineage export: loaded events as JSONL and Markdown, traced lineage as JSON and Markdown',
  );
}

import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TechStackStore } from '../../../packages/techstack/dist/index.js';
import { openProjectView, revealProjectTools } from './native-project-navigation.mjs';

export async function exerciseNativeTechStack({
  page,
  rpc,
  project,
  otherProject,
  wrongstackHome,
  waitFor,
  artifactDir,
}) {
  const http = async (resource, method = 'GET', body) =>
    rpc('project.http', {
      projectId: project.id,
      resource,
      method,
      body: body ?? null,
      ...(method === 'POST' ? { operationId: crypto.randomUUID() } : {}),
    });
  const open = async (owner) => {
    await page.locator('.project-item').filter({ hasText: owner.name }).click();
    await revealProjectTools(page, owner);
    await openProjectView(page, owner, 'TechStack');
    await page.getByRole('region', { name: 'Project TechStack workspace' }).waitFor();
  };
  const count = (await rpc('snapshot')).sessions.length;
  await open(project);
  const screen = page.getByRole('region', { name: 'Project TechStack workspace' });
  await screen
    .getByRole('heading', { name: 'Start with what is actually in the project.' })
    .waitFor();
  await screen.getByRole('button', { name: 'Scan local dependencies', exact: true }).click();
  const saved = await waitFor(
    async () => {
      const response = await http('/api/techstack/snapshot');
      return response.ok && response.data.snapshot ? response.data.snapshot : null;
    },
    'Real local TechStack inventory',
    100000,
  );
  assert.ok(saved.workspaces.length >= 3);
  assert.ok(saved.dependencies.length > 0);
  await screen
    .locator('.tech-job')
    .getByText('completed', { exact: true })
    .waitFor({ timeout: 60000 });
  await writeFile(
    join(artifactDir, 'analysis-model-diagnostic.json'),
    JSON.stringify(
      {
        models: (await http('/api/techstack/models')).data,
        fullDisabled: await screen
          .locator('option[value="full"]')
          .evaluate((option) => option.disabled),
      },
      null,
      2,
    ),
  );
  assert.equal(
    (await rpc('snapshot')).sessions.length,
    count,
    'Inventory never creates conversations',
  );
  assert.equal(
    await screen.locator('option[value="full"]').evaluate((option) => option.disabled),
    true,
    'No invented AI model',
  );
  const jobId = await page.evaluate(
    (id) => localStorage.getItem(`wrongstack.desktop.techstack.job.${id}`),
    project.id,
  );
  assert.equal((await http(`/api/techstack/jobs/${jobId}`)).data.job.status, 'completed');
  // Find this isolated engine's actual store; never derive identity from a UI path spelling.
  let store;
  for (const entry of await readdir(join(wrongstackHome, 'projects'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(wrongstackHome, 'projects', entry.name, 'techstack/techstack.db');
    if (!(await Bun.file(path).exists())) continue;
    const candidate = new TechStackStore({ projectSlug: entry.name, dbPath: path });
    if (candidate.getSnapshot(saved.projectId)?.id === saved.id) {
      store = candidate;
      break;
    }
    candidate.close();
  }
  assert.ok(store, 'Fixture uses the same canonical persisted snapshot as the native engine');
  try {
    const dependency = saved.dependencies[0];
    const evidence = {
      kind: 'registry',
      source: 'https://registry.example.invalid/native-fixture',
      retrievedAt: new Date().toISOString(),
      detail: 'Explicit native display fixture; no registry request was made.',
    };
    const enriched = {
      ...saved,
      id: crypto.randomUUID(),
      fingerprint: `${saved.fingerprint}-display-fixture`,
      createdAt: new Date(Date.now() + 1000).toISOString(),
      dependencies: saved.dependencies.map((item) =>
        item.id === dependency.id
          ? {
              ...item,
              locked: '1.0.0',
              latestStable: '2.0.0',
              wanted: '1.2.0',
              resolvable: '2.0.0',
              status: 'vulnerable',
              license: 'MIT',
              deprecated: false,
              yanked: false,
              evidence: [...item.evidence, evidence],
            }
          : item,
      ),
      findings: [
        {
          id: 'native-vulnerability',
          dependencyId: dependency.id,
          type: 'vulnerability',
          severity: 'high',
          action: 'upgrade_major',
          confidence: 1,
          rationale: 'Native advisory display fixture.',
          breakingRisk: 'Review the fixture API changes.',
          evidence: [{ ...evidence, kind: 'osv' }],
        },
        {
          id: 'native-interpretation',
          dependencyId: dependency.id,
          type: 'investigate',
          severity: 'info',
          action: 'none',
          confidence: 0.65,
          rationale: 'Native model interpretation fixture.',
          evidence: [{ ...evidence, kind: 'agent' }],
        },
      ],
    };
    store.saveSnapshot(enriched);
    await screen.getByRole('button', { name: 'Refresh TechStack', exact: true }).click();
    await screen
      .getByRole('button', {
        name: new RegExp(dependency.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      })
      .first()
      .click();
    const detail = screen.getByRole('article', { name: 'Dependency details' });
    await detail.getByText('Native advisory display fixture.', { exact: true }).waitFor();
    await detail.getByText(/Model interpretation.*65%/).waitFor();
    assert.equal(
      await detail
        .getByRole('button', { name: 'Research this dependency', exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(
      (await http(`/api/techstack/deps/${encodeURIComponent(dependency.id)}/research`, 'POST'))
        .status,
      503,
    );
    await detail
      .getByRole('heading', { name: dependency.name, exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(artifactDir, 'native-techstack-dependency.png'),
      fullPage: true,
    });
    // The page scrolls vertically only: name whatever reaches past its scroll box.
    const overflow = await page.evaluate(() => {
      let box = document.querySelector('.project-techstack')?.parentElement ?? null;
      while (box && getComputedStyle(box).overflowX === 'visible') box = box.parentElement;
      if (!box || box.scrollWidth <= box.clientWidth + 1) return [];
      const edge = box.getBoundingClientRect().left + box.clientWidth;
      return [...box.querySelectorAll('*')]
        .map((element) => ({ element, right: element.getBoundingClientRect().right }))
        .filter(({ right }) => right > edge + 1)
        .sort((a, b) => b.right - a.right)
        .slice(0, 6)
        .map(
          ({ element, right }) =>
            `${element.tagName.toLowerCase()}.${[...element.classList].join('.')} +${Math.round(right - edge)}px`,
        );
    });
    assert.deepEqual(overflow, [], 'The TechStack page does not scroll sideways');
    await screen
      .getByRole('textbox', { name: 'Search dependencies', exact: true })
      .fill('no-matching-native-package');
    await screen.getByText('No dependencies match this view.', { exact: true }).waitFor();
    await screen.getByRole('textbox', { name: 'Search dependencies', exact: true }).fill('');
    await screen
      .getByRole('navigation', { name: 'TechStack views' })
      .getByRole('button', { name: 'Workspaces', exact: true })
      .click();
    await screen
      .getByRole('button', { name: 'Inspect workspace dependencies', exact: true })
      .first()
      .click();
    assert.notEqual(
      await screen
        .getByRole('combobox', { name: 'Dependency workspace', exact: true })
        .inputValue(),
      '',
    );
    await screen
      .getByRole('navigation', { name: 'TechStack views' })
      .getByRole('button', { name: 'Findings', exact: true })
      .click();
    await screen
      .getByRole('combobox', { name: 'Finding severity', exact: true })
      .selectOption('high');
    assert.equal(
      await screen.getByText('Native model interpretation fixture.', { exact: true }).count(),
      0,
    );
    await screen
      .getByRole('navigation', { name: 'TechStack views' })
      .getByRole('button', { name: 'Trends', exact: true })
      .click();
    await screen.getByRole('heading', { name: 'Version movement', exact: true }).waitFor();
    assert.ok((await http('/api/techstack/trends')).data.trend.snapshots >= 2);
    await page.screenshot({
      path: join(artifactDir, 'native-techstack-trends.png'),
      fullPage: true,
    });
    await screen
      .getByRole('navigation', { name: 'TechStack views' })
      .getByRole('button', { name: 'Remediation', exact: true })
      .click();
    await screen.getByRole('checkbox').first().check();
    await screen.getByRole('button', { name: 'Review 1 selected operations', exact: true }).click();
    await screen
      .getByRole('heading', { name: 'Execute 1 selected operations?', exact: true })
      .waitFor();
    await screen.getByRole('button', { name: 'Keep reviewing plan', exact: true }).click();
    assert.equal(
      store.getSnapshot(saved.projectId).id,
      enriched.id,
      'Plan review never applies changes',
    );
    await screen
      .getByRole('combobox', { name: 'TechStack report format', exact: true })
      .selectOption('md');
    await screen.getByRole('button', { name: 'Read report', exact: true }).click();
    await screen
      .getByRole('button', { name: 'Copy TechStack Markdown report', exact: true })
      .waitFor();
    const markdown = await http(`/api/techstack/reports/${enriched.id}?format=md`);
    assert.equal(markdown.ok, true);
    assert.equal(typeof markdown.data, 'string');
    assert.ok(markdown.data.includes('TechStack'));
    for (const [format, field, expected] of [
      ['spdx', 'spdxVersion', 'SPDX-2.3'],
      ['cyclonedx', 'bomFormat', 'CycloneDX'],
      ['json', 'id', enriched.id],
    ]) {
      const report = await http(`/api/techstack/reports/${enriched.id}?format=${format}`);
      assert.equal(report.ok, true);
      assert.equal(report.data[field], expected);
    }
    await page.setViewportSize({ width: 800, height: 640 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({
      path: join(artifactDir, 'native-techstack-compact.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1480, height: 960 });
    await open(otherProject);
    await page
      .getByRole('heading', { name: 'Start with what is actually in the project.' })
      .waitFor();
    await open(project);
    await screen.locator('.tech-job').getByText('completed', { exact: true }).waitFor();
    assert.equal((await rpc('snapshot')).sessions.length, count);
    console.log(
      'PASS: native TechStack real local inventory/job/persistence without conversations, canonical display fixtures for version/finding/evidence/interpretation, workspace filters/trends/plan review, Markdown/JSON/SPDX/CycloneDX through native bridge, missing-model refusal and project isolation',
    );
  } finally {
    store.close();
  }
}

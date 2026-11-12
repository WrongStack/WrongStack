import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, relative } from 'node:path';
import { openProjectView } from './native-project-navigation.mjs';
import { findConversationMessages } from './transcript-test-helpers.mjs';

const plans = new Map();
export function planNativeDesignToolCall(tag, input) {
  const plan = { input };
  plans.set(tag, plan);
  return plan;
}
const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((part) => part.type === 'text')
          .map((part) => part.text ?? '')
          .join('\n')
      : '';

/** Only the model's tool choice is controlled; the packaged engine executes each real tool. */
export function resolveNativeDesignToolCall(body) {
  if (!body.stream || !Array.isArray(body.tools)) return undefined;
  const instruction = (body.messages ?? [])
    .filter((item) => item.role === 'user')
    .map((item) => textOf(item.content))
    .findLast((text) => /\[native-design-handoff:[a-z-]+\]/.test(text));
  const tag = instruction?.match(/\[native-design-handoff:([a-z-]+)\]/)?.[1];
  if (!tag || !plans.has(tag)) return undefined;
  const plan = plans.get(tag);
  const id = `native-design-${tag}`;
  const returned = body.messages.find((item) => item.role === 'tool' && item.tool_call_id === id);
  if (returned) {
    plan.output = textOf(returned.content);
    return undefined;
  }
  const searched = body.messages.some(
    (item) => item.role === 'tool' && item.tool_call_id === `${id}-search`,
  );
  const offered = body.tools?.some((tool) => tool.function?.name === 'design_reference');
  const name = offered || searched ? 'design_reference' : 'tool_search';
  assert.ok(
    offered || searched || body.tools?.some((tool) => tool.function?.name === 'tool_search'),
    'The packaged engine offers design_reference or its production discovery tool',
  );
  plan.calls = (plan.calls ?? 0) + Number(name === 'design_reference');
  return {
    index: 0,
    id: name === 'tool_search' ? `${id}-search` : id,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(
        name === 'tool_search' ? { query: 'design_reference' } : plan.input,
      ),
    },
  };
}

const cleanHtml = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Native design handoff</title>
<style>*{box-sizing:border-box}body{margin:0;background:#fff;color:#18202b;font:16px/1.6 Arial,sans-serif}main{max-width:720px;padding:24px;margin:auto}h1{font-size:32px;line-height:1.2}button{background:#174ea6;color:#fff;border:0;border-radius:8px;padding:12px 24px;min-height:48px;font:inherit}</style>
<main><h1>Native design handoff</h1><p>A measured fixture with a readable layout and one clear action.</p><button>Continue</button></main></html>`;

/** Real Windows payload, native IPC, engine journal, browser measurements and disk artifacts. */
export async function exerciseNativeDesignHandoff({
  page,
  rpc,
  project,
  otherProject,
  root,
  waitFor,
  artifactDir,
  sessionIds,
  providerFixture,
}) {
  const rootControl = process.env.WRONGSTACK_DESKTOP_HANDOFF_ROOT_CONTROL === '1';
  const receipt = { checks: [], tools: [], root, mode: rootControl ? 'root-control' : 'complete' };
  const pass = (text) => {
    receipt.checks.push(text);
    console.log('PASS: ' + text);
  };
  let released = false,
    requests = 0;
  const waiting = new Set();
  const server = createServer((request, response) => {
    if (request.url !== '/reference.html') {
      response.writeHead(404).end();
      return;
    }
    requests++;
    const send = () => {
      if (!response.destroyed)
        response.writeHead(200, { 'content-type': 'text/html' }).end(cleanHtml);
    };
    if (released) send();
    else waiting.add(send);
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const source = `${origin}/reference.html`;
  const offsets = new Map();
  const call = async (agent, type, payload = {}) => {
    const requestId = crypto.randomUUID();
    await rpc('engine.send', {
      id: agent.id,
      message: { type, payload: { ...payload, requestId } },
    });
    return waitFor(
      async () => {
        const batch = await rpc('engine.events', {
          id: agent.id,
          offset: offsets.get(agent.id) ?? 0,
        });
        offsets.set(agent.id, batch.offset);
        const event = batch.events.find((item) => item.payload?.requestId === requestId);
        if (!event) return null;
        if (event.type === 'error' || event.payload?.error || event.payload?.ok === false)
          throw Error(JSON.stringify(event));
        return event.payload;
      },
      type,
      90000,
    );
  };
  const openAgent = async (owner, title, workdir) => {
    const agent = await rpc('session.open', {
      projectId: owner.id,
      kind: 'agent',
      title,
      ...(workdir ? { workdir } : {}),
    });
    sessionIds.push(agent.id);
    const identity = await waitFor(
      async () => {
        const state = (await rpc('snapshot')).sessions.find((item) => item.id === agent.id);
        if (state?.status === 'error') throw Error(state.error);
        if (state?.status !== 'running') return null;
        const value = await rpc('engine.identity', { id: agent.id });
        return value.sessionId ? value : null;
      },
      title + ' readiness',
      100000,
    );
    const projectRoot = await waitFor(async () => {
      const batch = await rpc('engine.events', { id: agent.id, offset: 0 });
      return batch.events.find((event) => event.type === 'session.start')?.payload?.projectRoot;
    }, title + ' authoritative project root');
    return { ...agent, identity, projectRoot };
  };
  const show = async (agent) => {
    await page.locator('.tree-session').filter({ hasText: agent.title }).click();
    await page.locator(`[data-engine-session="${agent.identity.sessionId}"]`).waitFor();
  };
  const composer = () => page.getByRole('textbox', { name: 'Message WrongStack', exact: true });
  const chat = () =>
    page
      .getByRole('navigation', { name: 'Agent workspace views' })
      .getByRole('button', { name: 'Chat', exact: true });
  const openForm = async () => {
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /Reference Site/ })
      .click();
    return page.getByRole('dialog').getByRole('form');
  };
  const send = async (tag, input) => {
    plans.set(tag, { input });
    await composer().fill(
      `[native-design-handoff:${tag}] Run exactly this design_reference request: ${JSON.stringify(input)}`,
    );
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
  };
  const revealCompleted = async (tag) => {
    const [messageId] = await findConversationMessages(page, `[native-design-handoff:${tag}]`, 1);
    const row = page.locator(`[data-message-id="${messageId}"]`).locator('..');
    const disclosure = row.locator('details.chat-run-activity');
    await disclosure.waitFor({ state: 'attached' });
    if ((await disclosure.getAttribute('open')) === null)
      await disclosure.locator(':scope > summary').click();
  };
  const completed = async (tag) => {
    const plan = plans.get(tag);
    await waitFor(
      () => typeof plan.output === 'string',
      `Real design tool ${tag} returned`,
      150000,
    );
    await waitFor(
      async () => !(await page.getByRole('button', { name: 'Stop run', exact: true }).count()),
      'Design run finished',
      60000,
    );
    assert.equal(plan.calls, 1, 'Exactly one real design operation per request');
    receipt.tools.push({ tag, ...plan });
    await revealCompleted(tag);
  };
  const openedFile = async (path, expected) => {
    await waitFor(
      async () =>
        (await page.locator('.file-document-path').getAttribute('title'))
          ?.replaceAll('\\', '/')
          .endsWith(path),
      'Native artifact path ' + path,
      60000,
    );
    await waitFor(
      async () =>
        ((await page.locator('.native-file-content').textContent()) ?? '').includes(expected),
      'Native file contents from the owning project',
      60000,
    );
    assert.ok(
      !((await page.locator('.native-file-content').textContent()) ?? '').includes(
        'FOREIGN OR NESTED DECOY',
      ),
    );
    await chat().click();
  };
  try {
    const first = await openAgent(
      project,
      'Design owner Alpha',
      process.env.WRONGSTACK_DESKTOP_HANDOFF_ROOT_CONTROL === '1' ? undefined : 'packages/alpha',
    );
    const executionRoot = first.projectRoot;
    receipt.executionRoot = executionRoot;
    const projectArtifact = (path) =>
      relative(root, join(executionRoot, path)).replaceAll('\\', '/');
    const second = await openAgent(project, 'Design alternate Alpha');
    const foreign = await openAgent(otherProject, 'Design foreign Beta');
    const terminal = await rpc('session.open', {
      projectId: project.id,
      kind: 'terminal',
      title: 'Design excluded terminal',
    });
    sessionIds.push(terminal.id);
    await show(foreign);
    await composer().fill('Beta unsent work');
    await show(second);
    await composer().fill('Alternate Alpha unsent work');
    await show(first);
    await composer().fill('Alpha unsent work');
    const modelCalls = () =>
      providerFixture.calls.filter((item) => item.stream && !item.refiner && !item.topicAdvisor)
        .length;
    const callsBefore = modelCalls();
    const form = await openForm();
    await form.getByRole('textbox', { name: 'Reference URL or local HTML file' }).fill(source);
    await form.getByRole('combobox', { name: 'Pages to analyze' }).selectOption('1');
    await form.getByRole('combobox', { name: 'Synthesis workflow' }).selectOption('materialize-rn');
    await form.getByRole('button', { name: 'Prepare DESIGN.md prompt', exact: true }).click();
    await form.waitFor({ state: 'hidden' });
    const prepared = await composer().inputValue();
    receipt.prepared = prepared;
    assert.ok(prepared.startsWith('Alpha unsent work\n\n'));
    assert.ok(
      prepared.includes(`url: ${JSON.stringify(source)}`) && prepared.includes('react-native'),
    );
    assert.equal(plans.size, 0, 'Preparing a prompt does not call the model');
    pass(
      'Conversation prepares React Native draft, preserves text and keeps HTTPS/HTTP HTML URLs remote',
    );
    await page.locator('.project-item').filter({ hasText: project.name }).click();
    await openProjectView(page, project, 'Design Studio');
    await page.getByRole('button', { name: 'Prepare reference', exact: true }).click();
    const studio = page.getByRole('form');
    const target = studio.locator('select').first();
    const choices = await target.locator('option').allTextContents();
    assert.equal(choices[0], 'Choose a project conversation…');
    assert.deepEqual(choices.slice(1).sort(), [first.title, second.title].sort());
    await studio.getByRole('combobox', { name: 'Synthesis workflow' }).selectOption('compare');
    await studio
      .getByRole('textbox', { name: 'Implementation URL or local HTML file' })
      .fill('broken.html');
    await studio.getByRole('textbox', { name: 'Extracted reference name' }).fill('native-handoff');
    assert.equal(
      await studio.getByRole('button', { name: 'Prepare review prompt', exact: true }).isDisabled(),
      true,
    );
    await target.selectOption(first.id);
    await studio.getByRole('button', { name: 'Prepare review prompt', exact: true }).click();
    await composer().waitFor();
    assert.ok((await composer().inputValue()).startsWith(prepared + '\n\n'));
    assert.ok((await composer().inputValue()).includes('"action":"compare"'));
    await waitFor(
      async () => JSON.parse((await rpc('snapshot')).layout ?? '{}').selected === first.id,
      'Native host confirms the prepared conversation layout',
    );
    await page.reload();
    await composer().waitFor();
    await waitFor(
      async () => (await composer().inputValue()).includes('"action":"compare"'),
      'Prepared draft restored from native storage',
    );
    await show(second);
    assert.equal(await composer().inputValue(), 'Alternate Alpha unsent work');
    await show(foreign);
    assert.equal(await composer().inputValue(), 'Beta unsent work');
    await show(first);
    assert.equal(
      modelCalls(),
      callsBefore,
      'Preparation did not send a conversation request to the provider',
    );
    pass(
      'Studio requires a same-project agent, excludes terminal/foreign sessions and preserves drafts after host-confirmed layout reload',
    );
    const prefs = await call(first, 'prefs.get');
    const options = page.locator('.composer-options');
    if ((await options.getAttribute('open')) === null)
      await options.getByLabel('Composer options', { exact: true }).click();
    const refine = options.getByRole('checkbox', { name: 'Refine before sending', exact: true });
    await waitFor(
      async () => (await refine.isChecked()) === (prefs.enhanceEnabled === true),
      'Native refinement preference has loaded',
    );
    await refine.uncheck();
    await waitFor(
      async () => !(await refine.isChecked()) && (await refine.isEnabled()),
      'Direct-send fixture preference saved',
    );
    assert.equal((await call(first, 'prefs.get')).enhanceEnabled, false);
    await options.getByLabel('Composer options', { exact: true }).click();
    const spec = '.design/references/native-handoff/DESIGN.md';
    for (const base of [otherProject.root, root, join(root, 'packages/alpha')].filter(
      (base) => relative(executionRoot, base) !== '',
    )) {
      await mkdir(join(base, '.design/references/native-handoff'), { recursive: true });
      await writeFile(join(base, spec), 'FOREIGN OR NESTED DECOY');
    }
    await writeFile(join(executionRoot, 'reference.html'), cleanHtml);
    await writeFile(
      join(executionRoot, 'broken.html'),
      cleanHtml.replace(
        '</style>',
        'main{min-width:900px}button{font-size:9px;color:#e1e1e1;background:#e2e2e2;padding:0;min-height:8px}</style>',
      ),
    );
    const allowed = await call(first, 'browser.policy', { args: `allow ${origin}` });
    assert.equal(allowed.ok, true);
    await send('extract', {
      action: 'extract',
      url: source,
      maxPages: 1,
      name: 'native-handoff',
      viewports: [1024, 375],
    });
    await waitFor(
      () => {
        const early = plans.get('extract').output;
        if (early && requests === 0)
          throw Error(`The real extraction returned before reaching the page: ${early}`);
        return requests > 0;
      },
      'Real browser reaches the gated reference',
      120000,
    );
    await revealCompleted('extract');
    const extraction = page.getByRole('region', {
      name: 'Reference Site → DESIGN.md Synthesis',
      exact: true,
    });
    await extraction.waitFor();
    assert.equal(
      await extraction.getByRole('button', { name: 'Open DESIGN.md', exact: true }).count(),
      0,
    );
    assert.ok(await extraction.locator('[data-state="running"]').count());
    await page.screenshot({ path: join(artifactDir, 'native-design-running.png'), fullPage: true });
    released = true;
    for (const release of waiting) release();
    waiting.clear();
    await completed('extract');
    const specText = await readFile(join(executionRoot, spec), 'utf8');
    assert.equal(
      await extraction.getByRole('button', { name: 'Open DESIGN.md', exact: true }).count(),
      1,
      `A completed extraction must expose its actual artifact under ${executionRoot}`,
    );
    await extraction.getByRole('button', { name: 'Open DESIGN.md', exact: true }).click();
    await writeFile(join(artifactDir, 'native-generated-design.md'), specText);
    assert.ok(specText.includes(source));
    const specHeading = /^# (.+)$/m.exec(specText)?.[1];
    assert.ok(specHeading, 'The actual specification has its own document heading');
    await openedFile(projectArtifact(spec), specHeading);
    pass(
      'Real extraction progress hides artifact action until completion and opens project-root DESIGN.md from nested workdir',
    );
    if (rootControl) return;
    await send('inspect', {
      action: 'inspect',
      file: 'broken.html',
      surface: 'app',
      viewports: [1024, 375],
    });
    await completed('inspect');
    const inspection = page.getByRole('region', {
      name: 'Rendered design inspection',
      exact: true,
    });
    await inspection.waitFor();
    const inspectionDisk = await readFile(
      join(executionRoot, '.design/inspect/broken/inspect.md'),
      'utf8',
    );
    const inspectionReport = await inspection
      .locator('.design-extraction-artifact code')
      .textContent();
    assert.match(
      inspectionReport,
      /^\.design\/inspect\/broken\/(?:runs\/[a-f0-9-]{36}\/)?inspect\.md$/,
    );
    assert.equal(await readFile(join(executionRoot, inspectionReport), 'utf8'), inspectionDisk);
    await writeFile(join(artifactDir, 'native-generated-inspect.md'), inspectionDisk);
    const counts = inspectionDisk.match(/(\d+) FAIL · (\d+) WARN/);
    assert.ok(counts && Number(counts[1]) > 0);
    assert.ok((await inspection.textContent()).includes(`${counts[1]} FAIL · ${counts[2]} WARN`));
    assert.match(await inspection.textContent(), /1024, 375 px/);
    assert.ok(await inspection.locator('time').getAttribute('datetime'));
    await inspection.getByRole('button', { name: 'Open report', exact: true }).click();
    await openedFile(projectArtifact(inspectionReport), 'Inspect');
    await send('compare', { action: 'compare', file: 'broken.html', reference: 'native-handoff' });
    await completed('compare');
    const comparison = page.getByRole('region', {
      name: 'Design fidelity comparison',
      exact: true,
    });
    await comparison.waitFor();
    const fidelityDisk = await readFile(
      join(executionRoot, '.design/references/native-handoff/fidelity.md'),
      'utf8',
    );
    const comparisonReport = await comparison
      .locator('.design-extraction-artifact code')
      .textContent();
    assert.match(
      comparisonReport,
      /^\.design\/references\/native-handoff\/(?:runs\/[a-f0-9-]{36}\/)?fidelity\.md$/,
    );
    assert.equal(await readFile(join(executionRoot, comparisonReport), 'utf8'), fidelityDisk);
    await writeFile(join(artifactDir, 'native-generated-fidelity.md'), fidelityDisk);
    const score = fidelityDisk.match(/^Overall (\d+(?:\.\d+)?)%/m)?.[1];
    assert.ok(score && Number(score) < 100, 'Altered implementation differs from the reference');
    assert.ok((await comparison.textContent()).includes(`Fidelity ${score}%`));
    assert.match(await comparison.textContent(), /native-handoff/);
    await page.setViewportSize({ width: 800, height: 600 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await comparison.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(artifactDir, 'native-design-review-compact.png'),
      fullPage: true,
    });
    await comparison.getByRole('button', { name: 'Open report', exact: true }).click();
    await openedFile(projectArtifact(comparisonReport), 'Fidelity');
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /Run activity/ })
      .click();
    const activity = page.getByRole('region', { name: 'Design fidelity comparison', exact: true });
    await activity.getByRole('button', { name: 'Open report', exact: true }).click();
    await openedFile(projectArtifact(comparisonReport), 'Fidelity');
    pass(
      'Actual inspection and fidelity results display measurements and open their own report in transcript and Run activity',
    );
    await send('missing', {
      action: 'extract',
      file: 'missing.html',
      name: 'missing-handoff',
      viewports: [375],
    });
    await completed('missing');
    const failed = page
      .getByRole('region', { name: 'Reference Site → DESIGN.md Synthesis', exact: true })
      .last();
    assert.equal(
      await failed.getByRole('button', { name: 'Open DESIGN.md', exact: true }).count(),
      0,
    );
    pass('A real failed extraction offers no completed artifact action');
  } finally {
    receipt.plans = Object.fromEntries(plans);
    released = true;
    for (const release of waiting) release();
    waiting.clear();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await writeFile(
      join(artifactDir, 'design-handoff-receipt.json'),
      JSON.stringify(receipt, null, 2),
    );
  }
}

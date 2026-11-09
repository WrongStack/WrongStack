import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { portableDirectory } from '../scripts/portable.ts';
import { longReplyLines } from './local-provider.mjs';
import { openProjectView } from './native-project-navigation.mjs';

const mb = (bytes) => Math.round((bytes / 1048576) * 10) / 10;
const since = (start) => Math.round(performance.now() - start);

/**
 * Memory of every process this app owns: the UI process, its WebView2 processes, the native host
 * and the engines it started. Working sets count shared pages in each process; private bytes do
 * not, so their sum is the closer estimate of what the app costs.
 */
function processMemory({ dataDir, uiPid, hostPid }) {
  // Command lines stay in PowerShell: only whether one names the data directory, and the
  // script a Bun process runs, come back.
  const code = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    '$dir = $env:WRONGSTACK_PERF_DIR',
    "Get-CimInstance Win32_Process | ForEach-Object { $line = [string]$_.CommandLine; [pscustomobject]@{ ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; Name = $_.Name; WorkingSetSize = $_.WorkingSetSize; PrivatePageCount = $_.PrivatePageCount; Owned = $line.Contains($dir); Script = $(if ($line -match '([A-Za-z0-9_.-]+[.][cm]?[jt]s)') { $Matches[1] } else { $null }) } } | ConvertTo-Json -Compress",
  ].join('; ');
  const out = spawnSync(
    join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', code],
    {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, WRONGSTACK_PERF_DIR: dataDir },
    },
  );
  assert.equal(out.status, 0, out.stderr);
  const all = JSON.parse(out.stdout);
  const owned = new Set([uiPid, hostPid]);
  for (const item of all) if (item.Owned) owned.add(item.ProcessId);
  for (let grew = true; grew; ) {
    grew = false;
    for (const item of all)
      if (!owned.has(item.ProcessId) && owned.has(item.ParentProcessId)) {
        owned.add(item.ProcessId);
        grew = true;
      }
  }
  const groups = {};
  let workingSet = 0;
  let privateBytes = 0;
  for (const item of all.filter((candidate) => owned.has(candidate.ProcessId))) {
    const group =
      item.ProcessId === uiPid
        ? 'ui'
        : /msedgewebview2/i.test(item.Name)
          ? 'webview'
          : 'hostAndEngines';
    groups[group] ??= { processes: 0, workingSetMb: 0, privateMb: 0, byName: {} };
    groups[group].processes++;
    const role = /^bun/i.test(item.Name) && item.Script ? `${item.Name} ${item.Script}` : item.Name;
    groups[group].byName[role] ??= { processes: 0, privateMb: 0 };
    const named = groups[group].byName[role];
    named.processes++;
    named.privateMb = mb(named.privateMb * 1048576 + item.PrivatePageCount);
    groups[group].workingSetMb = mb(groups[group].workingSetMb * 1048576 + item.WorkingSetSize);
    groups[group].privateMb = mb(groups[group].privateMb * 1048576 + item.PrivatePageCount);
    workingSet += item.WorkingSetSize;
    privateBytes += item.PrivatePageCount;
  }
  return { workingSetMb: mb(workingSet), privateMb: mb(privateBytes), groups };
}

/** Animation-frame timing in the page: how often the window could not paint on time. */
const startFrames = (page) =>
  page.evaluate(() => {
    const probe = { gaps: [], last: performance.now(), on: true };
    window.__nativePerfFrames = probe;
    const tick = (time) => {
      if (!probe.on) return;
      probe.gaps.push(time - probe.last);
      probe.last = time;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
const stopFrames = (page) =>
  page.evaluate(() => {
    const probe = window.__nativePerfFrames;
    probe.on = false;
    const gaps = probe.gaps.slice(1).sort((a, b) => a - b);
    return {
      frames: gaps.length,
      p95Ms: Math.round(gaps[Math.floor(gaps.length * 0.95)] ?? 0),
      longestMs: Math.round(gaps.at(-1) ?? 0),
      over50Ms: gaps.filter((gap) => gap > 50).length,
      over100Ms: gaps.filter((gap) => gap > 100).length,
    };
  });

async function directorySize(path) {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true }))
    total += entry.isDirectory()
      ? await directorySize(join(path, entry.name))
      : (await stat(join(path, entry.name))).size;
  return total;
}

async function packageSizes({ root, release }) {
  const app = resolve(root, 'apps/desktop-v2');
  const size = async (path) => {
    try {
      return mb(
        (await stat(path)).isDirectory() ? await directorySize(path) : (await stat(path)).size,
      );
    } catch {
      return null;
    }
  };
  const portable = (() => {
    try {
      return portableDirectory(app);
    } catch {
      return null;
    }
  })();
  return {
    build: release ? 'release' : 'debug',
    nativeExecutableMb: await size(
      join(app, `src-tauri/target/${release ? 'release' : 'debug'}/wrongstack-desktop-native.exe`),
    ),
    frontendAssetsMb: await size(join(app, 'dist')),
    portable: portable
      ? {
          directory: portable.split(/[/\\]/).at(-1),
          nativeExecutableMb: await size(join(portable, 'wrongstack-desktop-native.exe')),
          engineExecutableMb: await size(join(portable, 'wrongstack-engine.exe')),
        }
      : null,
  };
}

/**
 * Startup, memory, large trees/transcripts/catalogs, terminal floods and package size, measured
 * on the real native app. Numbers are recorded, not judged; only broken behavior fails the run.
 */
export async function exerciseNativePerformance({
  page,
  rpc,
  project,
  waitFor,
  artifactDir,
  sessionIds,
  dataDir,
  providerFixture,
  uiPid,
  startup,
  relaunchUi,
  release,
  root,
}) {
  const hostPid = (await rpc('snapshot')).hostPid;
  const memory = () => processMemory({ dataDir, uiPid: uiPid(), hostPid });
  const results = { startup: { ...startup }, memory: {} };

  // A second UI launch reuses the running host, like reopening the window.
  const relaunched = await relaunchUi();
  page = relaunched.page;
  results.startup.uiRelaunch = relaunched.launch;
  await page.waitForTimeout(3000);
  results.memory.idle = memory();
  console.log(`PERF startup ${JSON.stringify(results.startup)}`);
  console.log(`PERF idle memory ${JSON.stringify(results.memory.idle)}`);

  // A conversation's turn: how long the engine takes to reach the provider, and to finish.
  const openConversation = async (title) => {
    const session = await rpc('session.open', { projectId: project.id, kind: 'agent', title });
    sessionIds.push(session.id);
    await waitFor(
      async () => (await rpc('engine.identity', { id: session.id })).sessionId,
      `${title} engine`,
      100000,
    );
    await rpc('engine.send', {
      id: session.id,
      message: {
        type: 'prefs.update',
        payload: { autonomy: 'off', enhanceEnabled: false, requestId: crypto.randomUUID() },
      },
    });
    await page.locator('.tree-session').filter({ hasText: title }).click();
    const composer = page.getByRole('textbox', { name: 'Message WrongStack', exact: true });
    await composer.waitFor({ timeout: 100000 });
    // The window can render before the preference update lands; make direct send explicit so no
    // refinement review sits in front of a timed turn.
    const options = page
      .locator('.composer-options')
      .getByLabel('Composer options', { exact: true });
    const refine = page.getByRole('checkbox', { name: 'Refine before sending', exact: true });
    await options.click();
    // An unchecked box may only mean the profile's value has not streamed in yet. Switch it on
    // and off through the composer, which holds a confirmed choice until the stream reports it,
    // and wait for each save to finish (the box is disabled while it runs).
    const settled = async (checked) =>
      (await refine.isChecked()) === checked && (await refine.isEnabled());
    if (!(await refine.isChecked())) {
      await refine.check();
      await waitFor(() => settled(true), `${title} refinement saved on`);
    }
    await refine.uncheck();
    await waitFor(() => settled(false), `${title} direct send`);
    await options.click();
    return { session, composer };
  };
  const keep = page.getByRole('button', { name: 'Keep original draft', exact: true });
  const idle = () =>
    waitFor(
      async () => {
        if ((await keep.count()) > 0) await keep.first().click();
        return !(await page.getByRole('button', { name: 'Stop run', exact: true }).count());
      },
      'Turn finished',
      180000,
    );
  const timedTurn = async ({ session, composer }, marker) => {
    await page.getByRole('combobox', { name: 'Message delivery mode' }).selectOption('btw');
    await composer.fill(`${marker} Answer briefly.`);
    // The conversation's events with their arrival time, to show which step holds the turn.
    let offset = 0;
    for (let more = true; more; ) {
      const batch = await rpc('engine.events', { id: session.id, offset });
      more = batch.events.length > 0 && batch.offset !== offset;
      offset = batch.offset;
    }
    const timeline = [];
    let watching = true;
    const sentAt = Date.now();
    const watcher = (async () => {
      while (watching) {
        const batch = await rpc('engine.events', { id: session.id, offset });
        offset = batch.offset;
        for (const event of batch.events) {
          const last = timeline.at(-1);
          const at = Date.now() - sentAt;
          if (last?.type === event.type) last.count++;
          else timeline.push({ at, type: event.type, count: 1 });
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })();
    await page.locator('.composer-send').click();
    await waitFor(
      () => providerFixture.calls.some((call) => call.instructionMarkers.includes(marker)),
      `${marker} reached the provider`,
      180000,
    );
    const request = providerFixture.calls.find((call) => call.instructionMarkers.includes(marker));
    await idle();
    watching = false;
    await watcher;
    return {
      providerRequestMs: request.receivedAt - sentAt,
      finishedMs: Date.now() - sentAt,
      timeline,
    };
  };
  const conversation = await openConversation('Performance transcript');
  const { session, composer } = conversation;
  results.turns = {
    firstTurn: await timedTurn(conversation, '[native-composer-perf-first]'),
    secondTurn: await timedTurn(conversation, '[native-composer-perf-second]'),
  };
  console.log(`PERF turns ${JSON.stringify(results.turns)}`);

  // The session model picker, then the largest provider catalog the profile offers.
  let start = performance.now();
  await page.getByRole('button', { name: 'Choose session model', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Choose a model' });
  const search = picker.getByRole('textbox', { name: 'Search session models' });
  await search.waitFor();
  const pickerOpen = since(start);
  const models = picker.locator('.composer-model-list > button');
  // The catalog loads after the dialog opens; count once it is listed.
  await waitFor(
    async () =>
      (await models.count()) > 0 ||
      (await picker.getByText('No available models match', { exact: false }).count()) > 0,
    'Session model catalog listed',
    60000,
  );
  const ownListedMs = since(start);
  const ownModels = await models.count();
  const providerSelect = picker.getByRole('combobox', { name: 'Session model provider' });
  const offered = await providerSelect
    .locator('option')
    .evaluateAll((options) => options.map((option) => option.value));
  const largest = ['openrouter', 'vercel-ai-gateway', 'github-copilot', 'openai'].find((id) =>
    offered.includes(id),
  );
  let catalog = null;
  if (largest) {
    start = performance.now();
    await providerSelect.selectOption(largest);
    let previous = -1;
    let steady = 0;
    await waitFor(
      async () => {
        const count = await models.count();
        steady = count > 0 && count === previous ? steady + 1 : 0;
        previous = count;
        return steady >= 3;
      },
      `${largest} catalog listed`,
      60000,
    );
    const listedMs = since(start) - 300;
    const listed = await models.count();
    start = performance.now();
    await search.fill('mini');
    await waitFor(async () => (await models.count()) < listed, 'Catalog filtered', 10000).catch(
      () => {},
    );
    catalog = {
      provider: largest,
      modelsListed: listed,
      listedMs,
      filterMs: since(start),
      modelsAfterFilter: await models.count(),
    };
  }
  await page.keyboard.press('Escape');
  await picker.waitFor({ state: 'detached' });
  results.modelPicker = {
    openMs: pickerOpen,
    fixtureProviderModels: ownModels,
    fixtureCatalogListedMs: ownListedMs,
    providersOffered: offered.length,
    largestCatalog: catalog,
  };
  console.log(`PERF model picker ${JSON.stringify(results.modelPicker)}`);

  await page.getByRole('combobox', { name: 'Message delivery mode' }).selectOption('btw');
  await composer.fill('[native-composer-long-reply] Write the long transcript.');
  // Where the time goes: provider request, engine text deltas, end of the run, then the window.
  let eventOffset = 0;
  for (let more = true; more; ) {
    const batch = await rpc('engine.events', { id: session.id, offset: eventOffset });
    more = batch.events.length > 0 && batch.offset !== eventOffset;
    eventOffset = batch.offset;
  }
  const engine = { deltas: 0, deltaCharacters: 0 };
  let watching = true;
  const sentAt = Date.now();
  const watcher = (async () => {
    while (watching) {
      const batch = await rpc('engine.events', { id: session.id, offset: eventOffset });
      eventOffset = batch.offset;
      for (const event of batch.events) {
        const at = Date.now() - sentAt;
        if (event.type === 'provider.text_delta') {
          engine.firstDeltaMs ??= at;
          engine.lastDeltaMs = at;
          engine.deltas++;
          engine.deltaCharacters += String(event.payload?.text ?? '').length;
        }
        if (event.type === 'run.result') engine.runResultMs ??= at;
      }
      if (engine.runResultMs !== undefined) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  })();
  await startFrames(page);
  start = performance.now();
  await page.locator('.composer-send').click();
  const transcript = page.locator('.native-chat-messages');
  await waitFor(
    async () => {
      if ((await keep.count()) > 0) await keep.first().click();
      return (await transcript.textContent())?.includes('Long reply complete.');
    },
    'Long answer rendered',
    180000,
  );
  const longReplyRendered = since(start);
  const streamFrames = await stopFrames(page);
  await waitFor(() => engine.runResultMs !== undefined, 'Long answer run result', 60000);
  watching = false;
  await watcher;
  const request = providerFixture.calls.findLast((call) =>
    call.instructionMarkers.includes('[native-composer-long-reply]'),
  );
  engine.providerRequestMs = request ? request.receivedAt - sentAt : null;
  await waitFor(
    async () => !(await page.getByRole('button', { name: 'Stop run', exact: true }).count()),
    'Long answer turn finished',
    60000,
  );
  await transcript.hover();
  await startFrames(page);
  for (let step = 0; step < 40; step++) await page.mouse.wheel(0, -2400);
  for (let step = 0; step < 40; step++) await page.mouse.wheel(0, 2400);
  const transcriptScrollFrames = await stopFrames(page);
  results.transcript = {
    answerLines: longReplyLines,
    answerCharacters: (await transcript.textContent()).length,
    sendToRenderedMs: longReplyRendered,
    engine,
    streamFrames,
    scrollFrames: transcriptScrollFrames,
  };
  results.memory.afterLongTranscript = memory();
  console.log(`PERF transcript ${JSON.stringify(results.transcript)}`);

  // A tree of 20,000 files in 20 folders.
  const folders = 20;
  const perFolder = 1000;
  const treeRoot = join(project.root, 'perf-tree');
  for (let folder = 0; folder < folders; folder++) {
    const path = join(treeRoot, `f${String(folder).padStart(2, '0')}`);
    await mkdir(path, { recursive: true });
    await Promise.all(
      Array.from({ length: perFolder }, (_, index) =>
        writeFile(join(path, `item-${String(index).padStart(4, '0')}.txt`), `${index}\n`),
      ),
    );
  }
  await page.locator('.project-item').filter({ hasText: project.name }).click();
  await openProjectView(page, project, 'Files');
  const tree = page.getByRole('tree', { name: 'Project directory tree', exact: true });
  start = performance.now();
  await page.getByRole('button', { name: 'Refresh file manager', exact: true }).click();
  await tree.getByRole('treeitem', { name: 'perf-tree', exact: true }).waitFor({ timeout: 60000 });
  const treeRefresh = since(start);
  start = performance.now();
  await tree.getByRole('treeitem', { name: 'perf-tree', exact: true }).click();
  await tree.getByRole('treeitem', { name: 'perf-tree/f19', exact: true }).waitFor();
  const folderExpand = since(start);
  start = performance.now();
  await startFrames(page);
  await tree.getByRole('treeitem', { name: 'perf-tree/f00', exact: true }).click();
  await tree
    .getByRole('treeitem', { name: 'perf-tree/f00/item-0000.txt', exact: true })
    .waitFor({ timeout: 60000 });
  const largeFolderExpand = since(start);
  const mounted = await tree.getByRole('treeitem').count();
  await tree.hover();
  for (let step = 0; step < 30; step++) await page.mouse.wheel(0, 1200);
  const treeScrollFrames = await stopFrames(page);
  results.fileTree = {
    files: folders * perFolder,
    refreshMs: treeRefresh,
    expandRootMs: folderExpand,
    expandThousandFileFolderMs: largeFolderExpand,
    mountedRows: mounted,
    scrollFrames: treeScrollFrames,
  };
  results.memory.afterFileTree = memory();
  console.log(`PERF file tree ${JSON.stringify(results.fileTree)}`);

  // A new conversation's first turn once the project holds those 20,000 files.
  results.turns.firstTurnAfterLargeTree = await timedTurn(
    await openConversation('Performance large project'),
    '[native-composer-perf-large]',
  );
  console.log(`PERF turns ${JSON.stringify(results.turns)}`);

  // Three terminals each print 30,000 lines at once while one of them is on screen.
  const terminals = [];
  for (const index of [1, 2, 3]) {
    const terminal = await rpc('session.open', {
      projectId: project.id,
      kind: 'terminal',
      title: `Performance terminal ${index}`,
    });
    sessionIds.push(terminal.id);
    terminals.push({ id: terminal.id, index });
  }
  const tail = async (id) => {
    const { end } = await rpc('session.read', { id });
    const read = await rpc('session.read', { id, offset: Math.max(0, end - 4096) });
    return { end, text: Buffer.from(read.bytes).toString() };
  };
  const linesPerTerminal = 30000;
  // The text is built before the clock starts, so the measurement is the terminal path, not
  // PowerShell's pipeline producing it.
  for (const terminal of terminals) {
    await rpc('session.resize', { id: terminal.id, rows: 40, cols: 120 });
    await rpc('session.write', {
      id: terminal.id,
      data: `$s = (1..${linesPerTerminal} | ForEach-Object { "perf line $_ of terminal ${terminal.index}" }) -join [char]10; Write-Output ('PERF_'+'READY')\r`,
    });
  }
  await waitFor(
    async () =>
      (await Promise.all(terminals.map((terminal) => tail(terminal.id)))).every((item) =>
        item.text.includes('PERF_READY'),
      ),
    'Performance terminals ready',
    60000,
  );
  await page.locator('.tree-session').filter({ hasText: 'Performance terminal 1' }).click();
  await page.locator('.xterm-screen').waitFor();
  await startFrames(page);
  start = performance.now();
  for (const terminal of terminals)
    await rpc('session.write', {
      id: terminal.id,
      data: `[Console]::Out.Write($s); Write-Output ('PERF_DONE_'+'${terminal.index}')\r`,
    });
  const finished = {};
  await waitFor(
    async () => {
      for (const terminal of terminals)
        if (!finished[terminal.index]) {
          const item = await tail(terminal.id);
          if (item.text.includes(`PERF_DONE_${terminal.index}`))
            finished[terminal.index] = { ms: since(start), bytes: item.end };
        }
      return Object.keys(finished).length === terminals.length;
    },
    'Terminal floods finished',
    300000,
  );
  await page.waitForTimeout(1000);
  const terminalFrames = await stopFrames(page);
  const slowest = Math.max(...Object.values(finished).map((item) => item.ms));
  results.terminals = {
    terminals: terminals.length,
    linesPerTerminal,
    perTerminal: finished,
    allFinishedMs: slowest,
    linesPerSecondCombined: Math.round((terminals.length * linesPerTerminal * 1000) / slowest),
    framesWhileVisible: terminalFrames,
  };
  results.memory.afterTerminalFlood = memory();
  console.log(`PERF terminals ${JSON.stringify(results.terminals)}`);
  await page.screenshot({ path: join(artifactDir, 'native-performance-terminal.png') });

  results.package = await packageSizes({ root, release });
  console.log(`PERF package ${JSON.stringify(results.package)}`);
  console.log(`PERF memory ${JSON.stringify(results.memory)}`);
  await writeFile(
    join(artifactDir, 'native-performance.json'),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  console.log('PASS: performance measurements recorded in native-performance.json');
  return { ...results, page };
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { summarizeDesignDna } from '@wrongstack/core/design';
import { planNativeDesignToolCall } from './native-design-handoff.mjs';

const clean =
  '<!doctype html><html lang="en"><meta charset="utf-8"><title>History fixture</title><style>*{box-sizing:border-box}body{margin:0;background:#fff;color:#18202b;font:16px/1.6 Arial}main{max-width:720px;padding:24px;margin:auto}h1{font-size:32px}button{background:#174ea6;color:#fff;border:0;padding:12px 24px;min-height:48px;font:inherit}</style><main><h1>History fixture</h1><p>A readable measured page.</p><button>Continue</button></main></html>';
const broken = clean.replace(
  '</style>',
  'main{min-width:1100px}button{font-size:8px;color:#e1e1e1;background:#e2e2e2;min-height:8px;padding:0}</style>',
);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const normalized = (value) => value.replace(/^\\\\\?\\/, '').replaceAll('\\', '/');
function dna(primary, radius) {
  return summarizeDesignDna([
    {
      v: 1,
      url: 'https://example.test/',
      title: 'History fixture',
      vw: 375,
      vh: 900,
      docH: 900,
      screens: 1,
      rootBg: '#ffffff',
      colorScheme: 'normal',
      themeColor: null,
      generator: null,
      samples: { points: 100, media: 0, gradient: 0, area: [['#ffffff', 95]] },
      text: [['16|400|24|0|Inter||p', 500]],
      textColor: [['#111111', 500]],
      families: [['Inter', 500]],
      fontsLoaded: ['Inter'],
      padding: [['16', 10]],
      gap: [['8', 5]],
      vmargin: [],
      radius: [[radius, 5]],
      shadow: [],
      borderW: [],
      borderColor: [],
      duration: [['200', 3]],
      easing: [['ease', 3]],
      gradients: [],
      effects: {},
      grids: [],
      buttons: [
        {
          h: 48,
          w: 120,
          padX: 16,
          r: 6,
          bg: primary,
          fg: '#ffffff',
          border: null,
          fw: '500',
          fs: 16,
          tt: 'none',
          y: 100,
        },
      ],
      inputs: [],
      nav: null,
      sections: [],
      images: 0,
      imgRatios: [],
      icons: [],
      vars: {},
      elements: 10,
    },
  ]);
}

/** All measurements/writes/navigation are real; only the provider's tool choice is planned. */
export async function exerciseNativeDesignReviewHistory({
  page,
  rpc,
  project,
  waitFor,
  artifactDir,
  sessionIds,
}) {
  const receipt = { checks: [], reviews: [] };
  const pass = (text) => {
    receipt.checks.push(text);
    console.log('PASS: ' + text);
  };
  const agent = await rpc('session.open', {
    projectId: project.id,
    kind: 'agent',
    title: 'Historical design review',
  });
  receipt.agent = agent;
  sessionIds.push(agent.id);
  const root = normalized(project.root);
  let offset = 0;
  const frames = [];
  const pump = async () => {
    for (;;) {
      const previous = offset,
        batch = await rpc('engine.events', { id: agent.id, offset });
      offset = batch.offset;
      frames.push(...batch.events);
      if (!(batch.hasMore ?? batch.events.length === 200) || offset === previous) break;
    }
  };
  const call = async (type, payload) => {
    const requestId = crypto.randomUUID();
    await rpc('engine.send', {
      id: agent.id,
      message: { type, payload: { ...payload, requestId } },
    });
    return waitFor(
      async () => {
        await pump();
        const event = frames.find((event) => event.payload?.requestId === requestId);
        if (!event) return null;
        assert.notEqual(event.type, 'error');
        assert.notEqual(event.payload.success, false);
        return event.payload;
      },
      type,
      60000,
    );
  };
  const showActivity = async () => {
    await page
      .getByRole('navigation', { name: 'Agent workspace views' })
      .getByRole('button', { name: 'Tools', exact: true })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /Run activity/ })
      .click();
  };
  const cards = (action) =>
    page.locator('.session-activity:not(.session-activity-compact)').getByRole('region', {
      name: action === 'inspect' ? 'Rendered design inspection' : 'Design fidelity comparison',
      exact: true,
    });
  const review = async (tag, input) => {
    const plan = planNativeDesignToolCall(tag, input),
      id = crypto.randomUUID(),
      from = frames.length;
    await rpc('engine.send', {
      id: agent.id,
      message: {
        type: 'user_message',
        payload: {
          id,
          requestId: crypto.randomUUID(),
          timestamp: Date.now(),
          content: `[native-design-handoff:${tag}] Execute exactly this design_reference request: ${JSON.stringify(input)}`,
        },
      },
    });
    const result = await waitFor(
      async () => {
        await pump();
        return frames
          .slice(from)
          .find((event) => event.type === 'run.result' && event.payload?.requestId === id)?.payload;
      },
      'Real review completes',
      150000,
    );
    assert.equal(result.status, 'done');
    assert.equal(plan.calls, 1);
    const toolId = `native-design-${tag}`;
    assert.equal(
      frames.find((event) => event.type === 'tool.executed' && event.payload?.id === toolId)
        ?.payload.ok,
      true,
    );
    const candidates = frames
      .filter((event) => event.payload?.id === toolId)
      .flatMap((event) => [
        event.payload.event?.path,
        ...(event.payload.fileTargets ?? []).map((file) => file.filePath),
      ])
      .filter((value) => typeof value === 'string');
    const reported = candidates.find((value) =>
      normalized(value).endsWith(input.action === 'inspect' ? '/inspect.md' : '/fidelity.md'),
    );
    assert.ok(reported, 'Actual tool progress reports its markdown file');
    const file = isAbsolute(reported) ? normalized(reported) : join(root, reported);
    const reportPath = relative(root, file).replaceAll('\\', '/');
    assert.ok(!reportPath.startsWith('..'), 'Reported file belongs to this native project');
    const bytes = await readFile(file, 'utf8');
    const captured = { tag, input, path: reportPath, sha256: hash(bytes), bytes, result, plan };
    receipt.reviews.push(captured);
    return captured;
  };
  const opened = async (path, text) => {
    await waitFor(
      async () =>
        normalized(
          (await page.locator('.file-document-path').getAttribute('title')) ?? '',
        ).endsWith(path),
      'Native report file path',
      60000,
    );
    await waitFor(
      async () => ((await page.locator('.native-file-content').textContent()) ?? '').includes(text),
      'Native historical report contents',
      60000,
    );
  };
  const preserved = async (first, second, action) => {
    const current = await readFile(join(root, first.path), 'utf8');
    receipt.preservation = {
      action,
      firstPath: first.path,
      secondPath: second.path,
      expected: first.sha256,
      actual: hash(current),
    };
    assert.equal(
      current,
      first.bytes,
      'Historical design report must keep its own bytes after another review',
    );
    assert.notEqual(first.path, second.path);
    await showActivity();
    await cards(action).nth(0).getByRole('button', { name: 'Open report', exact: true }).click();
    await opened(
      first.path,
      action === 'inspect'
        ? first.bytes.split('\n')[1]
        : first.bytes.split('\n').find((line) => line.startsWith('Overall ')),
    );
    await showActivity();
    await cards(action).nth(1).getByRole('button', { name: 'Open report', exact: true }).click();
    await opened(
      second.path,
      action === 'inspect'
        ? second.bytes.split('\n')[1]
        : second.bytes.split('\n').find((line) => line.startsWith('Overall ')),
    );
    await showActivity();
    await cards(action).nth(0).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(artifactDir, `native-${action}-history.png`),
      fullPage: true,
    });
    pass(
      `Two real ${action} results keep distinct report files and each native card opens its original report after the later run`,
    );
  };
  try {
    receipt.identity = await waitFor(
      async () => {
        const value = await rpc('engine.identity', { id: agent.id });
        return value.sessionId ? value : null;
      },
      'Review engine ready',
      100000,
    );
    await call('prefs.update', { enhanceEnabled: false, autonomy: 'off' });
    await page.locator('.tree-session').filter({ hasText: agent.title }).click();
    await page.locator(`[data-engine-session="${receipt.identity.sessionId}"]`).waitFor();
    await writeFile(join(root, 'history-target.html'), clean);
    const first = await review('review-inspect-first', {
      action: 'inspect',
      file: 'history-target.html',
      surface: 'app',
      viewports: [375],
    });
    await showActivity();
    await cards('inspect').nth(0).getByRole('button', { name: 'Open report', exact: true }).click();
    await opened(first.path, first.bytes.split('\n')[1]);
    const screenshot = join(root, first.path.replace(/inspect\.md$/, '375.png'));
    receipt.firstScreenshotSha256 = hash(await readFile(screenshot));
    pass(
      'A genuine first inspection writes its report and screenshot, and its native card opens matching measured results',
    );
    await writeFile(join(root, 'history-target.html'), broken);
    const second = await review('review-inspect-second', {
      action: 'inspect',
      file: 'history-target.html',
      surface: 'app',
      viewports: [375],
    });
    assert.notEqual(
      first.bytes,
      second.bytes,
      'Changed source produces a different measured report',
    );
    receipt.inspectScreenshotAfter = hash(await readFile(screenshot));
    await preserved(first, second, 'inspect');
    assert.equal(
      receipt.firstScreenshotSha256,
      receipt.inspectScreenshotAfter,
      'The first report screenshot is not overwritten',
    );
    for (const [slug, value] of [
      ['history-a', dna('#e11d48', '12')],
      ['history-b', dna('#2563eb', '4')],
    ]) {
      const dir = join(root, '.design/references', slug);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'dna.json'), JSON.stringify(value));
    }
    const comparison = await review('review-compare-first', {
      action: 'compare',
      reference: 'history-a',
      against: 'history-a',
    });
    const changed = await review('review-compare-second', {
      action: 'compare',
      reference: 'history-a',
      against: 'history-b',
    });
    assert.match(comparison.bytes, /Overall 100%/);
    assert.notEqual(changed.bytes, comparison.bytes);
    await preserved(comparison, changed, 'compare');
  } finally {
    await pump().catch(() => {});
    receipt.events = frames.filter((event) => ['tool.executed', 'run.result'].includes(event.type));
    await writeFile(
      join(artifactDir, 'design-review-history-receipt.json'),
      JSON.stringify(receipt, null, 2),
    );
  }
}

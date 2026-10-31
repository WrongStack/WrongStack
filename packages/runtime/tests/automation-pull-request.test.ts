import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AutomationPullRequestView } from '@wrongstack/webui-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAutomationServer } from '../src/automation/http.js';
import { AutomationPullRequests } from '../src/automation/pull-request.js';
import { AutomationService } from '../src/automation/service.js';
import { AutomationStore } from '../src/automation/store.js';
import type { DockerWorkspaceOptions, DockerWorkspaceResult } from '../src/docker-workspace.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-C', root, ...args], { windowsHide: true, timeout: 15_000 })
    .toString()
    .trim();
async function fixture(verified = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wrongstack-pr-test-'));
  cleanups.push(async () => {
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('wrongstack-pr-test-'))
      await rm(root, { recursive: true, force: true });
  });
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'config', 'core.autocrlf', 'false');
  await writeFile(path.join(root, '.gitignore'), 'state/\n');
  await writeFile(path.join(root, 'a.txt'), 'before\n');
  git(root, 'add', '.gitignore', 'a.txt');
  git(root, 'commit', '-qm', 'base');
  const baseCommit = git(root, 'rev-parse', 'HEAD'),
    sourceTree = git(root, 'rev-parse', 'HEAD^{tree}');
  await writeFile(path.join(root, 'a.txt'), 'after\n');
  git(root, 'add', 'a.txt');
  const tree = git(root, 'write-tree');
  const patch = execFileSync('git', [
    '-C',
    root,
    'diff',
    '--cached',
    '--binary',
    'HEAD',
  ]).toString();
  await writeFile(path.join(root, 'a.txt'), 'before\n');
  git(root, 'add', 'a.txt');
  const store = new AutomationStore(path.join(root, 'state'));
  const job = await store.add({
    name: 'Parser fix',
    projectRoot: root,
    image: 'trusted:1',
    prompt: 'Fix',
    envNames: [],
    yolo: false,
    enabled: true,
    timeoutMs: 1000,
    ...(verified ? { verification: { commands: [['bun', 'run', 'test']], timeoutMs: 1000 } } : {}),
  });
  const run = await store.enqueue(job.id);
  const execute = vi.fn(
    async (options: DockerWorkspaceOptions): Promise<DockerWorkspaceResult> => ({
      id: options.id!,
      ownerToken: options.ownerToken!,
      exitCode: 0,
      cleanup: 'removed',
      snapshotRevision: baseCommit,
      patch,
      output: 'All tests passed',
      sourceTree,
      inputTree: options.command === 'wstack' ? sourceTree : tree,
      outputTree: tree,
      imageId: `sha256:${'a'.repeat(64)}`,
      stepResults: [{ exitCode: 0, durationMs: 1, output: '1 test passed' }],
    }),
  );
  const service = new AutomationService(store, execute);
  await service.tick();
  await service.idle();
  return {
    root,
    baseCommit,
    sourceTree,
    tree,
    patch,
    store,
    run,
    service,
    execute,
    requests: new AutomationPullRequests(store),
  };
}
const input = { repository: 'owner/repo', base: 'main', title: 'Fix parser' };
function github(f: Awaited<ReturnType<typeof fixture>>) {
  const calls: Array<{ route: string; body: Record<string, unknown> | undefined }> = [];
  const remote = {
    base: f.baseCommit,
    tree: f.sourceTree,
    commit: 'd'.repeat(40),
    nextCommit: undefined as string | undefined,
    candidateTree: f.tree,
    raceUpdate: false,
    loseUpdateResponse: false,
    failNextPRRead: false,
    // GitHub's PR view lags a ref update: these many reads still report the previous head.
    laggingHeadReads: 0,
    laggingHead: undefined as string | undefined,
    branch: null as string | null,
    pr: null as Record<string, unknown> | null,
    checks: [] as unknown[],
    statuses: [] as unknown[],
    jobs: {} as Record<string, unknown>,
    annotations: {} as Record<string, unknown[]>,
    losePRResponse: false,
    missingPage: false,
    checkHead: undefined as string | undefined,
  };
  vi.stubEnv('GITHUB_TOKEN', 'test-token-do-not-persist');
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).startsWith('https://api.github.com/')) return nativeFetch(url, init);
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeDefined();
      const reply = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), { status });
      if (String(url) === 'https://api.github.com/graphql') {
        const body = JSON.parse(String(init?.body));
        calls.push({ route: 'graphql', body });
        const input = body.variables.input,
          update = input.refUpdates[0];
        expect(update.force).toBe(false);
        expect(update.name).toBe(`refs/heads/${(remote.pr!['head'] as { ref: string }).ref}`);
        if (remote.raceUpdate) {
          remote.branch = 'f'.repeat(40);
          remote.commit = remote.branch;
        }
        if (update.beforeOid !== remote.branch)
          return reply({ errors: [{ message: 'Head changed' }] });
        if (remote.laggingHeadReads) remote.laggingHead = update.beforeOid;
        remote.branch = update.afterOid;
        remote.commit = update.afterOid;
        if (remote.loseUpdateResponse) {
          remote.loseUpdateResponse = false;
          remote.failNextPRRead = true;
          throw new Error('Lost update response');
        }
        return reply({ data: { updateRefs: { clientMutationId: input.clientMutationId } } });
      }
      const route = String(url).slice('https://api.github.com/repos/owner/repo/'.length);
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;
      calls.push({ route, body });
      if (String(url) === 'https://api.github.com/repos/owner/repo')
        return reply({ node_id: 'repository-node' });
      if (route === 'commits/main')
        return reply({ sha: remote.base, commit: { tree: { sha: remote.tree } } });
      if (route === 'git/blobs') {
        const content = Buffer.from(body!['content'] as string, 'base64');
        return reply({
          sha: createHash('sha1')
            .update(Buffer.from(`blob ${content.length}\0`))
            .update(content)
            .digest('hex'),
        });
      }
      if (route === 'git/trees') return reply({ sha: remote.candidateTree });
      if (route === 'git/commits') return reply({ sha: remote.nextCommit ?? remote.commit });
      if (route.startsWith('git/ref/'))
        return remote.branch ? reply({ object: { sha: remote.branch } }) : reply({}, 404);
      if (route === 'git/refs') {
        expect(remote.branch).toBeNull();
        remote.branch = body!['sha'] as string;
        return reply({ object: { sha: remote.branch } }, 201);
      }
      if (route.startsWith('pulls?')) return reply(remote.pr ? [remote.pr] : []);
      if (route === 'pulls') {
        expect(body).toMatchObject({ draft: true, maintainer_can_modify: false });
        remote.pr = {
          number: 7,
          state: 'open',
          draft: true,
          head: { sha: remote.commit, ref: body!['head'], repo: { full_name: 'owner/repo' } },
          base: { ref: 'main', repo: { full_name: 'owner/repo' } },
        };
        if (remote.losePRResponse) {
          remote.losePRResponse = false;
          throw new Error('Lost network response');
        }
        return reply(remote.pr, 201);
      }
      if (route === 'pulls/7') {
        if (remote.failNextPRRead) {
          remote.failNextPRRead = false;
          throw new Error('Lost verification read');
        }
        const lagging = remote.laggingHead !== undefined && remote.laggingHeadReads-- > 0;
        return reply({
          ...remote.pr,
          head: {
            ...(remote.pr!['head'] as object),
            sha: lagging ? remote.laggingHead : (remote.checkHead ?? remote.commit),
          },
        });
      }
      const job = /^actions\/jobs\/(\d+)$/.exec(route);
      if (job) return remote.jobs[job[1]!] ? reply(remote.jobs[job[1]!]) : reply({}, 404);
      const annotations = /^check-runs\/(\d+)\/annotations\?/.exec(route);
      if (annotations) return reply(remote.annotations[annotations[1]!] ?? []);
      const page = Number(route.match(/[?&]page=(\d+)/)?.[1] ?? 1);
      if (route.includes('/check-runs?'))
        return reply({
          total_count: remote.checks.length,
          check_runs:
            remote.missingPage && page === 2
              ? []
              : remote.checks.slice((page - 1) * 100, page * 100),
        });
      if (route.includes('/status?'))
        // GitHub's combined status: the commit at the top level, entries without a sha.
        return reply({
          sha: remote.commit,
          total_count: remote.statuses.length,
          statuses: remote.statuses.slice((page - 1) * 100, page * 100),
        });
      throw new Error(`Unexpected GitHub request ${route}`);
    }),
  );
  return { remote, calls };
}

describe('verified automation to draft PR', () => {
  it('prepares locally through the authenticated API and keeps host files, index and refs unchanged', async () => {
    const f = await fixture(),
      server = createAutomationServer(f.service, 't'.repeat(64));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/runs/${f.run.id}/pr/prepare`, {
      method: 'POST',
      headers: { authorization: `Bearer ${'t'.repeat(64)}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(200);
    const view = (await response.json()) as AutomationPullRequestView;
    expect(view.plan).toMatchObject({
      candidateTree: f.tree,
      baseCommit: f.baseCommit,
      files: ['a.txt'],
      repository: 'owner/repo',
    });
    expect(view.receipt).toBeNull();
    expect(await readFile(path.join(f.root, 'a.txt'), 'utf8')).toBe('before\n');
    expect(git(f.root, 'write-tree')).toBe(f.sourceTree);
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.baseCommit);
    expect((await fetch(`http://127.0.0.1:${port}/v1/runs/${f.run.id}/pr`)).status).toBe(401);
  });
  it('refuses successful agent prose without independent verification', async () => {
    const f = await fixture(false);
    await expect(f.requests.prepare(f.run.id, input)).rejects.toThrow('independent checks');
  });
  it('refuses a committed source that differs from the verified source', async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, 'a.txt'), 'another base\n');
    git(f.root, 'add', 'a.txt');
    git(f.root, 'commit', '-qm', 'new base');
    await expect(f.requests.prepare(f.run.id, input)).rejects.toThrow('Verified source differs');
  });
  it('keeps an existing prepared target immutable', async () => {
    const f = await fixture();
    await f.requests.prepare(f.run.id, input);
    await expect(
      f.requests.prepare(f.run.id, { ...input, repository: 'another/repo' }),
    ).rejects.toThrow('different PR plan');
  });
  it('publishes only the reviewed plan and reuses its branch and draft on retries', async () => {
    const f = await fixture(),
      network = github(f),
      view = await f.requests.prepare(f.run.id, input);
    expect(network.calls).toEqual([]);
    await expect(f.requests.publish(f.run.id, '0'.repeat(64))).rejects.toThrow('fingerprint');
    expect(network.calls).toEqual([]);
    const result = await f.requests.publish(f.run.id, view.plan!.fingerprint);
    expect(result.receipt).toMatchObject({ number: 7, draft: true, commit: network.remote.commit });
    const beforeRetry = network.calls.filter((call) => call.body).length;
    await f.requests.publish(f.run.id, view.plan!.fingerprint);
    expect(network.calls.filter((call) => call.body)).toHaveLength(beforeRetry);
    expect(
      await readFile(path.join(f.store.directory, 'runs', f.run.id, 'pull-request.json'), 'utf8'),
    ).not.toContain('test-token');
  });
  it('recovers an accepted PR whose network response was lost without creating a duplicate', async () => {
    const f = await fixture(),
      network = github(f),
      view = await f.requests.prepare(f.run.id, input);
    network.remote.losePRResponse = true;
    await expect(f.requests.publish(f.run.id, view.plan!.fingerprint)).rejects.toThrow(
      'not confirmed',
    );
    expect((await f.requests.publish(f.run.id, view.plan!.fingerprint)).receipt?.number).toBe(7);
    expect(network.calls.filter((call) => call.route === 'pulls' && call.body)).toHaveLength(1);
  });
  it('refuses source drift, changed evidence, remote base drift and an occupied branch', async () => {
    const f = await fixture(),
      network = github(f),
      view = await f.requests.prepare(f.run.id, input);
    network.remote.base = 'e'.repeat(40);
    await expect(f.requests.publish(f.run.id, view.plan!.fingerprint)).rejects.toThrow(
      'Remote base',
    );
    expect(network.calls.some((call) => call.body)).toBe(false);
    network.remote.base = f.baseCommit;
    network.remote.branch = 'f'.repeat(40);
    await expect(f.requests.publish(f.run.id, view.plan!.fingerprint)).rejects.toThrow(
      'not be overwritten',
    );
    expect(network.calls.some((call) => call.route === 'git/refs')).toBe(false);
    await writeFile(
      path.join(f.store.directory, 'runs', f.run.id, 'changes.patch'),
      f.patch.replace('after', 'tampered'),
    );
    await expect(f.requests.publish(f.run.id, view.plan!.fingerprint)).rejects.toThrow(
      'evidence changed',
    );
  });
  it('binds hosted checks and legacy statuses to the published head and treats no checks as unknown', async () => {
    const f = await fixture(),
      { remote } = github(f),
      plan = (await f.requests.prepare(f.run.id, input)).plan!;
    await f.requests.publish(f.run.id, plan.fingerprint);
    expect((await f.requests.check(f.run.id)).ci?.status).toBe('unknown');
    remote.checks = [
      { name: 'tests', status: 'completed', conclusion: 'success', head_sha: remote.commit },
    ];
    expect((await f.requests.check(f.run.id)).ci?.status).toBe('passed');
    remote.statuses = [{ context: 'legacy lint', state: 'pending' }];
    expect((await f.requests.check(f.run.id)).ci?.status).toBe('pending');
    remote.statuses = [{ context: 'legacy lint', state: 'failure' }];
    expect((await f.requests.check(f.run.id)).ci?.status).toBe('failed');
    remote.statuses = [];
    remote.checkHead = 'f'.repeat(40);
    expect((await f.requests.check(f.run.id)).ci?.status).toBe('stale');
  });
  it('names the failed steps of a GitHub Actions job, whose check run has no output text', async () => {
    // Recorded live shape: an Actions check run carries no summary or text; the job's steps and
    // the failure annotation are the only evidence the API offers without following log redirects.
    const f = await fixture(),
      { remote } = github(f),
      plan = (await f.requests.prepare(f.run.id, input)).plan!;
    await f.requests.publish(f.run.id, plan.fingerprint);
    remote.checks = [
      {
        id: 124516729286,
        name: 'mean of an empty list throws RangeError',
        status: 'completed',
        conclusion: 'failure',
        head_sha: remote.commit,
        app: { slug: 'github-actions' },
        output: { title: null, summary: null, text: null, annotations_count: 3 },
      },
      {
        id: 7,
        name: 'other app',
        status: 'completed',
        conclusion: 'failure',
        head_sha: remote.commit,
        app: { slug: 'someone-else' },
        output: { summary: null, text: null },
      },
    ];
    remote.jobs['124516729286'] = {
      name: 'mean of an empty list throws RangeError',
      head_sha: remote.commit,
      steps: [
        { name: 'Run actions/checkout@v4', conclusion: 'success' },
        { name: "mean([]) must throw RangeError('mean of an empty list')", conclusion: 'failure' },
        { name: 'Post Run actions/setup-node@v4', conclusion: 'skipped' },
      ],
    };
    remote.annotations['124516729286'] = [
      { annotation_level: 'warning', message: 'Node.js 20 is deprecated.' },
      { annotation_level: 'failure', message: 'Process completed with exit code 1.' },
    ];
    const ci = (await f.requests.check(f.run.id)).ci!;
    expect(ci.checks[0]!.details).toBe(
      "Failed step: mean([]) must throw RangeError('mean of an empty list')\nProcess completed with exit code 1.",
    );
    expect(ci.checks[1]!.details).toBe('');
    // A job that names another commit is not evidence for this head.
    remote.jobs['124516729286'] = {
      ...(remote.jobs['124516729286'] as object),
      head_sha: 'e'.repeat(40),
    };
    expect((await f.requests.check(f.run.id)).ci!.checks[0]!.details).toBe('');
  });
  it('reads later CI pages and refuses a truncated successful collection', async () => {
    const f = await fixture(),
      { remote } = github(f),
      plan = (await f.requests.prepare(f.run.id, input)).plan!;
    await f.requests.publish(f.run.id, plan.fingerprint);
    remote.checks = Array.from({ length: 101 }, (_, i) => ({
      name: `check-${i}`,
      status: 'completed',
      conclusion: i === 100 ? 'failure' : 'success',
      head_sha: remote.commit,
    }));
    expect((await f.requests.check(f.run.id)).ci?.status).toBe('failed');
    remote.missingPage = true;
    await expect(f.requests.check(f.run.id)).rejects.toThrow('collection is incomplete');
    expect((await f.requests.inspect(f.run.id)).ci?.status).toBe('failed');
  });
  it('never calls neutral-only or wrong-head checks a passing result', async () => {
    const f = await fixture(),
      { remote } = github(f),
      plan = (await f.requests.prepare(f.run.id, input)).plan!;
    await f.requests.publish(f.run.id, plan.fingerprint);
    remote.checks = [
      { name: 'skipped', status: 'completed', conclusion: 'skipped', head_sha: remote.commit },
    ];
    expect((await f.requests.check(f.run.id)).ci?.status).toBe('unknown');
    remote.checks = [
      { name: 'wrong head', status: 'completed', conclusion: 'success', head_sha: 'e'.repeat(40) },
    ];
    await expect(f.requests.check(f.run.id)).rejects.toThrow('identity is invalid');
  });
  it.each(['normal', 'concurrent-head-change', 'lost-update-response', 'lagging-pr-head'] as const)(
    'continues the exact run and updates the same PR safely: %s',
    async (scenario) => {
      const f = await fixture(),
        { remote, calls } = github(f);
      const original = (await f.requests.prepare(f.run.id, input)).plan!;
      await f.requests.publish(f.run.id, original.fingerprint);
      remote.checks = [
        { name: 'tests', status: 'completed', conclusion: 'failure', head_sha: remote.commit },
      ];
      const ci = (await f.requests.check(f.run.id)).ci!;
      // A later unrelated default-subject run must never become the repair checkpoint.
      const unrelated = await f.store.enqueue(f.run.jobId);
      await f.service.tick();
      await f.service.idle();
      await writeFile(
        path.join(f.store.directory, 'runs', unrelated.id, 'changes.patch'),
        'unrelated patch',
      );
      const parentConversation = path.join(f.store.directory, 'runs', f.run.id, 'conversation');
      await mkdir(parentConversation);
      await writeFile(path.join(parentConversation, 'checkpoint'), 'parent');
      let queued: AutomationPullRequestView;
      if (scenario === 'normal') {
        const server = createAutomationServer(f.service, 't'.repeat(64));
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        cleanups.push(
          () =>
            new Promise<void>((resolve) => {
              server.closeAllConnections();
              server.close(() => resolve());
            }),
        );
        const response = await fetch(
          `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/runs/${f.run.id}/pr/follow-up`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${'t'.repeat(64)}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ fingerprint: ci.fingerprint }),
          },
        );
        expect(response.status).toBe(202);
        queued = (await response.json()) as AutomationPullRequestView;
      } else queued = await f.requests.followUp(f.run.id, ci.fingerprint!);
      expect((await f.requests.followUp(f.run.id, ci.fingerprint!)).followUpRunId).toBe(
        queued.followUpRunId,
      );
      const child = (await f.store.snapshot()).runs.find((run) => run.id === queued.followUpRunId)!;
      expect(child).toMatchObject({
        trigger: 'github',
        continuationRunId: f.run.id,
        status: 'queued',
        subjectKey: f.run.subjectKey,
      });
      expect(JSON.parse(child.context)).toMatchObject({
        type: 'ci-repair',
        pullRequest: 7,
        commit: remote.commit,
      });
      await f.store.prune(Date.now() + 10_000);
      expect((await f.store.snapshot()).runs.map((run) => run.id)).toEqual(
        expect.arrayContaining([f.run.id, child.id]),
      );
      expect((await f.requests.inspect(child.id)).suggestedTarget).toEqual(input);
      await writeFile(path.join(f.root, 'a.txt'), 'repaired\n');
      git(f.root, 'add', 'a.txt');
      const repairedTree = git(f.root, 'write-tree');
      const repairedPatch = execFileSync('git', [
        '-C',
        f.root,
        'diff',
        '--cached',
        '--binary',
        'HEAD',
      ]).toString();
      await writeFile(path.join(f.root, 'a.txt'), 'before\n');
      git(f.root, 'add', 'a.txt');
      f.execute.mockImplementation(async (options) => ({
        id: options.id!,
        ownerToken: options.ownerToken!,
        exitCode: 0,
        cleanup: 'removed',
        snapshotRevision: f.baseCommit,
        patch: repairedPatch,
        output: '',
        sourceTree: f.sourceTree,
        inputTree: options.command === 'wstack' ? f.tree : repairedTree,
        outputTree: repairedTree,
        imageId: `sha256:${'a'.repeat(64)}`,
        stepResults: [{ exitCode: 0, durationMs: 1, output: 'passed' }],
      }));
      await f.service.tick();
      await f.service.idle();
      const dispatch = f.execute.mock.calls.find(
        ([options]) => options.id === child.id && options.command === 'wstack',
      )![0];
      expect(dispatch.initialPatch).toBe(f.patch);
      expect(dispatch.previousConversationDirectory).toBe(parentConversation);
      expect(dispatch.args).toContain('--continue');
      const plan = (await f.requests.prepare(child.id, input)).plan!;
      expect(plan.target).toEqual({ sourceRunId: f.run.id, number: 7, headCommit: remote.commit });
      expect(plan.branch).toBe(original.branch);
      remote.candidateTree = repairedTree;
      remote.nextCommit = 'e'.repeat(40);
      if (scenario === 'concurrent-head-change') {
        remote.raceUpdate = true;
        await expect(f.requests.publish(child.id, plan.fingerprint)).rejects.toThrow(
          'Expected PR head changed',
        );
        expect(remote.branch).toBe('f'.repeat(40));
        expect((await f.requests.inspect(child.id)).receipt).toBeNull();
        return;
      }
      if (scenario === 'lost-update-response') {
        remote.loseUpdateResponse = true;
        await expect(f.requests.publish(child.id, plan.fingerprint)).rejects.toThrow(
          'Lost verification read',
        );
      }
      // A real update to a private repository: the first PR reads after the ref moved still
      // named the old head, and the first publish reported a failure for a landed update.
      if (scenario === 'lagging-pr-head') remote.laggingHeadReads = 2;
      const result = await f.requests.publish(child.id, plan.fingerprint);
      expect(result.receipt).toMatchObject({ number: 7, commit: remote.nextCommit });
      expect(calls.filter((call) => call.route === 'pulls' && call.body)).toHaveLength(1);
      expect(calls.filter((call) => call.route === 'git/refs' && call.body)).toHaveLength(1);
      expect(calls.findLast((call) => call.route === 'git/commits')!.body!['parents']).toEqual([
        'd'.repeat(40),
      ]);
      expect(calls.filter((call) => call.route === 'graphql')).toHaveLength(1);
    },
  );
  it('refuses stale CI fingerprints, changed job revisions and a PR head that moved', async () => {
    const f = await fixture(),
      { remote } = github(f);
    await f.requests.publish(
      f.run.id,
      (await f.requests.prepare(f.run.id, input)).plan!.fingerprint,
    );
    remote.checks = [
      { name: 'tests', status: 'completed', conclusion: 'failure', head_sha: remote.commit },
    ];
    const ci = (await f.requests.check(f.run.id)).ci!;
    await expect(f.requests.followUp(f.run.id, '0'.repeat(64))).rejects.toThrow('CI changed');
    remote.checkHead = 'f'.repeat(40);
    await expect(f.requests.followUp(f.run.id, ci.fingerprint!)).rejects.toThrow('CI changed');
    remote.checkHead = undefined;
    remote.checks = [
      { name: 'tests', status: 'completed', conclusion: 'success', head_sha: remote.commit },
    ];
    await expect(f.requests.followUp(f.run.id, ci.fingerprint!)).rejects.toThrow('CI changed');
    remote.checks = [
      { name: 'tests', status: 'completed', conclusion: 'failure', head_sha: remote.commit },
    ];
    const job = (await f.store.snapshot()).jobs[0]!;
    remote.pr!['state'] = 'closed';
    await expect(f.requests.followUp(f.run.id, ci.fingerprint!)).rejects.toThrow('draft state');
    remote.pr!['state'] = 'open';
    remote.pr!['draft'] = false;
    await expect(f.requests.followUp(f.run.id, ci.fingerprint!)).rejects.toThrow('draft state');
    remote.pr!['draft'] = true;
    await f.store.update(job.id, { ...job, prompt: 'Different operator task' }, job.revision!);
    await expect(f.requests.followUp(f.run.id, ci.fingerprint!)).rejects.toThrow(
      'Automation changed',
    );
    expect((await f.store.snapshot()).runs).toHaveLength(1);
  });
  it('bounds real CI summaries and the queued untrusted feedback context', async () => {
    const f = await fixture(),
      { remote } = github(f);
    await f.requests.publish(
      f.run.id,
      (await f.requests.prepare(f.run.id, input)).plan!.fingerprint,
    );
    remote.checks = Array.from({ length: 12 }, (_, i) => ({
      name: `check-${i}`,
      status: 'completed',
      conclusion: 'failure',
      head_sha: remote.commit,
      output: { summary: `Parser error ${i}: ${'x'.repeat(3000)}` },
    }));
    const ci = (await f.requests.check(f.run.id)).ci!;
    expect(
      ci.checks.reduce((size, check) => size + (check.details?.length ?? 0), 0),
    ).toBeLessThanOrEqual(16_384);
    const result = await f.requests.followUp(f.run.id, ci.fingerprint!);
    const child = (await f.store.snapshot()).runs.find((run) => run.id === result.followUpRunId)!;
    expect(child.context.length).toBeLessThanOrEqual(14_000);
    expect(JSON.parse(child.context).checks[0].details).toContain('Parser error 0');
    expect(JSON.parse(child.context).checksTruncated).toBe(true);
  });

  it('handles continuation run inspect and prepare when the parent has no pull-request.json artifact', async () => {
    const f = await fixture();
    const child = await f.store.enqueueCIRepair(f.run.id, 'repair context', 'b'.repeat(64));
    await f.service.tick();
    await f.service.idle();

    await expect(f.requests.inspect(child.id)).resolves.toEqual({
      plan: null,
      receipt: null,
      ci: null,
    });
    await expect(f.requests.prepare(child.id, input)).rejects.toThrow(
      'CI repair requires its published parent',
    );
  });
});

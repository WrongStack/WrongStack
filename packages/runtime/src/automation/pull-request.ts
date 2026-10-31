import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { atomicWrite, withFileLock } from '@wrongstack/core/utils';
import type {
  AutomationPullRequestPlan,
  AutomationPullRequestReceipt,
  AutomationPullRequestView,
} from '@wrongstack/webui-protocol';
import { readAutomationArtifact } from './artifact.js';
import { AutomationGitHubAPI } from './pull-request-api.js';
import { materializeAutomationPatch } from './pull-request-git.js';
import type { AutomationStore } from './store.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
function fingerprint(plan: Omit<AutomationPullRequestPlan, 'fingerprint'>): string {
  return digest(JSON.stringify(plan));
}
type RemotePR = {
  number: number;
  draft: boolean;
  state: string;
  head: { sha: string; ref: string; repo: { full_name: string } };
  base: { ref: string; repo: { full_name: string } };
};

/** All remote writes are reachable only from the explicit publish operation. */
export class AutomationPullRequests {
  constructor(private readonly store: AutomationStore) {}
  private file(id: string) {
    return path.join(this.store.directory, 'runs', id, 'pull-request.json');
  }
  private async run(id: string) {
    const run = (await this.store.snapshot()).runs.find((item) => item.id === id);
    if (!run) throw new Error('Automation run not found');
    return run;
  }
  private async candidate(id: string) {
    const run = await this.run(id);
    const validation = run.result?.validation;
    if (
      run.status !== 'completed' ||
      validation?.status !== 'passed' ||
      !validation.checks?.length ||
      validation.checks.some((check) => check.exitCode !== 0)
    )
      throw new Error(
        'Only completed runs with independent checks passed can prepare or publish a PR',
      );
    const [patch, raw, verification] = await Promise.all(
      ['changes.patch', 'run.json', 'verification.json'].map((name) =>
        readAutomationArtifact(this.store, id, name),
      ),
    );
    const metadata = JSON.parse(raw!);
    const recorded = JSON.parse(verification!);
    if (
      !patch?.trim() ||
      !sha(metadata.sourceTree) ||
      metadata.outputTree !== validation.workspaceTree ||
      metadata.imageId !== validation.imageId ||
      metadata.exitCode !== 0 ||
      metadata.cleanup !== 'removed' ||
      JSON.stringify(metadata.result?.validation) !== JSON.stringify(validation) ||
      recorded.status !== 'passed' ||
      recorded.workspaceTree !== validation.workspaceTree ||
      recorded.planFingerprint !== validation.planFingerprint ||
      JSON.stringify(recorded.checks) !== JSON.stringify(validation.checks)
    )
      throw new Error('Verified candidate evidence is missing or inconsistent');
    return {
      run,
      patch,
      sourceTree: metadata.sourceTree as string,
      inputTree: metadata.inputTree as string | undefined,
      tree: validation.workspaceTree!,
      patchSha256: digest(patch),
      verificationSha256: digest(verification!),
    };
  }
  async inspect(id: string): Promise<AutomationPullRequestView> {
    const run = await this.run(id);
    let state: AutomationPullRequestView = { plan: null, receipt: null, ci: null };
    try {
      state = JSON.parse(await readAutomationArtifact(this.store, id, 'pull-request.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!state.plan && run.continuationRunId) {
      let parent: AutomationPullRequestView = { plan: null, receipt: null, ci: null };
      try {
        parent = JSON.parse(
          await readAutomationArtifact(this.store, run.continuationRunId, 'pull-request.json'),
        ) as AutomationPullRequestView;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (parent.plan && parent.receipt)
        state.suggestedTarget = {
          repository: parent.plan.repository,
          base: parent.plan.base,
          title: parent.plan.title,
        };
    }
    return state;
  }
  async prepare(
    id: string,
    input: { repository: string; base: string; title: string },
  ): Promise<AutomationPullRequestView> {
    if (
      !input ||
      typeof input.repository !== 'string' ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) ||
      input.repository.split('/').some((p) => p === '.' || p === '..') ||
      typeof input.base !== 'string' ||
      !input.base ||
      input.base.length > 200 ||
      !/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(input.base) ||
      /\.\.|\/\/|\/$|\.lock(?:\/|$)/.test(input.base) ||
      typeof input.title !== 'string' ||
      !input.title.trim() ||
      input.title.length > 200 ||
      /[\x00-\x1f\x7f]/.test(input.title)
    )
      throw new Error(
        'Repository, valid base branch and a title of at most 200 characters are required',
      );
    const candidate = await this.candidate(id);
    return withFileLock(this.file(id), async () => {
      const existing = await this.inspect(id);
      if (existing.plan) {
        if (
          existing.plan.repository !== input.repository ||
          existing.plan.base !== input.base ||
          existing.plan.title !== input.title.trim()
        )
          throw new Error('A different PR plan already exists for this run');
        return existing;
      }
      const git = await materializeAutomationPatch(
        candidate.run.job.projectRoot,
        candidate.patch,
        candidate.sourceTree,
      );
      if (git.tree !== candidate.tree)
        throw new Error('Patch no longer produces the independently verified tree');
      let parent: AutomationPullRequestView | undefined;
      if (candidate.run.continuationRunId) {
        parent = await this.inspect(candidate.run.continuationRunId);
        if (
          !parent.plan ||
          !parent.receipt ||
          parent.plan.repository !== input.repository ||
          parent.plan.base !== input.base ||
          parent.plan.baseCommit !== git.commit ||
          parent.plan.sourceTree !== git.source ||
          candidate.inputTree !== parent.plan.candidateTree ||
          git.tree === parent.plan.candidateTree
        )
          throw new Error(
            'CI repair requires its published parent, unchanged base and a new independently verified tree',
          );
      }
      const fields: Omit<AutomationPullRequestPlan, 'fingerprint'> = {
        version: 1,
        runId: id,
        repository: input.repository,
        base: input.base,
        branch: parent?.plan?.branch ?? `wrongstack/automation/${id}`,
        baseCommit: git.commit,
        sourceTree: git.source,
        candidateTree: git.tree,
        patchSha256: candidate.patchSha256,
        verificationSha256: candidate.verificationSha256,
        title: input.title.trim(),
        files: git.changes.map((change) => change.path),
        createdAt: candidate.run.completedAt!,
        body: `Prepared by WrongStack from automation run ${id}.\n\nIndependent checks passed for candidate tree ${git.tree}.\n\n${candidate.run.result!.validation.checks!.map((check) => `- ${JSON.stringify(check.argv)}: exit ${check.exitCode}`).join('\n')}\n\nVerification receipt SHA-256: ${candidate.verificationSha256}.\nPatch SHA-256: ${candidate.patchSha256}.\n\nReview the changes and hosted CI before merging.`,
        ...(parent?.receipt
          ? {
              target: {
                sourceRunId: candidate.run.continuationRunId!,
                number: parent.receipt.number,
                headCommit: parent.receipt.commit,
              },
            }
          : {}),
      };
      if (fields.body.length > 60_000) throw new Error('PR verification summary exceeds 60 KB');
      const state: AutomationPullRequestView = {
        plan: { ...fields, fingerprint: fingerprint(fields) },
        receipt: null,
        ci: null,
      };
      await this.save(id, state);
      return state;
    });
  }
  private save(id: string, state: AutomationPullRequestView) {
    return atomicWrite(this.file(id), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }
  private validatePR(pr: RemotePR, plan: AutomationPullRequestPlan, commit: string) {
    if (
      !Number.isSafeInteger(pr?.number) ||
      pr.number < 1 ||
      pr.state !== 'open' ||
      !pr.draft ||
      pr.head?.sha !== commit ||
      pr.head.ref !== plan.branch ||
      pr.head.repo?.full_name.toLowerCase() !== plan.repository.toLowerCase() ||
      pr.base?.ref !== plan.base ||
      pr.base.repo?.full_name.toLowerCase() !== plan.repository.toLowerCase()
    )
      throw new Error('PR identity, draft state or head differs from the prepared plan');
  }
  async publish(id: string, expectedFingerprint: string): Promise<AutomationPullRequestView> {
    await this.run(id);
    return withFileLock(this.file(id), async () => {
      const state = await this.inspect(id),
        plan = state.plan;
      if (
        !plan ||
        !/^[a-f0-9]{64}$/.test(expectedFingerprint) ||
        expectedFingerprint !== plan.fingerprint
      )
        throw new Error('Review and submit the current PR plan fingerprint');
      const { fingerprint: recordedFingerprint, ...fields } = plan;
      if (fingerprint(fields) !== recordedFingerprint || plan.runId !== id)
        throw new Error('PR plan fingerprint is invalid');
      const candidate = await this.candidate(id);
      if (
        candidate.patchSha256 !== plan.patchSha256 ||
        candidate.verificationSha256 !== plan.verificationSha256 ||
        candidate.tree !== plan.candidateTree ||
        candidate.sourceTree !== plan.sourceTree
      )
        throw new Error('Prepared patch or verification evidence changed');
      const git = await materializeAutomationPatch(
        candidate.run.job.projectRoot,
        candidate.patch,
        plan.sourceTree,
        plan.baseCommit,
      );
      if (git.tree !== plan.candidateTree) throw new Error('Candidate tree changed');
      const api = new AutomationGitHubAPI();
      if (state.receipt) {
        const pr = await api.request<RemotePR>(`${plan.repository}/pulls/${state.receipt.number}`);
        this.validatePR(pr!, plan, state.receipt.commit);
        return state;
      }
      if (plan.target) {
        const pr = await api.request<RemotePR>(`${plan.repository}/pulls/${plan.target.number}`);
        if (sha(state.publicationCommit) && pr?.head.sha === state.publicationCommit) {
          this.validatePR(pr, plan, state.publicationCommit);
          state.receipt = this.receipt(plan, state.publicationCommit, pr.number);
          await this.save(id, state);
          return state;
        }
        this.validatePR(pr!, plan, plan.target.headCommit);
      }
      const baseRoute = `${plan.repository}/commits/${encodeURIComponent(plan.base)}`;
      const remote = await api.request<{ sha: string; commit: { tree: { sha: string } } }>(
        baseRoute,
      );
      if (!remote || remote.sha !== plan.baseCommit || remote.commit?.tree?.sha !== plan.sourceTree)
        throw new Error(
          'Remote base moved or differs from the verified source; rerun and prepare again',
        );
      for (const [blobSha, content] of git.blobs) {
        const uploaded = await api.request<{ sha: string }>(`${plan.repository}/git/blobs`, {
          content: content.toString('base64'),
          encoding: 'base64',
        });
        if (uploaded?.sha !== blobSha) throw new Error('Uploaded Git blob identity differs');
      }
      const tree = await api.request<{ sha: string }>(`${plan.repository}/git/trees`, {
        base_tree: plan.sourceTree,
        tree: git.changes.map((change) => ({ ...change, type: 'blob' })),
      });
      if (tree?.sha !== plan.candidateTree)
        throw new Error('Uploaded Git tree differs from verified candidate');
      const identity = {
        name: 'WrongStack Automation',
        email: 'automation@wrongstack.invalid',
        date: new Date(plan.createdAt).toISOString(),
      };
      const commit = await api.request<{ sha: string }>(`${plan.repository}/git/commits`, {
        message: `${plan.title}\n\nWrongStack run: ${id}\nPlan: ${plan.fingerprint}`,
        tree: plan.candidateTree,
        parents: [plan.target?.headCommit ?? plan.baseCommit],
        author: identity,
        committer: identity,
      });
      if (!sha(commit?.sha)) throw new Error('GitHub commit identity is invalid');
      if ((await api.request<{ sha: string }>(baseRoute))?.sha !== plan.baseCommit)
        throw new Error('Remote base moved during publication; no branch was changed');
      if (plan.target) {
        state.publicationCommit = commit.sha;
        await this.save(id, state);
        const pr = await api.request<RemotePR>(`${plan.repository}/pulls/${plan.target.number}`);
        this.validatePR(pr!, plan, plan.target.headCommit);
        try {
          await api.updateBranch(
            plan.repository,
            plan.branch,
            plan.target.headCommit,
            commit.sha,
            plan.fingerprint,
          );
        } catch {
          const observed = await api.request<RemotePR>(
            `${plan.repository}/pulls/${plan.target.number}`,
          );
          if (observed?.head.sha !== commit.sha)
            throw new Error(
              'Expected PR head changed or update was not confirmed; retry the same reviewed plan',
            );
        }
        const updated = await api.request<RemotePR>(
          `${plan.repository}/pulls/${plan.target.number}`,
        );
        this.validatePR(updated!, plan, commit.sha);
        state.receipt = this.receipt(plan, commit.sha, updated!.number);
        await this.save(id, state);
        return state;
      }
      const refRoute = `${plan.repository}/git/ref/heads/${plan.branch}`;
      let branch = await api.request<{ object: { sha: string } }>(refRoute, undefined, true);
      if (!branch) {
        try {
          await api.request(`${plan.repository}/git/refs`, {
            ref: `refs/heads/${plan.branch}`,
            sha: commit.sha,
          });
        } catch {
          branch = await api.request(refRoute, undefined, true);
          if (branch?.object.sha !== commit.sha)
            throw new Error('Branch creation was not confirmed; retry the same prepared plan');
        }
      } else if (branch.object?.sha !== commit.sha)
        throw new Error(
          'Publication branch already has another commit; it will not be overwritten',
        );
      const pulls = await api.request<RemotePR[]>(
        `${plan.repository}/pulls?state=all&head=${encodeURIComponent(`${plan.repository.split('/')[0]}:${plan.branch}`)}&base=${encodeURIComponent(plan.base)}&per_page=100`,
      );
      if (!Array.isArray(pulls) || pulls.length > 1)
        throw new Error('Ambiguous PR publication state');
      let pr = pulls[0];
      if (!pr) {
        try {
          pr = (await api.request<RemotePR>(`${plan.repository}/pulls`, {
            title: plan.title,
            body: plan.body,
            head: plan.branch,
            base: plan.base,
            draft: true,
            maintainer_can_modify: false,
          }))!;
        } catch {
          throw new Error(
            'PR creation was not confirmed; retry the same prepared plan to recover without a duplicate',
          );
        }
      }
      this.validatePR(pr, plan, commit.sha);
      const receipt: AutomationPullRequestReceipt = {
        fingerprint: plan.fingerprint,
        commit: commit.sha,
        number: pr.number,
        url: `https://github.com/${plan.repository}/pull/${pr.number}`,
        draft: true,
      };
      state.receipt = receipt;
      await this.save(id, state);
      return state;
    });
  }
  async check(id: string): Promise<AutomationPullRequestView> {
    await this.run(id);
    return withFileLock(this.file(id), async () => {
      const state = await this.inspect(id),
        plan = state.plan,
        receipt = state.receipt;
      if (!plan || !receipt) throw new Error('Publish the prepared draft PR before checking CI');
      const api = new AutomationGitHubAPI();
      const pr = await api.request<RemotePR>(`${plan.repository}/pulls/${receipt.number}`);
      const ci: NonNullable<AutomationPullRequestView['ci']> = {
        commit: receipt.commit,
        checkedAt: Date.now(),
        status: 'unknown',
        checks: [],
      };
      if (
        pr?.number !== receipt.number ||
        pr.head?.repo?.full_name.toLowerCase() !== plan.repository.toLowerCase() ||
        pr.base?.repo?.full_name.toLowerCase() !== plan.repository.toLowerCase() ||
        pr.head?.sha !== receipt.commit
      )
        ci.status = 'stale';
      else {
        let detailsRemaining = 16_384;
        const detailsFor = (text: string) => {
          const value = text.slice(0, Math.min(2048, detailsRemaining));
          detailsRemaining -= value.length;
          return value;
        };
        for (let page = 1; page <= 10; page++) {
          const response = await api.request<{
            total_count: number;
            check_runs: Array<{
              name: string;
              status: string;
              conclusion: string | null;
              head_sha: string;
              output?: { summary?: string; text?: string } | undefined;
            }>;
          }>(
            `${plan.repository}/commits/${receipt.commit}/check-runs?filter=latest&per_page=100&page=${page}`,
          );
          if (
            !response ||
            !Number.isSafeInteger(response.total_count) ||
            response.total_count < 0 ||
            response.total_count > 1000 ||
            !Array.isArray(response.check_runs) ||
            response.check_runs.length !==
              Math.min(100, Math.max(0, response.total_count - (page - 1) * 100))
          )
            throw new Error('CI check collection is incomplete');
          for (const check of response.check_runs) {
            if (
              check.head_sha !== receipt.commit ||
              typeof check.name !== 'string' ||
              typeof check.status !== 'string' ||
              (check.conclusion !== null && typeof check.conclusion !== 'string')
            )
              throw new Error('CI check identity is invalid');
            ci.checks.push({
              name: check.name.slice(0, 256).replace(/[\x00-\x1f\x7f]/g, ' '),
              status: check.status,
              conclusion: check.conclusion,
              ...(check.conclusion && !['success', 'neutral', 'skipped'].includes(check.conclusion)
                ? {
                    details: detailsFor(
                      [check.output?.summary, check.output?.text]
                        .filter((value) => typeof value === 'string')
                        .join('\n'),
                    ),
                  }
                : {}),
            });
          }
          if (ci.checks.length >= response.total_count) break;
          if (page === 10 || !response.check_runs.length)
            throw new Error('CI check collection is incomplete');
        }
        for (let page = 1; page <= 10; page++) {
          // The combined status names its commit once, at the top level; its entries carry
          // no sha, so the identity check binds that top-level sha to the published head.
          const response = await api.request<{
            sha: string;
            total_count: number;
            statuses: Array<{ context: string; state: string; description?: string }>;
          }>(`${plan.repository}/commits/${receipt.commit}/status?per_page=100&page=${page}`);
          if (
            !response ||
            !Number.isSafeInteger(response.total_count) ||
            response.total_count < 0 ||
            response.total_count > 1000 ||
            !Array.isArray(response.statuses) ||
            response.statuses.length !==
              Math.min(100, Math.max(0, response.total_count - (page - 1) * 100))
          )
            throw new Error('CI status collection is incomplete');
          for (const status of response.statuses) {
            if (
              response.sha !== receipt.commit ||
              typeof status.context !== 'string' ||
              typeof status.state !== 'string'
            )
              throw new Error('CI status is invalid');
            ci.checks.push({
              name: status.context.slice(0, 256).replace(/[\x00-\x1f\x7f]/g, ' '),
              status: status.state === 'pending' ? 'pending' : 'completed',
              conclusion: status.state,
              ...(status.state !== 'success' && typeof status.description === 'string'
                ? { details: detailsFor(status.description) }
                : {}),
            });
          }
          if (page * 100 >= response.total_count) break;
          if (page === 10 || !response.statuses.length)
            throw new Error('CI status collection is incomplete');
        }
        const failures = [
          'failure',
          'error',
          'cancelled',
          'timed_out',
          'action_required',
          'stale',
          'startup_failure',
        ];
        ci.status = ci.checks.some((c) => failures.includes(c.conclusion ?? ''))
          ? 'failed'
          : ci.checks.some((c) => c.status !== 'completed')
            ? 'pending'
            : ci.checks.length &&
                ci.checks.every((c) =>
                  ['success', 'neutral', 'skipped'].includes(c.conclusion ?? ''),
                ) &&
                ci.checks.some((c) => c.conclusion === 'success')
              ? 'passed'
              : 'unknown';
        const latest = await api.request<RemotePR>(`${plan.repository}/pulls/${receipt.number}`);
        if (latest?.head?.sha !== receipt.commit) ci.status = 'stale';
      }
      ci.fingerprint = digest(
        JSON.stringify({
          commit: ci.commit,
          status: ci.status,
          checks: ci.checks.map((check) => JSON.stringify(check)).sort(),
        }),
      );
      state.ci = ci;
      await this.save(id, state);
      await atomicWrite(
        path.join(this.store.directory, 'runs', id, 'ci.json'),
        `${JSON.stringify(ci, null, 2)}\n`,
        { mode: 0o600 },
      );
      return state;
    });
  }
  private receipt(
    plan: AutomationPullRequestPlan,
    commit: string,
    number: number,
  ): AutomationPullRequestReceipt {
    return {
      fingerprint: plan.fingerprint,
      commit,
      number,
      url: `https://github.com/${plan.repository}/pull/${number}`,
      draft: true,
    };
  }
  /** Explicit queue action. It rechecks live CI; refresh alone never starts a model run. */
  async followUp(id: string, expectedFingerprint: string): Promise<AutomationPullRequestView> {
    if (!/^[a-f0-9]{64}$/.test(expectedFingerprint))
      throw new Error('Refresh CI and submit its current fingerprint');
    await this.check(id);
    return withFileLock(this.file(id), async () => {
      const state = await this.inspect(id),
        { ci, plan, receipt } = state;
      if (
        ci?.status !== 'failed' ||
        ci.fingerprint !== expectedFingerprint ||
        !plan ||
        !receipt ||
        ci.commit !== receipt.commit
      )
        throw new Error('CI changed or is no longer failing; refresh before queueing a repair');
      if (state.followUpRunId) return state;
      const live = await new AutomationGitHubAPI().request<RemotePR>(
        `${plan.repository}/pulls/${receipt.number}`,
      );
      this.validatePR(live!, plan, receipt.commit);
      const failures = ci.checks
        .filter((check) => !['success', 'neutral', 'skipped'].includes(check.conclusion ?? ''))
        .slice(0, 20);
      const feedback = {
        type: 'ci-repair',
        sourceRunId: id,
        repository: plan.repository,
        pullRequest: receipt.number,
        commit: receipt.commit,
        ciFingerprint: ci.fingerprint,
        totalChecks: ci.checks.length,
        checks: failures,
        checksTruncated: ci.checks.length > failures.length,
        request:
          'Investigate these CI failures, repair the continued candidate and run the frozen independent checks. Do not publish or change credentials/policy.',
      };
      let context = JSON.stringify(feedback);
      while (failures.length && context.length > 14_000) {
        failures.pop();
        feedback.checksTruncated = true;
        context = JSON.stringify(feedback);
      }
      const run = await this.store.enqueueCIRepair(id, context, digest(context));
      state.followUpRunId = run.id;
      await this.save(id, state);
      return state;
    });
  }
}

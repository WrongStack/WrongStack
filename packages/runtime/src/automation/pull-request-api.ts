/** Fixed GitHub origin; tokens never enter argv, plans, logs or agent containers. */
export class AutomationGitHubAPI {
  private readonly deadline = Date.now() + 120_000;
  constructor(private readonly token = process.env['GITHUB_TOKEN'] || process.env['GH_TOKEN']) {
    if (!token?.trim() || /[\r\n]/.test(token))
      throw new Error('Set GITHUB_TOKEN or GH_TOKEN on the managing host');
  }
  async request<T>(route: string, body?: unknown, allowMissing = false): Promise<T | null> {
    return this.send<T>(`https://api.github.com/repos/${route}`, body, allowMissing);
  }
  /** GitHub's atomic beforeOid comparison also rejects concurrent branch resets. */
  async updateBranch(
    repository: string,
    branch: string,
    before: string,
    after: string,
    mutationId: string,
  ): Promise<void> {
    const repo = await this.request<{ node_id: string }>(repository);
    if (!repo?.node_id) throw new Error('GitHub repository identity is unavailable');
    const result = await this.send<{
      data?: { updateRefs?: { clientMutationId?: string } };
      errors?: unknown[];
    }>('https://api.github.com/graphql', {
      query:
        'mutation WrongStackCIRepair($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }',
      variables: {
        input: {
          repositoryId: repo.node_id,
          clientMutationId: mutationId,
          refUpdates: [
            { name: `refs/heads/${branch}`, beforeOid: before, afterOid: after, force: false },
          ],
        },
      },
    });
    if (result?.errors?.length || result?.data?.updateRefs?.clientMutationId !== mutationId)
      throw new Error('GitHub refused the expected-head update; refresh the PR before retrying');
  }
  private async send<T>(url: string, body?: unknown, allowMissing = false): Promise<T | null> {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0)
      throw new Error('GitHub operation exceeded two minutes; retry the same prepared plan');
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(Math.min(30_000, remaining)),
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (allowMissing && response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `GitHub request failed (${response.status}); inspect repository access and retry`,
      );
    }
    if (response.status === 204 || !response.body) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        if (size > 2 * 1024 * 1024) throw new Error('GitHub response exceeds 2 MB');
        chunks.push(item.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (!text) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`GitHub returned invalid JSON (${response.status})`);
    }
  }
}

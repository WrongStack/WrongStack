/**
 * Report which expensive CI jobs have already passed for this exact commit.
 *
 * A GitHub Actions re-run creates fresh job checks even though the source,
 * lockfile, workflow, and test inputs are identical. Reusing a completed
 * successful check for the SAME SHA avoids paying for an unchanged test run;
 * a different SHA always runs the job normally. API errors are fail-closed.
 */
const checks = {
  lint: 'Lint (Biome)',
  typecheck: 'TypeCheck (tsc)',
  build: 'Build (esbuild + tsc declarations)',
  test: 'Test (Vitest + coverage ratchets)',
  e2e: 'E2E (Playwright)',
  'tui-smoke': 'TUI Smoke (non-TTY)',
  'tui-heap-soak': 'TUI Heap Soak',
};

const outputFile = process.env.GITHUB_OUTPUT;
const apiUrl = process.env.GITHUB_API_URL;
const repository = process.env.GITHUB_REPOSITORY;
const sha = process.env.GITHUB_SHA;
const token = process.env.GITHUB_TOKEN;

async function writeOutput(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  if (outputFile) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(outputFile, `${lines.join('\n')}\n`);
  } else {
    console.log(lines.join('\n'));
  }
}

const noReuse = Object.fromEntries(Object.keys(checks).map((key) => [key, 'false']));

if (!apiUrl || !repository || !sha || !token) {
  console.warn('[ci-reuse] GitHub Actions metadata is unavailable; running all checks.');
  await writeOutput(noReuse);
} else {
  const results = { ...noReuse };
  try {
    await Promise.all(
      Object.entries(checks).map(async ([job, checkName]) => {
        const url = new URL(`${apiUrl}/repos/${repository}/commits/${sha}/check-runs`);
        url.searchParams.set('check_name', checkName);
        // `latest` would hide a prior pass behind this re-run's queued check.
        url.searchParams.set('filter', 'all');
        url.searchParams.set('per_page', '100');
        const response = await fetch(url, {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });
        if (!response.ok) {
          console.warn(
            `[ci-reuse] ${job}: check-run lookup returned HTTP ${response.status}; rerunning.`,
          );
          return;
        }
        const body = await response.json();
        const previousSuccess = Array.isArray(body.check_runs)
          ? body.check_runs.some(
              (check) =>
                check?.name === checkName &&
                check?.status === 'completed' &&
                check?.conclusion === 'success',
            )
          : false;
        results[job] = String(previousSuccess);
      }),
    );
  } catch (error) {
    console.warn(
      `[ci-reuse] check-run lookup failed; rerunning all checks: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  await writeOutput(results);
  console.log(
    `[ci-reuse] same-SHA reusable jobs: ${
      Object.entries(results)
        .filter(([, reusable]) => reusable === 'true')
        .map(([job]) => job)
        .join(', ') || 'none'
    }`,
  );
}

import { spawnSync } from 'node:child_process';

const pnpmCli = process.env.npm_execpath;

if (!pnpmCli) {
  throw new Error('test:coverage must be started through pnpm');
}

const runs = [
  {
    label: 'Node packages',
    args: ['test:coverage:root'],
  },
  {
    label: 'LSP package per-file gate',
    args: ['--filter', '@wrongstack/plug-lsp', 'test:coverage'],
  },
  {
    label: 'WebUI package',
    args: ['--filter', '@wrongstack/webui', 'test:coverage'],
  },
];

let failed = false;

for (const run of runs) {
  console.log(`\n=== Coverage: ${run.label} ===\n`);
  const result = spawnSync(process.execPath, [pnpmCli, ...run.args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    failed = true;
  }
}

process.exitCode = failed ? 1 : 0;

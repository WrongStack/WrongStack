import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extractIgnoredGhsas } from './check-audit-suppressions.mjs';

// Retain the reviewed suppression policy and its PR additions guard.
const ignored = extractIgnoredGhsas(
  readFileSync(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8'),
);
const result = spawnSync(
  process.execPath,
  ['audit', ...process.argv.slice(2), ...[...ignored].flatMap((id) => ['--ignore', id])],
  {
    stdio: 'inherit',
    windowsHide: true,
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

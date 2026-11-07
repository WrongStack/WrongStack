/**
 * Hermetic global root for this package's tests.
 *
 * The process-guard plugin registers its PID in the cross-instance persistent
 * registry, which lives under `~/.wrongstack` unless `WRONGSTACK_HOME` points
 * elsewhere. Mirrors the root `vitest.setup.ts` so package-level runs never
 * write to the developer's real registry (and never register the test process
 * for real kill protection).
 */
import * as os from 'node:os';
import * as path from 'node:path';

if (!process.env['WRONGSTACK_HOME']) {
  process.env['WRONGSTACK_HOME'] = path.join(
    os.tmpdir(),
    `wstack-plugins-vitest-${process.pid}`,
    '.wrongstack',
  );
}

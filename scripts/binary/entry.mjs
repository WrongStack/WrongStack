// Standalone-binary entry. Compiled by scripts/build-binaries.mjs with
// `bun build --compile`; never run directly. See
// packages/persistence/src/standalone-binary.ts for the invariants this file
// implements (daemon dispatch, script dispatch, extracted asset root).
//
// Every WrongStack module is reached through a dynamic import so nothing
// evaluates before the asset root and build stamp are in place.

import assetPackPath from '../../dist-bin/.stage/assets.pack' with { type: 'file' };
import { startStandalone } from './runtime.mjs';

await startStandalone(assetPackPath, {
  runMain: () => import('../../packages/cli/dist/index.js'),
  runDaemon,
});

async function runDaemon(name) {
  switch (name) {
    // These modules start their server on import.
    case 'chronicle':
      await import('../../packages/chronicle/dist/project-server.js');
      return;
    case 'mailbox':
      await import('../../packages/coordination/dist/mailbox-project-server.js');
      return;
    case 'session-catalog':
      await import('../../packages/core/dist/session-catalog/project-server.js');
      return;
    case 'sage':
      await import('../../packages/sage/dist/project-server.js');
      return;
    case 'codebase-index':
      await import('../../packages/codebase/dist/project-server.js');
      return;
    // These guard on "am I main", which the binary disables; call explicitly.
    case 'governance': {
      const mod = await import('../../packages/governance/dist/project-daemon.js');
      mod.runGovernanceProjectDaemon();
      return;
    }
    case 'kanban': {
      const mod = await import('../../packages/kanban/dist/project-server.js');
      await mod.main();
      return;
    }
    default:
      process.stderr.write(`wstack: unknown daemon "${name ?? ''}"\n`);
      process.exit(2);
  }
}

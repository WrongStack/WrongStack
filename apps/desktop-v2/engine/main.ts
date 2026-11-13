// Reuse WrongStack's backend services and protocol, never its web frontend.
import { version } from '../package.json';

if (process.argv.includes('--version')) {
  console.log(`WrongStack desktop engine ${version}`);
  process.exit(0);
}

const portIndex = process.argv.indexOf('--port');
const port = Number(process.argv[portIndex + 1]);
const accessToken = process.env['WEBUI_TOKEN'];
const distDir = process.env['WRONGSTACK_DESKTOP_EMPTY_DIST'];
if (!Number.isInteger(port) || port < 1 || port > 65535 || !accessToken || !distDir) {
  throw new Error(
    'Desktop engine requires a valid port, private token, and disabled frontend directory.',
  );
}
const { hardenWin32ExecutableSearch } = await import('@wrongstack/core/utils');
hardenWin32ExecutableSearch();
const { startWebUI } = await import('@wrongstack/webui-server');
const resumeIndex = process.argv.indexOf('--resume');
const resumeSource = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : undefined;
const readyFile = process.env['WRONGSTACK_DESKTOP_RESTORE_READY'];
// A spare engine boots now and learns which conversation it is when the host claims it.
const spareClaimFile = process.env['WRONGSTACK_DESKTOP_SPARE_CLAIM'];
if (spareClaimFile && (resumeIndex >= 0 || !readyFile))
  throw Error('A spare engine takes its conversation from its claim, with a readiness path.');
/** Copies a recorded conversation into a new one in this project and returns the copy's id. */
async function forkSession(source: string): Promise<string> {
  const { DefaultSessionStore } = await import('@wrongstack/core/storage');
  const { resolveWstackPaths } = await import('@wrongstack/core/utils');
  const projectRoot = process.cwd();
  const paths = resolveWstackPaths({ projectRoot });
  const store = new DefaultSessionStore({ dir: paths.projectSessions, projectRoot });
  try {
    return (await store.fork(source)).id;
  } finally {
    await store.dispose?.();
  }
}
let restoreId = resumeSource;
if (resumeIndex >= 0) {
  if (!resumeSource || !readyFile)
    throw Error('Recorded conversation boot requires a source and native readiness path.');
  if (process.argv.includes('--fork-session')) restoreId = await forkSession(resumeSource);
}
await startWebUI({
  useCwdAsProjectRoot: process.env['WRONGSTACK_DESKTOP_USE_CWD_AS_PROJECT_ROOT'] === '1',
  wsHost: '127.0.0.1',
  httpPort: port,
  accessToken,
  requireToken: true,
  distDir,
  open: false,
  // A built engine (it carries the release build's stamp) reports newer releases; dev runs do not.
  appVersion: (globalThis as Record<symbol, unknown>)[Symbol.for('wrongstack.standalone-build')]
    ? version
    : undefined,
});
if (spareClaimFile && readyFile) {
  const { writeFile } = await import('node:fs/promises');
  const { spareMaxAge, waitForSpareClaim } = await import('./spare-claim');
  // Unclaimed for its whole life: stop, so an unused engine does not hold its memory. The
  // graceful shutdown ends and closes the boot session, so it is a strictly empty journal the
  // engines' ownerless-empty-session sweep removes; a hard exit would leave a 0-byte transcript
  // that sweep can never prove empty. The host removes its own files for the spare.
  const stopUnclaimed = (): Promise<never> => {
    if (process.listenerCount('SIGTERM') > 0) process.emit('SIGTERM');
    else process.exit(0);
    return new Promise<never>(() => undefined);
  };
  const waited = await waitForSpareClaim(spareClaimFile, {
    maxWaitMs: spareMaxAge(process.env['WRONGSTACK_DESKTOP_SPARE_MAX_AGE_MS']),
  });
  // The host asks a spare it no longer wants to stop the same graceful way.
  const claim = waited && !waited.stop ? waited : await stopUnclaimed();
  try {
    if (claim.resume) {
      restoreId = claim.fork ? await forkSession(claim.resume) : claim.resume;
    } else {
      // A new conversation is the session this engine started with; the host only waits for
      // the readiness answer before it connects.
      await writeFile(readyFile, JSON.stringify({ sessionId: 'new' }));
    }
  } catch (error) {
    await writeFile(
      readyFile,
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
    );
    throw error;
  }
}
if (restoreId && readyFile) {
  const { writeFile } = await import('node:fs/promises');
  const { restoreEngineSession } = await import('./restore-session');
  try {
    await restoreEngineSession(port, accessToken, restoreId);
    await writeFile(readyFile, JSON.stringify({ sessionId: restoreId }));
  } catch (error) {
    await writeFile(
      readyFile,
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
    );
    throw error;
  }
}

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
let restoreId = resumeSource;
if (resumeIndex >= 0) {
  if (!resumeSource || !readyFile)
    throw Error('Recorded conversation boot requires a source and native readiness path.');
  if (process.argv.includes('--fork-session')) {
    const { DefaultSessionStore } = await import('@wrongstack/core/storage');
    const { resolveWstackPaths } = await import('@wrongstack/core/utils');
    const projectRoot = process.cwd();
    const paths = resolveWstackPaths({ projectRoot });
    const store = new DefaultSessionStore({ dir: paths.projectSessions, projectRoot });
    try {
      restoreId = (await store.fork(resumeSource)).id;
    } finally {
      await store.dispose?.();
    }
  }
}
await startWebUI({
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

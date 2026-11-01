import { type EngineCommand, EngineReplyError } from './engine-operations';

const digest = /^[a-f0-9]{64}$/;
export type FileSaveOutcome =
  | { kind: 'saved' }
  /** The disk differs from the version this save was bound to; nothing was written. */
  | { kind: 'conflict'; sha256: string | null };

/**
 * Save a draft only over the disk version it was reviewed against. A normal save
 * binds to the version whose text equals the editor's saved baseline; an
 * explicit overwrite binds to the version shown in the conflict review.
 * The engine re-checks that hash immediately before its atomic rename.
 */
export async function saveFileVersion(
  command: EngineCommand,
  path: string,
  content: string,
  baseline: string,
  overwrite?: string,
): Promise<FileSaveOutcome> {
  const latest = await command('files.read', { filePath: path }, ['files.read']);
  if (latest['binary'] || latest['tooLarge'])
    throw new Error('This file can no longer be saved as text. Your draft is still open.');
  const current = latest['sha256'];
  if (typeof current !== 'string' || !digest.test(current))
    throw new Error(
      'This project engine cannot verify saves against the disk version. Restart the project to update its engine. Your draft is still open.',
    );
  if (overwrite === undefined && latest['content'] !== baseline)
    return { kind: 'conflict', sha256: current };
  if (overwrite !== undefined && overwrite !== current)
    return { kind: 'conflict', sha256: current };
  let written: Record<string, unknown>;
  try {
    written = await command('files.write', { filePath: path, content, expectedSha256: current }, [
      'files.written',
    ]);
  } catch (error) {
    if (error instanceof EngineReplyError && error.details['conflict'] === true) {
      const sha = error.details['currentSha256'];
      return { kind: 'conflict', sha256: typeof sha === 'string' && digest.test(sha) ? sha : null };
    }
    throw error;
  }
  const result = await command('files.read', { filePath: path }, ['files.read']);
  if (result['content'] !== content || result['sha256'] !== written['sha256'])
    throw new Error('The saved file differs from your draft. Reload before continuing.');
  return { kind: 'saved' };
}

/**
 * Opens a project path in the system file manager (`shell.open`); a file opens its folder. The
 * engine keeps the path inside the project and asks for approval where the profile requires it.
 */
export async function showInFileManager(command: EngineCommand, path: string): Promise<void> {
  try {
    await command('shell.open', { path, target: 'file' }, ['key.operation_result']);
  } catch (failure) {
    throw Error(failure instanceof Error ? failure.message : String(failure));
  }
}

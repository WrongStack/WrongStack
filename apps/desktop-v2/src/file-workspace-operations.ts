import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import type { EngineState } from './engine-state';
import {
  copyTarget,
  EMPTY_SHA256,
  folderCopyPlan,
  MAX_FOLDER_COPY_BYTES,
  MAX_FOLDER_COPY_FILES,
  type RenameStep,
  relocatedPath,
} from './file-bulk';
import { type FileNode, parentPath } from './file-model';
import type { Document } from './file-workspace-types';

type FileOperationsOptions = {
  command: EngineCommand;
  all: FileNode[];
  docs: RefObject<Record<string, Document>>;
  setDocuments: Dispatch<SetStateAction<Record<string, Document>>>;
  setActive: Dispatch<SetStateAction<string>>;
  setFolder: Dispatch<SetStateAction<string>>;
  state: EngineState;
  t: ReturnType<typeof useDesktopText>['t'];
};

export function createFileWorkspaceOperations({
  command,
  all,
  docs,
  setDocuments,
  setActive,
  setFolder,
  state,
  t,
}: FileOperationsOptions) {
  /** Open documents, the active file and the folder follow an item to its new path. */
  const relocate = (path: string, nextPath: string) => {
    setDocuments((current) =>
      Object.fromEntries(
        Object.entries(current).map(([p, doc]) => [relocatedPath(p, path, nextPath) ?? p, doc]),
      ),
    );
    setActive((current) => relocatedPath(current, path, nextPath) ?? current);
    setFolder((current) => relocatedPath(current, path, nextPath) ?? current);
  };
  const hasUnsaved = (path: string) =>
    Object.entries(docs.current).some(
      ([p, d]) => relocatedPath(p, path, p) !== null && d.content !== d.saved,
    );
  const forget = (path: string) => {
    setDocuments((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([p]) => relocatedPath(p, path, p) === null),
      ),
    );
    setActive((current) => (relocatedPath(current, path, '') === null ? current : ''));
    setFolder((current) =>
      relocatedPath(current, path, '') === null ? current : parentPath(path),
    );
  };
  const removePath = async (path: string) => {
    await command(
      'files.delete',
      { filePath: path, recursive: all.find((n) => n.path === path)?.type === 'directory' },
      ['files.deleted'],
    );
    forget(path);
  };
  // Engines with `files.batch` apply a bulk move, rename or delete all or nothing;
  // `files.batch-copy` does the same for copies.
  const capabilities = state.results['session.start']?.['protocolCapabilities'];
  const batchFiles = Array.isArray(capabilities) && capabilities.includes('files.batch');
  const batchCopy = Array.isArray(capabilities) && capabilities.includes('files.batch-copy');
  const copyMany = async (steps: RenameStep[]) => {
    await command('files.copy_many', { items: steps }, ['files.copied_many']);
  };
  const moveMany = async (steps: RenameStep[]) => {
    await command('files.move_many', { items: steps }, ['files.moved_many']);
    for (const step of steps) relocate(step.from, step.to);
  };
  const removeMany = async (paths: string[]) => {
    const result = await command(
      'files.delete_many',
      {
        filePaths: paths,
        recursive: paths.some((path) => all.find((n) => n.path === path)?.type === 'directory'),
      },
      ['files.deleted_many'],
    );
    for (const path of paths) forget(path);
    return typeof result['warning'] === 'string' ? result['warning'] : undefined;
  };
  const movePath = async (path: string, destination: string) => {
    const result = await command('files.move', { srcPath: path, destDir: destination }, [
      'files.moved',
    ]);
    relocate(path, String(result['destPath'] ?? result['newPath'] ?? ''));
  };
  /**
   * Copies a saved text file: create refuses an existing target, and the content is written
   * only while the new file is still the empty one just created.
   */
  const copyPath = async (path: string, destination: string) => {
    if (all.find((node) => node.path === path)?.type === 'directory')
      return copyFolder(path, destination);
    const source = await command('files.read', { filePath: path }, ['files.read']);
    if (source['binary'] || source['tooLarge']) throw Error(t('fileView.copyTextOnly'));
    const target = copyTarget(path, destination);
    await command('files.create', { filePath: target, type: 'file' }, ['files.created']);
    await command(
      'files.write',
      { filePath: target, content: String(source['content'] ?? ''), expectedSha256: EMPTY_SHA256 },
      ['files.written'],
    );
  };
  /**
   * Copies a folder only when every listed file is readable text: all sources are read and
   * checked before anything is created, so a refusal leaves no partial copy.
   */
  const copyFolder = async (path: string, destination: string) => {
    const listing = await command('files.tree', { path, includeIgnored: true }, ['files.tree']);
    if (listing['error']) throw Error(String(listing['error']));
    const plan = folderCopyPlan(listing['tree'], path, destination);
    if (plan.tooDeep) throw Error(t('fileView.copyTooDeep'));
    if (plan.files.length > MAX_FOLDER_COPY_FILES)
      throw Error(t('fileView.copyTooMany', { count: MAX_FOLDER_COPY_FILES }));
    const contents: string[] = [];
    let bytes = 0;
    for (const file of plan.files) {
      const source = await command('files.read', { filePath: file.from }, ['files.read']);
      if (source['binary'] || source['tooLarge'])
        throw Error(t('fileView.copyNotText', { path: file.from }));
      const content = String(source['content'] ?? '');
      bytes += new TextEncoder().encode(content).length;
      if (bytes > MAX_FOLDER_COPY_BYTES) throw Error(t('fileView.copyTooLarge'));
      contents.push(content);
    }
    // The root is created first: an existing target refuses the copy before anything else.
    await command('files.create', { filePath: plan.dirs[0], type: 'directory' }, ['files.created']);
    try {
      for (const dir of plan.dirs.slice(1))
        await command('files.create', { filePath: dir, type: 'directory' }, ['files.created']);
      for (const [index, file] of plan.files.entries()) {
        await command('files.create', { filePath: file.to, type: 'file' }, ['files.created']);
        await command(
          'files.write',
          { filePath: file.to, content: contents[index], expectedSha256: EMPTY_SHA256 },
          ['files.written'],
        );
      }
    } catch (failure) {
      throw Error(
        t('fileView.copyPartial', {
          path: plan.dirs[0],
          reason: failure instanceof Error ? failure.message : String(failure),
        }),
      );
    }
  };
  const renamePath = async (path: string, newPath: string) => {
    const result = await command('files.rename', { oldPath: path, newPath }, ['files.renamed']);
    relocate(path, String(result['newPath'] ?? newPath));
  };

  return {
    relocate,
    hasUnsaved,
    removePath,
    batchFiles,
    batchCopy,
    copyMany,
    moveMany,
    removeMany,
    movePath,
    copyPath,
    renamePath,
  };
}

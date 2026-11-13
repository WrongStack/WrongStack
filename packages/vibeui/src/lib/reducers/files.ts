import { bounded, number, rows, text } from '../session-coercion';
import type { SessionState } from '../session-state';
import { parseFileTree } from '../workspace-model';
import type { FrameReducer, FrameReducerTable } from './types';

const PREVIEWABLE_IMAGE = /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z\d+/=]+$/i;

/** files.read / files.image only settle the preview the controller requested. */
const preview: FrameReducer = (state, p, frame) => {
  const current = state.preview;
  if (!current || p.requestId !== current.requestId || p.filePath !== current.artifact.path)
    return state;
  const image = frame.type === 'files.image';
  const content = text(image ? p.dataUrl : p.content);
  const error =
    text(p.error) ||
    (p.binary || p.tooLarge || p.notImage ? 'Preview unavailable for this file.' : '');
  const invalidImage = image && !PREVIEWABLE_IMAGE.test(content);
  return {
    ...state,
    preview: {
      ...current,
      content: image ? content : bounded(content),
      error: error || (invalidImage ? 'Image preview unavailable.' : ''),
      loading: false,
    },
  };
};

function diffError(p: Record<string, unknown>): string {
  return (
    text(p.error) ||
    (p.binary
      ? 'Binary file — preview unavailable.'
      : p.tooLarge
        ? 'File exceeds the preview limit.'
        : '')
  );
}

/** Project files, previews, file search and git working-tree changes. */
export const fileReducers: FrameReducerTable = {
  'files.tree': (state, p): SessionState => ({
    ...state,
    fileTree: parseFileTree(p.tree),
    treeLoading: false,
    treeLoaded: true,
    treeError: text(p.error),
  }),
  'files.read': preview,
  'files.image': preview,
  'files.list': (state, p) => ({
    ...state,
    matches: Array.isArray(p.files)
      ? p.files.filter((v): v is string => typeof v === 'string').slice(0, 30)
      : [],
  }),
  'git.changes': (state, p) => ({
    ...state,
    files: rows(p.files).map((f) => ({
      path: text(f.path),
      status: text(f.status),
      additions: number(f.added),
      deletions: number(f.deleted),
    })),
    notice: text(p.error) || state.notice,
  }),
  'git.diff': (state, p) => ({
    ...state,
    diff: {
      path: text(p.path),
      oldText: text(p.oldText),
      newText: text(p.newText),
      error: diffError(p),
    },
  }),
};

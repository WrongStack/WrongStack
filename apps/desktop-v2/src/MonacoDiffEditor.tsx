import { DiffEditor } from '@monaco-editor/react';
import { getLanguage } from '@wrongstack/project-surfaces/lib/completion';
import type * as monaco from 'monaco-editor';
import { useEffect, useRef, useState } from 'react';
import { useCodeFont } from './appearance-fonts';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { saveFileVersion } from './file-save';
import { MONACO_FONT, useEditorTheme } from './MonacoFileEditor';
import './monaco-diff.css';

/**
 * The WebUI's editable side-by-side diff: HEAD on the left, the working tree on the right, where
 * edits can be applied back to the file. Applying binds to the version the diff showed, so a
 * file that changed on disk meanwhile is reported instead of overwritten.
 */
export default function MonacoDiffEditor({
  path,
  before,
  after,
  command,
  onApplied,
}: {
  path: string;
  before: string;
  after: string;
  command: EngineCommand;
  onApplied: () => void;
}) {
  const { t } = useDesktopText();
  const theme = useEditorTheme();
  const codeFont = useCodeFont();
  const editor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const models = useRef<monaco.editor.IDiffEditorModel | null>(null);
  // The wrapper disposes its models before the editor when it unmounts, which Monaco reports as
  // "TextModel got disposed before DiffEditorWidget model got reset". This component owns the
  // models instead: the editor lets go of them first, then they are disposed.
  useEffect(
    () => () => {
      try {
        editor.current?.setModel(null);
      } catch {
        // The wrapper disposed the editor first; the models are no longer attached.
      }
      models.current?.original.dispose();
      models.current?.modified.dispose();
    },
    [],
  );
  const [dirty, setDirty] = useState(false);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'conflict' | 'failed'>('idle');
  const [error, setError] = useState('');
  const apply = async () => {
    const content = editor.current?.getModifiedEditor().getValue();
    if (content === undefined) return;
    setState('saving');
    try {
      const outcome = await saveFileVersion(command, path, content, after);
      if (outcome.kind === 'conflict') return setState('conflict');
      setDirty(false);
      setState('saved');
      onApplied();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setState('failed');
    }
  };
  return (
    <div className="monaco-diff-editor">
      <div className="monaco-diff-toolbar">
        <span role="status">
          {state === 'conflict'
            ? t('diff.editConflict')
            : state === 'failed'
              ? error
              : state === 'saved' && !dirty
                ? t('diff.editApplied')
                : t('diff.editHint')}
        </span>
        <button
          type="button"
          className="button primary"
          disabled={!dirty || state === 'saving'}
          onClick={() => void apply()}
        >
          {state === 'saving' ? t('diff.editApplying') : t('diff.editApply')}
        </button>
      </div>
      <DiffEditor
        original={before}
        modified={after}
        language={getLanguage(path)}
        theme={theme}
        keepCurrentOriginalModel
        keepCurrentModifiedModel
        onMount={(mounted) => {
          editor.current = mounted;
          models.current = mounted.getModel();
          mounted.getModifiedEditor().onDidChangeModelContent(() => {
            setDirty(true);
            setState((current) => (current === 'saving' ? current : 'idle'));
          });
        }}
        options={{
          renderSideBySide: true,
          readOnly: false,
          originalEditable: false,
          automaticLayout: true,
          fontSize: 13,
          fontFamily: codeFont.family ?? MONACO_FONT,
          fontLigatures: codeFont.ligatures,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
        }}
      />
    </div>
  );
}

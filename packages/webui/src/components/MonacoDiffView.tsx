/**
 * MonacoDiffView — full Monaco side-by-side diff with an editable "modified"
 * pane. Lets the user tweak the working-tree version inline and Apply it back
 * to disk via the `files.write` WS message. Complements the lightweight,
 * read-only unified `DiffView` (ChangesView toggles between the two).
 */

import { DiffEditor, loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { Check, Loader2, Save } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getWSClient } from '@/lib/ws-client';
import { useConfigStore } from '@/stores';
import type { WSServerMessage } from '@/types';
import './monaco-theme';
import { getMonacoTheme } from './monaco-theme';

loader.config({ monaco });

const LANG_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript',
  json: 'json', css: 'css', scss: 'scss', html: 'html', md: 'markdown', py: 'python',
  go: 'go', rs: 'rust', java: 'java', c: 'c', cpp: 'cpp', cs: 'csharp', rb: 'ruby',
  php: 'php', sh: 'shell', bash: 'shell', yml: 'yaml', yaml: 'yaml', toml: 'toml', sql: 'sql',
};

function guessLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return LANG_MAP[ext] ?? 'plaintext';
}

export function MonacoDiffView({
  path,
  oldText,
  newText,
}: {
  path: string;
  oldText: string;
  newText: string;
}) {
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Reset transient state when switching files.
  useEffect(() => {
    setDirty(false);
    setSaving(false);
    setSavedAt(null);
  }, []);

  const handleMount = useCallback(
    (editor: monaco.editor.IStandaloneDiffEditor) => {
      editorRef.current = editor;
      monaco.editor.setTheme(getMonacoTheme());
      const modified = editor.getModifiedEditor();
      modified.onDidChangeModelContent(() => setDirty(true));
    },
    [],
  );

  const apply = useCallback(() => {
    const content = editorRef.current?.getModifiedEditor().getValue();
    if (content == null) return;
    setSaving(true);
    const ws = getWSClient(useConfigStore.getState().wsUrl);

    // Resolve when the server acknowledges the write (or time out).
    const off = ws.on('files.written', (msg: WSServerMessage) => {
      if (msg.type === 'files.written' && msg.payload.filePath === path) {
        off();
        clearTimeout(timer);
        setSaving(false);
        if (msg.payload.success) {
          setDirty(false);
          setSavedAt(Date.now());
        }
      }
    });
    const timer = setTimeout(() => {
      off();
      setSaving(false);
    }, 5000);

    ws.send({ type: 'files.write', payload: { filePath: path, content } });
  }, [path]);

  const language = guessLanguage(path);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-border/40">
        <span className="text-xs font-mono text-muted-foreground truncate">{path}</span>
        <button
          type="button"
          onClick={apply}
          disabled={!dirty || saving}
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-border text-xs font-medium disabled:opacity-40 enabled:hover:bg-muted transition-colors"
          title="Write the edited version back to disk"
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : savedAt && !dirty ? (
            <Check className="h-3.5 w-3.5 text-emerald-500" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          {saving ? 'Applying…' : savedAt && !dirty ? 'Applied' : 'Apply'}
        </button>
      </div>
      <div className="flex-1 overflow-hidden">
        <DiffEditor
          original={oldText}
          modified={newText}
          language={language}
          theme={getMonacoTheme()}
          onMount={handleMount}
          options={{
            renderSideBySide: true,
            readOnly: false,
            originalEditable: false,
            minimap: { enabled: false },
            fontSize: 13,
            scrollBeyondLastLine: false,
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  );
}

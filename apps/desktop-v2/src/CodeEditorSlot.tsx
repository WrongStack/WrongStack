import { Component, lazy, type ReactNode, Suspense } from 'react';
import type { EngineCommand } from './engine-operations';

const MonacoFileEditor = lazy(() => import('./MonacoFileEditor'));
const MonacoDiffEditor = lazy(() => import('./MonacoDiffEditor'));

const PLAIN_EDITOR_KEY = 'wrongstack.desktop.plainEditor';

/** Whether this desktop edits files in the plain text editor instead of the code editor. */
export function plainEditorPreferred(): boolean {
  try {
    return localStorage.getItem(PLAIN_EDITOR_KEY) === '1';
  } catch {
    return false;
  }
}

/** Remembers the editor choice for the next files opened; returns it. */
export function rememberPlainEditor(plain: boolean): boolean {
  try {
    if (plain) localStorage.setItem(PLAIN_EDITOR_KEY, '1');
    else localStorage.removeItem(PLAIN_EDITOR_KEY);
  } catch {
    /* The choice still holds for this window. */
  }
  return plain;
}

class EditorBoundary extends Component<
  { onError: () => void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch() {
    this.props.onError();
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * The code editor, loaded the first time a file is edited. When it cannot load, `onUnavailable`
 * hands the file back to the plain text editor.
 */
export function CodeEditorSlot({
  loading,
  onUnavailable,
  ...editor
}: {
  path: string;
  value: string;
  label: string;
  command: EngineCommand;
  onChange: (value: string) => void;
  loading: string;
  onUnavailable: () => void;
}) {
  return (
    <EditorBoundary onError={onUnavailable}>
      <Suspense
        fallback={
          <p role="status" className="file-quiet-state">
            {loading}
          </p>
        }
      >
        <MonacoFileEditor {...editor} />
      </Suspense>
    </EditorBoundary>
  );
}

/**
 * The editable side-by-side diff, loaded the first time a change is edited. When it cannot
 * load, `onUnavailable` returns to the read-only diff.
 */
export function DiffEditorSlot({
  loading,
  onUnavailable,
  ...editor
}: {
  path: string;
  before: string;
  after: string;
  command: EngineCommand;
  onApplied: () => void;
  loading: string;
  onUnavailable: () => void;
}) {
  return (
    <EditorBoundary onError={onUnavailable}>
      <Suspense
        fallback={
          <p role="status" className="file-quiet-state">
            {loading}
          </p>
        }
      >
        <MonacoDiffEditor {...editor} />
      </Suspense>
    </EditorBoundary>
  );
}

import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import { type MonacoWorkerKind, monacoWorkerKind } from './monaco-worker-kind';

const workers: Record<MonacoWorkerKind, new () => Worker> = {
  editor: EditorWorker,
  json: JsonWorker,
  css: CssWorker,
  html: HtmlWorker,
  typescript: TsWorker,
};

/**
 * Monaco's language workers, started from the bundled files of the desktop's own origin.
 * Without this, Monaco wraps each worker in a `blob:` script, which the desktop's content
 * policy (scripts only from itself, no separate worker source) refuses: the editor then loses
 * its language services and the page reports an uncaught error per worker.
 */
(globalThis as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
  getWorker: (_workerId: string, label: string) => new workers[monacoWorkerKind(label)](),
};

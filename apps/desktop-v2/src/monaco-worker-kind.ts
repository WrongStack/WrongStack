/** The bundled Monaco worker that serves an editor language label. */
export type MonacoWorkerKind = 'editor' | 'json' | 'css' | 'html' | 'typescript';

/** Monaco asks for a worker by language label; these labels share one language service each. */
export function monacoWorkerKind(label: string): MonacoWorkerKind {
  if (label === 'json') return 'json';
  if (label === 'css' || label === 'scss' || label === 'less') return 'css';
  if (label === 'html' || label === 'handlebars' || label === 'razor') return 'html';
  if (label === 'typescript' || label === 'javascript') return 'typescript';
  return 'editor';
}

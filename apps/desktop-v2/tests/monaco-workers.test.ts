import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { monacoWorkerKind } from '../src/monaco-worker-kind';

describe('Monaco language workers on the desktop', () => {
  it('serves each language label from its own bundled worker', () => {
    expect(['json'].map(monacoWorkerKind)).toEqual(['json']);
    expect(['css', 'scss', 'less'].map(monacoWorkerKind)).toEqual(['css', 'css', 'css']);
    expect(['html', 'handlebars', 'razor'].map(monacoWorkerKind)).toEqual(['html', 'html', 'html']);
    expect(['typescript', 'javascript'].map(monacoWorkerKind)).toEqual([
      'typescript',
      'typescript',
    ]);
    expect(['editorWorkerService', 'markdown'].map(monacoWorkerKind)).toEqual(['editor', 'editor']);
  });

  it('starts workers from bundled files before the editor loads, never from blob scripts', () => {
    // The content policy allows scripts only from the app itself; Monaco's own loader would
    // wrap each worker in a blob: script and be refused.
    const editor = readFileSync(resolve(__dirname, '../src/MonacoFileEditor.tsx'), 'utf8');
    const setup = readFileSync(resolve(__dirname, '../src/monaco-workers.ts'), 'utf8');
    expect(editor.indexOf("import './monaco-workers';")).toBeGreaterThan(-1);
    expect(editor.indexOf("import './monaco-workers';")).toBeLessThan(
      editor.indexOf('loader.config('),
    );
    expect(setup.match(/\.worker\?worker'/g)).toHaveLength(5);
    expect(setup).not.toContain('?worker&inline');
    const policy = JSON.parse(
      readFileSync(resolve(__dirname, '../src-tauri/tauri.conf.json'), 'utf8'),
    ).app.security.csp as string;
    expect(policy).not.toMatch(/(script|worker)-src[^;]*blob:/);
  });
});

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolOutputActions } from '../src/ToolOutputActions';

const render = (output: string) =>
  renderToStaticMarkup(createElement(ToolOutputActions, { tool: 'bash', output }));

describe('tool output actions', () => {
  it('shows the exit code a shell result ends with, marking a failure', () => {
    expect(render('built\nexit code: 0')).toContain('class="tool-exit ok">exit code 0<');
    expect(render('Error: missing\n[exit 2]')).toContain('class="tool-exit failed">exit code 2<');
    expect(render('done')).not.toContain('tool-exit');
  });

  it('offers Copy and Save for the output', () => {
    const html = render('done');
    expect(html).toContain('aria-label="Copy output"');
    expect(html).toContain('title="Save the output as a text file"');
  });
});

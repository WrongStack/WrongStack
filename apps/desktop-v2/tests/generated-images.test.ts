import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SessionActivity } from '../src/SessionActivity';

const executed = (name: string, output: string) => ({
  type: 'tool.executed',
  payload: { id: 't1', name, ok: true, output },
});
const render = (events: ReturnType<typeof executed>[], command?: () => Promise<never>) =>
  renderToStaticMarkup(
    createElement(SessionActivity, {
      events,
      onOpenFile: () => {},
      ...(command ? { command } : {}),
    }),
  );

describe('generated image previews', () => {
  const saved = JSON.stringify({ files: [{ path: 'art/logo.png' }, { path: 'art/icon.webp' }] });

  it('loads each picture an image_generate call saved, under its output', () => {
    const command = vi.fn(async () => {
      throw new Error('not in a render');
    });
    const html = render([executed('image_generate', saved)], command);
    expect(html).toContain('aria-label="Generated images"');
    expect(
      html.match(/class="generated-image-placeholder" title="art\/(logo\.png|icon\.webp)"/g),
    ).toHaveLength(2);
  });

  it('shows nothing for other tools, results without files, or without an engine', () => {
    const command = vi.fn(async () => {
      throw new Error('unused');
    });
    expect(render([executed('write_file', saved)], command)).not.toContain('Generated images');
    expect(render([executed('image_generate', 'failed')], command)).not.toContain(
      'Generated images',
    );
    expect(render([executed('image_generate', saved)])).not.toContain('Generated images');
  });
});

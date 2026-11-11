import { describe, expect, it } from 'vitest';
import { buildDesktopDesignPrompt } from '../src/design-dna-prompt';

describe('design extraction source arguments', () => {
  it.each([
    ['https://example.com', 'url', 'https://example.com'],
    ['example.com/pricing', 'url', 'https://example.com/pricing'],
    ['http://localhost:3000/index.html', 'url', 'http://localhost:3000/index.html'],
    ['https://example.com/index.html', 'url', 'https://example.com/index.html'],
    ['HTTPS://example.com/INDEX.HTML', 'url', 'HTTPS://example.com/INDEX.HTML'],
    ['index.html', 'file', 'index.html'],
    ['  public/INDEX.HTML  ', 'file', 'public/INDEX.HTML'],
    ['./page.htm', 'file', './page.htm'],
    ['D:\\project\\page.html', 'file', 'D:\\project\\page.html'],
    ['/project/page.html', 'file', '/project/page.html'],
  ])('keeps %s in the correct source field', (source, field, target) => {
    const prompt = buildDesktopDesignPrompt({ source, maxPages: 6, workflow: 'extract' });
    expect(prompt).toContain(`${field}: ${JSON.stringify(target)}`);
    expect(prompt).not.toContain(`${field === 'url' ? 'file' : 'url'}:`);
    expect(prompt.includes('maxPages: 6')).toBe(field === 'url');
  });

  it('retains the explicit materialize workflow after normalizing a URL', () => {
    const prompt = buildDesktopDesignPrompt({
      source: 'https://example.com/design.html',
      maxPages: 3,
      workflow: 'materialize-web',
    });
    expect(prompt).toContain('url: "https://example.com/design.html", maxPages: 3');
    expect(prompt).toContain('action: "capture"');
    expect(prompt).toContain('action: "materialize", stack: "web"');
  });
});

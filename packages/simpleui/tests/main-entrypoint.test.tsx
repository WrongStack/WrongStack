// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createRoot: vi.fn(),
  render: vi.fn(),
}));

vi.mock('react-dom/client', () => ({ createRoot: mocks.createRoot }));
vi.mock('../src/app.js', () => ({ App: () => null }));

describe('SimpleUI entrypoint', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.createRoot.mockReturnValue({ render: mocks.render });
    document.body.innerHTML = '<div id="root"></div>';
  });

  it('mounts the application into the required root element', async () => {
    const container = document.getElementById('root');
    await import('../src/main.js');
    expect(mocks.createRoot).toHaveBeenCalledWith(container);
    expect(mocks.render).toHaveBeenCalledOnce();
  });

  it('fails fast when the hosting document omits the root element', async () => {
    document.body.replaceChildren();
    await expect(import('../src/main.js')).rejects.toThrow('SimpleUI root element not found');
  });
});

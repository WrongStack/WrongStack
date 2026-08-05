/** @vitest-environment jsdom */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TokenGate } from '../src/views/token-gate.js';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function waitForElement<T extends Element>(query: () => T | null): Promise<T> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const element = query();
    if (element) return element;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error('Timed out waiting for element.');
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe('HQ token gate', () => {
  it('focuses the browser-token input in token-only mode', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ tokenMode: true, passwordMode: false, loggedIn: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(TokenGate, { hadToken: false }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(container.querySelector<HTMLInputElement>('input'));
    expect(container.querySelector<HTMLInputElement>('input')?.autocomplete).toBe('off');
  });

  it('authenticates a pasted token before reloading the current tab', async () => {
    const onAuthenticated = vi.fn();
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/auth/status')) {
        return Promise.resolve(
          new Response(JSON.stringify({ tokenMode: true, passwordMode: false, loggedIn: false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (url.includes('/api/auth/upgrade') && init?.method === 'POST') {
        return Promise.resolve(
          new Response(JSON.stringify({ loggedIn: true, upgraded: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(TokenGate, { hadToken: false, onAuthenticated }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const input = container.querySelector<HTMLInputElement>('input');
    await act(async () => {
      setInput(input!, 'manual-browser-token');
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onAuthenticated).toHaveBeenCalledOnce();
    const upgradeCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/api/auth/upgrade'),
    );
    expect((upgradeCall?.[1]?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      'Bearer manual-browser-token',
    );
  });

  it('shows a rejected-token error and stays on the gate', async () => {
    const onAuthenticated = vi.fn();
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/auth/status')) {
        return Promise.resolve(
          new Response(JSON.stringify({ tokenMode: true, passwordMode: false, loggedIn: false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (url.includes('/api/auth/upgrade') && init?.method === 'POST') {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'Token expired.' } }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(TokenGate, { hadToken: false, onAuthenticated }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const input = container.querySelector<HTMLInputElement>('input');
    await act(async () => {
      setInput(input!, 'expired-browser-token');
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Token expired.');
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLButtonElement>('.hq-token-submit')?.disabled).toBe(false);
  });

  it('prefers password login when password and token modes are both enabled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ tokenMode: true, passwordMode: true, loggedIn: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(TokenGate, { hadToken: false }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const passwordInput = container.querySelector<HTMLInputElement>('input');
    expect(container.textContent).toContain('Password required');
    expect(passwordInput?.autocomplete).toBe('current-password');
    expect(document.activeElement).toBe(passwordInput);
  });

  it('sends one password login request for rapid Enter presses while busy', async () => {
    let resolveLogin: ((response: Response) => void) | undefined;
    const loginPromise = new Promise<Response>((resolve) => {
      resolveLogin = resolve;
    });
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/auth/status')) {
        return Promise.resolve(
          new Response(JSON.stringify({ tokenMode: false, passwordMode: true, loggedIn: false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (url.includes('/api/login') && init?.method === 'POST') return loginPromise;
      return Promise.resolve(new Response('{}', { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(TokenGate, { hadToken: false }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const passwordInput = container.querySelector<HTMLInputElement>('input');
    await act(async () => {
      setInput(passwordInput!, 'secret-password');
      passwordInput!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      passwordInput!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/login'))).toHaveLength(
      1,
    );

    await act(async () => {
      resolveLogin?.(
        new Response(JSON.stringify({ totpRequired: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      await loginPromise;
    });
  });

  it('sends one TOTP verify request for rapid Enter presses while busy', async () => {
    let resolveLogin: ((response: Response) => void) | undefined;
    const loginPromise = new Promise<Response>((resolve) => {
      resolveLogin = resolve;
    });
    let resolveVerify: ((response: Response) => void) | undefined;
    const verifyPromise = new Promise<Response>((resolve) => {
      resolveVerify = resolve;
    });
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/auth/status')) {
        return Promise.resolve(
          new Response(JSON.stringify({ tokenMode: false, passwordMode: true, loggedIn: false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (url.includes('/api/login/verify') && init?.method === 'POST') return verifyPromise;
      if (url.includes('/api/login') && init?.method === 'POST') return loginPromise;
      return Promise.resolve(new Response('{}', { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(TokenGate, { hadToken: false }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const passwordInput = container.querySelector<HTMLInputElement>('input');
    await act(async () => {
      setInput(passwordInput!, 'secret-password');
      passwordInput!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await act(async () => {
      resolveLogin?.(
        new Response(JSON.stringify({ totpRequired: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      await loginPromise;
    });

    const totpInput = await waitForElement(
      () => container?.querySelector<HTMLInputElement>('#hq-totp-code') ?? null,
    );
    await act(async () => {
      setInput(totpInput, '123456');
      totpInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      totpInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/login/verify')),
    ).toHaveLength(1);

    await act(async () => {
      resolveVerify?.(
        new Response(JSON.stringify({ loggedIn: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      await verifyPromise;
    });
  });

  it('allows password login retry after a network error', async () => {
    let loginAttempts = 0;
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/auth/status')) {
        return Promise.resolve(
          new Response(JSON.stringify({ tokenMode: false, passwordMode: true, loggedIn: false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (url.includes('/api/login') && init?.method === 'POST') {
        loginAttempts++;
        return loginAttempts === 1
          ? Promise.reject(new Error('offline'))
          : Promise.resolve(
              new Response(JSON.stringify({ totpRequired: true }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            );
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(TokenGate, { hadToken: false }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const passwordInput = container.querySelector<HTMLInputElement>('input');
    await act(async () => {
      setInput(passwordInput!, 'secret-password');
      passwordInput!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Network error.');

    await act(async () => {
      passwordInput!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
    });

    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/login'))).toHaveLength(
      2,
    );
  });

  it('allows TOTP retry after a failed verification', async () => {
    let verifyAttempts = 0;
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/auth/status')) {
        return Promise.resolve(
          new Response(JSON.stringify({ tokenMode: false, passwordMode: true, loggedIn: false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (url.includes('/api/login/verify') && init?.method === 'POST') {
        verifyAttempts++;
        return Promise.resolve(
          new Response(
            JSON.stringify(
              verifyAttempts === 1 ? { error: { message: 'Bad code.' } } : { loggedIn: true },
            ),
            {
              status: verifyAttempts === 1 ? 401 : 200,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
        );
      }
      if (url.includes('/api/login') && init?.method === 'POST') {
        return Promise.resolve(
          new Response(JSON.stringify({ totpRequired: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(TokenGate, { hadToken: false }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const passwordInput = container.querySelector<HTMLInputElement>('input');
    await act(async () => {
      setInput(passwordInput!, 'secret-password');
      passwordInput!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    const totpInput = await waitForElement(
      () => container?.querySelector<HTMLInputElement>('#hq-totp-code') ?? null,
    );

    await act(async () => {
      setInput(totpInput, '123456');
      totpInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Bad code.');

    await act(async () => {
      totpInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
    });

    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/login/verify')),
    ).toHaveLength(2);
  });

  it('focuses the authenticator code after password login requires TOTP', async () => {
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/auth/status')) {
        return Promise.resolve(
          new Response(JSON.stringify({ tokenMode: false, passwordMode: true, loggedIn: false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (url.includes('/api/login') && init?.method === 'POST') {
        return Promise.resolve(
          new Response(JSON.stringify({ totpRequired: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(TokenGate, { hadToken: false }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const passwordInput = container.querySelector<HTMLInputElement>('input');
    expect(document.activeElement).toBe(passwordInput);

    await act(async () => {
      setInput(passwordInput!, 'secret-password');
    });

    const login = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Log in'),
    );
    await act(async () => {
      login?.click();
    });

    const totpInput = await waitForElement(
      () => container?.querySelector<HTMLInputElement>('#hq-totp-code') ?? null,
    );
    expect(document.activeElement).toBe(totpInput);
  });
});

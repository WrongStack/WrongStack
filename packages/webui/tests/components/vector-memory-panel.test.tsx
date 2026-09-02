/**
 * VectorMemoryPanel — inline expand + Forget flow tests.
 *
 * The panel fetches over plain `fetch` (not the WS client), so the network
 * boundary is stubbed with a URL-keyed route map: status/search/forget each
 * get a resolvable Response. Covers the master-detail expand convention
 * (collapsed = truncated preview + no detail; expanded = full text + id/score
 * fields), the destructive confirmation dialog before DELETE, optimistic
 * removal from the hit list, and the disabled-state contract (no interactive
 * surface at all).
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchCalls: string[] = [];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const statusEnabled = {
  enabled: true,
  providerId: 'transformers',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  dimensions: 384,
  entries: 2,
  vectors: 2,
  providers: ['transformers'],
};

const hitsPayload = {
  hits: [
    {
      id: 'vm_alpha',
      score: 0.912,
      text: 'Alpha entry '.repeat(60), // long enough to truncate at 170 chars
      summary: 'alpha summary',
      tags: ['webui', 'vector'],
    },
    {
      id: 'vm_beta',
      score: 0.704,
      text: 'Beta entry — short text.',
      tags: [],
    },
  ],
  count: 2,
  similarity: [
    [1.0, 0.2],
    [0.2, 1.0],
  ],
};

let forgetStatus = 200;
let forgetBody: unknown = { removed: true };

// Deferred-promise gates for the interleaving test: when a hold flag is set,
// the NEXT matching fetch returns a promise the test resolves manually.
let holdSearchResponse = false;
let holdDeleteResponse = false;
let searchGate: ((body: unknown) => void) | null = null;
let deleteGate: ((body: unknown) => void) | null = null;

function routeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  fetchCalls.push(`${init?.method ?? 'GET'} ${url}`);
  if (url.includes('/api/vector-memory/status')) {
    return Promise.resolve(jsonResponse(200, statusEnabled));
  }
  if (url.includes('/api/vector-memory/search')) {
    if (holdSearchResponse) {
      holdSearchResponse = false;
      return new Promise<Response>((resolve) => {
        searchGate = (body) => resolve(jsonResponse(200, body));
      });
    }
    return Promise.resolve(jsonResponse(200, hitsPayload));
  }
  if (url.includes('/api/vector-memory/store/vm_alpha')) {
    if (holdDeleteResponse) {
      holdDeleteResponse = false;
      return new Promise<Response>((resolve) => {
        deleteGate = (body) => resolve(jsonResponse(200, body));
      });
    }
    return Promise.resolve(jsonResponse(forgetStatus, forgetBody));
  }
  return Promise.resolve(jsonResponse(404, { error: 'unexpected route' }));
}

vi.stubGlobal(
  'fetch',
  vi.fn((input: RequestInfo | URL, init?: RequestInit) => routeFetch(input, init)),
);

import { VectorMemoryPanel } from '../../src/components/vector-memory-panel/index.js';
import { previewText } from '../../src/components/vector-memory-panel/model.js';

const alphaToggle = () => screen.getByRole('button', { name: /0\.912\s*alpha summary/ });

async function loadAndSearch() {
  render(<VectorMemoryPanel />);
  await screen.findByText('Xenova/all-MiniLM-L6-v2'); // status strip rendered
  fireEvent.change(screen.getByLabelText('Query'), { target: { value: 'alpha beta' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  await screen.findByText('alpha summary');
}

beforeEach(() => {
  fetchCalls.length = 0;
  forgetStatus = 200;
  forgetBody = { removed: true };
  holdSearchResponse = false;
  holdDeleteResponse = false;
  searchGate = null;
  deleteGate = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('VectorMemoryPanel inline expand', () => {
  it('collapses hits to a preview with no detail region', async () => {
    await loadAndSearch();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Forget' })).toBeNull();
    expect(screen.queryByText('vm_alpha')).toBeNull();
    // Long text is truncated with an ellipsis, not rendered in full.
    expect(screen.getByText(previewText(hitsPayload.hits[0]!.text))).toBeTruthy();
  });

  it('expands a hit inline with full text and id/score fields', async () => {
    await loadAndSearch();

    fireEvent.click(alphaToggle());

    expect(screen.getByText(hitsPayload.hits[0]!.text, { exact: true, trim: false })).toBeTruthy();
    expect(screen.getByText('vm_alpha')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Forget' })).toBeTruthy();
  });

  it('collapses the hit on a second toggle click', async () => {
    await loadAndSearch();

    fireEvent.click(alphaToggle());
    expect(screen.getByText('vm_alpha')).toBeTruthy();

    fireEvent.click(alphaToggle());
    expect(screen.queryByText('vm_alpha')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Forget' })).toBeNull();
  });
});

describe('VectorMemoryPanel forget flow', () => {
  it('confirms in a dialog before issuing the DELETE and removes the hit', async () => {
    await loadAndSearch();

    fireEvent.click(alphaToggle());
    fireEvent.click(screen.getByRole('button', { name: 'Forget' }));

    // Destructive confirmation first — no network mutation until confirmed.
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(fetchCalls.some((c) => c.startsWith('DELETE'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Forget memory' }));

    await waitFor(() => {
      expect(fetchCalls).toContainEqual('DELETE /api/vector-memory/store/vm_alpha');
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Hit removed from the list; the other result remains.
    expect(screen.queryByText('vm_alpha')).toBeNull();
    expect(screen.getByText('0.704')).toBeTruthy();
  });

  it('cancel keeps the entry in the list without a DELETE', async () => {
    await loadAndSearch();

    fireEvent.click(alphaToggle());
    fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetchCalls.some((c) => c.startsWith('DELETE'))).toBe(false);
    expect(screen.getByText('vm_alpha')).toBeTruthy();
  });

  it('shows the error in the dialog when the store refuses the forget', async () => {
    forgetStatus = 500;
    forgetBody = { error: 'Vector memory forget failed' };
    await loadAndSearch();

    fireEvent.click(alphaToggle());
    fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
    fireEvent.click(screen.getByRole('button', { name: 'Forget memory' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('forget failed: HTTP 500');
    // Entry stays in the list; the dialog stays open for a retry decision.
    expect(screen.getByText('vm_alpha')).toBeTruthy();
  });
});

describe('VectorMemoryPanel disabled contract', () => {
  it('renders the placeholder with no search surface when the host wires no store', async () => {
    vi.mocked(fetch).mockImplementationOnce(() =>
      Promise.resolve(jsonResponse(200, { enabled: false })),
    );
    render(<VectorMemoryPanel />);

    await screen.findByText(/Disabled —/);
    expect(screen.queryByLabelText('Query')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();
  });

  it('does not keep the previous host’s status when the new host fails', async () => {
    const { rerender } = render(<VectorMemoryPanel baseUrl="/host-a" />);
    await screen.findByText('Xenova/all-MiniLM-L6-v2'); // host A status loaded

    // Host B's status request fails — the panel must show the error state,
    // not host A's provider/paths/counts.
    vi.mocked(fetch).mockImplementationOnce(() =>
      Promise.reject(new Error('status failed: HTTP 502')),
    );
    rerender(<VectorMemoryPanel baseUrl="/host-b" />);

    expect(await screen.findByText(/Status unavailable/)).toBeTruthy();
    expect(screen.queryByText('Xenova/all-MiniLM-L6-v2')).toBeNull();
  });
});

describe('VectorMemoryPanel forget/search interleaving', () => {
  it('a search landing during an in-flight forget wins; the stale patch is rejected', async () => {
    const gammaHit = {
      id: 'vm_gamma',
      score: 0.555,
      text: 'Gamma entry — new result set.',
      summary: 'gamma summary',
      tags: [],
    };
    await loadAndSearch(); // search 1: alpha + beta (version 1)

    // Fire search 2 and hold its response — the list still shows alpha/beta.
    holdSearchResponse = true;
    fireEvent.change(screen.getByLabelText('Query'), { target: { value: 'gamma' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    // Confirm a forget of alpha while search 2 is in flight; hold the DELETE.
    holdDeleteResponse = true;
    fireEvent.click(alphaToggle());
    fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
    fireEvent.click(screen.getByRole('button', { name: 'Forget memory' }));
    expect(fetchCalls).toContainEqual('DELETE /api/vector-memory/store/vm_alpha');

    // Search 2 lands with a brand-new result set — the version bumps.
    await act(async () => {
      searchGate?.({ hits: [gammaHit], count: 1 });
    });
    expect(await screen.findByText('gamma summary')).toBeTruthy();

    // The DELETE resolves last: its snapshot belongs to the pre-search result
    // set, so the version guard must reject the patch instead of slicing
    // gamma's hit list / similarity matrix with stale indices.
    await act(async () => {
      deleteGate?.({ removed: true });
    });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('gamma summary')).toBeTruthy(); // untouched
    expect(screen.queryByRole('button', { name: /0\.912/ })).toBeNull(); // old set replaced
    // The successful forget still bumps statusNonce → one extra status fetch.
    const statusCalls = fetchCalls.filter((c) => c.endsWith('/api/vector-memory/status'));
    expect(statusCalls.length).toBe(2);
  });
});

describe('previewText', () => {
  it('truncates long text with an ellipsis and keeps short text intact', () => {
    const long = 'word '.repeat(100);
    expect(previewText(long).endsWith('…')).toBe(true);
    expect(previewText(long).length).toBeLessThanOrEqual(170);
    expect(previewText('short')).toBe('short');
  });
});

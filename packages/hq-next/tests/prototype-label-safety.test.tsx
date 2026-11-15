// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ruleChecks } from '../src/features/alerts/model';
import { stepLabel } from '../src/features/brain/model';
import { AuthAuditPanel } from '../src/hq/views/settings/auth-audit';

describe('hq-next UI label Object.prototype safety', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('ruleChecks ignores Object.prototype keys in RULE_LABEL', () => {
    expect(ruleChecks('budget-fleet-24h')).toBe(
      'Fleet spend over the last 24 hours reached the daily budget.',
    );
    for (const key of ['toString', 'constructor', 'valueOf']) {
      expect(ruleChecks(key)).toBeUndefined();
    }
  });

  it('stepLabel falls back to raw kind for Object.prototype keys', () => {
    expect(stepLabel('decision_requested')).toBe('Asked');
    for (const key of ['toString', 'constructor', 'valueOf']) {
      expect(stepLabel(key)).toBe(key);
    }
  });

  it('AuthAuditPanel falls back to entry.kind text for Object.prototype keys', async () => {
    const now = Date.now();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          entries: [
            { at: now, kind: 'create', scope: 'admin', tokenId: 'tok_12345678' },
            { at: now - 1000, kind: 'toString', scope: 'admin', tokenId: 'tok_87654321' },
          ],
        }),
      })),
    );

    render(<AuthAuditPanel />);

    await waitFor(() => {
      expect(screen.getAllByTestId('auth-audit-row')).toHaveLength(2);
    });

    expect(screen.getByText('Token created')).toBeTruthy();
    expect(screen.getByText('toString')).toBeTruthy();
  });
});

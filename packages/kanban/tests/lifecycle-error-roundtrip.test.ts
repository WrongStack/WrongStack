/**
 * KanbanLifecycleError round-trip across the IPC boundary.
 *
 * Wire-stable test: a typed `KanbanLifecycleError` thrown on the server side
 * must reconstruct as `instanceof KanbanLifecycleError` on the client side,
 * with the original issues array intact. The naive `instanceof` check breaks
 * when the error crosses `errorFromThrown` (JSON envelope) and back through
 * the client frame parser; `code === 'LIFECYCLE'` is the only signal that
 * survives.
 */
import { describe, expect, it } from 'vitest';
import {
  decodeLifecycleIssues,
  KanbanLifecycleError,
  LIFECYCLE_ISSUES_PREFIX,
  stripLifecycleIssues,
} from '../src/manager/lifecycle.js';

describe('KanbanLifecycleError IPC round-trip', () => {
  const issues = [
    { code: 'transition-skipped', field: 'status', message: 'Status transition was rejected.' },
    {
      code: 'review-evidence-missing',
      field: 'verificationReport',
      message: 'Verification evidence is required.',
    },
  ] as const;

  it('encodes issues into message via JSON payload', () => {
    const err = new KanbanLifecycleError('transition blocked', issues);

    expect(err.code).toBe('LIFECYCLE');
    expect(err.message).toContain('transition blocked');
    expect(err.message).toContain('LIFECYCLE_ISSUES');
    expect(decodeLifecycleIssues(err)).toEqual(issues);
  });

  it('decodes issues from a plain Error after JSON envelope (server → client)', () => {
    // Server side: errorFromThrown serializes via JSON.stringify and the
    // receiving client sees a plain Error with `message` only — no class.
    const original = new KanbanLifecycleError('transition blocked', issues);
    const envelope = JSON.parse(JSON.stringify({ code: original.code, message: original.message }));

    // Client side: a plain Error reconstructed from the envelope.
    const reconstructed = new Error(envelope.message as string);

    expect(reconstructed instanceof KanbanLifecycleError).toBe(false);
    const recovered = decodeLifecycleIssues(reconstructed);
    expect(recovered).toEqual(issues);
  });

  it('reconstructs a typed KanbanLifecycleError when client.ts wraps the frame', () => {
    const original = new KanbanLifecycleError('transition blocked', issues);
    const envelope = JSON.parse(JSON.stringify({ code: original.code, message: original.message }));

    // Mirrors the new client.ts error-frame branch: code === 'LIFECYCLE'
    // triggers `new KanbanLifecycleError(original, decodeLifecycleIssues({ message: original }))`.
    // `decodeLifecycleIssues` reads `.message` from an Error-like input, so a
    // bare string argument would return [] and lose the issues entirely.
    const recovered = new KanbanLifecycleError(
      envelope.message as string,
      decodeLifecycleIssues({ message: envelope.message } as Error),
    );

    expect(recovered).toBeInstanceOf(KanbanLifecycleError);
    expect((recovered as { code?: string }).code).toBe('LIFECYCLE');
    expect(recovered.issues).toEqual(issues);
  });

  it('returns [] when decodeLifecycleIssues is called with a bare string (regression guard)', () => {
    // If someone refactors client.ts back to passing a raw string, issues
    // silently disappear. Lock the helper's contract: it must require an
    // Error-like input and return [] for plain strings.
    expect(decodeLifecycleIssues('foo' as unknown as Error)).toEqual([]);
  });

  it('does not stack a second envelope when the client rewraps an enveloped message', () => {
    // client.ts reconstructs the typed error from a message that ALREADY
    // carries an envelope. Appending unconditionally produced
    // `... LIFECYCLE_ISSUES{...} LIFECYCLE_ISSUES{...}`, and that whole string
    // reached the model as the explanation for why its card would not start.
    const original = new KanbanLifecycleError('transition blocked', issues);
    const rewrapped = new KanbanLifecycleError(
      original.message,
      decodeLifecycleIssues({ message: original.message } as Error),
    );

    const envelopeCount = rewrapped.message.split(LIFECYCLE_ISSUES_PREFIX).length - 1;
    expect(envelopeCount).toBe(1);
    expect(rewrapped.issues).toEqual(issues);
    expect(stripLifecycleIssues(rewrapped.message)).toBe('transition blocked');
  });

  it('strips the envelope down to the human sentence', () => {
    const err = new KanbanLifecycleError('Running requires every dependency.', issues);
    const clean = stripLifecycleIssues(err.message);

    expect(clean).toBe('Running requires every dependency.');
    expect(clean).not.toContain('LIFECYCLE_ISSUES');
    expect(clean).not.toContain('\u0001');
    // A message with no envelope is returned unchanged apart from trimming.
    expect(stripLifecycleIssues('plain message')).toBe('plain message');
    // An unterminated envelope must not spin forever.
    expect(stripLifecycleIssues(`tail ${LIFECYCLE_ISSUES_PREFIX}{"code":`)).toBe('tail');
  });

  it('returns an empty array for non-LIFECYCLE errors', () => {
    const plain = new Error('something else');
    expect(decodeLifecycleIssues(plain)).toEqual([]);
    expect(decodeLifecycleIssues(null)).toEqual([]);
    expect(decodeLifecycleIssues(undefined)).toEqual([]);
  });
});

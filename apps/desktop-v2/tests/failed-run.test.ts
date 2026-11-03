import { MAX_FAILED_RUN_RESUMES } from '@wrongstack/contracts/types/failed-run-resume';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { emptyEngineState, type EngineState } from '../src/engine-state';
import { FailedRunContinue } from '../src/FailedRunContinue';
import {
  automaticResumeDelayMs,
  automaticResumePrompt,
  failedRun,
  nextAutomaticResume,
  recordAutomaticResume,
  resetAutomaticResumes,
} from '../src/failed-run-model';

const ended = (status: string, error?: Record<string, unknown>, running = false) => ({
  running,
  results: { 'run.result': { status, ...(error ? { error } : {}) } },
});

describe('failed run recovery', () => {
  it('offers recovery only for a failed run that nothing has replaced', () => {
    expect(failedRun(ended('done'))).toBeNull();
    expect(failedRun(ended('aborted', { message: 'User aborted' }))).toBeNull();
    expect(failedRun(ended('failed', { message: 'boom' }, true))).toBeNull();
    expect(failedRun({ running: false, results: {} })).toBeNull();
    expect(failedRun(ended('failed', { message: 'boom' }))).toEqual({
      message: 'boom',
      resumable: false,
    });
  });

  it('resumes by itself only after a recoverable provider error', () => {
    const provider = (code: string, recoverable = true) =>
      failedRun(ended('failed', { message: 'x', code, recoverable }))?.resumable;
    expect(provider('PROVIDER_TIMEOUT')).toBe(true);
    expect(provider('PROVIDER_RATE_LIMIT')).toBe(true);
    expect(provider('PROVIDER_CONTEXT_OVERFLOW')).toBe(false);
    expect(provider('PROVIDER_TIMEOUT', false)).toBe(false);
    expect(provider('LOOP_GUARD')).toBe(false);
  });

  it('spends a budget of automatic resumes with a growing wait, reset by a finished run', () => {
    const session = 'budget';
    resetAutomaticResumes(session);
    for (let attempt = 1; attempt <= MAX_FAILED_RUN_RESUMES; attempt++) {
      expect(nextAutomaticResume(session)).toBe(attempt);
      recordAutomaticResume(session);
    }
    expect(nextAutomaticResume(session)).toBeNull();
    resetAutomaticResumes(session);
    expect(nextAutomaticResume(session)).toBe(1);
    expect(automaticResumeDelayMs(2)).toBe(2 * automaticResumeDelayMs(1));
    expect(automaticResumePrompt(2, { message: 'timeout\nstack', resumable: true })).toContain(
      `Automatic resume 2 of ${MAX_FAILED_RUN_RESUMES}: the previous run stopped on a provider error (timeout)`,
    );
  });

  it('shows the error with Continue, and nothing once another run starts', () => {
    const state = (running: boolean): EngineState => ({
      ...emptyEngineState,
      sessionId: 's',
      connected: true,
      running,
      results: { 'run.result': { status: 'failed', error: { message: 'Overloaded\nat x (a:1:2)' } } },
    });
    const render = (running: boolean) =>
      renderToStaticMarkup(
        createElement(FailedRunContinue, {
          state: state(running),
          send: async () => '',
          report: () => {},
        }),
      );
    const html = render(false);
    expect(html).toContain('The run stopped on an error');
    expect(html).toContain('<span>Overloaded</span>');
    expect(html).toContain('Details');
    expect(html).toContain('Continue</button>');
    expect(render(true)).toBe('');
  });
});

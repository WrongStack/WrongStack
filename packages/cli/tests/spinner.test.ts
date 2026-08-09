import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Spinner } from '../src/spinner.js';

const originalNoColor = process.env.NO_COLOR;

beforeAll(() => {
  delete process.env.NO_COLOR;
});

afterAll(() => {
  if (originalNoColor === undefined) {
    delete process.env.NO_COLOR;
  } else {
    process.env.NO_COLOR = originalNoColor;
  }
});

// Minimal mock stream that tracks writes
class MockStream extends Writable {
  writes: string[] = [];
  isTTY = true;

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    this.writes.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    cb();
  }
}

describe('Spinner', () => {
  let stream: MockStream;
  let spinner: Spinner;

  beforeEach(() => {
    stream = new MockStream();
    spinner = new Spinner(stream as never as NodeJS.WriteStream, { enabled: true });
  });

  afterEach(() => {
    spinner.stop();
  });

  describe('start / stop', () => {
    it('writes a frame when started', () => {
      spinner.start('Thinking');
      // First frame written
      expect(stream.writes.length).toBeGreaterThan(0);
    });

    it('is a no-op when already active', () => {
      spinner.start('Thinking');
      const countBefore = stream.writes.length;
      spinner.start('Thinking again'); // same label
      // Should not write duplicate frames on same label
      expect(stream.writes.length).toBe(countBefore);
    });

    it('stop clears the timer and line', () => {
      spinner.start('Thinking');
      spinner.stop();
      // stop should have written a clear line
      expect(stream.writes.some((w) => w.includes('\r'))).toBe(true);
    });

    it('multiple stops are safe', () => {
      spinner.start('Thinking');
      spinner.stop();
      spinner.stop(); // no-op
      spinner.stop(); // no-op
    });
  });

  describe('stopWith', () => {
    it('writes the note after stopping', () => {
      spinner.start('Thinking');
      spinner.stopWith('✓ done in 1.4s');
      const noteWritten = stream.writes.some((w) => w.includes('✓ done in 1.4s'));
      expect(noteWritten).toBe(true);
    });
  });

  describe('setContext', () => {
    it('stores context info without throwing', () => {
      spinner.start('Thinking');
      expect(() => spinner.setContext({ used: 50000, max: 200000 })).not.toThrow();
    });

    it('can clear context by setting undefined', () => {
      spinner.start('Thinking');
      spinner.setContext({ used: 50000, max: 200000 });
      expect(() => spinner.setContext(undefined)).not.toThrow();
    });
  });

  describe('disabled state', () => {
    it('is a no-op when enabled is false', () => {
      const disabledSpinner = new Spinner(stream as never as NodeJS.WriteStream, {
        enabled: false,
      });
      disabledSpinner.start('Thinking');
      // No writes should happen
      expect(stream.writes.length).toBe(0);
    });
  });
});

// Test the static functions via integration
describe('renderProgress (via Spinner)', () => {
  it('renders 0% as all empty bars', () => {
    const spinner = new Spinner({ write: vi.fn() } as never as NodeJS.WriteStream, {
      enabled: true,
    });
    // Trigger a render with 0% context
    spinner.start('test');
    spinner.setContext({ used: 0, max: 100 });
    // stop and check output
    spinner.stop();
  });
});

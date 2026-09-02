import { describe, expect, it } from 'vitest';
import {
  AgentError,
  ConfigError,
  type ErrorSeverity,
  FetchError,
  FsError,
  ParseError,
  PluginError,
  SessionError,
  SddError,
  ToolError,
  ToolValidationError,
  WrongStackError,
} from '../../src/types/errors.js';

/**
 * Integration test that verifies every WrongStackError subclass declares
 * the right default severity. This is a cross-cutting invariant: the
 * severity drives UI behavior (fatal → abort the session, error → surface
 * to the user, warning → log and continue) and the classifyToolError
 * retry-policy decisions. A subclass with the wrong default silently
 * changes how errors from that subsystem are surfaced.
 *
 * The test enumerates every subclass with representative codes and asserts
 * the expected severity. For subclasses with code-conditional severity
 * (AgentError, SessionError, SddError), each branch is tested.
 */

describe('WrongStackError subclass severity defaults', () => {
  /** Helper: construct an error, assert its severity matches expected. */
  function expectSeverity(err: WrongStackError, expected: ErrorSeverity, label: string): void {
    expect(err.severity, `${label} should have severity '${expected}'`).toBe(expected);
  }

  // ── Subclasses with a single fixed severity ────────────────────────

  describe('fixed-severity subclasses', () => {
    it('ToolError defaults to error', () => {
      expectSeverity(
        new ToolError({ message: 'fail', code: 'TOOL_EXECUTION_FAILED', toolName: 'read' }),
        'error',
        'ToolError(TOOL_EXECUTION_FAILED)',
      );
    });

    it('ConfigError defaults to fatal', () => {
      expectSeverity(
        new ConfigError({ message: 'bad config', code: 'CONFIG_INVALID' }),
        'fatal',
        'ConfigError(CONFIG_INVALID)',
      );
    });

    it('PluginError defaults to error', () => {
      expectSeverity(
        new PluginError({ message: 'load fail', code: 'PLUGIN_LOAD_FAILED', pluginName: 'bad' }),
        'error',
        'PluginError(PLUGIN_LOAD_FAILED)',
      );
    });

    it('FsError defaults to error', () => {
      expectSeverity(
        new FsError({ message: 'read fail', code: 'FS_READ_FAILED' }),
        'error',
        'FsError(FS_READ_FAILED)',
      );
    });

    it('FetchError defaults to error', () => {
      expectSeverity(
        new FetchError({ message: 'HTTP 500', status: 500 }),
        'error',
        'FetchError(500)',
      );
    });

    it('ToolValidationError defaults to error', () => {
      expectSeverity(
        new ToolValidationError({ message: 'missing field', field: 'path' }),
        'error',
        'ToolValidationError',
      );
    });

    it('ParseError defaults to error', () => {
      expectSeverity(
        new ParseError({ message: 'missing fields', source: 'test' }),
        'error',
        'ParseError',
      );
    });
  });

  // ── Subclasses with code-conditional severity ──────────────────────

  describe('AgentError — code-conditional severity', () => {
    it('AGENT_ABORTED → warning', () => {
      expectSeverity(
        new AgentError({ message: 'aborted', code: 'AGENT_ABORTED' }),
        'warning',
        'AgentError(AGENT_ABORTED)',
      );
    });

    it('AGENT_RUN_FAILED → error', () => {
      expectSeverity(
        new AgentError({ message: 'crashed', code: 'AGENT_RUN_FAILED' }),
        'error',
        'AgentError(AGENT_RUN_FAILED)',
      );
    });

    it('AGENT_ITERATION_LIMIT → error', () => {
      expectSeverity(
        new AgentError({ message: 'max iters', code: 'AGENT_ITERATION_LIMIT' }),
        'error',
        'AgentError(AGENT_ITERATION_LIMIT)',
      );
    });

    it('AGENT_CONTEXT_OVERFLOW → error', () => {
      expectSeverity(
        new AgentError({ message: 'overflow', code: 'AGENT_CONTEXT_OVERFLOW' }),
        'error',
        'AgentError(AGENT_CONTEXT_OVERFLOW)',
      );
    });
  });

  describe('SessionError — code-conditional severity', () => {
    it('SESSION_WRITE_FAILED → error', () => {
      expectSeverity(
        new SessionError({ message: 'disk full', code: 'SESSION_WRITE_FAILED', sessionId: 's1' }),
        'error',
        'SessionError(SESSION_WRITE_FAILED)',
      );
    });

    it('SESSION_NOT_FOUND → warning', () => {
      expectSeverity(
        new SessionError({ message: 'gone', code: 'SESSION_NOT_FOUND' }),
        'warning',
        'SessionError(SESSION_NOT_FOUND)',
      );
    });

    it('SESSION_CORRUPTED → warning', () => {
      expectSeverity(
        new SessionError({ message: 'bad json', code: 'SESSION_CORRUPTED', sessionId: 's1' }),
        'warning',
        'SessionError(SESSION_CORRUPTED)',
      );
    });
  });

  describe('SddError — code-conditional severity', () => {
    it('SDD_PARSE_FAILED → warning', () => {
      expectSeverity(
        new SddError({ message: 'bad spec', code: 'SDD_PARSE_FAILED' }),
        'warning',
        'SddError(SDD_PARSE_FAILED)',
      );
    });

    it('SDD_VALIDATION_FAILED → error', () => {
      expectSeverity(
        new SddError({ message: 'invalid', code: 'SDD_VALIDATION_FAILED' }),
        'error',
        'SddError(SDD_VALIDATION_FAILED)',
      );
    });

    it('SDD_INVALID_STATE → error', () => {
      expectSeverity(
        new SddError({ message: 'wrong state', code: 'SDD_INVALID_STATE' }),
        'error',
        'SddError(SDD_INVALID_STATE)',
      );
    });

    it('SDD_NOT_READY → error', () => {
      expectSeverity(
        new SddError({ message: 'not ready', code: 'SDD_NOT_READY' }),
        'error',
        'SddError(SDD_NOT_READY)',
      );
    });
  });

  // ── All subclasses inherit from WrongStackError ────────────────────

  describe('all subclasses extend WrongStackError', () => {
    const cases: Array<{ label: string; err: WrongStackError }> = [
      {
        label: 'ToolError',
        err: new ToolError({ message: 'x', code: 'TOOL_EXECUTION_FAILED', toolName: 't' }),
      },
      { label: 'ConfigError', err: new ConfigError({ message: 'x', code: 'CONFIG_INVALID' }) },
      {
        label: 'PluginError',
        err: new PluginError({ message: 'x', code: 'PLUGIN_LOAD_FAILED', pluginName: 'p' }),
      },
      { label: 'AgentError', err: new AgentError({ message: 'x', code: 'AGENT_RUN_FAILED' }) },
      { label: 'SessionError', err: new SessionError({ message: 'x', code: 'SESSION_NOT_FOUND' }) },
      { label: 'SddError', err: new SddError({ message: 'x', code: 'SDD_VALIDATION_FAILED' }) },
      { label: 'FsError', err: new FsError({ message: 'x', code: 'FS_READ_FAILED' }) },
      { label: 'FetchError', err: new FetchError({ message: 'x', status: 500 }) },
      { label: 'ToolValidationError', err: new ToolValidationError({ message: 'x' }) },
      { label: 'ParseError', err: new ParseError({ message: 'x' }) },
    ];

    it.each(cases)('$label is a WrongStackError instance', ({ err, label }) => {
      expect(err).toBeInstanceOf(WrongStackError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name, `${label} name property`).toBe(label);
    });
  });

  // ── Severity is always a valid ErrorSeverity value ─────────────────

  describe('severity is always a valid value', () => {
    const validSeverities: ErrorSeverity[] = ['warning', 'error', 'fatal'];

    const allConstructable: Array<{ label: string; err: WrongStackError }> = [
      {
        label: 'ToolError',
        err: new ToolError({ message: 'x', code: 'TOOL_EXECUTION_FAILED', toolName: 't' }),
      },
      { label: 'ConfigError', err: new ConfigError({ message: 'x', code: 'CONFIG_INVALID' }) },
      {
        label: 'PluginError',
        err: new PluginError({ message: 'x', code: 'PLUGIN_LOAD_FAILED', pluginName: 'p' }),
      },
      {
        label: 'AgentError(ABORTED)',
        err: new AgentError({ message: 'x', code: 'AGENT_ABORTED' }),
      },
      {
        label: 'AgentError(FAILED)',
        err: new AgentError({ message: 'x', code: 'AGENT_RUN_FAILED' }),
      },
      {
        label: 'SessionError(WRITE)',
        err: new SessionError({ message: 'x', code: 'SESSION_WRITE_FAILED' }),
      },
      {
        label: 'SessionError(NOT_FOUND)',
        err: new SessionError({ message: 'x', code: 'SESSION_NOT_FOUND' }),
      },
      { label: 'SddError(PARSE)', err: new SddError({ message: 'x', code: 'SDD_PARSE_FAILED' }) },
      {
        label: 'SddError(VALIDATION)',
        err: new SddError({ message: 'x', code: 'SDD_VALIDATION_FAILED' }),
      },
      { label: 'FsError', err: new FsError({ message: 'x', code: 'FS_READ_FAILED' }) },
      { label: 'FetchError', err: new FetchError({ message: 'x', status: 500 }) },
      { label: 'ToolValidationError', err: new ToolValidationError({ message: 'x' }) },
      { label: 'ParseError', err: new ParseError({ message: 'x' }) },
    ];

    it.each(allConstructable)('$label has a valid severity', ({ err, label }) => {
      expect(validSeverities, `${label} severity '${err.severity}' is valid`).toContain(
        err.severity,
      );
    });
  });
});

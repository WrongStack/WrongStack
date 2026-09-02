import { describe, expect, it } from 'vitest';
import {
  AgentError,
  ConfigError,
  FetchError,
  FsError,
  ParseError,
  PluginError,
  SessionError,
  SddError,
  ToolError,
  ToolValidationError,
} from '../../src/types/errors.js';
import { ToolErrorCategory } from '../../src/types/tool.js';
import { classifyToolError } from '../../src/execution/tool-executor.js';

/**
 * classifyToolError now recognizes every WrongStackError subclass via a
 * catch-all `instanceof WrongStackError` arm. This test verifies the
 * routing for each subclass — severity drives the category (fatal → FATAL,
 * warning → TRANSIENT) and the subclass's `recoverable` flag drives the
 * retryable boolean.
 */
describe('classifyToolError — WrongStackError subclasses', () => {
  it('routes FetchError via httpStatusToCategory (not the catch-all)', () => {
    const result = classifyToolError(new FetchError({ message: 'HTTP 429', status: 429 }));
    expect(result.category).toBe(ToolErrorCategory.TRANSIENT);
    expect(result.retryable).toBe(true);
    expect(result.detail).toBe('HTTP 429');
  });

  it('routes ToolValidationError as VALIDATION', () => {
    const result = classifyToolError(
      new ToolValidationError({ message: 'bad input', field: 'path' }),
    );
    expect(result.category).toBe(ToolErrorCategory.VALIDATION);
    expect(result.retryable).toBe(false);
  });

  it('routes ParseError as FATAL (severity: error, not recoverable)', () => {
    const result = classifyToolError(new ParseError({ message: 'missing fields', source: 'test' }));
    expect(result.category).toBe(ToolErrorCategory.FATAL);
    expect(result.retryable).toBe(false);
    expect(result.detail).toContain('PARSE_FAILED');
  });

  it('routes FsError(FS_READ_FAILED) as FATAL (severity: error)', () => {
    const result = classifyToolError(
      new FsError({ message: 'ENOENT', code: 'FS_READ_FAILED', path: '/x' }),
    );
    expect(result.category).toBe(ToolErrorCategory.FATAL);
    expect(result.retryable).toBe(false);
  });

  it('routes ConfigError(CONFIG_INVALID) as FATAL (severity: fatal)', () => {
    const result = classifyToolError(new ConfigError({ message: 'bad', code: 'CONFIG_INVALID' }));
    expect(result.category).toBe(ToolErrorCategory.FATAL);
    expect(result.retryable).toBe(false);
  });

  it('routes SessionError(SESSION_WRITE_FAILED) as FATAL (severity: error, recoverable)', () => {
    const result = classifyToolError(
      new SessionError({ message: 'disk full', code: 'SESSION_WRITE_FAILED', sessionId: 's1' }),
    );
    expect(result.category).toBe(ToolErrorCategory.FATAL);
    // SESSION_WRITE_FAILED is recoverable (not SESSION_CORRUPTED) — the
    // caller can retry the write. classifyToolError passes recoverable through.
    expect(result.retryable).toBe(true);
  });

  it('routes SessionError(SESSION_NOT_FOUND) as TRANSIENT (severity: warning)', () => {
    const result = classifyToolError(
      new SessionError({ message: 'gone', code: 'SESSION_NOT_FOUND' }),
    );
    expect(result.category).toBe(ToolErrorCategory.TRANSIENT);
    expect(result.retryable).toBe(true);
  });

  it('routes AgentError(AGENT_ABORTED) as TRANSIENT (severity: warning)', () => {
    const result = classifyToolError(new AgentError({ message: 'aborted', code: 'AGENT_ABORTED' }));
    expect(result.category).toBe(ToolErrorCategory.TRANSIENT);
    expect(result.retryable).toBe(false);
  });

  it('routes SddError(SDD_PARSE_FAILED) as TRANSIENT (severity: warning)', () => {
    const result = classifyToolError(
      new SddError({ message: 'bad spec', code: 'SDD_PARSE_FAILED' }),
    );
    expect(result.category).toBe(ToolErrorCategory.TRANSIENT);
    expect(result.retryable).toBe(false);
  });

  it('routes PluginError as FATAL (severity: error)', () => {
    const result = classifyToolError(
      new PluginError({ message: 'load fail', code: 'PLUGIN_LOAD_FAILED', pluginName: 'bad' }),
    );
    expect(result.category).toBe(ToolErrorCategory.FATAL);
    expect(result.retryable).toBe(false);
  });

  it('routes ToolError as FATAL (severity: error, no explicit override)', () => {
    const result = classifyToolError(
      new ToolError({ message: 'boom', code: 'TOOL_EXECUTION_FAILED', toolName: 'read' }),
    );
    expect(result.category).toBe(ToolErrorCategory.FATAL);
    expect(result.retryable).toBe(false);
  });

  it('detail includes code and subsystem for structured errors', () => {
    const result = classifyToolError(
      new FsError({ message: 'disk full', code: 'FS_WRITE_FAILED', path: '/x' }),
    );
    expect(result.detail).toBe('FS_WRITE_FAILED [fs]');
  });
});

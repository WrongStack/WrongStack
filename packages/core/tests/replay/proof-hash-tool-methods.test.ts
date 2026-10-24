/**
 * Diagnostic proof: inspect the exact JSON strings that feed the hash
 * to confirm which tool properties cause instability.
 */

import type { Request } from '@wrongstack/contracts/types/provider';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { describe, expect, it } from 'vitest';
import { hashRequest, stableStringify } from '../../src/replay/hash.js';
import { compactToolDefinitionForWire } from '../../src/utils/tool-wire-compact.js';

function makeBaseRequest(): Request {
  return {
    model: 'claude-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    maxTokens: 1,
  };
}

// `Tool.execute` is required by the type but irrelevant to hashing: functions
// are dropped by `stableStringify`, so every literal below carries the same
// one and the hash comparisons stay symmetric.
const noopExecute = async (): Promise<unknown> => ({});

// ── Contract: which tool properties reach the hash, and survive a round-trip ──

describe('hashRequest: tool properties that reach the hash', () => {
  it('inspect JSON for a request with execute/validate functions', () => {
    const req = makeBaseRequest();
    req.tools = [
      {
        name: 'read',
        description: 'Read a file',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        permission: 'confirm' as const,
        mutating: false,
        execute: async (_: unknown) => ({ contents: '' }),
        validate: (_: unknown) => [],
      },
    ];

    const json = stableStringify({
      model: req.model,
      system: req.system,
      messages: req.messages,
      tools: req.tools,
      maxTokens: req.maxTokens,
      temperature: req.temperature,
      topP: req.topP,
      stopSequences: req.stopSequences,
      toolChoice: req.toolChoice,
    });

    // The open question here ("null, or dropped?") is exactly what decides
    // whether the hash is stable, so answer it with an assertion instead of a
    // console.log a human has to read. Dropped entirely: no key at all, so a
    // tool carrying functions hashes the same as that tool read back from disk
    // without them.
    expect(json).not.toContain('"execute"');
    expect(json).not.toContain('"validate"');
    // Serialisable siblings survive — the drop is specific to functions, not a
    // wholesale loss of the tool definition.
    expect(json).toContain('"name":"read"');
    expect(json).toContain('"permission":"confirm"');
  });

  it('inspect JSON for a request after JSON round-trip (no functions)', () => {
    const req = makeBaseRequest();
    req.tools = [
      {
        name: 'read',
        description: 'Read a file',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        permission: 'confirm' as const,
        mutating: false,
        execute: async (_: unknown) => ({ contents: '' }),
        validate: (_: unknown) => [],
      },
    ];

    const json = stableStringify({
      model: req.model,
      system: req.system,
      messages: req.messages,
      tools: req.tools,
      maxTokens: req.maxTokens,
      temperature: req.temperature,
      topP: req.topP,
      stopSequences: req.stopSequences,
      toolChoice: req.toolChoice,
    });

    const deserialised = JSON.parse(json);
    const jsonAfterRoundTrip = stableStringify({
      model: deserialised.model,
      system: deserialised.system,
      messages: deserialised.messages,
      tools: deserialised.tools,
      maxTokens: deserialised.maxTokens,
      temperature: deserialised.temperature,
      topP: deserialised.topP,
      stopSequences: deserialised.stopSequences,
      toolChoice: deserialised.toolChoice,
    });

    // These console.logs asked the right questions and recorded no answer. The
    // invariant they probed is load-bearing for replay: a request is written to
    // disk and read back WITHOUT its functions, so if the round-trip changed the
    // hash, no replayed request would ever match its recording.
    expect(jsonAfterRoundTrip).toBe(json);
    expect(hashRequest(deserialised as Request)).toBe(hashRequest(req));
  });
});

// ── Runtime-only tool fields must not move the digest ──
//
// `_estDefTokens`, `timeoutMs` and `estimatedDurationMs` are set per process or
// per run and never reach the provider, so two requests differing only in them
// must hash identically. This WAS a real defect (fixed 2026-09-16 by making
// `semanticTool()` project the wire triple); the assertions below were inverted
// when it was fixed and only these labels still described the old behaviour.
// The labels are corrected here so no future reader mistakes the fixed contract
// for an open bug.

describe('digest invariance: runtime-only Tool fields never change the hash', () => {
  it('hashes identically when tools differ only by _estDefTokens', () => {
    const reqWithout = makeBaseRequest();
    reqWithout.tools = [
      {
        name: 'read',
        description: 'Read a file',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        permission: 'confirm' as const,
        mutating: false,
        execute: noopExecute,
      },
    ];

    const reqWith = makeBaseRequest();
    reqWith.tools = [
      {
        name: 'read',
        description: 'Read a file',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        permission: 'confirm' as const,
        mutating: false,
        execute: noopExecute,
        _estDefTokens: 42, // runtime token estimate — set by ToolRegistry, differs per run
      },
    ];

    // `_estDefTokens` is a registration-time token-estimate cache: it differs on
    // every run while the provider payload stays byte-identical.
    expect(hashRequest(reqWithout)).toBe(hashRequest(reqWith));
  });

  it('hashes identically when tools differ only by timeoutMs', () => {
    const reqWithout = makeBaseRequest();
    reqWithout.tools = [
      {
        name: 'read',
        description: 'Read a file',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        permission: 'confirm' as const,
        mutating: false,
        execute: noopExecute,
      },
    ];

    const reqWith = makeBaseRequest();
    reqWith.tools = [
      {
        name: 'read',
        description: 'Read a file',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        permission: 'confirm' as const,
        mutating: false,
        execute: noopExecute,
        timeoutMs: 30000, // runtime config — differs per run, not sent to provider
      },
    ];

    // `timeoutMs` is executor policy — local to the run, never sent to the provider.
    expect(hashRequest(reqWithout)).toBe(hashRequest(reqWith));
  });

  it('hashes identically when tools differ only by estimatedDurationMs', () => {
    const reqWithout = makeBaseRequest();
    reqWithout.tools = [
      {
        name: 'read',
        description: 'Read a file',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        permission: 'confirm' as const,
        mutating: false,
        execute: noopExecute,
      },
    ];

    const reqWith = makeBaseRequest();
    reqWith.tools = [
      {
        name: 'read',
        description: 'Read a file',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        permission: 'confirm' as const,
        mutating: false,
        execute: noopExecute,
        estimatedDurationMs: 5000, // runtime hint — not sent to provider
      },
    ];

    // `estimatedDurationMs` is a UI hint for the spinner — local display only.
    expect(hashRequest(reqWithout)).toBe(hashRequest(reqWith));
  });
});

// ── Regression (round 20260916-i18n-discard): the tool digest is the WIRE triple ──
//
// semanticTool() projects to exactly {name, description, inputSchema} — the
// fields every provider wire converter sends (toolsToAnthropic / toolsToOpenAI /
// toolsToResponses / toolsToGemini all map through compactToolDefinitionForWire).
// Everything else on Tool (permission policy, executor policy, UI/guidance
// metadata) is edited independently of the prompt, so a difference in it must
// NOT move the digest: the provider payload is byte-identical and a recorded
// response must still be found. A previous fix stripped four such fields via a
// deny-list; the deny-list left the rest of the non-wire surface in the hash.

describe('wire-invariance: non-provider Tool fields never change the hash', () => {
  const baseTool = {
    name: 'read',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    permission: 'auto' as const,
    mutating: false,
    execute: noopExecute,
  } satisfies Tool;

  it('hashes identically when only permission differs (config-driven, never sent)', () => {
    const a = makeBaseRequest();
    a.tools = [baseTool];
    const b = makeBaseRequest();
    b.tools = [{ ...baseTool, permission: 'confirm' as const }];

    expect(compactToolDefinitionForWire(b.tools[0]!)).toEqual(
      compactToolDefinitionForWire(a.tools[0]!),
    );
    expect(hashRequest(b)).toBe(hashRequest(a));
  });

  it('hashes identically when icon/riskTier/capabilities differ', () => {
    const a = makeBaseRequest();
    a.tools = [
      { ...baseTool, icon: 'file' as const, riskTier: 'safe' as const, capabilities: ['fs.read'] },
    ];
    const b = makeBaseRequest();
    b.tools = [
      {
        ...baseTool,
        icon: 'edit' as const,
        riskTier: 'standard' as const,
        capabilities: ['fs.read', 'fs.write'],
      },
    ];

    expect(compactToolDefinitionForWire(b.tools[0]!)).toEqual(
      compactToolDefinitionForWire(a.tools[0]!),
    );
    expect(hashRequest(b)).toBe(hashRequest(a));
  });

  it('hashes identically when usageHint/selection/category/subject*/maxOutputBytes differ', () => {
    const a = makeBaseRequest();
    a.tools = [
      {
        ...baseTool,
        usageHint: 'hint A',
        selection: { doNotUseWhen: 'never for binary files', useInstead: ['x'] },
        category: 'files',
        subjectKey: 'path',
        subjectFields: ['path'],
        maxOutputBytes: 1024,
      },
    ];
    const b = makeBaseRequest();
    b.tools = [
      {
        ...baseTool,
        usageHint: 'hint B',
        selection: { doNotUseWhen: 'never for directories' },
        category: 'search',
        subjectKey: 'command',
        subjectFields: ['command'],
        maxOutputBytes: 2048,
      },
    ];

    expect(compactToolDefinitionForWire(b.tools[0]!)).toEqual(
      compactToolDefinitionForWire(a.tools[0]!),
    );
    expect(hashRequest(b)).toBe(hashRequest(a));
  });

  it('still reacts to the wire-visible triple (description / inputSchema / name)', () => {
    const a = makeBaseRequest();
    a.tools = [baseTool];

    const b = makeBaseRequest();
    b.tools = [{ ...baseTool, description: 'Read a file v2' }];
    expect(hashRequest(b)).not.toBe(hashRequest(a));

    const c = makeBaseRequest();
    c.tools = [
      {
        ...baseTool,
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' }, encoding: { type: 'string' } },
          required: ['path'],
        },
      },
    ];
    expect(hashRequest(c)).not.toBe(hashRequest(a));

    const d = makeBaseRequest();
    d.tools = [{ ...baseTool, name: 'readx' }];
    expect(hashRequest(d)).not.toBe(hashRequest(a));
  });
});

// ── The stability property the digest exists for ──
//
// Replay finds a recorded response BY HASH, so one request must always produce
// one hash: across repeat calls, and across two equal requests that were built
// separately. The second case is the one that bites in practice — the recorder
// and the replayer construct the request separately, so any dependence on
// object identity or key insertion order turns a recorded run into a silent
// cache miss and `mode: 'replay'` throws "no recorded response" for a request
// that was recorded verbatim. Sorting (stableStringify) is what makes it hold.

describe('digest stability: identical requests hash identically', () => {
  const stableTool = {
    name: 'read',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    permission: 'confirm' as const,
    mutating: false,
    execute: noopExecute,
  } satisfies Tool;

  it('returns the same hash for repeated calls on one request', () => {
    const req = makeBaseRequest();
    req.tools = [stableTool];

    const first = hashRequest(req);
    expect(hashRequest(req)).toBe(first);
    expect(hashRequest(req)).toBe(first);
  });

  it('returns the same hash for a separately built but equal request', () => {
    const recorded = makeBaseRequest();
    recorded.tools = [stableTool];

    const replayed = makeBaseRequest();
    // Identical content, different object graph AND different key order — the
    // shape a replayer naturally produces.
    replayed.tools = [
      {
        mutating: false,
        execute: noopExecute,
        permission: 'confirm' as const,
        inputSchema: {
          required: ['path'],
          properties: { path: { type: 'string' } },
          type: 'object',
        },
        description: 'Read a file',
        name: 'read',
      } satisfies Tool,
    ];

    expect(hashRequest(replayed)).toBe(hashRequest(recorded));
  });
});

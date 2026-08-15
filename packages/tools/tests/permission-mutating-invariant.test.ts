import { describe, expect, it } from 'vitest';
import { ToolCapabilities } from '@wrongstack/core/security';
import { builtinTools } from '../src/builtin.js';

/**
 * Invariant tests for the builtin tool registry.
 *
 * The most important rule in this file: a tool marked
 * `permission: 'auto'` must NOT mutate any persistent state.
 *
 * Why this matters
 * ────────────────
 * `permission: 'auto'` is the subagent guard rail's "this is safe to run
 * without asking the user" signal. The YOLO mode, the agent bridge, and
 * every subagent coordinator trust that label. If a tool silently writes
 * to disk while claiming `'auto'`, it bypasses the user confirmation
 * step entirely — exactly the kind of bug that turns a read-only
 * inspection into a destructive operation in production.
 *
 * The reverse direction is fine: a tool with `mutating: true` paired with
 * `permission: 'confirm'` is the intended design — destructive tools
 * are supposed to require user confirmation.
 *
 * History
 * ───────
 * 2026-05 audit: `planTool` was registered with
 *   `permission: 'auto' + mutating: false`
 * while calling `savePlan()` for every action except `show`. The fix
 * (CRIT-001) flipped it to `'confirm' + true`. The tests below are
 * the regression guard that this class of bug does not reappear.
 */
describe('builtin tool permission/mutating invariant (H7)', () => {
  it('no auto-permission tool declares mutating: true', () => {
    const offenders = builtinTools
      .filter((t) => t.permission === 'auto' && t.mutating === true)
      .map((t) => t.name);

    expect(
      offenders,
      `Tools with permission='auto' must be read-only (mutating=false).\n` +
        `Offenders: ${offenders.join(', ') || '(none)'}\n` +
        `Either change permission to 'confirm' or set mutating: false.`,
    ).toEqual([]);
  });

  it('every builtin tool declares its name', () => {
    const unnamed = builtinTools
      .map((t, i) => ({ i, name: t.name }))
      .filter(({ name }) => !name || typeof name !== 'string' || name.length === 0);

    expect(unnamed, 'Every tool must have a non-empty name').toEqual([]);
  });

  it('every builtin tool has a unique name', () => {
    const counts = new Map<string, number>();
    for (const t of builtinTools) {
      counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
    }
    const dups = [...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name);

    expect(dups, `Duplicate tool names: ${dups.join(', ')}`).toEqual([]);
  });

  it('every builtin tool has an object-typed inputSchema', () => {
    const offenders = builtinTools
      .filter((t) => !t.inputSchema || (t.inputSchema as { type?: string }).type !== 'object')
      .map((t) => t.name);

    expect(offenders, `Tools without object inputSchema: ${offenders.join(', ')}`).toEqual([]);
  });

  it('every builtin tool has a description of at least 20 characters', () => {
    // LLM-callable tools live or die by their description. A 20-char
    // minimum is the bare threshold for the model to recognize intent.
    const offenders = builtinTools
      .filter((t) => !t.description || t.description.length < 20)
      .map((t) => ({ name: t.name, len: t.description?.length ?? 0 }));

    expect(offenders, 'Tools with too-short descriptions:').toEqual([]);
  });

  it('no builtin tool is marked permission: deny (deny tools should not be registered)', () => {
    // If a tool should never run, omit it from the registry entirely.
    // A registered tool with permission: 'deny' is dead weight that
    // confuses the permission UI and counts against the tool count.
    const denied = builtinTools.filter((t) => t.permission === 'deny').map((t) => t.name);

    expect(denied, `Tools with permission='deny' should be removed: ${denied.join(', ')}`).toEqual(
      [],
    );
  });

  it('auto-permission tools do not declare dangerous capabilities', () => {
    const dangerous = new Set([
      'fs.write',
      'fs.write.outside-project',
      'shell.arbitrary',
      'shell.restricted',
      'shell.exec',
      'package.install',
      'config.mutate',
      'mcp.proxy',
      'subagent.spawn',
      'tool.mutate.any',
      'memory.write',
      'memory.delete',
    ]);
    const offenders = builtinTools
      .filter(
        (t) => t.permission === 'auto' && (t.capabilities ?? []).some((c) => dangerous.has(c)),
      )
      .map((t) => `${t.name} (${(t.capabilities ?? []).join(', ')})`);

    expect(
      offenders,
      `Auto tools must not carry dangerous capabilities: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('every builtin capability is centrally registered', () => {
    const known = new Set<string>(Object.values(ToolCapabilities));
    const offenders = builtinTools
      .flatMap((t) => (t.capabilities ?? []).map((cap) => ({ tool: t.name, cap })))
      .filter(({ cap }) => !known.has(cap))
      .map(({ tool, cap }) => `${tool} (${cap})`);

    expect(
      offenders,
      `Builtin tools must use ToolCapabilities values: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('mutating: true tools declare at least one capability', () => {
    // Subagent guard rails scope mutating tools by their declared
    // capabilities. A tool with mutating: true but no capabilities
    // array effectively has unlimited access — that is almost always
    // a registration bug.
    //
    // Whitelist: meta-tools that orchestrate the agent loop itself
    // (they invoke other tools rather than touching the filesystem or
    // shell). Their effect is mediated by the inner tool's capabilities
    // check, so an empty outer capability list is acceptable. The
    // permission policy already special-cases these.
    const META_TOOLS = new Set(['tool_use', 'batch_tool_use']);

    const offenders = builtinTools
      .filter(
        (t) =>
          t.mutating === true &&
          !META_TOOLS.has(t.name) &&
          (!t.capabilities || t.capabilities.length === 0),
      )
      .map((t) => t.name);

    expect(
      offenders,
      `Mutating tools must declare capabilities (meta-tools are whitelisted): ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});

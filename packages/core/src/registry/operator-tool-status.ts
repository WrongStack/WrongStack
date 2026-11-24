import type { SessionWriter } from '@wrongstack/contracts/types/session';
import { isOperatorOnlyTool, type Tool } from '@wrongstack/contracts/types/tool';

type SchemaVersion = Pick<SessionWriter, 'providerToolSchemaVersion'>;

export interface ToolSchemaSessionContext {
  readonly activeRunSessionWriter?: SchemaVersion | undefined;
  readonly session?: SchemaVersion | undefined;
}

export function toolSchemaSessionVersion(ctx: ToolSchemaSessionContext): number {
  return (ctx.activeRunSessionWriter ?? ctx.session)?.providerToolSchemaVersion ?? 0;
}

const filtered = new WeakMap<Tool[], Map<number, Tool[]>>();

/** Preserve order and identity across requests with the same registered roster. */
export function withoutOperatorToolStatus(tools: Tool[], schemaVersion: number): Tool[] {
  let versions = filtered.get(tools);
  if (!versions) {
    versions = new Map();
    filtered.set(tools, versions);
  }
  const cached = versions.get(schemaVersion);
  if (cached) return cached;
  const available = tools.filter((tool) => !isOperatorOnlyTool(tool, schemaVersion));
  const result = available.length === tools.length ? tools : available;
  versions.set(schemaVersion, result);
  return result;
}

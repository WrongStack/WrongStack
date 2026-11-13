import type { ToolProjection } from '@wrongstack/webui-protocol';
import { parseArtifact } from '../artifacts';
import { bounded } from '../session-coercion';
import { MAX_ARTIFACTS, MAX_TOOLS, type SessionState, type ToolEntry } from '../session-state';

/**
 * Tool start / progress / completion. A successful tool whose output is an
 * `artifact.presentation` for this session also registers a previewable artifact.
 */
export function reduceTool(state: SessionState, tool: ToolProjection): SessionState {
  const artifact =
    tool.kind === 'executed' && tool.ok && tool.output
      ? parseArtifact(tool.output, state.id)
      : null;
  const existing = state.tools.find((t) => t.id === tool.id);
  const next: ToolEntry =
    tool.kind === 'started'
      ? { id: tool.id, name: tool.name, input: tool.input, output: '', status: 'running' }
      : {
          id: tool.id,
          name: tool.name || existing?.name || 'tool',
          input: existing?.input,
          output: bounded(
            tool.kind === 'progress'
              ? (existing?.output ?? '') + tool.text
              : (tool.output ?? existing?.output ?? ''),
          ),
          status: tool.kind === 'executed' ? (tool.ok ? 'done' : 'error') : 'running',
        };
  return {
    ...state,
    tools: [...state.tools.filter((t) => t.id !== tool.id), next].slice(-MAX_TOOLS),
    ...(artifact
      ? {
          artifacts: [...state.artifacts.filter((a) => a.id !== artifact.id), artifact].slice(
            -MAX_ARTIFACTS,
          ),
        }
      : {}),
  };
}

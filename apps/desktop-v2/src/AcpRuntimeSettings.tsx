import type {
  AcpRuntimeOptionsResult,
  AcpRuntimeValues,
} from '@wrongstack/contracts/types/acp-runtime';
import { AcpRuntimeControls } from '@wrongstack/project-surfaces/ui/AcpRuntimeControls';
import type { EngineCommand } from './engine-operations';

export function AcpRuntimeSettings({
  agentId,
  values,
  command,
  onChange,
  disabled,
}: {
  agentId: string;
  values?: AcpRuntimeValues | undefined;
  command: EngineCommand;
  onChange: (values: AcpRuntimeValues) => void | Promise<void>;
  disabled?: boolean | undefined;
}) {
  return (
    <AcpRuntimeControls
      agentId={agentId}
      values={values}
      disabled={disabled}
      onChange={onChange}
      request={async (id, selected) => {
        const result = await command(
          'acp.config_options',
          { agentId: id, values: selected },
          ['acp.config_options'],
          { timeoutMs: 100_000 },
        );
        if (result['ok'] !== true)
          throw Error(String(result['error'] ?? 'ACP settings request failed.'));
        return result as unknown as AcpRuntimeOptionsResult;
      }}
    />
  );
}

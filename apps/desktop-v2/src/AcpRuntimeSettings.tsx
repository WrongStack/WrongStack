import type {
  AcpNativeModeSelector,
  AcpRuntimeOptionsResult,
  AcpRuntimeValues,
} from '@wrongstack/contracts/types/acp-runtime';
import { AcpRuntimeControls } from '@wrongstack/project-surfaces/ui/AcpRuntimeControls';
import type { EngineCommand } from './engine-operations';

export function AcpRuntimeSettings({
  agentId,
  sessionId,
  values,
  command,
  onChange,
  disabled,
}: {
  agentId: string;
  sessionId?: string | undefined;
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
      modeRequest={
        sessionId
          ? async (id, choice) => {
              const result = await command(
                'acp.mode',
                {
                  agentId: id,
                  sessionId,
                  ...(choice?.optionId ? { optionId: choice.optionId } : {}),
                  ...(choice?.value ? { value: choice.value } : {}),
                },
                ['acp.mode'],
                { timeoutMs: 100_000 },
              );
              if (result['ok'] !== true)
                throw Error(String(result['error'] ?? 'ACP mode request failed.'));
              return { modes: (result['modes'] as AcpNativeModeSelector[] | undefined) ?? [] };
            }
          : undefined
      }
    />
  );
}

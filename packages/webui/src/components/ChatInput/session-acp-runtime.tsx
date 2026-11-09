import { AcpRuntimeControls } from '@wrongstack/project-surfaces/ui/AcpRuntimeControls';
import { requestAcpRuntime, saveSessionAcpRuntime } from '@/lib/acp-runtime';
import { useLocalPrefs } from '@/stores/local-prefs';

export function SessionAcpRuntime({ agentId }: { agentId: string }) {
  const settings = useLocalPrefs((s) => s.acpRuntime);
  const sessionId = useLocalPrefs((s) => s.activeSessionId);
  return (
    <AcpRuntimeControls
      key={`${sessionId}/${agentId}`}
      agentId={agentId}
      values={settings?.[agentId]}
      request={requestAcpRuntime}
      onChange={async (values) => {
        await saveSessionAcpRuntime({ ...settings, [agentId]: values }, sessionId);
      }}
    />
  );
}

import { AcpRuntimeControls } from '@wrongstack/project-surfaces/ui/AcpRuntimeControls';
import { requestAcpMode, requestAcpRuntime, saveSessionAcpRuntime } from '@/lib/acp-runtime';
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
      modeRequest={sessionId ? (id, choice) => requestAcpMode(id, sessionId, choice) : undefined}
      onChange={async (values) => {
        const next = { ...settings, [agentId]: values };
        await saveSessionAcpRuntime(next, sessionId);
        useLocalPrefs.getState().set({ acpRuntime: next });
      }}
    />
  );
}

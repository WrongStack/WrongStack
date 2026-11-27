import { useEffect } from 'react';
import { projectFormDraftStorage } from './platform';
import { recoveryLog, recoveryLogKey, type SavedRecoveryLog } from './recovery-log';
import type { ProjectFormDraftStorage } from './requirement-draft';

/** Recovery operations persist per project session so they survive a restart. */
export function useSessionRecoveryLog(projectId: string, sessionId: string): void {
  useEffect(() => {
    if (!projectId || !sessionId) return;
    void recoveryLogKey(projectId, sessionId).then((key) =>
      recoveryLog.attach(
        sessionId,
        projectFormDraftStorage(projectId, key) as ProjectFormDraftStorage<SavedRecoveryLog>,
      ),
    );
  }, [projectId, sessionId]);
}

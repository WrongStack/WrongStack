import { Database } from 'lucide-react';
import { useAppTranslation } from '@/i18n';
import type { CustomRosterStats } from './agent-roster-data.js';
import { SelfLearningAgentList } from './self-learning/SelfLearningAgentList';
import { SelfLearningDetail } from './self-learning/SelfLearningDetail';
import { useSelfLearningState } from './self-learning/use-self-learning-state';

export function SelfLearningTab({
  customStats,
  onRefresh,
}: {
  customStats: CustomRosterStats[];
  onRefresh: () => void;
}) {
  const { t } = useAppTranslation();
  const state = useSelfLearningState({ customStats, onRefresh });

  if (state.populated.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <div className="text-center space-y-3">
          <Database className="h-10 w-10 mx-auto opacity-30" />
          <p className="text-sm">{t('activity:agentRoster.noSelfLearningDataYet')}</p>
          <p className="text-xs text-muted-foreground/70">
            {t('activity:agentRoster.learningsEmpty')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <SelfLearningAgentList
        populated={state.populated}
        selectedRole={state.selectedRole}
        onSelectRole={state.selectRole}
        onBulkOptimize={state.runBulkOptimize}
        bulkOptimizing={state.bulkOptimizing}
      />
      <div className="flex-1 min-h-0 min-w-0 overflow-y-auto p-4">
        {!state.selectedRole && (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            {t('activity:agentRoster.selectAnAgentToViewLearning')}
          </div>
        )}
        {state.selectedRole && state.selectedStats && (
          <SelfLearningDetail
            selectedRole={state.selectedRole}
            selectedStats={state.selectedStats}
            saving={state.saving}
            setLearningEnabled={state.setLearningEnabled}
            optimizing={state.optimizing}
            runOptimize={state.runOptimize}
            autoStatus={state.autoStatus}
            consolidatedContent={state.consolidatedContent}
            loadConsolidated={state.loadConsolidated}
            setConsolidatedContent={state.setConsolidatedContent}
            skills={state.skills}
            toggleSkillBody={state.toggleSkillBody}
            toggleSkillPin={state.toggleSkillPin}
            openSkill={state.openSkill}
            retired={state.retired}
            showRetired={state.showRetired}
            setShowRetired={state.setShowRetired}
            loadEntries={state.loadEntries}
            loadingEntries={state.loadingEntries}
            reviewEntries={state.reviewEntries}
            reviewDecisions={state.reviewDecisions}
            setReviewEntries={state.setReviewEntries}
            setReviewDecisions={state.setReviewDecisions}
            applyReview={state.applyReview}
            teachInput={state.teachInput}
            setTeachInput={state.setTeachInput}
            runTeach={state.runTeach}
            teachFeedback={state.teachFeedback}
          />
        )}
      </div>
    </div>
  );
}

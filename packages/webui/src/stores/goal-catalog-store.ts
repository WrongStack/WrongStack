import type { GoalSummary } from '@wrongstack/goal';
import { create } from 'zustand';

interface GoalCatalogState {
  goals: GoalSummary[];
  selectedGoalId: string | null;
  setGoals(goals: GoalSummary[]): void;
  selectGoal(goalId: string | null): void;
}

export const useGoalCatalogStore = create<GoalCatalogState>()((set) => ({
  goals: [],
  selectedGoalId: null,
  setGoals: (goals) => set({ goals }),
  selectGoal: (selectedGoalId) => set({ selectedGoalId }),
}));

import type { SkillEntry } from '@wrongstack/contracts/types';
import type { ToolResultViewMode } from './settings-contracts.js';
import type {
  LiveSessionEntry,
  McpPickerItem,
  ModeOption,
  PromptPickEntry,
  ProviderOption,
  ResourceMenuAction,
  ResourceMenuSnapshot,
  ToolPickerItem,
} from './ui-contracts.js';
export type AppActionServices =
  | { type: 'toolStarted'; id: string; name: string }
  | { type: 'toolEnded'; id?: string | undefined; name?: string | undefined }
  | { type: 'toolStreamAppend'; toolUseId: string; name: string; text: string; startedAt: number }
  | { type: 'toolStreamClear'; toolUseId?: string | undefined; name?: string | undefined }
  | {
      type: 'modelPickerOpen';
      providers: ProviderOption[];
      purpose?: 'switch' | 'pick' | undefined;
      title?: string | undefined;
    }
  | { type: 'modelPickerClose' }
  | { type: 'modelPickerMove'; delta: number }
  | { type: 'modelPickerPickProvider'; providerId: string; models: string[] }
  | { type: 'modelPickerBack' }
  | { type: 'modelPickerHint'; text?: string | undefined }
  | { type: 'modelPickerSearch'; query: string }
  | { type: 'modelPickerEffort'; delta: number }
  | {
      type: 'skillPickerOpen';
      entries: SkillEntry[];
      mention?: import('@wrongstack/core/skill-mentions').SkillMention | undefined;
    }
  | {
      type: 'skillMentionResults';
      entries: SkillEntry[];
      hint?: string | undefined;
      mention: import('@wrongstack/core/skill-mentions').SkillMention;
    }
  | { type: 'skillPickerClose' }
  | { type: 'skillPickerMove'; delta: number }
  | { type: 'skillPickerHint'; text?: string | undefined }
  | { type: 'resourceMenuOpen'; snapshot: ResourceMenuSnapshot }
  | { type: 'resourceMenuClose' }
  | { type: 'resourceMenuMove'; delta: number }
  | { type: 'resourceMenuHint'; text?: string | undefined }
  | { type: 'resourceMenuFilter'; filter: string; active: boolean }
  | { type: 'resourceMenuConfirm'; action?: ResourceMenuAction | undefined }
  | {
      type: 'modePickerOpen';
      modes: ModeOption[];
    }
  | { type: 'modePickerClose' }
  | { type: 'modePickerMove'; delta: number }
  | { type: 'modePickerHint'; text?: string | undefined }
  | {
      type: 'promptPickerOpen';
      all: PromptPickEntry[];
      categories: string[];
      recentSlugs: string[];
    }
  | { type: 'promptPickerClose' }
  | { type: 'promptPickerMove'; delta: number }
  | { type: 'promptPickerCategory'; delta: number }
  | { type: 'promptPickerLevel'; level: 'simple' | 'detailed' | 'advanced' }
  | {
      type: 'toolResultViewSet';
      entryIds: readonly number[];
      mode: ToolResultViewMode;
    }
  | { type: 'mcpPickerOpen'; items?: McpPickerItem[] | undefined }
  | { type: 'mcpPickerClose' }
  | { type: 'mcpPickerMove'; delta: number }
  | { type: 'mcpPickerSetItems'; items: McpPickerItem[] }
  | { type: 'mcpPickerBusy'; busy: boolean }
  | { type: 'mcpPickerHint'; text?: string | undefined }
  | { type: 'mcpPickerEditor'; editor?: import('./ui-contracts.js').McpPickerEditor | undefined }
  | { type: 'toolsPickerOpen'; items?: ToolPickerItem[] | undefined }
  | { type: 'toolsPickerClose' }
  | { type: 'toolsPickerMove'; delta: number }
  | { type: 'toolsPickerSetItems'; items: ToolPickerItem[] }
  | { type: 'toolsPickerToggle' }
  | { type: 'toolsPickerBusy'; busy: boolean }
  | { type: 'toolsPickerHint'; text?: string | undefined }
  | { type: 'toolsPickerFilter'; filter: string }
  | { type: 'historyPush'; text: string }
  | { type: 'historyUp' }
  | { type: 'historyDown' }
  | { type: 'sessionRewound'; toPromptIndex: number }
  | {
      type: 'sessionsPanelSet';
      sessions: LiveSessionEntry[];
    }
  | { type: 'sessionsPanelMove'; delta: number }
  | { type: 'sessionsPanelBusy'; on: boolean }
  | { type: 'sessionResumeConfirmSet'; sessionId: string; sessionName: string }
  | { type: 'sessionResumeConfirmClear' };

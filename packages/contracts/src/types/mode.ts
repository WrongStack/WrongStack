export interface Mode {
  id: string;
  name: string;
  description: string;
  /** Additional prompt text injected into system prompt when mode is active */
  prompt: string;
  /** Tags for tool_search filtering */
  tags?: string[] | undefined;
  /** Tools that should be prioritized/highlighted when this mode is active */
  toolPreferences?: string[] | undefined;
  /**
   * Skill names that are particularly relevant to this mode. The system
   * prompt builder appends a "Suggested skills" note so the model knows
   * which domain knowledge to leverage first. Skill must exist in the
   * loaded skill set to appear.
   */
  suggestedSkills?: string[] | undefined;
}

export interface ModeManifest {
  modes: Mode[];
  defaultMode?: string | undefined;
}

export interface ModeStore {
  getActiveMode(): Promise<Mode | null>;
  setActiveMode(modeId: string | null): Promise<void>;
  listModes(): Promise<Mode[]>;
  getMode(modeId: string): Promise<Mode | null>;
}

export interface ModeConfig {
  directory: string;
}

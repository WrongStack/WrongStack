export interface WSSkillsList {
  type: 'skills.list';
  payload: {
    enabled: boolean;
    error?: string | undefined;
    skills: Array<{
      name: string;
      description: string;
      version: string;
      source: string;
      sourceUrl: string;
      ref: string;
      path: string;
      trigger: string;
      scope: string[];
    }>;
  };
}

export interface WSSkillContent {
  type: 'skills.content';
  payload: {
    name: string;
    body: string;
    path: string;
    source: string;
    relatedFiles: string[];
    references: string[];
    error?: string | undefined;
    sourceUrl?: string;
  };
}

interface WSDesignKitSummary {
  id: string;
  name: string;
  aesthetic: string;
  bestFor: string;
  stacks: string[];
  tags: string[];
  light: Record<string, string>;
  dark: Record<string, string>;
}

export interface WSDesignList {
  type: 'design.list';
  payload: {
    kits: WSDesignKitSummary[];
    activeKit: string | null;
    stack: string | null;
    overrides?: Record<string, string> | undefined;
    error?: string | undefined;
  };
}

export interface WSDesignUse {
  type: 'design.use';
  payload: {
    ok: boolean;
    kit?: string | undefined;
    name?: string | undefined;
    aesthetic?: string | undefined;
    stack?: string | undefined;
    body?: string | undefined;
    overrides?: Record<string, string> | undefined;
    light?: Record<string, string> | undefined;
    dark?: Record<string, string> | undefined;
    error?: string | undefined;
  };
}

export interface WSDesignState {
  type: 'design.state';
  payload: {
    activeKit: string | null;
    stack: string | null;
    overrides?: Record<string, string> | undefined;
  };
}

export interface WSDesignSet {
  type: 'design.set';
  payload: {
    ok: boolean;
    overrides?: Record<string, string> | undefined;
    error?: string | undefined;
  };
}

export interface WSDesignTune {
  type: 'design.tune';
  payload: {
    ok: boolean;
    /** The concrete token overrides the knobs resolved to. */
    resolved?: Record<string, string> | undefined;
    overrides?: Record<string, string> | undefined;
    error?: string | undefined;
  };
}

export interface WSDesignSwap {
  type: 'design.swap';
  payload: {
    ok: boolean;
    kit?: string | undefined;
    name?: string | undefined;
    aesthetic?: string | undefined;
    stack?: string | undefined;
    body?: string | undefined;
    overrides?: Record<string, string> | undefined;
    light?: Record<string, string> | undefined;
    dark?: Record<string, string> | undefined;
    error?: string | undefined;
  };
}

export interface WSDesignMaterialize {
  type: 'design.materialize';
  payload: {
    ok: boolean;
    path?: string | undefined;
    format?: string | undefined;
    stack?: string | undefined;
    error?: string | undefined;
  };
}

export interface WSDesignVerify {
  type: 'design.verify';
  payload: {
    ok: boolean;
    kit?: string | undefined;
    filesScanned?: number | undefined;
    score?: number | undefined;
    violationCount?: number | undefined;
    violations?: { file: string; line: number; snippet: string; reason: string }[] | undefined;
    error?: string | undefined;
  };
}

export interface WSSkillsInstalled {
  type: 'skills.installed';
  payload: {
    success: boolean;
    error: string | null;
    results?: Array<{
      name: string;
      path: string;
      scope: 'project' | 'user';
      source: string;
      ref: string;
      skillCount: number;
    }>;
  };
}

export interface WSSkillsUninstalled {
  type: 'skills.uninstalled';
  payload: {
    success: boolean;
    error: string | null;
  };
}

export interface WSSkillsUpdated {
  type: 'skills.updated';
  payload: {
    success: boolean;
    error: string | null;
    updated?: Array<{ name: string; oldRef: string; newRef: string }>;
    unchanged?: string[];
    errors?: Array<{ name: string; error: string }>;
  };
}

export interface WSSkillsCreated {
  type: 'skills.created';
  payload: {
    success: boolean;
    error: string | null;
    skill?: {
      name: string;
      path: string;
      scope: 'project' | 'user';
    };
  };
}

export interface WSSkillsEdited {
  type: 'skills.edited';
  payload: {
    success: boolean;
    error: string | null;
  };
}

export interface WSSkillsExported {
  type: 'skills.exported';
  payload: {
    /** Base64-encoded ZIP buffer containing all skills as SKILL.md files */
    zipBase64: string;
    skillCount: number;
    error?: string | undefined;
  };
}

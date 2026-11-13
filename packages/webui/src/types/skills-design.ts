export interface WSSkillsList {
  type: 'skills.list';
  payload: {
    /**
     * Echoed back from the request when the caller minted one
     * (`withRequestId` on the server). `consumeSuppressedChatEcho` correlates
     * on it to drop the chat echo for exactly the request that asked to be
     * suppressed.
     */
    requestId?: string | undefined;
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
  axes?: { paper: string; display: string; accent: string; displayFace?: string } | undefined;
  posture?: string | undefined;
  material?: string | undefined;
  photo?: string | undefined;
  fontLinks?: string[] | undefined;
  pictured?: string | undefined;
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
    /** WCAG AA gate: fg/bg + primary/bg pairs below 4.5:1 (empty = clean). */
    contrastIssues?: Array<{ theme: 'light' | 'dark'; pair: string; ratio: number }> | undefined;
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
    /** WCAG AA gate: fg/bg + primary/bg pairs below 4.5:1 (empty = clean). */
    contrastIssues?: Array<{ theme: 'light' | 'dark'; pair: string; ratio: number }> | undefined;
    error?: string | undefined;
  };
}

export interface WSDesignVerify {
  type: 'design.verify';
  payload: {
    ok: boolean;
    /** Token basis: 'kit' (pinned) or 'captured' (the project's own tokens). */
    source?: 'kit' | 'captured' | undefined;
    /** Kit id when source === 'kit'; null when verifying against a capture. */
    kit?: string | null | undefined;
    /** Files the capture was taken from, when source === 'captured'. */
    capturedFrom?: string[] | null | undefined;
    filesScanned?: number | undefined;
    score?: number | undefined;
    violationCount?: number | undefined;
    violations?: { file: string; line: number; snippet: string; reason: string }[] | undefined;
    waived?: { file: string; line: number; id: string; reason?: string }[] | undefined;
    houseStyleSuggestions?: { id: string; count: number; message: string }[] | undefined;
    error?: string | undefined;
  };
}

export interface WSDesignDraw {
  type: 'design.draw';
  payload: {
    ok: boolean;
    kit?: string | null | undefined;
    seed?: string | undefined;
    job?: string | undefined;
    material?: string | undefined;
    macrostructure?: { id: string; label: string; description: string } | undefined;
    opening?: { id: string; label: string; description: string } | undefined;
    navigation?: { id: string; label: string; description: string } | undefined;
    sections?: { id: string; label: string; description: string }[] | undefined;
    footer?: { id: string; label: string; description: string } | undefined;
    markdown?: string | undefined;
    error?: string | undefined;
  };
}

export interface WSDesignPhotos {
  type: 'design.photos';
  payload: {
    ok: boolean;
    kit?: string | null | undefined;
    seed?: string | undefined;
    query?: string | undefined;
    orient?: string | undefined;
    totalCatalog?: number | undefined;
    candidates?: Record<string, unknown>[] | undefined;
    slotsHelper?: string | undefined;
    markdown?: string | undefined;
    error?: string | undefined;
  };
}

export interface WSDesignSnapshot {
  type: 'design.snapshot';
  payload: {
    ok: boolean;
    path?: string | undefined;
    filesScanned?: number | undefined;
    routes?: string[] | undefined;
    inputs?: string[] | undefined;
    testIds?: string[] | undefined;
    handlers?: string[] | undefined;
    error?: string | undefined;
  };
}

export interface WSDesignKept {
  type: 'design.kept';
  payload: {
    ok: boolean;
    clean?: boolean | undefined;
    missingRoutes?: string[] | undefined;
    missingInputs?: string[] | undefined;
    missingTestIds?: string[] | undefined;
    missingHandlers?: string[] | undefined;
    markdown?: string | undefined;
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

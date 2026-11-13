import type { StreamActivity } from '@wrongstack/webui-protocol';
import type { Artifact } from './artifacts';
import type { AgentEntry } from './session-agents';
import type { FileNode } from './workspace-model';

/** Retention caps: the browser keeps a bounded window of a long session. */
export const MAX_MESSAGES = 500;
export const MAX_TOOLS = 200;
export const MAX_ARTIFACTS = 30;
export const MAX_CONFIRM_QUEUE = 50;

export interface ChatEntry {
  id: string;
  role: 'user' | 'assistant' | 'thinking' | 'system';
  text: string;
  streaming?: boolean;
  final?: boolean;
  runtimeContext?: string[];
  delivery?: 'btw';
  autoEligible?: boolean;
  images?: { data: string; mediaType: string }[];
}
export interface ToolEntry {
  id: string;
  name: string;
  input: unknown;
  output: string;
  status: 'running' | 'done' | 'error' | 'interrupted';
}
export interface InputQuestion {
  id: string;
  prompt: string;
  kind: string;
  required: boolean;
  allowCustom: boolean;
  options: { id: string; label: string }[];
}
export interface InputRequest {
  id: string;
  title: string;
  questions: InputQuestion[];
}
export interface Confirmation {
  id: string;
  tool: string;
  input: string;
  deadlineAt: number;
}
export type { AgentEntry };
export interface SessionState {
  streamActivity?: StreamActivity | null;
  runOutcome: 'done' | 'aborted' | 'error' | null;
  id: string;
  project: string;
  appVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  cache: {
    readTokens: number;
    writeTokens: number;
    hitRatio: number;
    lastHitRatio: number | null;
    coverageTokens: number;
    capturedAt: number;
  } | null;
  usage: { input: number; output: number; total: number };
  cwd: string;
  provider: string;
  model: string;
  maxContext: number;
  tokens: number;
  load: number;
  running: boolean;
  messages: ChatEntry[];
  tools: ToolEntry[];
  sessions: { id: string; title: string; startedAt: string }[];
  models: Record<string, { id: string; name: string; contextWindow: number }[]>;
  providers: { id: string; name: string; configured: boolean; family: string; baseUrl: string }[];
  todos: { id: string; title: string; status: string }[];
  plan: { id: string; title: string; status: string }[];
  tasks: { id: string; title: string; status: string }[];
  files: { path: string; status: string; additions: number; deletions: number }[];
  matches: string[];
  diff: { path: string; oldText: string; newText: string; error: string } | null;
  agents: AgentEntry[];
  confirm: Confirmation | null;
  confirmQueue: Confirmation[];
  inputs: InputRequest[];
  notice: string;
  prefs: Record<string, unknown>;
  mode: string;
  modes: { id: string; name: string; description: string }[];
  effortLevels: string[] | undefined;
  effortSupported: boolean | undefined;
  projectEffort: string;
  runFailure: string;
  fileTree: FileNode[];
  treeLoading: boolean;
  treeLoaded: boolean;
  treeError: string;
  artifacts: Artifact[];
  preview: {
    requestId: string;
    artifact: Artifact;
    content: string;
    error: string;
    loading: boolean;
  } | null;
}

export const initialState = (): SessionState => ({
  streamActivity: null,
  id: '',
  project: '',
  appVersion: '',
  latestVersion: '',
  updateAvailable: false,
  cache: null,
  usage: { input: 0, output: 0, total: 0 },
  cwd: '',
  provider: '',
  model: '',
  maxContext: 0,
  tokens: 0,
  load: 0,
  running: false,
  runOutcome: null,
  messages: [],
  tools: [],
  sessions: [],
  models: {},
  providers: [],
  todos: [],
  plan: [],
  tasks: [],
  files: [],
  matches: [],
  diff: null,
  agents: [],
  confirm: null,
  confirmQueue: [],
  inputs: [],
  notice: '',
  prefs: {},
  mode: '',
  modes: [],
  effortLevels: undefined,
  effortSupported: undefined,
  projectEffort: '',
  runFailure: '',
  fileTree: [],
  treeLoading: false,
  treeLoaded: false,
  treeError: '',
  artifacts: [],
  preview: null,
});

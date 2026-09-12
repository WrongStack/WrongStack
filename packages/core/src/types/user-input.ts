/** A selectable answer displayed by an interactive user-input surface. */
export interface UserInputOption {
  id: string;
  label: string;
  /** Optional consequence or trade-off shown below the label. */
  description?: string | undefined;
}

export type UserInputQuestionKind = 'single_select' | 'multi_select' | 'text';

/** One question in a tabbed user-input form. */
export interface UserInputQuestion {
  id: string;
  prompt: string;
  description?: string | undefined;
  kind: UserInputQuestionKind;
  required?: boolean | undefined;
  options?: UserInputOption[] | undefined;
  /** Recommended option ids. Single-select questions use at most one id. */
  recommendedOptionIds?: string[] | undefined;
  /** Recommended text for a free-form question. */
  recommendedText?: string | undefined;
  recommendationReason?: string | undefined;
  /** Permit an additional write-in answer on a select question. */
  allowCustomResponse?: boolean | undefined;
  placeholder?: string | undefined;
}

export interface UserInputTab {
  id: string;
  label: string;
  description?: string | undefined;
  questions: UserInputQuestion[];
}

export interface UserInputRequest {
  id: string;
  title: string;
  description?: string | undefined;
  submitLabel?: string | undefined;
  tabs: UserInputTab[];
}

export interface UserInputAnswer {
  questionId: string;
  selectedOptionIds: string[];
  text?: string | undefined;
  /** True when the submitted value equals the model's recommendation. */
  usedRecommendation: boolean;
}

export interface UserInputResponse {
  requestId: string;
  status: 'submitted' | 'cancelled';
  answers: UserInputAnswer[];
}

export type UserInputAwaiter = (
  request: UserInputRequest,
  options: { signal: AbortSignal; sessionId?: string | undefined },
) => Promise<UserInputResponse | undefined>;

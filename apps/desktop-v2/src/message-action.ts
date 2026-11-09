/** An action on a message: enabled with `run`, or shown disabled with the reason. */
export type MessageAction = { run: () => void | Promise<unknown> } | { reason: string };

import { record } from './engine-values';

export class EngineHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly data: unknown,
  ) {
    super(engineHttpError(data, status));
    this.name = 'EngineHttpError';
  }
}
export function engineHttpError(data: unknown, status: number): string {
  const error = record(data)['error'];
  if (typeof error === 'string' && error) return error;
  const message = record(error)['message'];
  return typeof message === 'string' && message ? message : statusMessage(status);
}

/**
 * The failure in words, for an engine answer that carries no message of its own. It used to
 * read "The engine refused this operation (200)": a success code beside "refused", and a number
 * that told the user nothing.
 */
function statusMessage(status: number): string {
  if (status === 401 || status === 403) return 'The engine did not allow this.';
  if (status === 404) return 'The running engine does not offer this yet. Update it to use this.';
  if (status === 408 || status === 504) return 'The engine took too long to answer. Try again.';
  if (status === 429) return 'The engine is busy. Try again in a moment.';
  if (status >= 500) return 'The engine hit an error doing this. Try again.';
  if (status >= 400) return 'The engine could not do this with what was sent.';
  return 'The engine gave no usable answer. Try again.';
}

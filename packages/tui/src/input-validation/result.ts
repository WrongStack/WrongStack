export interface ValidationOk<T> {
  valid: true;
  value: T;
}

export interface ValidationError {
  valid: false;
  error: string;
}

export type ValidationResult<T> = ValidationOk<T> | ValidationError;

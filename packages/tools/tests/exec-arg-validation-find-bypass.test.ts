import { describe, expect, it } from 'vitest';
import { validateArgs } from '../src/exec-arg-validation.js';

describe('validateArgs find -- and -okdir enforcement (F938)', () => {
  it('blocks find command-executing primaries even after --', () => {
    expect(validateArgs('find', ['--', '.', '-exec', 'sh', '-c', 'id', ';'])).not.toBeNull();
    expect(validateArgs('find', ['-H', '--', '.', '-execdir', 'sh', ';'])).not.toBeNull();
    expect(validateArgs('find', ['--', '.', '-ok', 'rm', '{}', ';'])).not.toBeNull();
    expect(validateArgs('find', ['.', '-okdir', 'sh', '-c', 'id', ';'])).not.toBeNull();
    expect(validateArgs('find', ['--', '.', '-okdir', 'sh', ';'])).not.toBeNull();
  });

  it('keeps benign find -- queries and git -- pathspecs allowed', () => {
    expect(validateArgs('find', ['--', '.', '-name', '*.ts'])).toBeNull();
    expect(validateArgs('git', ['status', '--', '--exec=file.txt'])).toBeNull();
  });
});

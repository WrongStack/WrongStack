import { expect, it } from 'vitest';
import { configDoctorReport } from '../src/ConfigDoctor';

it('reads the doctor result without inventing an applied repair', () => {
  expect(
    configDoctorReport({
      success: true,
      applied: false,
      changed: true,
      changes: [
        { path: 'context.reserve', action: 'added' },
        { path: 'fleet.maxWorkers', action: 'replaced' },
      ],
      configPath: '/home/u/.wrongstack/config.json',
    }),
  ).toEqual({
    changed: true,
    applied: false,
    changes: [
      { path: 'context.reserve', action: 'added' },
      { path: 'fleet.maxWorkers', action: 'replaced' },
    ],
    configPath: '/home/u/.wrongstack/config.json',
    backupPath: '',
  });
  expect(configDoctorReport({ applied: true, changed: true, backupPath: '/b' }).backupPath).toBe(
    '/b',
  );
  expect(configDoctorReport({}).changes).toEqual([]);
});

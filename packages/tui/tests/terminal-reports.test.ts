import { describe, expect, it } from 'vitest';
import { TerminalReportParser } from '../src/terminal-reports.js';

describe('TerminalReportParser', () => {
  it.each(['\x1bOP', '\x1b[24~', '\x1b[<64;120;40M'])(
    'frames %j at every transport split',
    (report) => {
      for (let split = 1; split < report.length; split++) {
        const parser = new TerminalReportParser();
        expect(parser.push(report.slice(0, split))).toEqual([]);
        expect(parser.push(report.slice(split))).toEqual([report]);
        expect(parser.hasPendingControl).toBe(false);
      }
    },
  );

  it('ignores a byte-fragmented paste and resumes reports after the closing marker', () => {
    const parser = new TerminalReportParser();
    const reports = [...'\x1b[200~hello\x1bOQ\x1b[<0;10;4M\x1b[201~\x1bOR'].flatMap((byte) =>
      parser.push(byte),
    );
    expect(reports).toEqual(['\x1bOR']);
  });

  it('does not expire paste state between slow payload chunks', () => {
    const parser = new TerminalReportParser();
    parser.push('\x1b[200~');
    parser.discardPendingControl();
    expect(parser.push('\x1bOQ')).toEqual([]);
    parser.push('\x1b[201');
    parser.discardPendingControl();
    expect(parser.push('~\x1bOR')).toEqual(['\x1bOR']);
  });

  it('drops oversized and interrupted controls and recovers at the next report', () => {
    const parser = new TerminalReportParser();
    expect(parser.push(`\x1b[${'1'.repeat(200)}`)).toEqual([]);
    expect(parser.hasPendingControl).toBe(false);
    expect(parser.push('M\x1b[<64;\x1bOQ')).toEqual(['\x1bOQ']);
  });
});

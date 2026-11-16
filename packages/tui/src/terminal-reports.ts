const ESC = '\x1b';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const MAX_REPORT_LENGTH = 128;

/**
 * Frame the supplemental F-key/SGR reports Ink's public Key cannot represent.
 * A transport read is not a key: reports can be split or batched by a PTY or
 * WebSocket. Paste bodies must never become keyboard or pointer commands.
 * Only a short unfinished control or paste-end prefix is retained, not text.
 */
export class TerminalReportParser {
  private pending = '';
  private pasting = false;

  get hasPendingControl(): boolean {
    return !this.pasting && this.pending !== '';
  }

  /** Match Ink's escape timeout without abandoning an unfinished paste. */
  discardPendingControl(): void {
    if (!this.pasting) this.pending = '';
  }

  push(chunk: string): string[] {
    const data = this.pending + chunk;
    this.pending = '';
    const reports: string[] = [];
    let offset = 0;
    while (offset < data.length) {
      if (this.pasting) {
        const end = data.indexOf(PASTE_END, offset);
        if (end < 0) {
          // Retain only a suffix that can close the paste on the next read.
          for (
            let length = Math.min(PASTE_END.length - 1, data.length - offset);
            length > 0;
            length--
          ) {
            if (data.endsWith(PASTE_END.slice(0, length))) {
              this.pending = data.slice(-length);
              break;
            }
          }
          break;
        }
        this.pasting = false;
        offset = end + PASTE_END.length;
        continue;
      }

      const start = data.indexOf(ESC, offset);
      if (start < 0) break;
      const type = data[start + 1];
      if (type === undefined) {
        this.pending = ESC;
        break;
      }
      if (type !== '[' && type !== 'O') {
        offset = start + 1;
        continue;
      }
      let end = start + 2;
      while (end < data.length && /[\x20-\x3f]/.test(data[end]!)) end++;
      if (end === data.length) {
        if (end - start <= MAX_REPORT_LENGTH) this.pending = data.slice(start);
        break;
      }
      const final = data.charCodeAt(end);
      if (final < 0x40 || final > 0x7e) {
        offset = end;
        continue;
      }
      const report = data.slice(start, end + 1);
      offset = end + 1;
      if (report === PASTE_START) this.pasting = true;
      else if (report !== PASTE_END && report.length <= MAX_REPORT_LENGTH) reports.push(report);
    }
    return reports;
  }
}

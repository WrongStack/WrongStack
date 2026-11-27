/**
 * PowerShell started with `-EncodedCommand` assumes its caller is another
 * PowerShell and serializes the error, warning and progress streams as CLIXML
 * on stderr:
 *
 *   #< CLIXML
 *   <Objs …><S S="Error">_x001B_[31;1mWrite-Error: _x001B_[0mbad_x000D__x000A_</S></Objs>
 *
 * Every failing PowerShell command — the `pwsh` tool, and `bash` wherever the
 * session shell is pinned to PowerShell — reached the model as that markup:
 * the one line that said what went wrong, buried in XML and `_xHHHH_`
 * escapes. `-OutputFormat Text` fixes PowerShell 7 but not Windows PowerShell
 * 5.1, so the stream is decoded here, on the shared output path, for both.
 *
 * Progress records are dropped (they are status chatter, e.g. 5.1's
 * "Preparing modules for first use."); warning/verbose/debug/information keep
 * the prefix PowerShell itself prints for them. Text without the marker is
 * returned unchanged.
 */
export function decodePowerShellClixml(text: string): string {
  if (!text.includes('#< CLIXML')) return text;
  return text.replace(/#< CLIXML\r?\n(<Objs\b[\s\S]*?(?:<\/Objs>|$))/g, (_block, objs: string) =>
    decodeObjs(objs),
  );
}

const STREAM_PREFIX: Readonly<Record<string, string>> = {
  error: '',
  warning: 'WARNING: ',
  verbose: 'VERBOSE: ',
  debug: 'DEBUG: ',
  information: '',
};

function decodeObjs(objs: string): string {
  let out = '';
  for (const m of objs.matchAll(/<S S="([^"]*)">([\s\S]*?)<\/S>/g)) {
    const stream = (m[1] ?? '').toLowerCase();
    const prefix = STREAM_PREFIX[stream];
    if (prefix === undefined) continue;
    out += prefix + decodeClixmlString(m[2] ?? '');
  }
  return out;
}

function decodeClixmlString(s: string): string {
  return s
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/&(lt|gt|quot|apos|amp);/g, (_m, name: string) => XML_ENTITIES[name] ?? _m);
}

const XML_ENTITIES: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  amp: '&',
};

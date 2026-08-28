/**
 * Minimal diagnostic page used only when the packaged HQ SPA assets cannot be found.
 * It intentionally contains no telemetry UI or control-plane implementation.
 */
const HQ_RECOVERY_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>WrongStack HQ — assets unavailable</title>
  <style>
    :root{color-scheme:dark;background:#0c111b;color:#e7edf7;font:16px/1.5 system-ui,sans-serif}
    body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box}
    main{max-width:680px;border:1px solid #334155;background:#111827;padding:28px}
    h1{margin-top:0;font-size:1.5rem}code{color:#93c5fd}p{color:#cbd5e1}
  </style>
</head>
<body>
  <main data-hq-recovery-shell>
    <h1>HQ frontend assets are unavailable</h1>
    <p>The HQ backend is running, but the packaged React application could not be resolved.</p>
    <p>Rebuild or reinstall <code>@wrongstack/webui-hq</code>, then restart HQ. API routes remain available for diagnostics.</p>
  </main>
</body>
</html>`;

/** Backward-compatible public name; now always represents the diagnostic shell. */
export const HQ_HTML = HQ_RECOVERY_HTML;

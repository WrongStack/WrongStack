/**
 * HQ dashboard — the single self-contained HTML document served at `/`.
 *
 * Rendered with React + React Flow (loaded from esm.sh) into a live fleet
 * graph: machine → project → terminal → agent, with a full-chat-history
 * sidebar. Falls back to a dependency-free nested tree when the CDN can't be
 * reached, so HQ stays fully usable offline.
 *
 * IMPORTANT: this whole file is a single template literal. The embedded
 * browser script therefore uses `React.createElement` + string concatenation
 * and contains NO backticks and NO `${` sequences, which would otherwise be
 * interpreted by the TypeScript template literal. Keep it that way.
 *
 * @module hq-dashboard-html
 */
export const HQ_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>WrongStack HQ</title>
<link rel="stylesheet" href="https://esm.sh/reactflow@11.11.4/dist/style.css" />
<style>
  :root {
    --bright: #f0f6fc;
    --inset: #0d1117;
    --bg: #0a0e14;
    --bg2: #0d1117;
    --panel: #131a24;
    --panel2: #161d28;
    --border: #232c39;
    --border2: #2c3848;
    --text: #d7e0ea;
    --muted: #8b97a7;
    --dim: #5d6b7d;
    --accent: #58a6ff;
    --purple: #a371f7;
    --green: #3fb950;
    --amber: #e3a83a;
    --red: #f85149;
    --cyan: #39d0d8;
  }
  body.light {
    --bright: #1f2328;
    --inset: #eaeef2;
    --bg: #f3f5f8;
    --bg2: #ffffff;
    --panel: #ffffff;
    --panel2: #f6f8fa;
    --border: #d0d7de;
    --border2: #d8dee4;
    --text: #1f2328;
    --muted: #57606a;
    --dim: #8c959f;
    --accent: #0969da;
    --purple: #8250df;
    --green: #1a7f37;
    --amber: #9a6700;
    --red: #cf222e;
    --cyan: #0a7ea4;
  }
  body.light { background: radial-gradient(1200px 600px at 80% -10%, rgba(9,105,218,0.06), transparent), radial-gradient(900px 500px at 0% 110%, rgba(130,80,223,0.05), transparent), var(--bg); }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background: radial-gradient(1200px 600px at 80% -10%, rgba(88,166,255,0.07), transparent), radial-gradient(900px 500px at 0% 110%, rgba(163,113,247,0.06), transparent), var(--bg); color: var(--text); overflow: hidden; }
  #root { height: 100vh; display: flex; flex-direction: column; }
  .hq-top { display: flex; align-items: center; gap: 14px; padding: 12px 20px; border-bottom: 1px solid var(--border); background: rgba(13,17,23,0.7); backdrop-filter: blur(8px); }
  .hq-brand { font-size: 17px; font-weight: 800; letter-spacing: 0.2px; background: linear-gradient(90deg, var(--accent), var(--purple)); -webkit-background-clip: text; background-clip: text; color: transparent; white-space: nowrap; }
  .hq-led { width: 9px; height: 9px; border-radius: 50%; display: inline-block; margin-right: 6px; }
  .hq-led.live { background: var(--green); box-shadow: 0 0 8px var(--green); }
  .hq-led.dead { background: var(--dim); }
  .hq-conn { font-size: 12px; color: var(--muted); white-space: nowrap; }
  .theme-btn { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; cursor: pointer; font-size: 14px; line-height: 1; padding: 6px 9px; color: var(--text); }
  .theme-btn:hover { border-color: var(--accent); }
  .statbar { display: flex; gap: 10px; margin-left: auto; flex-wrap: wrap; }
  .stat { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 7px 13px; min-width: 78px; text-align: center; }
  .stat .num { font-size: 19px; font-weight: 800; line-height: 1.1; color: var(--bright); font-variant-numeric: tabular-nums; }
  .stat .label { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--dim); margin-top: 2px; }
  .stat.green .num { color: var(--green); }
  .stat.amber .num { color: var(--amber); }
  .stat.purple .num { color: var(--purple); }
  .stat.attn { border-color: var(--red); animation: attnpulse 1.6s ease-in-out infinite; }
  .stat.attn .num { color: var(--red); }
  @keyframes attnpulse { 0%,100% { box-shadow: 0 0 0 1px rgba(248,81,73,0.0); } 50% { box-shadow: 0 0 0 3px rgba(248,81,73,0.30); } }
  .hq-tabs { display: flex; gap: 4px; padding: 8px 20px 0; border-bottom: 1px solid var(--border); background: rgba(13,17,23,0.5); }
  .hq-tab { padding: 8px 16px; font-size: 13px; font-weight: 600; color: var(--muted); cursor: pointer; border: 1px solid transparent; border-bottom: none; border-radius: 8px 8px 0 0; }
  .hq-tab.active { color: var(--bright); background: var(--panel); border-color: var(--border); }
  .hq-tab .badge { display: inline-block; margin-left: 6px; background: var(--red); color: #fff; border-radius: 999px; font-size: 10px; padding: 0 6px; }
  .hq-body { flex: 1; min-height: 0; display: flex; }
  .fleetwrap { flex: 1; min-height: 0; display: flex; }
  .graphwrap { flex: 1; min-width: 0; position: relative; }
  .empty-graph { position: absolute; inset: 0; display: grid; place-items: center; color: var(--dim); font-style: italic; text-align: center; padding: 40px; }
  .gtoolbar { position: absolute; top: 12px; left: 12px; z-index: 5; display: flex; gap: 8px; flex-wrap: wrap; background: rgba(13,17,23,0.82); backdrop-filter: blur(8px); border: 1px solid var(--border); border-radius: 10px; padding: 6px; box-shadow: 0 8px 20px rgba(0,0,0,0.4); }
  .tgroup { display: flex; gap: 2px; background: var(--inset); border: 1px solid var(--border); border-radius: 8px; padding: 2px; }
  .tbtn { background: transparent; border: none; color: var(--muted); font-size: 12px; font-weight: 600; padding: 5px 10px; border-radius: 6px; cursor: pointer; white-space: nowrap; }
  .tbtn:hover { color: var(--text); background: var(--panel); }
  .tbtn.on { background: linear-gradient(180deg, var(--accent), #3b82f6); color: #04121f; }
  .glegend { display: flex; gap: 10px; align-items: center; padding: 0 6px; font-size: 10.5px; color: var(--dim); }
  .glegend span { display: inline-flex; align-items: center; gap: 4px; }

  /* Console (primary view): rail + agent grid / chat */
  .console { flex: 1; min-height: 0; display: flex; }
  .rail { flex-shrink: 0; border-right: 1px solid var(--border); background: var(--bg2); display: flex; flex-direction: column; min-width: 220px; overflow: hidden; }
  .rail-head { padding: 11px 14px; font-size: 11px; letter-spacing: 1.2px; color: var(--dim); border-bottom: 1px solid var(--border); font-weight: 700; }
  .rail-resizer { width: 5px; cursor: col-resize; background: transparent; flex-shrink: 0; }
  .rail-resizer:hover { background: var(--accent); }
  .tree { flex: 1; overflow-y: auto; padding: 6px 0; }
  .tree-empty { color: var(--dim); font-style: italic; padding: 18px; font-size: 12px; }
  .trow { display: flex; align-items: center; gap: 6px; padding: 4px 10px; font-size: 12.5px; cursor: pointer; white-space: nowrap; border-left: 2px solid transparent; }
  .trow:hover { background: var(--panel); }
  .trow.sel { background: rgba(88,166,255,0.13); border-left-color: var(--accent); }
  .trow.d0 { padding-left: 8px; font-weight: 700; color: var(--bright); }
  .trow.d1 { padding-left: 24px; }
  .trow.d2 { padding-left: 40px; }
  .trow.d3 { padding-left: 62px; color: var(--muted); }
  .tcaret { width: 12px; font-size: 9px; color: var(--dim); flex-shrink: 0; text-align: center; }
  .tic { flex-shrink: 0; }
  .tlabel { overflow: hidden; text-overflow: ellipsis; }
  .tcount { margin-left: auto; font-size: 10px; color: var(--dim); font-variant-numeric: tabular-nums; }
  .tbranch { font-size: 10px; color: var(--dim); }
  .ttool { font-size: 10px; color: var(--cyan); margin-left: auto; }
  .console-main { flex: 1; min-width: 0; overflow: hidden; display: flex; flex-direction: column; }
  .agrid-wrap { flex: 1; overflow-y: auto; padding: 16px 18px; }
  .agrid-head { font-size: 12px; color: var(--muted); margin-bottom: 12px; }
  .agrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 12px; }
  .acard { background: linear-gradient(180deg, var(--panel2), var(--panel)); border: 1px solid var(--border2); border-left: 3px solid var(--dim); border-radius: 12px; padding: 12px 14px; cursor: pointer; transition: transform 0.12s, box-shadow 0.12s; }
  .acard:hover { transform: translateY(-2px); box-shadow: 0 12px 26px rgba(0,0,0,0.45); }
  .acard.selected { outline: 2px solid var(--accent); outline-offset: 1px; }
  .acard.s-running, .acard.s-streaming { border-left-color: var(--green); box-shadow: 0 0 0 1px rgba(63,185,80,0.18); }
  .acard.s-waiting_user { border-left-color: var(--amber); }
  .acard.s-error { border-left-color: var(--red); }
  .acard-top { display: flex; align-items: center; gap: 8px; }
  .acard-name { font-weight: 700; color: var(--bright); font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .acard-status { margin-left: auto; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.5px; padding: 1px 7px; border-radius: 999px; background: var(--inset); color: var(--muted); }
  .acard-status.running, .acard-status.streaming { color: var(--green); }
  .acard-status.waiting_user { color: var(--amber); }
  .acard-status.error { color: var(--red); }
  .crumb { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; font-size: 10.5px; color: var(--muted); margin-top: 6px; }
  .crumb .sep { color: var(--dim); }
  .acard-tool { margin-top: 8px; font-size: 11px; color: var(--cyan); }
  .acard-stream { margin-top: 8px; font-size: 11px; color: var(--muted); background: var(--inset); border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; font-family: ui-monospace, monospace; max-height: 58px; overflow: hidden; white-space: pre-wrap; word-break: break-word; }
  .acard-meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 9px; font-size: 10.5px; color: var(--dim); font-variant-numeric: tabular-nums; }
  .acard-meta .mut { color: var(--dim); }
  .acard-meta .warm { color: var(--amber); }
  .acard-meta .hot { color: var(--red); }
  .ctxbar { margin-top: 9px; height: 4px; border-radius: 999px; background: var(--inset); overflow: hidden; }
  .ctxbar-fill { height: 100%; background: var(--accent); border-radius: 999px; transition: width 0.3s ease; }
  .ctxbar-fill.warm { background: var(--amber); }
  .ctxbar-fill.hot { background: var(--red); }
  .rail-tree { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .rail-search { display: flex; gap: 5px; padding: 8px 10px; border-bottom: 1px solid var(--border); }
  .rsearch { flex: 1; min-width: 0; background: var(--inset); border: 1px solid var(--border); border-radius: 7px; color: var(--text); font-size: 12px; padding: 5px 9px; }
  .rsearch:focus { outline: none; border-color: var(--accent); }
  .rsearch-btn { background: var(--inset); border: 1px solid var(--border); border-radius: 7px; color: var(--muted); cursor: pointer; font-size: 11px; padding: 0 9px; }
  .rsearch-btn:hover { color: var(--text); border-color: var(--accent); }
  .chatview { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .chat-head { display: flex; align-items: center; gap: 12px; padding: 12px 18px; border-bottom: 1px solid var(--border); flex-wrap: wrap; background: rgba(13,17,23,0.5); }
  .chat-back { background: transparent; border: 1px solid var(--border); color: var(--text); padding: 4px 11px; border-radius: 7px; cursor: pointer; font-size: 12px; }
  .chat-back:hover { background: var(--panel); }
  .chat-agent { display: inline-flex; align-items: center; gap: 6px; font-weight: 700; color: var(--bright); font-size: 13px; }
  .subbadge { font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; padding: 1px 6px; border-radius: 999px; background: rgba(163,113,247,0.18); color: var(--purple); font-weight: 700; }
  .chat-meta { margin-left: auto; font-size: 11px; color: var(--dim); }
  .chat-body { flex: 1; overflow-y: auto; padding: 16px 22px; }
  .bub.live { border-color: rgba(63,185,80,0.5); box-shadow: 0 0 0 1px rgba(63,185,80,0.15); }
  .bub.live .live-dot { margin-left: auto; color: var(--green); font-size: 9px; animation: livepulse 1.4s ease-in-out infinite; }
  @keyframes livepulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
  .caret { display: inline-block; width: 7px; height: 13px; margin-left: 2px; background: var(--green); vertical-align: text-bottom; animation: blink 1s steps(2, start) infinite; }
  @keyframes blink { to { visibility: hidden; } }

  /* React Flow nodes */
  .fnode { width: 210px; border-radius: 12px; padding: 10px 12px; background: linear-gradient(180deg, var(--panel2), var(--panel)); border: 1px solid var(--border2); box-shadow: 0 10px 22px rgba(0,0,0,0.35); cursor: default; transition: transform 0.12s, box-shadow 0.12s; }
  .fnode:hover { transform: translateY(-1px); box-shadow: 0 14px 30px rgba(0,0,0,0.5); }
  .fnode.clickable { cursor: pointer; }
  .fnode.selected { outline: 2px solid var(--accent); outline-offset: 1px; }
  .fnode-title { font-size: 13px; font-weight: 700; color: var(--bright); display: flex; align-items: center; gap: 7px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fnode-ic { font-size: 14px; }
  .fnode-sub { font-size: 10.5px; color: var(--muted); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fnode-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 7px; }
  .fchip { font-size: 9.5px; padding: 1px 6px; border-radius: 999px; background: var(--inset); border: 1px solid var(--border); color: var(--muted); }
  .fnode.machine { border-color: rgba(163,113,247,0.5); }
  .fnode.machine .fnode-ic { color: var(--purple); }
  .fnode.project { border-color: rgba(88,166,255,0.4); }
  .fnode.terminal { border-left: 3px solid var(--dim); }
  .fnode.terminal.k-tui { border-left-color: var(--green); }
  .fnode.terminal.k-repl { border-left-color: var(--amber); }
  .fnode.terminal.k-webui { border-left-color: var(--accent); }
  .fnode.terminal.k-cli { border-left-color: var(--cyan); }
  .fnode.agent { width: 220px; }
  .fnode.agent.s-running, .fnode.agent.s-streaming { border-color: var(--green); box-shadow: 0 0 0 1px rgba(63,185,80,0.25), 0 10px 22px rgba(0,0,0,0.4); animation: pulse 1.8s ease-in-out infinite; }
  .fnode.agent.s-waiting_user { border-color: var(--amber); }
  .fnode.agent.s-error { border-color: var(--red); }
  @keyframes pulse { 0%,100% { box-shadow: 0 0 0 1px rgba(63,185,80,0.25), 0 10px 22px rgba(0,0,0,0.4);} 50% { box-shadow: 0 0 0 4px rgba(63,185,80,0.12), 0 10px 22px rgba(0,0,0,0.4);} }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .dot.running, .dot.streaming { background: var(--green); box-shadow: 0 0 6px var(--green); }
  .dot.waiting_user { background: var(--amber); }
  .dot.error { background: var(--red); }
  .dot.idle { background: var(--dim); }
  .fhandle { opacity: 0; }

  /* Sidebar */
  .sidebar { width: 0; transition: width 0.16s ease; border-left: 1px solid var(--border); background: var(--bg2); display: flex; flex-direction: column; overflow: hidden; }
  .sidebar.open { width: min(560px, 46vw); }
  .side-head { padding: 14px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: flex-start; gap: 10px; }
  .side-head .st { font-size: 14px; font-weight: 700; color: var(--bright); }
  .side-head .ss { font-size: 11px; color: var(--muted); margin-top: 3px; }
  .side-close { margin-left: auto; cursor: pointer; color: var(--muted); border: 1px solid var(--border); border-radius: 6px; padding: 2px 9px; font-size: 12px; background: transparent; }
  .side-close:hover { background: var(--panel); color: var(--text); }
  .side-body { flex: 1; overflow-y: auto; padding: 14px 16px; }
  .side-empty { margin: auto; color: var(--dim); font-style: italic; text-align: center; padding: 40px 24px; }
  .bub { margin-bottom: 12px; border-radius: 10px; padding: 9px 12px; font-size: 12.5px; line-height: 1.5; border: 1px solid var(--border); }
  .bub .bub-meta { font-size: 10px; color: var(--dim); margin-bottom: 4px; display: flex; gap: 8px; align-items: center; text-transform: uppercase; letter-spacing: 0.5px; }
  .bub .bub-role { font-weight: 700; }
  .bub.user { background: rgba(88,166,255,0.08); border-color: rgba(88,166,255,0.25); }
  .bub.user .bub-role { color: var(--accent); }
  .bub.assistant { background: var(--panel); }
  .bub.assistant .bub-role { color: var(--purple); }
  .bub.tool { background: rgba(57,208,216,0.05); border-color: rgba(57,208,216,0.18); }
  .bub.tool .bub-role { color: var(--cyan); }
  .bub.error { background: rgba(248,81,73,0.08); border-color: rgba(248,81,73,0.3); }
  .bub.error .bub-role { color: var(--red); }
  .bub.system { background: transparent; border-style: dashed; color: var(--muted); }
  .bub pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11.5px; max-height: 320px; overflow: auto; }
  .bub .txt { white-space: pre-wrap; word-break: break-word; }
  .bub-sublabel { font-size: 9px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--dim); margin: 4px 0 2px; }
  .bub-fold { margin-top: 6px; }
  .bub-fold > summary { cursor: pointer; list-style: none; font-size: 11px; color: var(--cyan); padding: 4px 9px; background: var(--inset); border: 1px solid var(--border); border-radius: 6px; user-select: none; display: flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; }
  .bub-fold > summary::-webkit-details-marker { display: none; }
  .bub-fold > summary::before { content: '▸'; color: var(--dim); font-size: 9px; }
  .bub-fold[open] > summary::before { content: '▾'; }
  .bub-fold > summary:hover { border-color: var(--accent); color: var(--text); }
  .bub-fold[open] > summary { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
  .bub-fold > pre { margin: 0; border: 1px solid var(--border); border-top: none; border-radius: 0 0 6px 6px; padding: 8px 9px; background: var(--bg2); }
  .bub-argpre { color: var(--cyan); }
  .loading { color: var(--muted); font-style: italic; padding: 20px 0; }

  /* Mailbox tab (demoted) */
  .mbwrap { flex: 1; overflow-y: auto; padding: 18px 22px; }
  .mb-sec { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }
  .mb-sec h3 { margin: 0 0 10px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--muted); }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th { text-align: left; color: var(--dim); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.5px; padding: 6px 8px; border-bottom: 1px solid var(--border); }
  td { padding: 8px; border-bottom: 1px solid #1b2330; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 10.5px; background: var(--inset); border: 1px solid var(--border); color: var(--muted); }
  .empty { color: var(--dim); font-style: italic; }
  /* pointer-events:none is critical — if React mount is ever delayed (CDN
     hang / blocked esm.sh), this full-viewport overlay must NEVER intercept
     clicks meant for the dashboard rendered behind it. */
  #boot { position: fixed; inset: 0; display: grid; place-items: center; color: var(--muted); font-size: 14px; pointer-events: none; }
</style>
</head>
<body>
<div id="boot">Loading WrongStack HQ…</div>
<div id="root"></div>
<script type="module">
/* shared data store (framework-agnostic) */
var Store = {
  snapshot: null, connected: false, tab: 'console', theme: 'dark',
  selected: null, transcripts: {}, agentMsgs: {}, listeners: new Set(),
  emit: function(){ this.listeners.forEach(function(l){ try { l(); } catch(e){} }); },
  subscribe: function(l){ this.listeners.add(l); var s=this; return function(){ s.listeners.delete(l); }; },
  set: function(p){ Object.assign(this, p); this.emit(); }
};

function tokenStr(){ try { return new URL(location.href).searchParams.get('token') || ''; } catch(e){ return ''; } }
function withTok(p){ var u = new URL(p, location.href); var t = tokenStr(); if (t) u.searchParams.set('token', t); return u.pathname + u.search; }
function shortId(s){ if(!s) return '—'; s=String(s); var leaf=s.split('/').pop()||s; return leaf.length>16 ? leaf.slice(0,12)+'…'+leaf.slice(-5) : leaf; }
function fmtTime(iso){ if(!iso) return ''; var d=new Date(iso); return isNaN(d.getTime())?'':d.toLocaleTimeString(); }
function fmtAgo(iso){ if(!iso) return ''; var d=new Date(iso).getTime(); if(isNaN(d)) return ''; var s=Math.max(0,Math.floor((Date.now()-d)/1000)); if(s<5) return 'now'; if(s<60) return s+'s ago'; var m=Math.floor(s/60); if(m<60) return m+'m ago'; var hh=Math.floor(m/60); if(hh<24) return hh+'h ago'; return Math.floor(hh/24)+'d ago'; }
function fmtElapsed(iso){ if(!iso) return ''; var d=new Date(iso).getTime(); if(isNaN(d)) return ''; var s=Math.max(0,Math.floor((Date.now()-d)/1000)); if(s<60) return s+'s'; var m=Math.floor(s/60); if(m<60) return m+'m '+(s%60)+'s'; var h=Math.floor(m/60); if(h<24) return h+'h '+(m%60)+'m'; return Math.floor(h/24)+'d '+(h%24)+'h'; }
function fmtNum(n){ n=Number(n)||0; if(n>=1e6) return (n/1e6).toFixed(1)+'M'; if(n>=1e3) return (n/1e3).toFixed(1)+'k'; return String(n); }
function esc(s){ if(s==null) return ''; return String(s); }

function loadTranscript(sessionId){
  if(!sessionId) return;
  var cur = Store.transcripts[sessionId];
  if(cur && cur.loading) return;
  Store.transcripts[sessionId] = { entries: (cur&&cur.entries)||[], loading: true };
  Store.emit();
  fetch(withTok('/api/sessions/'+encodeURIComponent(sessionId)+'/events?full=1'))
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(d){
      if(!d){ Store.transcripts[sessionId] = { entries: [], loading: false, error: true }; Store.emit(); return; }
      Store.transcripts[sessionId] = { entries: d.entries||[], total: d.total, source: d.source, loading: false };
      Store.emit();
    })
    .catch(function(){ Store.transcripts[sessionId] = { entries: [], loading: false, error: true }; Store.emit(); });
}

function applyThemeClass(t){ try { document.body.className = (t==='light'?'light':''); } catch(e){} }
function initTheme(){ var t='dark'; try { t = localStorage.getItem('hq.theme') || 'dark'; } catch(e){} Store.theme = t; applyThemeClass(t); }
function toggleTheme(){ var t = (Store.theme==='light'?'dark':'light'); Store.theme = t; applyThemeClass(t); try { localStorage.setItem('hq.theme', t); } catch(e){} Store.emit(); }

function loadAgentMessages(agentId){
  if(!agentId) return;
  fetch(withTok('/api/agents/'+encodeURIComponent(agentId)+'/messages?full=1'))
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(d){ if(d && Array.isArray(d.entries)){ Store.agentMsgs[agentId] = d.entries; Store.emit(); } })
    .catch(function(){});
}

function selectSession(sessionId, agentId){
  Store.selected = { sessionId: sessionId, agentId: agentId || null };
  if(agentId && agentId !== 'leader'){ loadAgentMessages(agentId); }
  else { loadTranscript(sessionId); }
  Store.emit();
}

var ws = null;
var hqEverConnected = false;
function connectWs(){
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  try { ws = new WebSocket(proto + '//' + location.host + withTok('/ws/browser')); } catch(e){ setTimeout(connectWs, 2000); return; }
  ws.onopen = function(){
    var reconnect = hqEverConnected;
    hqEverConnected = true;
    Store.set({ connected: true });
    // After an HQ restart its in-memory transcript rings are empty; re-pull the
    // open selection so the chat view recovers instead of showing stale history.
    if(reconnect){
      var sel = Store.selected;
      if(sel && sel.sessionId){
        if(sel.agentId && sel.agentId !== 'leader') loadAgentMessages(sel.agentId);
        else loadTranscript(sel.sessionId);
      }
    }
  };
  ws.onmessage = function(ev){
    var msg; try { msg = JSON.parse(ev.data); } catch(e){ return; }
    if(msg.type === 'hq.snapshot'){ Store.set({ snapshot: msg.snapshot, connected: true }); }
    else if(msg.type === 'hq.event'){ handleEvent(msg.event); }
  };
  ws.onclose = function(){ Store.set({ connected: false }); setTimeout(connectWs, 2000); };
  ws.onerror = function(){ try { ws.close(); } catch(e){} };
}

function agentMsgRole(kind){ return kind==='tool_use'?'tool' : kind==='error'?'error' : kind==='status'?'system' : 'assistant'; }

// Append streamed entries into a transcript cache, merging a tool RESULT
// (toolUseId, no args) into the matching args entry so a tool's call + result
// stay in ONE box. Mutates 'cache' in place.
function appendEntries(cache, news){
  for(var k=0;k<news.length;k++){
    var e = news[k];
    var isResult = (e.role==='tool'||e.role==='error') && e.toolUseId!=null && e.toolInput===undefined;
    if(isResult){
      var merged = false;
      for(var i=cache.length-1; i>=0 && i>cache.length-400; i--){
        var c = cache[i];
        if(c.toolUseId===e.toolUseId && c.toolInput!==undefined){
          c.text = e.text || ''; if(e.durationMs!=null) c.durationMs = e.durationMs;
          if(e.isError){ c.role='error'; c.isError=true; }
          merged = true; break;
        }
      }
      if(merged) continue;
    }
    cache.push(e);
  }
  if(cache.length > 6000) cache.splice(0, cache.length-6000);
}

function handleEvent(ev){
  if(!ev) return;
  if(ev.type === 'session.transcript' && ev.payload && ev.payload.sessionId){
    var sid = ev.payload.sessionId;
    var c = Store.transcripts[sid];
    if(c && !c.loading && Array.isArray(ev.payload.entries)){
      appendEntries(c.entries, ev.payload.entries);
      Store.emit();
    }
    return;
  }
  // Subagent (shadow) conversation — buffered per subagentId, which matches the
  // agent card id. Lets clicking a subagent show ITS own live history.
  if(ev.type === 'agent.message' && ev.payload && ev.payload.subagentId){
    var p = ev.payload;
    var arr = Store.agentMsgs[p.subagentId] || (Store.agentMsgs[p.subagentId] = []);
    arr.push({ ts: p.ts, role: agentMsgRole(p.kind), text: p.content || '', tool: p.toolName });
    if(arr.length > 4000) Store.agentMsgs[p.subagentId] = arr.slice(-4000);
    Store.emit();
    return;
  }
  if(ev.type === 'agent.status' && ev.payload && ev.payload.subagentId){
    var sp = ev.payload;
    var a2 = Store.agentMsgs[sp.subagentId] || (Store.agentMsgs[sp.subagentId] = []);
    a2.push({ ts: sp.ts, role: 'system', text: '— ' + (sp.status||'') + (sp.summary ? (': '+sp.summary) : (sp.task ? (': '+sp.task) : '')) });
    Store.emit();
    return;
  }
}

// Group by physical machine. Prefer hostname so the SAME computer collapses to
// ONE node even when clients report different per-process machineIds (e.g. an
// older build that hashed hostname:pid).
function machineKey(hostname, machineId){
  var hn = hostname && String(hostname).trim();
  return hn ? ('host:' + hn.toLowerCase()) : ('mid:' + (machineId || 'local'));
}

/* fleet tree (shared) */
function buildTree(snap){
  var sessions = (snap && snap.liveSessions) || [];
  var machines = (snap && snap.machines) || [];
  var clients = (snap && snap.clients) || [];
  var projects = (snap && snap.projects) || [];
  var mMap = {};
  var pMap = {};
  projects.forEach(function(p){ if(p && p.projectId) pMap[p.projectId] = p; });
  function ensure(hostname, machineId){
    var key = machineKey(hostname, machineId);
    if(!mMap[key]) mMap[key] = { key: key, machineId: machineId || key, hostname: (hostname && String(hostname).trim()) || machineId || 'machine', projects: {}, sessionCount: 0, agentCount: 0 };
    return mMap[key];
  }
  function ensureProject(mm, pid, seed){
    if(!mm.projects[pid]) mm.projects[pid] = {
      projectId: pid,
      projectName: (seed && (seed.projectName || seed.projectId)) || pid,
      gitBranch: seed && seed.gitBranch,
      terminals: []
    };
    return mm.projects[pid];
  }
  sessions.forEach(function(s){
    var mm = ensure(s.hostname, s.machineId);
    mm.sessionCount++;
    mm.agentCount += (s.agents ? s.agents.length : 0);
    var pid = s.projectId || 'unknown';
    ensureProject(mm, pid, s).terminals.push(s);
  });
  clients.forEach(function(c){
    var alreadyRepresented = sessions.some(function(s){
      return s.projectId === c.projectId &&
        String(s.clientKind||'') === String(c.kind||'') &&
        (!c.pid || !s.pid || c.pid === s.pid);
    });
    if(alreadyRepresented) return;
    var project = pMap[c.projectId] || {};
    var mm = ensure(c.hostname, c.machineId);
    mm.sessionCount++;
    var terminal = {
      sessionId: 'client:' + (c.clientId || c.projectId || 'unknown'),
      clientKind: c.kind || 'cli',
      machineId: c.machineId,
      hostname: c.hostname,
      projectId: c.projectId || 'unknown',
      projectName: project.projectName || c.projectId || 'unknown',
      projectRoot: project.projectRootDisplay || '',
      gitBranch: project.gitBranch,
      status: c.connected ? 'active' : 'stale',
      startedAt: c.connectedAt,
      lastActivityAt: c.lastSeenAt,
      pid: c.pid,
      agentCount: 0,
      agents: [],
      synthetic: true
    };
    ensureProject(mm, terminal.projectId, terminal).terminals.push(terminal);
  });
  // Include machines that have a connected client but no live session yet.
  machines.forEach(function(m){ ensure(m.hostname, m.machineId); });
  return Object.keys(mMap).sort(function(a,b){ return (mMap[a].hostname||'').toLowerCase().localeCompare((mMap[b].hostname||'').toLowerCase()); }).map(function(k){
    var mm = mMap[k];
    mm.projectList = Object.keys(mm.projects).sort().map(function(p){ return mm.projects[p]; });
    return mm;
  });
}

// Build the LOGICAL graph (nodes carry data + ids only — positions are
// assigned by the dagre auto-layout). Tree shape:
//   groupBy 'machine': PC -> project -> terminal -> agent
//   groupBy 'project':       project -> terminal -> agent  (PC folded to a chip)
function buildGraph(snap, groupBy){
  var tree = buildTree(snap);
  var nodes = [], edges = [];
  var sel = Store.selected;
  var showMachine = groupBy !== 'project';

  tree.forEach(function(machine){
    var mNodeId = 'machine:' + machine.machineId;
    if(showMachine){ nodes.push(machineNode(mNodeId, machine)); }
    machine.projectList.forEach(function(project){
      // In project-mode the project is the root; dedupe across (the single) PC
      // by projectId so the same project is ONE node.
      var pid = showMachine ? ('project:' + machine.machineId + ':' + project.projectId)
                            : ('project:' + project.projectId);
      if(!nodes.find(function(n){ return n.id === pid; })){
        nodes.push(projNode(pid, project, showMachine ? null : machine));
      }
      if(showMachine){ edges.push(mkEdge(mNodeId, pid, true)); }
      project.terminals.forEach(function(term){
        var tid = 'terminal:' + term.sessionId;
        nodes.push(termNode(tid, term, sel));
        edges.push(mkEdge(pid, tid, term.status === 'active'));
        (term.agents || []).forEach(function(ag){
          var aid = 'agent:' + term.sessionId + ':' + ag.id;
          nodes.push(agentNode(aid, ag, term, sel));
          edges.push(mkEdge(tid, aid, ag.status === 'running' || ag.status === 'streaming'));
        });
      });
    });
  });
  return { nodes: nodes, edges: edges };
}

function mkEdge(from, to, active){
  return { id: from+'->'+to, source: from, target: to, animated: !!active, type: 'smoothstep',
    style: { stroke: active ? '#3fb950' : '#2c3848', strokeWidth: active ? 2 : 1.4 } };
}
function fleetNode(id, kind, data){
  return { id: id, type: 'fleet', position: { x: 0, y: 0 }, data: Object.assign({ kind: kind }, data) };
}
function machineNode(id, m){
  return fleetNode(id, 'machine', {
    icon: '🖥️', label: m.hostname || shortId(m.machineId), sub: 'this machine',
    chips: [ (Object.keys(m.projects).length)+' projects', (m.sessionCount||0)+' terminals', (m.agentCount||0)+' agents' ]
  });
}
function projNode(id, p, machine){
  var chips = [ p.terminals.length+' terminals' ];
  if(machine && machine.hostname) chips.unshift('🖥️ '+machine.hostname);
  return fleetNode(id, 'project', {
    icon: '📁', label: p.projectName, sub: p.gitBranch ? ('⎇ '+p.gitBranch) : shortId(p.projectId), chips: chips
  });
}
function termNode(id, t, sel){
  var synthetic = !!t.synthetic;
  return fleetNode(id, 'terminal', {
    termKind: t.clientKind, status: t.status, icon: kindIcon(t.clientKind),
    label: (t.clientKind||'cli').toUpperCase() + ' · ' + shortId(t.sessionId),
    sub: t.status + (t.pid ? (' · pid '+t.pid) : '') + (synthetic ? ' · waiting for session telemetry' : ''),
    chips: synthetic ? ['connected', '0 agents'] : [ (t.agentCount||(t.agents?t.agents.length:0))+' agents' ],
    clickable: !synthetic, selected: !synthetic && !!(sel && sel.sessionId === t.sessionId && !sel.agentId),
    onClick: synthetic ? undefined : function(){ selectSession(t.sessionId); }
  });
}
function agentNode(id, a, t, sel){
  var chips = [];
  var ctx = typeof a.ctxPct==='number' ? Math.max(0, Math.min(100, a.ctxPct)) : null;
  var active = a.status==='running'||a.status==='streaming'||a.status==='waiting_user';
  if(a.currentTool) chips.push('⚙ '+a.currentTool);
  if(a.model) chips.push(a.model);
  if(ctx!=null) chips.push('ctx '+ctx+'%');
  if(a.startedAt) chips.push((active?'run ':'last ')+fmtElapsed(a.startedAt));
  chips.push((a.iterations||0)+' it');
  if(typeof a.costUsd === 'number' && a.costUsd > 0) chips.push('$'+a.costUsd.toFixed(2));
  return fleetNode(id, 'agent', {
    status: a.status, label: a.name || a.id,
    sub: a.status + (a.partialText ? (' · '+String(a.partialText).slice(0,44)) : ''),
    chips: chips, clickable: true,
    selected: !!(sel && sel.sessionId === t.sessionId && sel.agentId === a.id),
    onClick: function(){ selectSession(t.sessionId, a.id); }
  });
}
function kindIcon(k){ return k==='tui'?'🖳':k==='webui'?'🌐':k==='repl'?'⌨️':'▷'; }
function miniColor(n){ var k=n.data&&n.data.kind; return k==='machine'?'#a371f7':k==='project'?'#58a6ff':k==='agent'?'#3fb950':'#39d0d8'; }

// Node footprints (width × height) for dagre sizing.
var NODE_SIZE = { machine: [220, 78], project: [220, 78], terminal: [220, 70], agent: [230, 92] };
// Auto-layout the logical nodes into a clean tree using dagre.
function layoutTree(nodes, edges, dir, dagre){
  if(!dagre || !nodes.length) return nodes;
  var g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: dir || 'LR', nodesep: 26, ranksep: 90, marginx: 30, marginy: 30, ranker: 'tight-tree' });
  g.setDefaultEdgeLabel(function(){ return {}; });
  nodes.forEach(function(n){ var s = NODE_SIZE[n.data.kind] || [210, 64]; g.setNode(n.id, { width: s[0], height: s[1] }); });
  edges.forEach(function(e){ if(g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target); });
  dagre.layout(g);
  return nodes.map(function(n){
    var p = g.node(n.id); if(!p) return n;
    return Object.assign({}, n, { position: { x: p.x - p.width/2, y: p.y - p.height/2 } });
  });
}

/* React app (preferred) */
async function boot(){
  var React, createRoot, RF, Background, Controls, MiniMap, Handle, Position, useNodesState, useEdgesState, dagre;
  // Race every CDN import against a timeout. A browser-side hang (ad blocker /
  // corporate proxy that stalls esm.sh without rejecting) would otherwise leave
  // the page on "Loading…" forever; on timeout we reject → fall back to the
  // dependency-free offline view instead of an eternal spinner.
  function imp(url){ return Promise.race([ import(url), new Promise(function(_, rej){ setTimeout(function(){ rej(new Error('cdn-timeout: ' + url)); }, 9000); }) ]); }
  try {
    React = (await imp('https://esm.sh/react@18.3.1')).default;
    createRoot = (await imp('https://esm.sh/react-dom@18.3.1/client')).createRoot;
    var rf = await imp('https://esm.sh/reactflow@11.11.4?deps=react@18.3.1,react-dom@18.3.1');
    RF = rf.default; Background = rf.Background; Controls = rf.Controls; MiniMap = rf.MiniMap; Handle = rf.Handle; Position = rf.Position;
    useNodesState = rf.useNodesState; useEdgesState = rf.useEdgesState;
    var dmod = await imp('https://esm.sh/dagre@0.8.5');
    dagre = dmod && dmod.default && dmod.default.graphlib ? dmod.default : dmod;
    if(!React || !createRoot || !RF){ throw new Error('cdn-incomplete'); }
  } catch(e){
    try { console.error('HQ: CDN load failed, using offline fallback —', e && e.message); } catch(_e){}
    renderFallback();
    connectWs();
    primeSnapshot();
    return;
  }
  var h = React.createElement;
  var bootEl = document.getElementById('boot'); if(bootEl) bootEl.remove();
  initTheme();

  function FleetNode(props){
    var d = props.data;
    return h('div', { className: 'fnode ' + d.kind + (d.termKind ? ' k-'+d.termKind : '') + (d.status ? ' s-'+d.status : '') + (d.clickable ? ' clickable' : '') + (d.selected ? ' selected' : ''), onClick: d.onClick || null },
      h(Handle, { type: 'target', position: Position.Left, className: 'fhandle' }),
      h('div', { className: 'fnode-title' },
        d.kind==='agent' ? h('span', { className: 'dot ' + (d.status||'idle') }) : (d.icon ? h('span', { className: 'fnode-ic' }, d.icon) : null),
        h('span', { style: { overflow:'hidden', textOverflow:'ellipsis' } }, d.label)
      ),
      d.sub ? h('div', { className: 'fnode-sub' }, d.sub) : null,
      d.chips && d.chips.length ? h('div', { className: 'fnode-chips' }, d.chips.map(function(c,i){ return h('span', { key: i, className: 'fchip' }, c); })) : null,
      h(Handle, { type: 'source', position: Position.Right, className: 'fhandle' })
    );
  }
  var nodeTypes = { fleet: FleetNode };

  function useStore(){
    var box = React.useState(0); var set = box[1];
    React.useEffect(function(){ return Store.subscribe(function(){ set(function(x){ return x+1; }); }); }, []);
    return Store;
  }

  function Stat(p){ return h('div', { className: 'stat ' + (p.accent||'') }, h('div', { className: 'num' }, p.num), h('div', { className: 'label' }, p.label)); }

  function TopBar(p){
    var t = (p.snap && p.snap.totals) || {};
    var tok = 0, busy = 0, attention = 0;
    (p.snap && p.snap.liveSessions || []).forEach(function(s){
      (s.agents||[]).forEach(function(a){
        tok += (a.tokensIn||0)+(a.tokensOut||0);
        if(a.status==='running'||a.status==='streaming'||a.status==='waiting_user') busy++;
        if(a.status==='error'||a.status==='waiting_user') attention++;
      });
    });
    return h('div', { className: 'hq-top' },
      h('div', { className: 'hq-brand' }, '📋 WrongStack HQ'),
      h('div', { className: 'hq-conn' }, h('span', { className: 'hq-led ' + (p.connected?'live':'dead') }), p.connected ? 'Live' : 'Reconnecting…'),
      h('button', { className: 'theme-btn', title: 'Toggle light / dark', onClick: toggleTheme }, Store.theme==='light' ? '🌙' : '☀️'),
      h('div', { className: 'statbar' },
        h(Stat, { num: t.activeMachines||0, label: 'Machines', accent: 'purple' }),
        h(Stat, { num: t.activeSessions||0, label: 'Terminals' }),
        h(Stat, { num: (busy?busy+'/':'')+(t.activeAgents||0), label: 'Agents', accent: 'green' }),
        h(Stat, { num: t.activeProjects||0, label: 'Projects' }),
        h(Stat, { num: fmtNum(tok), label: 'Tokens' }),
        h(Stat, { num: '$'+(t.totalCostUsd||0).toFixed(2), label: 'Cost' }),
        h(Stat, { num: t.unreadMailboxMessages||0, label: 'Unread', accent: 'amber' }),
        attention ? h(Stat, { num: '⚠ '+attention, label: 'Attention', accent: 'attn' }) : null
      )
    );
  }

  function fold(key, summary, content, preClass){
    return h('details', { key: key, className: 'bub-fold' },
      h('summary', null, summary),
      h('pre', { className: preClass || null }, content)
    );
  }
  function Bubble(p){
    var e = p.e;
    var isToolish = e.role === 'tool' || e.role === 'error';
    var bodyEls = [];
    if(isToolish){
      // Tool args + result are collapsed by default — click to expand.
      if(e.toolInput){ bodyEls.push(fold('a', '→ args · ' + e.toolInput.length + ' chars', e.toolInput, 'bub-argpre')); }
      if(e.text){ bodyEls.push(fold('o', (e.isError?'⚠ error':'← result') + ' · ' + e.text.length + ' chars' + (e.durationMs!=null?(' · '+e.durationMs+'ms'):''), e.text)); }
      if(!e.toolInput && !e.text){ bodyEls.push(h('div', { key:'n', className:'bub-sublabel' }, '(no output)')); }
    } else {
      bodyEls.push(h('div', { key:'t', className: 'txt' }, e.text || ''));
    }
    return h('div', { className: 'bub ' + e.role },
      h('div', { className: 'bub-meta' },
        h('span', { className: 'bub-role' }, e.role + (e.tool ? (' · '+e.tool) : '')),
        h('span', null, fmtTime(e.ts))
      ),
      bodyEls
    );
  }

  function Sidebar(p){
    var sel = Store.selected;
    var bodyRef = React.useRef(null);
    var tc = sel ? Store.transcripts[sel.sessionId] : null;
    var entries = tc ? tc.entries : [];
    React.useEffect(function(){
      var el = bodyRef.current; if(!el) return;
      el.scrollTop = el.scrollHeight;
    }, [entries.length, sel && sel.sessionId]);
    if(!sel) return h('div', { className: 'sidebar' });
    var session = (p.snap && p.snap.liveSessions || []).filter(function(s){ return s.sessionId === sel.sessionId; })[0];
    return h('div', { className: 'sidebar open' },
      h('div', { className: 'side-head' },
        h('div', null,
          h('div', { className: 'st' }, session ? ((session.clientKind||'cli').toUpperCase() + ' · ' + (session.projectName||'')) : 'Session'),
          h('div', { className: 'ss' }, shortId(sel.sessionId) + (sel.agentId ? (' · agent '+sel.agentId) : '') + (tc && tc.source ? (' · '+tc.source) : '') + (tc && tc.total!=null ? (' · '+tc.total+' turns') : ''))
        ),
        h('button', { className: 'side-close', onClick: function(){ Store.selected = null; Store.emit(); } }, '✕')
      ),
      h('div', { className: 'side-body', ref: bodyRef },
        (tc && tc.loading && entries.length===0) ? h('div', { className: 'loading' }, 'Loading full chat history…') :
        (entries.length===0 ? h('div', { className: 'side-empty' }, (tc&&tc.error)?'Could not load history.':'No transcript yet for this terminal.') :
          entries.map(function(e, i){ return h(Bubble, { key: i, e: e }); }))
      )
    );
  }

  function lsGet(k, def){ try { var v = localStorage.getItem(k); return v == null ? def : v; } catch(e){ return def; } }
  function lsSet(k, v){ try { localStorage.setItem(k, v); } catch(e){} }

  function ToolBtn(p){
    return h('button', { className: 'tbtn' + (p.active ? ' on' : ''), title: p.title, onClick: p.onClick }, p.label);
  }

  function FleetView(p){
    var nsState = useNodesState([]); var nodes = nsState[0], setNodes = nsState[1], onNodesChange = nsState[2];
    var esState = useEdgesState([]); var edges = esState[0], setEdges = esState[1];
    var dirBox = React.useState(lsGet('hq.dir', 'LR')); var dir = dirBox[0], setDir = dirBox[1];
    var grpBox = React.useState(lsGet('hq.group', 'machine')); var groupBy = grpBox[0], setGroupBy = grpBox[1];
    var rfRef = React.useRef(null);
    var movedRef = React.useRef({}); // node ids the user dragged — keep their positions across data updates

    function applyLayout(srcNodes, srcEdges){
      var laid = layoutTree(srcNodes, srcEdges, dir, dagre);
      setNodes(laid);
      movedRef.current = {};
      setTimeout(function(){ if(rfRef.current) rfRef.current.fitView({ padding: 0.18, duration: 400 }); }, 30);
    }

    // Reconcile snapshot → graph. Preserve positions on data-only updates and
    // for nodes the user dragged; auto-arrange only when the topology changes.
    React.useEffect(function(){
      var g = buildGraph(p.snap, groupBy);
      setEdges(g.edges);
      setNodes(function(prev){
        var prevById = {}; prev.forEach(function(n){ prevById[n.id] = n; });
        var nextIds = {};
        var merged = g.nodes.map(function(ln){
          nextIds[ln.id] = 1;
          var ex = prevById[ln.id];
          if(ex){ return Object.assign({}, ex, { data: ln.data }); } // keep position
          return ln; // new node (position assigned by layout below)
        });
        var added = merged.some(function(n){ return !prevById[n.id]; });
        var removed = prev.some(function(n){ return !nextIds[n.id]; });
        if(prev.length === 0 || added || removed){
          return layoutTree(merged, g.edges, dir, dagre);
        }
        return merged;
      });
    }, [p.snap, groupBy]);

    // Re-layout + persist when the direction changes.
    React.useEffect(function(){
      lsSet('hq.dir', dir);
      setNodes(function(prev){ return prev.length ? layoutTree(prev, edges, dir, dagre) : prev; });
      setTimeout(function(){ if(rfRef.current) rfRef.current.fitView({ padding: 0.18, duration: 400 }); }, 30);
    }, [dir]);

    React.useEffect(function(){ lsSet('hq.group', groupBy); }, [groupBy]);

    var toolbar = h('div', { className: 'gtoolbar' },
      h('div', { className: 'tgroup' },
        h(ToolBtn, { label: '⬌ LR', title: 'Left → right tree', active: dir==='LR', onClick: function(){ setDir('LR'); } }),
        h(ToolBtn, { label: '⬍ TB', title: 'Top → bottom tree', active: dir==='TB', onClick: function(){ setDir('TB'); } })
      ),
      h('div', { className: 'tgroup' },
        h(ToolBtn, { label: '🖥️ Machine', title: 'Group under the machine', active: groupBy==='machine', onClick: function(){ setGroupBy('machine'); } }),
        h(ToolBtn, { label: '📁 Project', title: 'Group by project', active: groupBy==='project', onClick: function(){ setGroupBy('project'); } })
      ),
      h('div', { className: 'tgroup' },
        h(ToolBtn, { label: '✨ Auto-arrange', title: 'Re-arrange the tree', onClick: function(){ applyLayout(nodes, edges); } }),
        h(ToolBtn, { label: '⊡ Fit', title: 'Fit to screen', onClick: function(){ if(rfRef.current) rfRef.current.fitView({ padding: 0.18, duration: 400 }); } })
      ),
      h('div', { className: 'glegend' },
        h('span', null, h('span', { className: 'dot running' }), 'active'),
        h('span', null, h('span', { className: 'dot waiting_user' }), 'waiting'),
        h('span', null, h('span', { className: 'dot error' }), 'error'),
        h('span', null, h('span', { className: 'dot idle' }), 'idle')
      )
    );

    return h('div', { className: 'fleetwrap' },
      h('div', { className: 'graphwrap' },
        nodes.length ? h(React.Fragment, null,
          toolbar,
          h(RF, {
            nodes: nodes, edges: edges, nodeTypes: nodeTypes,
            onNodesChange: onNodesChange,
            onInit: function(inst){ rfRef.current = inst; setTimeout(function(){ inst.fitView({ padding: 0.18 }); }, 40); },
            onNodeDragStop: function(_e, node){ movedRef.current[node.id] = 1; },
            fitView: true, minZoom: 0.1, maxZoom: 1.8,
            nodesDraggable: true, nodesConnectable: false, elementsSelectable: true,
            proOptions: { hideAttribution: true }
          },
            h(Background, { gap: 24, size: 1, color: '#1b2330' }),
            h(MiniMap, { pannable: true, zoomable: true, nodeColor: miniColor, maskColor: 'rgba(5,8,12,0.5)', style: { background: 'var(--inset)', border: '1px solid var(--border)' } }),
            h(Controls, { showInteractive: false })
          )
        ) : h('div', { className: 'empty-graph' }, 'No live terminals yet. Open a WrongStack TUI / REPL / WebUI with HQ running and it will appear here automatically.')
      ),
      h(Sidebar, { snap: p.snap })
    );
  }

  function MailboxView(p){
    var mbs = (p.snap && p.snap.mailboxes) || [];
    return h('div', { className: 'mbwrap' },
      h('div', { className: 'mb-sec' },
        h('h3', null, '📬 Mailboxes'),
        h('table', null,
          h('thead', null, h('tr', null,
            h('th', null, 'Mailbox'), h('th', null, 'Scope'), h('th', { className:'num' }, 'Msgs'),
            h('th', { className:'num' }, 'Unread'), h('th', { className:'num' }, 'High'), h('th', { className:'num' }, 'Agents'))),
          h('tbody', null, mbs.length ? mbs.map(function(m, i){
            return h('tr', { key: i },
              h('td', null, h('code', null, shortId(m.mailboxId))),
              h('td', null, h('span', { className: 'pill' }, m.scope)),
              h('td', { className:'num' }, m.messageCount),
              h('td', { className:'num' }, m.unreadCount),
              h('td', { className:'num' }, m.highPriorityCount),
              h('td', { className:'num' }, m.onlineAgentCount));
          }) : h('tr', null, h('td', { colSpan: 6, className: 'empty' }, 'No mailbox activity.')))
        )
      )
    );
  }

  // ── Console (primary): live fleet tree + agent cards + live chat ──────────
  function statusRank(st){ return (st==='running'||st==='streaming')?0 : st==='waiting_user'?1 : st==='error'?2 : 3; }

  function flattenAgents(snap){
    var out = [];
    (snap && snap.liveSessions || []).forEach(function(s){
      (s.agents||[]).forEach(function(a){ out.push({ a: a, s: s }); });
    });
    out.sort(function(x,y){ var r = statusRank(x.a.status)-statusRank(y.a.status); if(r!==0) return r; return (x.s.projectName||'').localeCompare(y.s.projectName||''); });
    return out;
  }

  function Crumb(p){
    var s = p.s;
    return h('div', { className: 'crumb' },
      h('span', null, '🖥️ ' + (s.hostname || shortId(s.machineId))),
      h('span', { className: 'sep' }, '›'),
      h('span', null, '📁 ' + (s.projectName||'')),
      h('span', { className: 'sep' }, '›'),
      h('span', null, kindIcon(s.clientKind) + ' ' + (s.clientKind||'cli').toUpperCase() + ' ' + shortId(s.sessionId))
    );
  }

  function AgentCard(p){
    var a = p.a, s = p.s, sel = Store.selected;
    var seld = sel && sel.sessionId===s.sessionId && sel.agentId===a.id;
    var meta = [];
    var active = a.status==='running'||a.status==='streaming'||a.status==='waiting_user';
    var ctx = typeof a.ctxPct==='number' ? Math.max(0, Math.min(100, a.ctxPct)) : null;
    if(a.model) meta.push(h('span', { key:'md', className:'mut' }, 'model '+a.model));
    if(ctx!=null) meta.push(h('span', { key:'cx', className: ctx>=85?'hot':ctx>=60?'warm':'mut' }, 'ctx '+ctx+'%'));
    if(a.startedAt) meta.push(h('span', { key:'rt', className:'mut' }, (active?'run ':'last run ')+fmtElapsed(a.startedAt)));
    meta.push(h('span', { key:'it' }, (a.iterations||0)+' it'));
    if(a.toolCalls!=null) meta.push(h('span', { key:'tc' }, (a.toolCalls||0)+' tools'));
    if(a.tokensIn||a.tokensOut) meta.push(h('span', { key:'tk' }, fmtNum((a.tokensIn||0)+(a.tokensOut||0))+' tok'));
    if(typeof a.costUsd==='number' && a.costUsd>0) meta.push(h('span', { key:'co' }, '$'+a.costUsd.toFixed(3)));
    if(a.lastActivityAt) meta.push(h('span', { key:'ag', className:'mut' }, fmtAgo(a.lastActivityAt)));
    return h('div', { className: 'acard s-'+(a.status||'idle')+(seld?' selected':''), onClick: function(){ selectSession(s.sessionId, a.id); } },
      h('div', { className: 'acard-top' },
        h('span', { className: 'dot '+(a.status||'idle') }),
        h('span', { className: 'acard-name' }, a.name || a.id),
        h('span', { className: 'acard-status '+(a.status||'idle') }, a.status)
      ),
      h(Crumb, { s: s }),
      a.currentTool ? h('div', { className: 'acard-tool' }, '⚙ ' + a.currentTool) : null,
      a.partialText ? h('div', { className: 'acard-stream' }, '…' + String(a.partialText).slice(-200)) : null,
      h('div', { className: 'acard-meta' }, meta),
      ctx!=null ? h('div', { className: 'ctxbar', title: 'context '+ctx+'%' }, h('div', { className: 'ctxbar-fill'+(ctx>=85?' hot':ctx>=60?' warm':''), style: { width: ctx+'%' } })) : null
    );
  }

  function AgentGrid(p){
    var items = flattenAgents(p.snap);
    if(!items.length) return h('div', { className: 'empty-graph' }, 'No live agents yet. Open a WrongStack TUI / REPL / WebUI with HQ running and they appear here automatically.');
    return h('div', { className: 'agrid-wrap' },
      h('div', { className: 'agrid-head' }, '⚡ ' + items.length + ' live agents across the fleet — click any to watch its chat'),
      h('div', { className: 'agrid' }, items.map(function(it, i){ return h(AgentCard, { key: i, a: it.a, s: it.s }); }))
    );
  }

  function caret(col){ return h('span', { className: 'tcaret' }, col?'▸':'▾'); }

  function agentMatches(a, q){ return String(a.name||a.id).toLowerCase().indexOf(q)>=0 || (a.currentTool && String(a.currentTool).toLowerCase().indexOf(q)>=0); }
  function termMatches(t, m, pr, q){
    if(!q) return true;
    if(String(t.clientKind||'').toLowerCase().indexOf(q)>=0) return true;
    if(String(t.sessionId||'').toLowerCase().indexOf(q)>=0) return true;
    if(String(pr.projectName||'').toLowerCase().indexOf(q)>=0) return true;
    if(String(m.hostname||'').toLowerCase().indexOf(q)>=0) return true;
    return (t.agents||[]).some(function(a){ return agentMatches(a, q); });
  }

  function FleetTree(p){
    var colBox = React.useState({}); var collapsed = colBox[0], setCollapsed = colBox[1];
    var qBox = React.useState(''); var q = qBox[0], setQ = qBox[1];
    var ql = q.trim().toLowerCase();
    var filtering = ql.length > 0;
    function toggle(id){ var c = Object.assign({}, collapsed); c[id] = !c[id]; setCollapsed(c); }
    var sel = Store.selected;
    var tree = buildTree(p.snap);
    function collapseAll(){ var c = {}; tree.forEach(function(m){ c['m:'+m.machineId] = true; }); setCollapsed(c); }
    var rows = [];
    tree.forEach(function(m){
      var projs = m.projectList.map(function(pr){
        return { pr: pr, terms: pr.terminals.filter(function(t){ return termMatches(t, m, pr, ql); }) };
      }).filter(function(x){ return x.terms.length > 0; });
      if(filtering && projs.length === 0) return;
      var mid = 'm:'+m.machineId, mcol = !filtering && collapsed[mid];
      rows.push(h('div', { key: mid, className: 'trow d0', onClick: function(){ toggle(mid); } },
        caret(mcol), h('span', { className: 'tic' }, '🖥️'),
        h('span', { className: 'tlabel' }, m.hostname || shortId(m.machineId)),
        h('span', { className: 'tcount' }, (m.sessionCount||0)+'·'+(m.agentCount||0))));
      if(mcol) return;
      projs.forEach(function(x){
        var pr = x.pr, pid = 'p:'+m.machineId+':'+pr.projectId, pcol = !filtering && collapsed[pid];
        rows.push(h('div', { key: pid, className: 'trow d1', onClick: function(){ toggle(pid); } },
          caret(pcol), h('span', { className: 'tic' }, '📁'),
          h('span', { className: 'tlabel' }, pr.projectName),
          pr.gitBranch ? h('span', { className: 'tbranch' }, '⎇ '+pr.gitBranch) : null));
        if(pcol) return;
        x.terms.forEach(function(t){
          var tid = 't:'+t.sessionId, tcol = !filtering && collapsed[tid];
          var tsel = sel && sel.sessionId===t.sessionId && !sel.agentId;
          var hasAgents = t.agents && t.agents.length;
          rows.push(h('div', { key: tid, className: 'trow d2'+(tsel?' sel':'') },
            h('span', { className: 'tcaret', onClick: function(e){ e.stopPropagation(); if(hasAgents) toggle(tid); } }, hasAgents?(tcol?'▸':'▾'):'·'),
            h('span', { className: 'tic k-'+t.clientKind }, kindIcon(t.clientKind)),
            h('span', { className: 'tlabel', onClick: function(){ selectSession(t.sessionId); } }, (t.clientKind||'cli').toUpperCase()+' · '+shortId(t.sessionId)),
            h('span', { className: 'dot '+(t.status||'idle') })));
          if(tcol) return;
          (t.agents||[]).forEach(function(a){
            var aid = 'a:'+t.sessionId+':'+a.id;
            var asel = sel && sel.sessionId===t.sessionId && sel.agentId===a.id;
            rows.push(h('div', { key: aid, className: 'trow d3'+(asel?' sel':''), onClick: function(){ selectSession(t.sessionId, a.id); } },
              h('span', { className: 'dot '+(a.status||'idle') }),
              h('span', { className: 'tlabel' }, a.name || a.id),
              a.currentTool ? h('span', { className: 'ttool' }, '⚙ '+a.currentTool) : null));
          });
        });
      });
    });
    return h('div', { className: 'rail-tree' },
      h('div', { className: 'rail-search' },
        h('input', { className: 'rsearch', placeholder: 'Filter terminals / agents…', value: q, onChange: function(e){ setQ(e.target.value); } }),
        q ? h('button', { className: 'rsearch-btn', title: 'clear', onClick: function(){ setQ(''); } }, '✕')
          : h('button', { className: 'rsearch-btn', title: 'collapse all', onClick: collapseAll }, '⊟')
      ),
      h('div', { className: 'tree' }, rows.length ? rows : h('div', { className: 'tree-empty' }, filtering ? 'No matches' : 'No terminals yet'))
    );
  }

  function LiveBubble(p){
    return h('div', { className: 'bub assistant live', key: 'live' },
      h('div', { className: 'bub-meta' },
        h('span', { className: 'bub-role' }, p.tool ? ('tool · '+p.tool) : 'assistant'),
        h('span', { className: 'live-dot' }, '● streaming')
      ),
      h('div', { className: 'txt' }, p.text, h('span', { className: 'caret' }))
    );
  }

  function ChatView(p){
    var sel = Store.selected;
    var bodyRef = React.useRef(null);
    var stickRef = React.useRef(true);
    // A non-leader agent is a subagent (shadow) — show ITS own buffered stream,
    // keyed by subagentId (== agent card id). The leader / a bare terminal show
    // the session's full on-disk transcript.
    var isSub = !!(sel && sel.agentId && sel.agentId !== 'leader');
    var subMsgs = isSub ? (Store.agentMsgs[sel.agentId] || []) : null;
    var tc = (sel && !isSub) ? Store.transcripts[sel.sessionId] : null;
    var entries = isSub ? subMsgs : (tc ? tc.entries : []);
    var session = (p.snap && p.snap.liveSessions || []).filter(function(s){ return s.sessionId===sel.sessionId; })[0];
    var agentsList = session ? (session.agents||[]) : [];
    var ag = sel.agentId ? agentsList.filter(function(a){ return a.id===sel.agentId; })[0]
                         : (agentsList.filter(function(a){ return a.id==='leader'; })[0] || agentsList[0]);
    // Live "typing" tail — instant stream of the response being generated now.
    var streaming = ag && (ag.status==='streaming' || ag.status==='running');
    var liveText = streaming && ag.partialText ? String(ag.partialText) : '';
    var liveTool = streaming && ag.currentTool ? ag.currentTool : '';
    var agBits = [];
    if(ag && ag.model) agBits.push('model '+ag.model);
    if(ag && typeof ag.ctxPct==='number') agBits.push('ctx '+Math.max(0, Math.min(100, ag.ctxPct))+'%');
    if(ag && ag.startedAt) agBits.push((streaming?'run ':'last run ')+fmtElapsed(ag.startedAt));

    // Keep pinned to the bottom while new content streams in, unless the user
    // has scrolled up to read history.
    React.useEffect(function(){
      var el = bodyRef.current; if(el && stickRef.current) el.scrollTop = el.scrollHeight;
    }, [entries.length, liveText, liveTool, sel && sel.sessionId, sel && sel.agentId]);
    function onScroll(){ var el = bodyRef.current; if(!el) return; stickRef.current = (el.scrollHeight - el.scrollTop - el.clientHeight) < 40; }

    var baseMeta = isSub ? (entries.length + ' messages' + (streaming?' · live':'')) : ((tc && tc.total!=null ? (tc.total+' turns') : '') + (tc && tc.source ? (' · '+tc.source) : ''));
    var metaText = (agBits.length ? (agBits.join(' · ') + (baseMeta ? ' · ' : '')) : '') + baseMeta;
    var bodyEls = [];
    if(!isSub && tc && tc.loading && !entries.length && !liveText){ bodyEls.push(h('div', { key:'l', className: 'loading' }, 'Loading full chat history…')); }
    else if(!entries.length && !liveText){ bodyEls.push(h('div', { key:'e', className: 'side-empty' }, isSub ? ('No messages from ' + (ag?ag.name:'this subagent') + ' yet — its conversation streams here live as it works.') : ((tc&&tc.error)?'Could not load history.':'No transcript yet for this terminal.'))); }
    else {
      for(var i=0;i<entries.length;i++){ bodyEls.push(h(Bubble, { key: i, e: entries[i] })); }
      if(liveText || (streaming && !isSub && liveTool)){ bodyEls.push(h(LiveBubble, { text: liveText, tool: liveTool })); }
    }
    return h('div', { className: 'chatview' },
      h('div', { className: 'chat-head' },
        h('button', { className: 'chat-back', onClick: function(){ Store.selected = null; Store.emit(); } }, '← Overview'),
        session ? h(Crumb, { s: session }) : null,
        ag ? h('span', { className: 'chat-agent' }, h('span', { className: 'dot '+(ag.status||'idle') }), ag.name || ag.id, isSub ? h('span', { className: 'subbadge' }, 'subagent') : null) : null,
        h('span', { className: 'chat-meta' }, metaText)
      ),
      h('div', { className: 'chat-body', ref: bodyRef, onScroll: onScroll }, bodyEls)
    );
  }

  function ConsoleView(p){
    var wBox = React.useState(parseInt(lsGet('hq.railw','320'),10)||320); var railW = wBox[0], setRailW = wBox[1];
    var railWRef = React.useRef(railW); railWRef.current = railW;
    function onDown(e){
      e.preventDefault();
      var startX = e.clientX, startW = railWRef.current;
      function mv(ev){ var w = Math.max(220, Math.min(560, startW + (ev.clientX - startX))); railWRef.current = w; setRailW(w); }
      function up(){ document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); lsSet('hq.railw', String(railWRef.current)); }
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    }
    return h('div', { className: 'console' },
      h('div', { className: 'rail', style: { width: railW + 'px' } },
        h('div', { className: 'rail-head' }, 'FLEET'),
        h(FleetTree, { snap: p.snap })
      ),
      h('div', { className: 'rail-resizer', onMouseDown: onDown }),
      h('div', { className: 'console-main' }, Store.selected ? h(ChatView, { snap: p.snap }) : h(AgentGrid, { snap: p.snap }))
    );
  }

  function App(){
    var s = useStore();
    var snap = s.snapshot;
    var unread = (snap && snap.totals && snap.totals.unreadMailboxMessages) || 0;
    var tab = s.tab || 'console';
    function tabBtn(id, label){ return h('div', { className: 'hq-tab' + (tab===id?' active':''), onClick: function(){ Store.set({ tab: id }); } }, label); }
    return h('div', { style: { height:'100%', display:'flex', flexDirection:'column' } },
      h(TopBar, { snap: snap, connected: s.connected }),
      h('div', { className: 'hq-tabs' },
        tabBtn('console', '🛰️ Console'),
        tabBtn('map', '🧭 Map'),
        h('div', { className: 'hq-tab' + (tab==='mailbox'?' active':''), onClick: function(){ Store.set({ tab:'mailbox' }); } }, '📬 Mailbox', unread? h('span', { className:'badge' }, unread):null)
      ),
      h('div', { className: 'hq-body' },
        tab==='map' ? h(FleetView, { snap: snap }) :
        tab==='mailbox' ? h(MailboxView, { snap: snap }) :
        h(ConsoleView, { snap: snap })
      )
    );
  }

  createRoot(document.getElementById('root')).render(h(App));
  // Esc closes the open chat (back to overview); keeps focus-free navigation fast.
  document.addEventListener('keydown', function(ev){
    if(ev.key === 'Escape' && Store.selected){ Store.selected = null; Store.emit(); }
  });
  connectWs();
  primeSnapshot();
}

function primeSnapshot(){
  fetch(withTok('/api/fleet')).then(function(r){ return r.ok?r.json():null; }).then(function(s){ if(s) Store.set({ snapshot: s }); }).catch(function(){});
}

/* dependency-free fallback (offline / CDN blocked) */
function renderFallback(){
  var bootEl = document.getElementById('boot'); if(bootEl) bootEl.remove();
  initTheme();
  var root = document.getElementById('root');
  function render(){
    var snap = Store.snapshot; var t = (snap && snap.totals) || {};
    var tree = buildTree(snap);
    var sel = Store.selected;
    var html = '';
    html += '<div class="hq-top"><div class="hq-brand">📋 WrongStack HQ</div>';
    html += '<div class="hq-conn"><span class="hq-led '+(Store.connected?'live':'dead')+'"></span>'+(Store.connected?'Live':'Reconnecting…')+'</div>';
    html += '<button class="theme-btn" id="fb-theme">'+(Store.theme==='light'?'🌙':'☀️')+'</button>';
    html += '<div class="statbar">';
    html += stat(t.activeMachines||0,'Machines')+stat(t.activeSessions||0,'Terminals')+stat(t.activeAgents||0,'Agents')+stat(t.activeProjects||0,'Projects');
    html += '</div></div>';
    html += '<div class="hq-body"><div style="flex:1;overflow:auto;padding:18px 22px">';
    if(!tree.length){ html += '<div class="empty" style="padding:40px">No live terminals yet.</div>'; }
    tree.forEach(function(m){
      html += '<div class="mb-sec"><h3>🖥️ '+escAttr(m.hostname)+' · '+(m.sessionCount||0)+' terminals · '+(m.agentCount||0)+' agents</h3>';
      m.projectList.forEach(function(p){
        html += '<div style="margin:6px 0 4px;color:var(--accent)">📁 '+escAttr(p.projectName)+(p.gitBranch?(' ⎇ '+escAttr(p.gitBranch)):'')+'</div>';
        p.terminals.forEach(function(term){
          html += '<div style="margin:2px 0 2px 14px">';
          if(term.synthetic) html += '<span style="color:var(--cyan)">▷ '+escAttr((term.clientKind||'cli').toUpperCase())+' · '+escAttr(shortId(term.sessionId))+'</span> <span class="pill">'+escAttr(term.status)+'</span> <span class="pill">waiting for session telemetry</span>';
          else html += '<a href="#" data-sid="'+escAttr(term.sessionId)+'" style="color:var(--cyan);text-decoration:none">▷ '+escAttr((term.clientKind||'cli').toUpperCase())+' · '+escAttr(shortId(term.sessionId))+'</a> <span class="pill">'+escAttr(term.status)+'</span>';
          (term.agents||[]).forEach(function(a){
            var active = a.status==='running'||a.status==='streaming'||a.status==='waiting_user';
            var extra = '';
            if(a.model) extra += ' <span class="pill">model '+escAttr(a.model)+'</span>';
            if(typeof a.ctxPct==='number') extra += ' <span class="pill">ctx '+escAttr(Math.max(0, Math.min(100, a.ctxPct)))+'%</span>';
            if(a.startedAt) extra += ' <span class="pill">'+escAttr(active?'run ':'last ')+escAttr(fmtElapsed(a.startedAt))+'</span>';
            html += '<div style="margin-left:22px;color:var(--muted)"><a href="#" data-sid="'+escAttr(term.sessionId)+'" data-aid="'+escAttr(a.id)+'" style="color:var(--text);text-decoration:none"><span class="dot '+escAttr(a.status||'idle')+'"></span> '+escAttr(a.name||a.id)+'</a> <span class="pill">'+escAttr(a.status)+'</span>'+(a.currentTool?(' <span class="pill">⚙ '+escAttr(a.currentTool)+'</span>'):'')+extra+'</div>';
          });
          html += '</div>';
        });
      });
      html += '</div>';
    });
    html += '</div>';
    // sidebar
    if(sel){
      var tc = Store.transcripts[sel.sessionId] || { entries: [], loading: true };
      html += '<div class="sidebar open"><div class="side-head"><div><div class="st">'+escAttr(shortId(sel.sessionId))+'</div><div class="ss">'+escAttr(tc.source||'')+(tc.total!=null?(' · '+tc.total+' turns'):'')+'</div></div><button class="side-close" id="fb-close">✕</button></div><div class="side-body" id="fb-body">';
      if(tc.loading && !tc.entries.length){ html += '<div class="loading">Loading full chat history…</div>'; }
      else if(!tc.entries.length){ html += '<div class="side-empty">No transcript yet.</div>'; }
      else { tc.entries.forEach(function(e){
        var head = '<div class="bub '+escAttr(e.role)+'"><div class="bub-meta"><span class="bub-role">'+escAttr(e.role)+(e.tool?(' · '+escAttr(e.tool)):'')+'</span><span>'+fmtTime(e.ts)+'</span></div>';
        var body;
        if(e.role==='tool' || e.role==='error'){
          body = '';
          if(e.toolInput) body += '<details class="bub-fold"><summary>→ args · '+e.toolInput.length+' chars</summary><pre class="bub-argpre">'+escAttr(e.toolInput)+'</pre></details>';
          if(e.text) body += '<details class="bub-fold"><summary>'+(e.isError?'⚠ error':'← result')+' · '+e.text.length+' chars</summary><pre>'+escAttr(e.text)+'</pre></details>';
        } else { body = '<div class="txt">'+escAttr(e.text||'')+'</div>'; }
        html += head + body + '</div>';
      }); }
      html += '</div></div>';
    }
    html += '</div>';
    root.innerHTML = html;
    Array.prototype.forEach.call(root.querySelectorAll('a[data-sid]'), function(a){
      a.onclick = function(ev){ ev.preventDefault(); selectSession(a.getAttribute('data-sid'), a.getAttribute('data-aid')); };
    });
    var cl = document.getElementById('fb-close'); if(cl) cl.onclick = function(){ Store.selected = null; Store.emit(); };
    var th = document.getElementById('fb-theme'); if(th) th.onclick = toggleTheme;
    var b = document.getElementById('fb-body'); if(b) b.scrollTop = b.scrollHeight;
  }
  function stat(n,l){ return '<div class="stat"><div class="num">'+n+'</div><div class="label">'+l+'</div></div>'; }
  function escAttr(s){ if(s==null) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  Store.subscribe(render);
  render();
}

boot();
</script>
</body>
</html>`;

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
 * For the same reason every backslash escape meant for the browser must be
 * doubled here: write a double-backslash n, never a single one. A bare
 * backslash-n is collapsed to a real newline by the outer template literal
 * (=> "unescaped line break" SyntaxError in the served page); a bare
 * backslash-s in a regex silently drops the backslash (=> a broken regex).
 * Doubling makes the emitted browser JS carry the intended single backslash.
 *
 * @module hq-dashboard-html
 */
import { SUMMARIZE_TOOL_INPUT_BROWSER_SRC } from '@wrongstack/tools/tool-summary';

// The served document is one big template literal (see header note). The
// tool-input summarizer is authored ONCE in @wrongstack/tools and injected via
// a post-.replace() on the placeholder comment below, so HQ and the WebUI share
// one implementation even though HQ cannot import at browser runtime. A replacer
// FUNCTION is used so any dollar-sign in the source is not treated as a
// String.prototype.replace special pattern.
const HQ_HTML_TEMPLATE = `<!DOCTYPE html>
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
  .hq-ui-badge { color: var(--amber); border: 1px solid var(--border); background: var(--inset); border-radius: 7px; padding: 3px 8px; font-size: 10px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; white-space: nowrap; }
  .hq-ui-badge::before { content: 'UI:'; color: var(--dim); margin-right: 4px; }
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
  .cmd-dock { border-top: 1px solid var(--border); background: var(--bg2); padding: 10px 14px; display: grid; gap: 8px; }
  .cmd-row { display: flex; gap: 8px; align-items: center; }
  .cmd-target { min-width: 220px; max-width: 44%; flex: 0 1 360px; background: var(--inset); border: 1px solid var(--border); color: var(--text); border-radius: 7px; padding: 7px 9px; font-size: 12px; }
  .cmd-type { flex: 0 0 auto; min-width: 84px; background: var(--inset); border: 1px solid var(--border); color: var(--text); border-radius: 7px; padding: 7px 9px; font-size: 12px; font-weight: 700; }
  .cmd-type:disabled { opacity: 0.55; cursor: not-allowed; }
  .cmd-text { flex: 1; min-height: 38px; max-height: 120px; resize: vertical; background: var(--inset); border: 1px solid var(--border); color: var(--text); border-radius: 7px; padding: 8px 10px; font: 12.5px/1.4 ui-sans-serif, system-ui, sans-serif; }
  .cmd-target:focus, .cmd-type:focus, .cmd-text:focus { outline: none; border-color: var(--accent); }
  .cmd-send { flex: 0 0 auto; background: var(--accent); color: #04121f; border: 1px solid var(--accent); border-radius: 7px; padding: 8px 12px; font-size: 12px; font-weight: 800; cursor: pointer; }
  .cmd-send:disabled { opacity: 0.5; cursor: not-allowed; }
  .cmd-status { font-size: 11px; color: var(--dim); min-height: 14px; }
  .cmd-status.ok { color: var(--green); }
  .cmd-status.err { color: var(--red); }
  .cmd-history { border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); background: var(--panel); padding: 10px 18px; }
  .cmd-hhead { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .cmd-htitle { font-size: 11px; font-weight: 800; color: var(--bright); text-transform: uppercase; letter-spacing: 0.6px; }
  .cmd-hnote { font-size: 10.5px; color: var(--dim); }
  .cmd-hrefresh { margin-left: auto; background: var(--inset); border: 1px solid var(--border); border-radius: 7px; color: var(--muted); cursor: pointer; font-size: 11px; padding: 5px 9px; }
  .cmd-hrefresh:hover { border-color: var(--accent); color: var(--text); }
  .cmd-hlist { display: grid; gap: 5px; }
  .cmd-hrow { display: grid; grid-template-columns: 92px 82px minmax(0, 1fr) 88px; gap: 8px; align-items: center; font-size: 11.5px; color: var(--muted); background: var(--inset); border: 1px solid var(--border); border-radius: 7px; padding: 6px 8px; }
  .cmd-htype { color: var(--bright); font-weight: 700; }
  .cmd-hstatus { text-transform: uppercase; font-size: 9.5px; font-weight: 800; letter-spacing: 0.5px; color: var(--amber); }
  .cmd-hstatus.acked { color: var(--green); }
  .cmd-hstatus.delivered { color: var(--cyan); }
  .cmd-hstatus.failed, .cmd-hstatus.rejected { color: var(--red); }
  .cmd-hclient, .cmd-hmsg { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cmd-history .side-empty { padding: 12px; font-size: 11.5px; }
  .timeline-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--bg2); }
  .timeline-head { padding: 12px 18px; border-bottom: 1px solid var(--border); display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .timeline-title { font-size: 13px; font-weight: 800; color: var(--bright); }
  .timeline-note { font-size: 11px; color: var(--dim); }
  .timeline-filters { margin-left: auto; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .timeline-input, .timeline-select { background: var(--inset); border: 1px solid var(--border); color: var(--text); border-radius: 7px; padding: 6px 9px; font-size: 12px; }
  .timeline-input { width: 260px; }
  .timeline-input:focus, .timeline-select:focus { outline: none; border-color: var(--accent); }
  .timeline-btn { background: var(--inset); border: 1px solid var(--border); color: var(--muted); border-radius: 7px; padding: 6px 10px; font-size: 12px; cursor: pointer; }
  .timeline-btn:hover { color: var(--text); border-color: var(--accent); }
  .timeline-list { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 18px 18px; display: grid; gap: 8px; align-content: start; }
  .timeline-row { display: grid; grid-template-columns: 34px 92px minmax(170px, 260px) minmax(0, 1fr); gap: 10px; border: 1px solid var(--border); border-radius: 10px; padding: 9px 10px; cursor: pointer; background: var(--panel); align-items: start; }
  .timeline-row:hover { background: var(--panel2); border-color: var(--accent); }
  .timeline-row.tool { border-color: rgba(57,208,216,0.22); background: rgba(57,208,216,0.045); }
  .timeline-row.assistant { border-color: rgba(163,113,247,0.20); }
  .timeline-row.error { border-color: rgba(248,81,73,0.32); background: rgba(248,81,73,0.06); }
  .timeline-mark { width: 28px; height: 28px; border-radius: 9px; display: grid; place-items: center; background: var(--inset); border: 1px solid var(--border); color: var(--muted); font-size: 14px; }
  .timeline-row.assistant .timeline-mark { color: var(--purple); border-color: rgba(163,113,247,0.35); background: rgba(163,113,247,0.12); }
  .timeline-row.tool .timeline-mark { color: var(--cyan); border-color: rgba(57,208,216,0.35); background: rgba(57,208,216,0.11); }
  .timeline-row.user .timeline-mark { color: var(--accent); border-color: rgba(88,166,255,0.35); background: rgba(88,166,255,0.11); }
  .timeline-row.error .timeline-mark { color: var(--red); border-color: rgba(248,81,73,0.38); background: rgba(248,81,73,0.12); }
  .timeline-time { color: var(--dim); font-size: 11px; font-variant-numeric: tabular-nums; }
  .timeline-who { min-width: 0; }
  .timeline-agent { color: var(--bright); font-weight: 700; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .timeline-project { color: var(--muted); font-size: 10.5px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .timeline-msg { min-width: 0; color: var(--text); font-size: 12.5px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; max-height: 86px; overflow: hidden; }
  .timeline-role { display: inline-block; margin-right: 6px; color: var(--dim); text-transform: uppercase; font-size: 9.5px; letter-spacing: 0.5px; font-weight: 800; }
  .timeline-role.user { color: var(--accent); }
  .timeline-role.assistant { color: var(--purple); }
  .timeline-role.tool { color: var(--cyan); }
  .timeline-role.error { color: var(--red); }
  .timeline-toolchip { display: inline-block; margin-right: 6px; border: 1px solid rgba(57,208,216,0.32); background: rgba(57,208,216,0.08); color: var(--cyan); border-radius: 999px; padding: 1px 7px; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 10px; }
  .bub.live .bub-card { border-color: rgba(63,185,80,0.5); box-shadow: 0 0 0 1px rgba(63,185,80,0.15); }
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
  .fnode.agent { width: 196px; padding: 9px 10px; }
  .fnode.agent .fnode-sub { max-height: 30px; white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .fnode.agent .fnode-chips { max-height: 34px; overflow: hidden; }
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
  .bub { margin-bottom: 14px; display: flex; gap: 10px; align-items: flex-start; font-size: 13px; line-height: 1.55; }
  .bub.user { flex-direction: row-reverse; }
  .bub-avatar { flex: 0 0 32px; width: 32px; height: 32px; border-radius: 10px; display: grid; place-items: center; font-size: 15px; border: 1px solid var(--border2); background: var(--panel); color: var(--muted); box-shadow: 0 0 0 3px rgba(13,17,23,0.65); }
  .bub.assistant .bub-avatar { background: rgba(163,113,247,0.16); color: var(--purple); border-color: rgba(163,113,247,0.35); }
  .bub.user .bub-avatar { background: var(--accent); color: #04121f; border-color: rgba(88,166,255,0.7); }
  .bub.tool .bub-avatar { background: rgba(57,208,216,0.13); color: var(--cyan); border-color: rgba(57,208,216,0.35); }
  .bub.error .bub-avatar { background: rgba(248,81,73,0.14); color: var(--red); border-color: rgba(248,81,73,0.4); }
  .bub.system .bub-avatar { background: var(--inset); color: var(--dim); }
  .bub-content { min-width: 0; flex: 1; max-width: 860px; display: flex; flex-direction: column; gap: 5px; }
  .bub.user .bub-content { align-items: flex-end; }
  .bub-head { display: flex; align-items: center; gap: 8px; padding: 0 2px; color: var(--dim); font-size: 10.5px; }
  .bub-role { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.6px; color: var(--muted); }
  .bub.assistant .bub-role { color: var(--purple); }
  .bub.user .bub-role { color: var(--accent); }
  .bub.tool .bub-role { color: var(--cyan); }
  .bub.error .bub-role { color: var(--red); }
  .bub-card { width: fit-content; max-width: 100%; border: 1px solid var(--border); border-radius: 14px; padding: 10px 12px; background: var(--panel); color: var(--text); box-shadow: 0 8px 20px rgba(0,0,0,0.18); }
  .bub.assistant .bub-card { background: var(--panel); border-color: var(--border2); border-bottom-left-radius: 5px; }
  .bub.user .bub-card { background: rgba(88,166,255,0.16); border-color: rgba(88,166,255,0.35); border-bottom-right-radius: 5px; }
  .bub.tool .bub-card { background: rgba(57,208,216,0.06); border-color: rgba(57,208,216,0.22); border-bottom-left-radius: 5px; }
  .bub.error .bub-card { background: rgba(248,81,73,0.08); border-color: rgba(248,81,73,0.32); color: var(--text); }
  .bub.system .bub-card { background: transparent; border-style: dashed; color: var(--muted); box-shadow: none; }
  .bub pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11.5px; max-height: 360px; overflow: auto; }
  .bub .txt { white-space: pre-wrap; word-break: break-word; }
  .assistant-body, .txt { word-break: break-word; }
  .msg-md { display: grid; gap: 8px; }
  .msg-md p { margin: 0; white-space: pre-wrap; }
  .md-heading { font-weight: 800; color: var(--bright); margin-top: 2px; }
  .md-bullet { display: grid; grid-template-columns: 14px minmax(0, 1fr); gap: 6px; align-items: start; }
  .md-bullet-dot { color: var(--accent); }
  .md-inline { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.92em; padding: 1px 4px; border-radius: 5px; background: var(--inset); border: 1px solid var(--border); color: var(--cyan); }
  .md-codewrap { border: 1px solid var(--border); border-radius: 9px; overflow: hidden; background: var(--bg2); }
  .md-codelabel { display: flex; align-items: center; gap: 6px; padding: 5px 9px; border-bottom: 1px solid var(--border); color: var(--dim); font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
  .md-code { margin: 0; padding: 10px 11px; max-height: 360px; overflow: auto; white-space: pre; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11.5px; line-height: 1.45; color: var(--text); }
  .tool-card { display: grid; gap: 8px; min-width: min(520px, 100%); }
  .tool-head { display: flex; align-items: center; gap: 8px; color: var(--text); min-width: 0; }
  .tool-name { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; font-weight: 800; color: var(--cyan); flex: 0 0 auto; }
  .tool-cat { font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--dim); flex: 0 0 auto; padding: 1px 6px; border: 1px solid var(--border); border-radius: 999px; background: var(--inset); }
  .tool-summary { margin-left: 6px; flex: 1 1 auto; min-width: 0; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tool-status { margin-left: auto; flex: 0 0 auto; font-size: 10px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--green); font-weight: 800; }
  .tool-status.error { color: var(--red); }
  .tool-duration { flex: 0 0 auto; font-size: 10.5px; color: var(--dim); font-variant-numeric: tabular-nums; }
  .tool-group { margin: 0 0 14px 42px; max-width: 860px; border: 1px solid var(--border); border-radius: 12px; background: rgba(57,208,216,0.045); overflow: hidden; }
  .tool-group > summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 8px; padding: 9px 11px; color: var(--text); user-select: none; }
  .tool-group > summary::-webkit-details-marker { display: none; }
  .tool-group > summary::before { content: '▸'; color: var(--dim); font-size: 10px; }
  .tool-group[open] > summary::before { content: '▾'; }
  .tool-group-title { font-weight: 800; color: var(--cyan); font-size: 12px; }
  .tool-group-meta { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tool-group-status { margin-left: auto; font-size: 10px; text-transform: uppercase; font-weight: 800; letter-spacing: 0.5px; color: var(--green); }
  .tool-group-status.error { color: var(--red); }
  .tool-group-body { padding: 10px 12px 2px; border-top: 1px solid var(--border); background: rgba(13,17,23,0.32); }
  .tool-group-body .bub { margin-bottom: 10px; }
  .tool-group-body .bub-content { max-width: 100%; }
  .tool-group-body .bub-avatar { width: 26px; height: 26px; flex-basis: 26px; border-radius: 8px; font-size: 12px; }
  .bub-sublabel { font-size: 9px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--dim); margin: 4px 0 2px; }
  .bub-fold { margin-top: 0; }
  .bub-fold > summary { cursor: pointer; list-style: none; font-size: 11px; color: var(--cyan); padding: 6px 9px; background: var(--inset); border: 1px solid var(--border); border-radius: 8px; user-select: none; display: flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; }
  .bub-fold > summary::-webkit-details-marker { display: none; }
  .bub-fold > summary::before { content: '▸'; color: var(--dim); font-size: 9px; }
  .bub-fold[open] > summary::before { content: '▾'; }
  .bub-fold > summary:hover { border-color: var(--accent); color: var(--text); }
  .bub-fold[open] > summary { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
  .bub-fold > pre { margin: 0; border: 1px solid var(--border); border-top: none; border-radius: 0 0 8px 8px; padding: 9px 10px; background: var(--bg2); }
  .bub-argpre { color: var(--cyan); }
  .tool-output { border: 1px solid var(--border); border-top: none; border-radius: 0 0 8px 8px; background: var(--bg2); overflow: hidden; }
  .tool-output-head { display: flex; align-items: center; gap: 8px; padding: 6px 9px; border-bottom: 1px solid var(--border); color: var(--dim); font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
  .tool-output-kind { color: var(--cyan); font-family: ui-monospace, "SF Mono", Menlo, monospace; font-weight: 800; }
  .tool-output-meta { margin-left: auto; font-variant-numeric: tabular-nums; }
  .tool-output pre { margin: 0; padding: 9px 10px; max-height: 380px; overflow: auto; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11.5px; line-height: 1.45; }
  .tool-output.error pre { color: var(--red); }
  .tool-output.bash pre { white-space: pre-wrap; word-break: break-word; }
  .tool-output.json pre, .tool-output.numbered pre { white-space: pre; }
  .tool-output-footer { display: flex; gap: 12px; border-top: 1px solid var(--border); padding: 5px 9px; background: rgba(255,255,255,0.02); color: var(--dim); font-size: 10.5px; font-variant-numeric: tabular-nums; }
  .tool-output-footer.bad { color: var(--red); }
  .line-view { display: flex; max-height: 380px; overflow: auto; }
  .line-gutter { flex: 0 0 auto; min-width: 38px; padding: 9px 8px; border-right: 1px solid var(--border); background: rgba(255,255,255,0.025); color: var(--dim); text-align: right; user-select: none; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11.5px; line-height: 1.45; white-space: pre; }
  .line-view pre { flex: 1; max-height: none; min-width: 0; }
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
  selected: null, transcripts: {}, agentMsgs: {}, timeline: [], timelineSeen: {}, timelineLoaded: false,
  commands: [], commandsLoaded: false, commandsLoading: false, listeners: new Set(),
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
function cacheKey(agentId, projectId, clientId){ return (projectId||'') + '||' + (clientId||'') + '||' + agentId; }
function findSession(snap, sessionId){ return ((snap && snap.liveSessions) || []).filter(function(s){ return s.sessionId === sessionId; })[0] || null; }
function findAgent(session, agentId){ return session ? ((session.agents||[]).filter(function(a){ return a.id === agentId; })[0] || null) : null; }
function clientIdForSession(snap, session){
  if(!session) return '';
  if(session.clientId) return session.clientId;
  var clients = (snap && snap.clients) || [];
  for(var i=0;i<clients.length;i++){
    var c = clients[i];
    if(c.projectId === session.projectId && c.machineId === session.machineId && c.kind === session.clientKind && (!session.pid || !c.pid || c.pid === session.pid)) return c.clientId || '';
  }
  return '';
}

function timelineKey(e){
  return [e.source||'', e.projectId||'', e.clientId||'', e.sessionId||'', e.agentId||'', e.ts||'', e.role||'', e.tool||'', String(e.text||'').slice(0,80)].join('|');
}
function addTimelineEntries(entries){
  if(!entries || !entries.length) return;
  var changed = false;
  for(var i=0;i<entries.length;i++){
    var e = entries[i];
    var key = timelineKey(e);
    if(Store.timelineSeen[key]) continue;
    Store.timelineSeen[key] = 1;
    Store.timeline.push(e);
    changed = true;
  }
  if(!changed) return;
  Store.timeline.sort(function(a,b){ return (Date.parse(b.ts||'')||0) - (Date.parse(a.ts||'')||0); });
  if(Store.timeline.length > 1500) Store.timeline = Store.timeline.slice(0, 1500);
  Store.emit();
}
function timelineEntriesFromEvent(ev){
  var out = [];
  if(!ev || !ev.payload) return out;
  if(ev.type === 'session.transcript' && ev.payload.sessionId && Array.isArray(ev.payload.entries)){
    ev.payload.entries.forEach(function(entry){
      out.push({
        source: 'session', projectId: ev.projectId, clientId: ev.clientId, sessionId: ev.payload.sessionId,
        agentId: entry.agentId || 'leader', agentName: entry.agentId || 'leader',
        ts: entry.ts || ev.timestamp, role: entry.role || 'assistant', tool: entry.tool, text: entry.text || ''
      });
    });
  } else if(ev.type === 'agent.message' && ev.payload.subagentId){
    out.push({
      source: 'agent', projectId: ev.projectId, clientId: ev.clientId, sessionId: ev.sessionId || null,
      agentId: ev.payload.subagentId, agentName: ev.payload.agentName || ev.payload.subagentId,
      ts: ev.payload.ts || ev.timestamp, role: agentMsgRole(ev.payload.kind), tool: ev.payload.toolName, text: ev.payload.content || ''
    });
  } else if(ev.type === 'agent.status' && ev.payload.subagentId){
    out.push({
      source: 'agent', projectId: ev.projectId, clientId: ev.clientId, sessionId: ev.sessionId || null,
      agentId: ev.payload.subagentId, agentName: ev.payload.agentName || ev.payload.subagentId,
      ts: ev.payload.ts || ev.timestamp, role: 'system', text: (ev.payload.status||'status') + (ev.payload.summary ? (': '+ev.payload.summary) : (ev.payload.task ? (': '+ev.payload.task) : ''))
    });
  }
  return out;
}
function timelineAgentValue(projectId, clientId, agentId){ return [projectId||'', clientId||'', agentId||''].join('||'); }
function parseTimelineAgentValue(value){
  if(!value || value === 'all') return null;
  var parts = String(value).split('||');
  return { projectId: parts[0] || '', clientId: parts[1] || '', agentId: parts[2] || '' };
}
function timelineFilterQuery(filters){
  var f = filters || {};
  var q = [];
  function add(k,v){ if(v && v !== 'all') q.push(encodeURIComponent(k) + '=' + encodeURIComponent(v)); }
  add('projectId', f.projectId);
  add('clientId', f.clientId);
  add('agentId', f.agentId);
  add('source', f.source);
  add('role', f.role);
  add('q', f.q);
  return q.length ? ('&' + q.join('&')) : '';
}
function loadRecentTimeline(filters, force){
  var f = typeof filters === 'string' ? { projectId: filters } : (filters || {});
  if(Store.timelineLoaded && !force) return;
  Store.timelineLoaded = true;
  var path = '/api/timeline?limit=800' + timelineFilterQuery(f);
  fetch(withTok(path))
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(d){
      if(d && Array.isArray(d.entries)){
        addTimelineEntries(d.entries);
        return;
      }
      return fetch(withTok('/api/events?limit=800'))
        .then(function(r){ return r.ok ? r.json() : null; })
        .then(function(fallback){
          var events = fallback && Array.isArray(fallback.events) ? fallback.events : [];
          var batch = [];
          events.forEach(function(ev){ batch = batch.concat(timelineEntriesFromEvent(ev)); });
          addTimelineEntries(batch);
        });
    })
    .catch(function(){});
}

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

function loadAgentMessages(agentId, session){
  if(!agentId) return;
  var projectId = session && session.projectId ? session.projectId : '';
  var clientId = clientIdForSession(Store.snapshot, session);
  var key = cacheKey(agentId, projectId, clientId);
  var url = '/api/agents/'+encodeURIComponent(agentId)+'/messages?full=1';
  if(projectId) url += '&projectId=' + encodeURIComponent(projectId);
  if(clientId) url += '&clientId=' + encodeURIComponent(clientId);
  fetch(withTok(url))
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(d){ if(d && Array.isArray(d.entries)){ Store.agentMsgs[key] = d.entries; Store.emit(); } })
    .catch(function(){});
}

function selectSession(sessionId, agentId){
  Store.selected = { sessionId: sessionId, agentId: agentId || null };
  var session = findSession(Store.snapshot, sessionId);
  if(agentId && agentId !== 'leader'){ loadAgentMessages(agentId, session); }
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
        if(sel.agentId && sel.agentId !== 'leader') loadAgentMessages(sel.agentId, findSession(Store.snapshot, sel.sessionId));
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

function agentMsgRole(kind){ return (kind==='tool_use'||kind==='tool_result')?'tool' : kind==='error'?'error' : kind==='status'?'system' : 'assistant'; }

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
  addTimelineEntries(timelineEntriesFromEvent(ev));
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
    var k = cacheKey(p.subagentId, ev.projectId, ev.clientId);
    var arr = Store.agentMsgs[k] || (Store.agentMsgs[k] = []);
    arr.push({ ts: p.ts, role: agentMsgRole(p.kind), text: p.content || '', tool: p.toolName });
    if(arr.length > 4000) Store.agentMsgs[k] = arr.slice(-4000);
    Store.emit();
    return;
  }
  if(ev.type === 'agent.status' && ev.payload && ev.payload.subagentId){
    var sp = ev.payload;
    var k2 = cacheKey(sp.subagentId, ev.projectId, ev.clientId);
    var a2 = Store.agentMsgs[k2] || (Store.agentMsgs[k2] = []);
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

function postHqCommand(clientId, type, payload){
  return fetch(withTok('/api/command'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: clientId, type: type, payload: payload })
  }).then(function(r){
    return r.json().catch(function(){ return {}; }).then(function(body){
      if(!r.ok){ throw new Error(body && body.error ? body.error : ('HTTP ' + r.status)); }
      return body;
    });
  });
}
/* Direct mailbox write — used when the target has no live command-capable
   client. The prompt lands in the project mailbox regardless of whether any
   agent loop is running; the server resolves the projectRoot from sessionId/
   projectId, so no filesystem path leaves the browser. */
function postHqMailboxSend(target, type, opts){
  return fetch(withTok('/api/mailbox-send'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: target.sessionId, projectId: target.projectId,
      type: type, to: target.to, subject: opts.subject, body: opts.body, priority: opts.priority
    })
  }).then(function(r){
    return r.json().catch(function(){ return {}; }).then(function(body){
      if(!r.ok){ throw new Error(body && body.error ? body.error : ('HTTP ' + r.status)); }
      return body;
    });
  });
}
function loadCommands(force){
  if(Store.commandsLoading) return;
  if(Store.commandsLoaded && !force) return;
  Store.commandsLoading = true;
  fetch(withTok('/api/commands?limit=80'))
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(d){
      var commands = d && Array.isArray(d.commands) ? d.commands.slice() : [];
      commands.sort(function(a,b){ return (Date.parse(b.enqueuedAt||'')||0) - (Date.parse(a.enqueuedAt||'')||0); });
      Store.commands = commands;
      Store.commandsLoaded = true;
      Store.commandsLoading = false;
      Store.emit();
    })
    .catch(function(){ Store.commandsLoading = false; Store.commandsLoaded = true; Store.emit(); });
}

function buildCommandTargets(snap){
  var targets = [];
  var seenProjects = {};
  ((snap && snap.liveSessions) || []).forEach(function(s){
    // A live client means the fast control-plane path (/api/command) is
    // available. Without one, targets still work via the direct mailbox
    // route (/api/mailbox-send) — the send simply lands in the project
    // mailbox and is picked up whenever an agent next runs. direct=true
    // marks those; the offline suffix hints at the fallback path.
    var clientId = clientIdForSession(snap, s);
    var direct = !clientId;
    var projName = s.projectName || s.projectId;
    var offlineSuffix = direct ? ' · (offline → mailbox)' : '';
    var projectKey = s.projectId + '|' + (clientId || 'nocli');
    if(!seenProjects[projectKey]){
      seenProjects[projectKey] = 1;
      targets.push({
        value: 'project|' + projectKey, kind: 'broadcast', clientId: clientId || null, direct: direct,
        to: 'all', sessionId: s.sessionId, projectId: s.projectId,
        label: 'Broadcast project · ' + projName + offlineSuffix
      });
    }
    targets.push({
      value: s.sessionId + '|leader', kind: 'agent', clientId: clientId || null, direct: direct,
      to: 'leader', sessionId: s.sessionId, projectId: s.projectId, agentId: 'leader',
      label: projName + ' · ' + (s.clientKind||'cli').toUpperCase() + ' · leader' + offlineSuffix
    });
    (s.agents||[]).forEach(function(a){
      if(a.id === 'leader') return;
      targets.push({
        value: s.sessionId + '|' + a.id, kind: 'agent', clientId: clientId || null, direct: direct,
        to: a.id, sessionId: s.sessionId, projectId: s.projectId, agentId: a.id,
        label: projName + ' · ' + (a.name || a.id) + offlineSuffix
      });
    });
  });
  return targets;
}

function selectedTargetValue(snap){
  var sel = Store.selected;
  if(!sel || !sel.sessionId) return '';
  var session = findSession(snap, sel.sessionId);
  if(!session) return '';
  return sel.agentId ? (sel.sessionId + '|' + sel.agentId) : (sel.sessionId + '|leader');
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
  var agentCount = t.agentCount || (t.agents ? t.agents.length : 0);
  return fleetNode(id, 'terminal', {
    termKind: t.clientKind, status: t.status, icon: kindIcon(t.clientKind),
    label: (t.clientKind||'cli').toUpperCase() + ' · ' + shortId(t.sessionId),
    sub: t.status + (t.pid ? (' · pid '+t.pid) : '') + (synthetic ? ' · waiting for session telemetry' : ''),
    agentCount: agentCount,
    chips: synthetic ? ['connected', '0 agents'] : [ agentCount+' agents' ],
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
    parentTerminalId: 'terminal:' + t.sessionId,
    status: a.status, label: a.name || a.id,
    sub: a.status + (a.partialText ? (' · '+String(a.partialText).slice(0,44)) : ''),
    chips: chips, clickable: true,
    selected: !!(sel && sel.sessionId === t.sessionId && sel.agentId === a.id),
    onClick: function(){ selectSession(t.sessionId, a.id); }
  });
}
function kindIcon(k){ return k==='tui'?'🖳':k==='webui'?'🌐':k==='repl'?'⌨️':'▷'; }
function miniColor(n){ var k=n.data&&n.data.kind; return k==='machine'?'#a371f7':k==='project'?'#58a6ff':k==='agent'?'#3fb950':'#39d0d8'; }

// Node footprints (width × height) for graph sizing. Agents are compact because
// subagent fleets can be large; they are clustered around their terminal rather
// than laid out as a long tree rank.
var NODE_SIZE = { machine: [220, 78], project: [220, 78], terminal: [220, 70], agent: [196, 78] };
function agentGrid(count, dir){
  if(!count) return { cols: 0, rows: 0, width: 0, height: 0 };
  var cols = dir === 'TB'
    ? Math.min(4, Math.max(1, Math.ceil(Math.sqrt(count))))
    : (count > 10 ? 4 : (count > 3 ? 2 : 1));
  var rows = Math.ceil(count / cols);
  var s = NODE_SIZE.agent;
  return { cols: cols, rows: rows, width: cols*s[0] + Math.max(0, cols-1)*22, height: rows*s[1] + Math.max(0, rows-1)*18 };
}
function actualNodeSize(n){ return NODE_SIZE[n.data.kind] || [210, 64]; }
function graphNodeSize(n, dir){
  var base = actualNodeSize(n);
  if(n.data.kind !== 'terminal') return base;
  var count = n.data.agentCount || 0;
  if(!count) return base;
  var grid = agentGrid(count, dir);
  if(dir === 'TB') return [Math.max(base[0], grid.width), base[1] + 58 + grid.height];
  return [base[0] + 70 + grid.width, Math.max(base[1], grid.height)];
}
function terminalActualPosition(center, n, graphSize, actualSize, dir){
  if(n.data.kind !== 'terminal' || !(n.data.agentCount > 0)){
    return { x: center.x - actualSize[0]/2, y: center.y - actualSize[1]/2 };
  }
  if(dir === 'TB'){
    return { x: center.x - actualSize[0]/2, y: center.y - graphSize[1]/2 };
  }
  return { x: center.x - graphSize[0]/2, y: center.y - actualSize[1]/2 };
}
function positionAgentsAroundTerminals(nodes, positioned, dir){
  var byTerm = {};
  nodes.forEach(function(n){
    if(n.data.kind === 'agent' && n.data.parentTerminalId){
      (byTerm[n.data.parentTerminalId] || (byTerm[n.data.parentTerminalId] = [])).push(n);
    }
  });
  Object.keys(byTerm).forEach(function(termId){
    var term = positioned[termId]; if(!term) return;
    var agents = byTerm[termId];
    var grid = agentGrid(agents.length, dir);
    var termSize = actualNodeSize(term);
    var agentSize = NODE_SIZE.agent;
    var termCenter = { x: term.position.x + termSize[0]/2, y: term.position.y + termSize[1]/2 };
    var startX, startY;
    if(dir === 'TB'){
      startX = termCenter.x - grid.width/2;
      startY = term.position.y + termSize[1] + 58;
    } else {
      startX = term.position.x + termSize[0] + 70;
      startY = termCenter.y - grid.height/2;
    }
    agents.forEach(function(agent, index){
      var col = index % grid.cols;
      var row = Math.floor(index / grid.cols);
      positioned[agent.id] = Object.assign({}, agent, {
        position: {
          x: startX + col * (agentSize[0] + 22),
          y: startY + row * (agentSize[1] + 18)
        }
      });
    });
  });
}
// Auto-layout the logical nodes into a clean spine, then cluster agents around
// the terminal they belong to so large fleets stay readable.
function layoutTree(nodes, edges, dir, dagre){
  if(!dagre || !nodes.length) return nodes;
  var g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: dir || 'LR', nodesep: 26, ranksep: 90, marginx: 30, marginy: 30, ranker: 'tight-tree' });
  g.setDefaultEdgeLabel(function(){ return {}; });
  var spine = nodes.filter(function(n){ return n.data.kind !== 'agent'; });
  spine.forEach(function(n){ var s = graphNodeSize(n, dir); g.setNode(n.id, { width: s[0], height: s[1] }); });
  edges.forEach(function(e){
    if(g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target);
  });
  dagre.layout(g);
  var positioned = {};
  spine.forEach(function(n){
    var p = g.node(n.id); if(!p){ positioned[n.id] = n; return; }
    var actual = actualNodeSize(n);
    var graph = graphNodeSize(n, dir);
    positioned[n.id] = Object.assign({}, n, { position: terminalActualPosition(p, n, graph, actual, dir) });
  });
  positionAgentsAroundTerminals(nodes, positioned, dir);
  return nodes.map(function(n){ return positioned[n.id] || n; });
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
    try { console.error(e); } catch(_e){}
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
      h('div', { className: 'hq-ui-badge', title: 'Served from packages/cli/src/hq-dashboard-html.ts' }, 'inline fallback'),
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

  // Per-tool visual identity, mirroring @wrongstack/tools/tool-icons so HQ's
  // chat history matches the WebUI. This SPA is a served string with no imports,
  // so the data is embedded inline: name -> icon id, id -> { glyph, color, label }.
  var TOOL_ICON_MAP = {
    read:'file', cat:'file', view:'file', write:'file', create:'file',
    edit:'edit', replace:'edit', str_replace:'edit', multi_edit:'edit', patch:'diff',
    grep:'search', search:'search', rg:'search', ripgrep:'search', glob:'search', find:'search',
    folder:'folder', ls:'folder', list:'folder', set_working_dir:'folder', tree:'tree',
    bash:'terminal', shell:'terminal', sh:'terminal', exec:'terminal', run:'terminal', command:'terminal',
    fetch:'web', web_fetch:'web', web_search:'web',
    git:'git', diff:'diff',
    lint:'code', format:'settings', typecheck:'code', test:'test',
    install:'package', outdated:'package', audit:'package',
    document:'document', scaffold:'scaffold',
    todo:'todo', plan:'plan', task:'task',
    json:'json', index:'index', logs:'logs', settings:'settings',
    remember:'brain', recall:'brain', memory:'brain'
  };
  var TOOL_ICON_INFO = {
    file:{ g:'📄', c:'#60a5fa', l:'file read/write' },
    edit:{ g:'✏️', c:'#fbbf24', l:'file editing' },
    search:{ g:'🔍', c:'#a78bfa', l:'search & grep' },
    folder:{ g:'📁', c:'#38bdf8', l:'folder navigation' },
    terminal:{ g:'▚', c:'#67e8f9', l:'shell commands' },
    web:{ g:'🌐', c:'#34d399', l:'web fetch' },
    git:{ g:'⎇', c:'#a3e635', l:'git operations' },
    tree:{ g:'🌲', c:'#22d3ee', l:'directory tree' },
    code:{ g:'{}', c:'#818cf8', l:'code quality' },
    test:{ g:'🧪', c:'#4ade80', l:'testing' },
    package:{ g:'📦', c:'#f472b6', l:'package management' },
    document:{ g:'📜', c:'#94a3b8', l:'documentation' },
    scaffold:{ g:'🔨', c:'#c084fc', l:'project scaffolding' },
    todo:{ g:'☑', c:'#facc15', l:'todo tracking' },
    plan:{ g:'📋', c:'#2dd4bf', l:'planning' },
    task:{ g:'✔', c:'#5eead4', l:'task management' },
    meta:{ g:'🔧', c:'#cbd5e1', l:'tool orchestration' },
    index:{ g:'🗄', c:'#06b6d4', l:'code indexing' },
    json:{ g:'{}', c:'#eab308', l:'JSON data' },
    diff:{ g:'±', c:'#93c5fd', l:'diff & patch' },
    logs:{ g:'#', c:'#a3a3a3', l:'log viewing' },
    settings:{ g:'⚙', c:'#9ca3af', l:'configuration' },
    brain:{ g:'🧠', c:'#e879f9', l:'memory' },
    fallback:{ g:'🔧', c:'#9ca3af', l:'external tool' }
  };
  function toolIconInfo(name){
    var id = TOOL_ICON_MAP[String(name||'').toLowerCase()] || 'fallback';
    return TOOL_ICON_INFO[id] || TOOL_ICON_INFO.fallback;
  }
  // Tool-input summarizer: authored once in @wrongstack/tools and injected here
  // via a post-.replace() on this placeholder, so HQ and the WebUI share one
  // implementation. Defines toolInputSummary(name, rawInput) where rawInput is
  // HQ's JSON string. See packages/tools/src/tool-summary.ts.
  /*__TOOL_SUMMARY_SRC__*/

  function fold(key, summary, content, preClass){
    return h('details', { key: key, className: 'bub-fold' },
      h('summary', null, summary),
      h('pre', { className: preClass || null }, content)
    );
  }
  function foldContent(key, summary, child){
    return h('details', { key: key, className: 'bub-fold' },
      h('summary', null, summary),
      child
    );
  }
  function roleIcon(role){
    if(role === 'user') return '👤';
    if(role === 'tool') return '⌘';
    if(role === 'error') return '!';
    if(role === 'system') return 'i';
    return '🤖';
  }
  function roleLabel(role){
    if(role === 'user') return 'You';
    if(role === 'tool') return 'Tool';
    if(role === 'error') return 'Error';
    if(role === 'system') return 'System';
    return 'Assistant';
  }
  function countLines(text){
    if(!text) return 0;
    return String(text).split('\\n').length;
  }
  function detectToolShape(tool, result){
    var text = String(result || '');
    var trimmed = text.trim();
    function numberedLine(line){
      var t = String(line || '').trim();
      var arrow = t.indexOf('→');
      if(arrow <= 0) return false;
      var n = t.slice(0, arrow).trim();
      if(!n) return false;
      for(var i=0;i<n.length;i++){ var c = n.charCodeAt(i); if(c < 48 || c > 57) return false; }
      return true;
    }
    if(text.split('\\n').slice(0, 8).some(numberedLine)) return { kind: 'numbered', text: text };
    if((trimmed.indexOf('{') === 0 && trimmed.lastIndexOf('}') === trimmed.length - 1) || (trimmed.indexOf('[') === 0 && trimmed.lastIndexOf(']') === trimmed.length - 1)){
      try { return { kind: 'json', text: JSON.stringify(JSON.parse(trimmed), null, 2) }; } catch(_e){}
    }
    var toolLower = String(tool || '').toLowerCase();
    var isBash = ['bash','shell','exec','run','tsc','pnpm','npm','yarn'].some(function(prefix){ return toolLower.indexOf(prefix) === 0; });
    var lines = text.split('\\n');
    var last = lines.length ? String(lines[lines.length - 1] || '').trim().toLowerCase() : '';
    var exitCode = null;
    if(last.indexOf('exit') === 0 || last.indexOf('[exit') === 0){
      var digits = '';
      for(var j=0;j<last.length;j++){ var ch = last.charCodeAt(j); if(ch >= 48 && ch <= 57) digits += last[j]; }
      if(digits) exitCode = Number(digits);
    }
    if(isBash || exitCode !== null){
      return { kind: 'bash', text: exitCode !== null ? lines.slice(0, -1).join('\\n').trimEnd() : text, exitCode: exitCode };
    }
    return { kind: 'plain', text: text };
  }
  function renderLineView(text, numbered){
    var lines = String(text || '').split('\\n');
    if(!numbered) return h('pre', null, text || '');
    return h('div', { className: 'line-view' },
      h('pre', { className: 'line-gutter', 'aria-hidden': true }, lines.map(function(_l, i){ return String(i + 1); }).join('\\n')),
      h('pre', null, text || '')
    );
  }
  function renderToolOutput(e){
    var shape = detectToolShape(e.tool, e.text);
    var lineCount = countLines(shape.text);
    var cls = 'tool-output ' + shape.kind + (e.isError || e.role === 'error' ? ' error' : '');
    var footer = null;
    if(shape.kind === 'bash' && (shape.exitCode !== null || e.durationMs != null)){
      footer = h('div', { className: 'tool-output-footer ' + (shape.exitCode && shape.exitCode !== 0 ? 'bad' : '') },
        shape.exitCode !== null ? h('span', null, 'exit code ', h('strong', null, String(shape.exitCode))) : null,
        e.durationMs != null ? h('span', null, e.durationMs + 'ms') : null
      );
    }
    return h('div', { className: cls },
      h('div', { className: 'tool-output-head' },
        h('span', { className: 'tool-output-kind' }, shape.kind === 'plain' ? 'output' : shape.kind),
        h('span', { className: 'tool-output-meta' }, lineCount + ' lines')
      ),
      renderLineView(shape.text, shape.kind === 'numbered' || shape.kind === 'bash'),
      footer
    );
  }
  function renderInlineText(text, keyBase){
    var s = String(text || '');
    var bt = String.fromCharCode(96);
    var out = [];
    var pos = 0, n = 0;
    while(pos < s.length){
      var start = s.indexOf(bt, pos);
      if(start < 0){ out.push(s.slice(pos)); break; }
      var end = s.indexOf(bt, start + 1);
      if(end < 0){ out.push(s.slice(pos)); break; }
      if(start > pos) out.push(s.slice(pos, start));
      out.push(h('code', { key: keyBase + '-ic-' + n++, className: 'md-inline' }, s.slice(start + 1, end)));
      pos = end + 1;
    }
    return out.length ? out : s;
  }
  function renderMessageText(text, role){
    var raw = String(text || '');
    if(!raw) return h('div', { className: 'msg-md empty' }, '');
    var fence = String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96);
    var lines = raw.split('\\n');
    var blocks = [];
    var para = [];
    var code = [];
    var lang = '';
    var inCode = false;
    function flushPara(){
      if(!para.length) return;
      var content = para.join(' ');
      blocks.push(h('p', { key: 'p-' + blocks.length }, renderInlineText(content, 'p-' + blocks.length)));
      para = [];
    }
    function flushCode(){
      blocks.push(h('div', { key: 'c-' + blocks.length, className: 'md-codewrap' },
        h('div', { className: 'md-codelabel' }, lang || 'code'),
        h('pre', { className: 'md-code' }, code.join('\\n'))
      ));
      code = [];
      lang = '';
    }
    for(var i=0;i<lines.length;i++){
      var line = lines[i];
      if(line.slice(0,3) === fence){
        if(inCode){ flushCode(); inCode = false; }
        else { flushPara(); inCode = true; lang = line.slice(3).trim(); code = []; }
        continue;
      }
      if(inCode){ code.push(line); continue; }
      if(!line.trim()){ flushPara(); continue; }
      if(line.indexOf('- ') === 0 || line.indexOf('* ') === 0){
        flushPara();
        blocks.push(h('div', { key: 'b-' + blocks.length, className: 'md-bullet' },
          h('span', { className: 'md-bullet-dot' }, '•'),
          h('span', null, renderInlineText(line.slice(2).trim(), 'b-' + blocks.length))
        ));
        continue;
      }
      if(line.indexOf('# ') === 0 || line.indexOf('## ') === 0 || line.indexOf('### ') === 0){
        flushPara();
        blocks.push(h('div', { key: 'h-' + blocks.length, className: 'md-heading' }, line.replace(/^#+\\s*/, '')));
        continue;
      }
      para.push(line);
    }
    if(inCode) flushCode();
    flushPara();
    return h('div', { className: (role === 'assistant' ? 'assistant-body ' : '') + 'msg-md' }, blocks);
  }
  function Bubble(p){
    var e = p.e;
    var isToolish = e.role === 'tool' || e.role === 'error';
    var failed = e.isError || e.role === 'error';
    var tinfo = isToolish ? toolIconInfo(e.tool) : null;
    var inputSummary = isToolish ? toolInputSummary(e.tool, e.toolInput) : '';
    var bodyEls = [];
    if(isToolish){
      var headKids = [
        h('span', { key:'nm', className: 'tool-name' }, e.tool || 'tool'),
        h('span', { key:'cat', className: 'tool-cat' }, tinfo.l)
      ];
      if(inputSummary){ headKids.push(h('span', { key:'sm', className: 'tool-summary', title: inputSummary }, inputSummary)); }
      headKids.push(h('span', { key:'st', className: 'tool-status ' + (failed ? 'error' : '') }, failed ? 'failed' : 'done'));
      if(e.durationMs != null){ headKids.push(h('span', { key:'du', className: 'tool-duration' }, e.durationMs + 'ms')); }
      bodyEls.push(h('div', { key: 'th', className: 'tool-head' }, headKids));
      if(e.toolInput){ bodyEls.push(fold('a', 'Input · ' + e.toolInput.length + ' chars', e.toolInput, 'bub-argpre')); }
      if(e.text){ bodyEls.push(foldContent('o', (failed?'Error output':'Output') + ' · ' + countLines(e.text) + ' lines', renderToolOutput(e))); }
      if(!e.toolInput && !e.text){ bodyEls.push(h('div', { key:'n', className:'bub-sublabel' }, 'no output')); }
    } else {
      bodyEls.push(h('div', { key:'t', className: 'txt' }, renderMessageText(e.text || '', e.role)));
    }
    var avatar = isToolish
      ? h('div', {
          className: 'bub-avatar tool' + (failed ? ' error' : ''),
          title: (e.tool || 'tool') + ' — ' + tinfo.l,
          style: failed ? null : { color: tinfo.c, borderColor: tinfo.c, background: 'color-mix(in srgb, ' + tinfo.c + ' 14%, transparent)' }
        }, tinfo.g)
      : h('div', { className: 'bub-avatar' }, roleIcon(e.role));
    return h('div', { className: 'bub ' + e.role },
      avatar,
      h('div', { className: 'bub-content' },
        h('div', { className: 'bub-head' },
          h('span', { className: 'bub-role' }, isToolish && e.tool ? e.tool : roleLabel(e.role)),
          h('span', null, fmtTime(e.ts))
        ),
        h('div', { className: 'bub-card' },
          isToolish ? h('div', { className: 'tool-card' }, bodyEls) : bodyEls
        )
      ),
    );
  }
  function isToolEntry(e){ return e && (e.role === 'tool' || e.role === 'error'); }
  function ToolGroup(p){
    var tools = p.tools || [];
    var names = [];
    var seen = {};
    var errored = false;
    var totalMs = 0;
    tools.forEach(function(t){
      if(t.tool && !seen[t.tool]){ seen[t.tool] = 1; names.push(t.tool); }
      if(t.isError || t.role === 'error') errored = true;
      if(typeof t.durationMs === 'number') totalMs += t.durationMs;
    });
    var preview = names.slice(0, 4).join(', ') + (names.length > 4 ? ' +' + (names.length - 4) : '');
    var meta = preview || tools.map(function(t){ return t.role; }).join(', ');
    if(totalMs > 0) meta += ' · ' + totalMs + 'ms';
    return h('details', { className: 'tool-group', open: p.defaultOpen ? true : undefined },
      h('summary', null,
        h('span', { className: 'tool-group-title' }, tools.length + ' tool calls'),
        h('span', { className: 'tool-group-meta' }, meta),
        h('span', { className: 'tool-group-status ' + (errored ? 'error' : '') }, errored ? 'failed' : 'done')
      ),
      h('div', { className: 'tool-group-body' },
        tools.map(function(t, i){ return h(Bubble, { key: i, e: t }); })
      )
    );
  }

  function PromptDock(p){
    var targets = buildCommandTargets(p.snap);
    var preferred = selectedTargetValue(p.snap) || (targets[0] && targets[0].value) || '';
    var tvState = React.useState(preferred); var targetValue = tvState[0], setTargetValue = tvState[1];
    var textState = React.useState(''); var text = textState[0], setText = textState[1];
    var sendState = React.useState(false); var sending = sendState[0], setSending = sendState[1];
    var stState = React.useState({ text: '', cls: '' }); var status = stState[0], setStatus = stState[1];
    var typeState = React.useState('steer'); var sendType = typeState[0], setSendType = typeState[1];
    React.useEffect(function(){ if(preferred) setTargetValue(preferred); }, [preferred]);
    var target = targets.filter(function(t){ return t.value === targetValue; })[0] || targets[0] || null;
    // Broadcast targets always fan out project-wide; agent targets use the
    // selected send-type (steer / btw / queue). All types are written to the
    // project mailbox by the client dispatcher, so they land even when no
    // agent loop is actively running. HQ prompts are raw and bypass prompt
    // refinement — a steer/btw/queue is already a directive, not user input.
    var effectiveType = target && target.kind === 'broadcast' ? 'broadcast' : sendType;
    // Derive the subject from the send-type so the two never drift (a steer
    // must not carry a "queue"-flavored subject). Single source of truth,
    // computed alongside effectiveType.
    var effectiveSubject =
      effectiveType === 'steer' ? 'HQ steer' :
      effectiveType === 'btw' ? 'HQ note' :
      effectiveType === 'broadcast' ? 'HQ broadcast' :
      'HQ prompt'; // queue (and any future fallthrough)
    function submit(){
      if(!target || sending) return;
      var body = text.trim();
      if(!body){ setStatus({ text: 'Write a prompt or note first.', cls: 'err' }); return; }
      setSending(true);
      // When the target has a live command-capable client, go through the
      // control plane (/api/command). Otherwise fall back to a direct mailbox
      // write (/api/mailbox-send) so the prompt still goes out immediately —
      // it lands in the project mailbox and the next agent to run picks it up.
      var useDirect = target.direct || !target.clientId;
      setStatus({ text: useDirect ? 'Delivering to mailbox…' : 'Queueing command…', cls: '' });
      var sendPromise;
      if(useDirect){
        sendPromise = postHqMailboxSend(target, effectiveType, { subject: effectiveSubject, body: body, priority: 'high' });
      } else {
        var payload = target.kind === 'broadcast'
          ? { subject: effectiveSubject, body: body, priority: 'high' }
          : { to: target.to, subject: effectiveSubject, body: body, priority: 'high' };
        sendPromise = postHqCommand(target.clientId, effectiveType, payload);
      }
      sendPromise
        .then(function(res){
          setText('');
          var okMsg = useDirect
            ? 'Delivered to mailbox (' + (res.messageId ? shortId(res.messageId) : 'ok') + ') for ' + target.label
            : 'Queued ' + (res.commandId ? shortId(res.commandId) : 'command') + ' for ' + target.label;
          setStatus({ text: okMsg, cls: 'ok' });
          loadCommands(true);
          setTimeout(function(){ loadCommands(true); }, 2500);
        })
        .catch(function(err){ setStatus({ text: err && err.message ? err.message : String(err), cls: 'err' }); })
        .finally(function(){ setSending(false); });
    }
    var isBroadcast = target && target.kind === 'broadcast';
    var typeOptions = [
      { value: 'steer', label: 'Steer' },
      { value: 'btw', label: 'BTW' },
      { value: 'queue', label: 'Queue' }
    ];
    var sendLabel = isBroadcast ? 'Broadcast'
      : effectiveType === 'btw' ? 'Send BTW'
      : effectiveType === 'queue' ? 'Queue'
      : 'Send steer';
    return h('div', { className: 'cmd-dock' },
      h('div', { className: 'cmd-row' },
        h('select', { className: 'cmd-target', value: target ? target.value : '', disabled: !targets.length || sending, onChange: function(e){ setTargetValue(e.target.value); } },
          targets.length ? targets.map(function(t){ return h('option', { key: t.value, value: t.value }, t.label); }) : h('option', { value: '' }, 'No command-capable client')
        ),
        h('select', {
          className: 'cmd-type',
          value: isBroadcast ? 'broadcast' : sendType,
          disabled: !target || sending || isBroadcast,
          title: isBroadcast ? 'Broadcast fans out to the whole project' : 'How the prompt reaches the agent',
          onChange: function(e){ setSendType(e.target.value); }
        },
          isBroadcast
            ? h('option', { value: 'broadcast' }, 'Broadcast')
            : typeOptions.map(function(o){ return h('option', { key: o.value, value: o.value }, o.label); })
        ),
        h('textarea', {
          className: 'cmd-text',
          value: text,
          disabled: !target || sending,
          placeholder: isBroadcast ? 'Broadcast a prompt to this project…' : 'Send a prompt to the selected agent…',
          onChange: function(e){ setText(e.target.value); },
          onKeyDown: function(e){ if((e.ctrlKey || e.metaKey) && e.key === 'Enter'){ e.preventDefault(); submit(); } }
        }),
        h('button', { className: 'cmd-send', disabled: !target || sending || !text.trim(), onClick: submit }, sending ? 'Sending…' : sendLabel)
      ),
      h('div', { className: 'cmd-status ' + (status.cls||'') }, status.text || 'Ctrl+Enter sends raw (no refine) via the project mailbox. Steer = change course now · BTW = FYI context · Queue = waits its turn.')
    );
  }

  function clientLabelForCommand(snap, clientId){
    var clients = (snap && snap.clients) || [];
    for(var i=0;i<clients.length;i++){
      var c = clients[i];
      if(c.clientId === clientId){
        var project = projectNameFor(snap, c.projectId);
        return project + ' · ' + String(c.kind || 'cli').toUpperCase();
      }
    }
    return shortId(clientId);
  }
  function commandStatus(c){
    return c.ackStatus || c.status || 'queued';
  }
  function CommandHistory(p){
    React.useEffect(function(){
      loadCommands(false);
      var id = setInterval(function(){ loadCommands(true); }, 4000);
      return function(){ clearInterval(id); };
    }, []);
    var rows = (Store.commands || []).slice(0, 8);
    return h('div', { className: 'cmd-history' },
      h('div', { className: 'cmd-hhead' },
        h('div', { className: 'cmd-htitle' }, 'Control Queue'),
        h('div', { className: 'cmd-hnote' }, rows.length ? 'recent HQ commands and acknowledgements' : (Store.commandsLoading ? 'loading command audit' : 'no commands queued yet')),
        h('button', { className: 'cmd-hrefresh', onClick: function(){ loadCommands(true); } }, 'Refresh')
      ),
      rows.length ? h('div', { className: 'cmd-hlist' },
        rows.map(function(c){
          var st = commandStatus(c);
          return h('div', { key: c.commandId, className: 'cmd-hrow' },
            h('div', { className: 'cmd-htype' }, c.type || 'command'),
            h('div', { className: 'cmd-hstatus ' + st }, st),
            h('div', { className: 'cmd-hclient' }, clientLabelForCommand(p.snap, c.clientId)),
            h('div', { className: 'cmd-hmsg', title: c.ackMessage || c.commandId }, c.ackMessage || fmtAgo(c.ackedAt || c.enqueuedAt))
          );
        })
      ) : h('div', { className: 'side-empty' }, Store.commandsLoading ? 'Loading command history…' : 'No HQ control commands have been queued in this server process.')
    );
  }

  function projectNameFor(snap, projectId){
    var p = ((snap && snap.projects) || []).filter(function(x){ return x.projectId === projectId; })[0];
    if(p) return p.projectName || p.projectId;
    var s = ((snap && snap.liveSessions) || []).filter(function(x){ return x.projectId === projectId; })[0];
    return s ? (s.projectName || s.projectId) : (projectId || 'unknown');
  }
  function sessionForTimelineEntry(snap, e){
    if(e.sessionId){
      var exact = findSession(snap, e.sessionId);
      if(exact) return exact;
    }
    var sessions = (snap && snap.liveSessions) || [];
    for(var i=0;i<sessions.length;i++){
      var s = sessions[i];
      if(s.projectId === e.projectId && clientIdForSession(snap, s) === e.clientId){
        if(!e.agentId || (s.agents||[]).some(function(a){ return a.id === e.agentId; })) return s;
      }
    }
    return null;
  }
  function agentNameForEntry(snap, e){
    var session = sessionForTimelineEntry(snap, e);
    var ag = session && e.agentId ? findAgent(session, e.agentId) : null;
    return (ag && (ag.name || ag.id)) || e.agentName || e.agentId || 'leader';
  }
  function timelinePreviewText(e){
    var text = String(e.text || '');
    if(e.role === 'tool'){
      var lines = text.split('\\n');
      return (lines[0] || 'tool output') + (lines.length > 1 ? (' +' + (lines.length - 1) + ' lines') : '');
    }
    return text;
  }
  function timelineAgentOptions(snap, project){
    var opts = [];
    var seen = {};
    function add(projectId, clientId, agentId, label){
      if(!agentId) return;
      if(project !== 'all' && projectId !== project) return;
      var value = timelineAgentValue(projectId, clientId, agentId);
      if(seen[value]) return;
      seen[value] = 1;
      opts.push({ value: value, projectId: projectId, clientId: clientId, agentId: agentId, label: label });
    }
    ((snap && snap.liveSessions) || []).forEach(function(s){
      var cid = clientIdForSession(snap, s);
      add(s.projectId, cid, 'leader', (s.projectName || s.projectId) + ' · leader');
      (s.agents||[]).forEach(function(a){
        add(s.projectId, cid, a.id, (s.projectName || s.projectId) + ' · ' + (a.name || a.id));
      });
    });
    Store.timeline.forEach(function(e){
      add(e.projectId, e.clientId, e.agentId, projectNameFor(snap, e.projectId) + ' · ' + (e.agentName || e.agentId));
    });
    opts.sort(function(a,b){ return a.label.toLowerCase().localeCompare(b.label.toLowerCase()); });
    return opts;
  }

  function GlobalTimelineView(p){
    var qState = React.useState(''); var q = qState[0], setQ = qState[1];
    var prState = React.useState('all'); var project = prState[0], setProject = prState[1];
    var srcState = React.useState('all'); var source = srcState[0], setSource = srcState[1];
    var roleState = React.useState('all'); var role = roleState[0], setRole = roleState[1];
    var agState = React.useState('all'); var agent = agState[0], setAgent = agState[1];
    var agentFilter = parseTimelineAgentValue(agent);
    var requestFilters = {
      projectId: project === 'all' ? '' : project,
      source: source === 'all' ? '' : source,
      role: role === 'all' ? '' : role,
      clientId: agentFilter ? agentFilter.clientId : '',
      agentId: agentFilter ? agentFilter.agentId : ''
    };
    React.useEffect(function(){ loadRecentTimeline(requestFilters, true); }, [project, source, role, agent]);
    var ql = q.trim().toLowerCase();
    var projects = (p.snap && p.snap.projects) || [];
    var agents = timelineAgentOptions(p.snap, project);
    var entries = Store.timeline.filter(function(e){
      if(project !== 'all' && e.projectId !== project) return false;
      if(source !== 'all' && e.source !== source) return false;
      if(role !== 'all' && e.role !== role) return false;
      if(agentFilter && (e.projectId !== agentFilter.projectId || e.clientId !== agentFilter.clientId || e.agentId !== agentFilter.agentId)) return false;
      if(!ql) return true;
      var hay = [e.text, e.role, e.tool, e.agentName, e.agentId, projectNameFor(p.snap, e.projectId)].join(' ').toLowerCase();
      return hay.indexOf(ql) >= 0;
    }).slice(0, 500);
    function openEntry(e){
      var session = sessionForTimelineEntry(p.snap, e);
      if(!session) return;
      selectSession(session.sessionId, e.agentId && e.agentId !== 'leader' ? e.agentId : null);
      Store.set({ tab: 'console' });
    }
    return h('div', { className: 'timeline-wrap' },
      h('div', { className: 'timeline-head' },
        h('div', null,
          h('div', { className: 'timeline-title' }, 'All Agent Timelines'),
          h('div', { className: 'timeline-note' }, entries.length + ' visible events from recent HQ telemetry across projects')
        ),
        h('div', { className: 'timeline-filters' },
          h('select', { className: 'timeline-select', value: project, onChange: function(e){ setProject(e.target.value); setAgent('all'); } },
            h('option', { value: 'all' }, 'All projects'),
            projects.map(function(pr){ return h('option', { key: pr.projectId, value: pr.projectId }, pr.projectName || pr.projectId); })
          ),
          h('select', { className: 'timeline-select', value: agent, onChange: function(e){ setAgent(e.target.value); } },
            h('option', { value: 'all' }, 'All agents'),
            agents.map(function(a){ return h('option', { key: a.value, value: a.value }, a.label); })
          ),
          h('select', { className: 'timeline-select', value: source, onChange: function(e){ setSource(e.target.value); } },
            h('option', { value: 'all' }, 'All sources'),
            h('option', { value: 'session' }, 'Leader/session'),
            h('option', { value: 'agent' }, 'Subagent')
          ),
          h('select', { className: 'timeline-select', value: role, onChange: function(e){ setRole(e.target.value); } },
            h('option', { value: 'all' }, 'All roles'),
            h('option', { value: 'user' }, 'User'),
            h('option', { value: 'assistant' }, 'Assistant'),
            h('option', { value: 'tool' }, 'Tool'),
            h('option', { value: 'system' }, 'System'),
            h('option', { value: 'error' }, 'Error')
          ),
          h('input', { className: 'timeline-input', placeholder: 'Filter text / agent / tool…', value: q, onChange: function(e){ setQ(e.target.value); } }),
          h('button', { className: 'timeline-btn', onClick: function(){
            var rf = Object.assign({}, requestFilters, { q: q.trim() });
            loadRecentTimeline(rf, true);
          } }, 'Refresh')
        )
      ),
      h(PromptDock, { snap: p.snap }),
      h(CommandHistory, { snap: p.snap }),
      h('div', { className: 'timeline-list' },
        entries.length ? entries.map(function(e, i){
          var pn = projectNameFor(p.snap, e.projectId);
          var an = agentNameForEntry(p.snap, e);
          return h('div', { key: i, className: 'timeline-row ' + (e.role || '') + ' ' + (e.source || ''), onClick: function(){ openEntry(e); } },
            h('div', { className: 'timeline-mark' }, roleIcon(e.role)),
            h('div', { className: 'timeline-time' }, fmtTime(e.ts), h('div', null, fmtAgo(e.ts))),
            h('div', { className: 'timeline-who' },
              h('div', { className: 'timeline-agent' }, an),
              h('div', { className: 'timeline-project' }, pn + (e.source ? (' · ' + e.source) : ''))
            ),
            h('div', { className: 'timeline-msg' },
              h('span', { className: 'timeline-role ' + (e.role||'') }, e.role || 'event'),
              e.tool ? h('span', { className: 'timeline-toolchip' }, e.tool) : null,
              timelinePreviewText(e)
            )
          );
        }) : h('div', { className: 'side-empty' }, Store.timelineLoaded ? 'No timeline events yet.' : 'Loading recent HQ timeline…')
      )
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
        h(ToolBtn, { label: '⬌ LR', title: 'Left → right clustered layout', active: dir==='LR', onClick: function(){ setDir('LR'); } }),
        h(ToolBtn, { label: '⬍ TB', title: 'Top → bottom clustered layout', active: dir==='TB', onClick: function(){ setDir('TB'); } })
      ),
      h('div', { className: 'tgroup' },
        h(ToolBtn, { label: '🖥️ Machine', title: 'Group under the machine', active: groupBy==='machine', onClick: function(){ setGroupBy('machine'); } }),
        h(ToolBtn, { label: '📁 Project', title: 'Group by project', active: groupBy==='project', onClick: function(){ setGroupBy('project'); } })
      ),
      h('div', { className: 'tgroup' },
        h(ToolBtn, { label: '✨ Auto-arrange', title: 'Re-arrange with terminal-centered agent clusters', onClick: function(){ applyLayout(nodes, edges); } }),
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
      h('div', { className: 'bub-avatar' }, p.tool ? '⌘' : '🤖'),
      h('div', { className: 'bub-content' },
        h('div', { className: 'bub-head' },
          h('span', { className: 'bub-role' }, p.tool ? p.tool : 'Assistant'),
          h('span', { className: 'live-dot' }, '● streaming')
        ),
        h('div', { className: 'bub-card' },
          h('div', { className: 'assistant-body' }, renderMessageText(p.text || '', 'assistant'), h('span', { className: 'caret' }))
        )
      )
    );
  }

  function ChatView(p){
    var sel = Store.selected;
    var bodyRef = React.useRef(null);
    var stickRef = React.useRef(true);
    // A non-leader agent is a subagent (shadow) — show ITS own buffered stream.
    // The leader / a bare terminal show the session's full on-disk transcript.
    var session = (p.snap && p.snap.liveSessions || []).filter(function(s){ return s.sessionId===sel.sessionId; })[0];
    var isSub = !!(sel && sel.agentId && sel.agentId !== 'leader');
    var subKey = isSub ? cacheKey(sel.agentId, session && session.projectId, clientIdForSession(p.snap, session)) : '';
    var subMsgs = isSub ? (Store.agentMsgs[subKey] || Store.agentMsgs[sel.agentId] || []) : null;
    var tc = (sel && !isSub) ? Store.transcripts[sel.sessionId] : null;
    var entries = isSub ? subMsgs : (tc ? tc.entries : []);
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
      for(var i=0;i<entries.length;i++){
        if(isToolEntry(entries[i])){
          var group = [], start = i;
          while(i < entries.length && isToolEntry(entries[i])){ group.push(entries[i]); i++; }
          if(group.length > 1) bodyEls.push(h(ToolGroup, { key: 'tg-' + start, tools: group, defaultOpen: i >= entries.length }));
          else bodyEls.push(h(Bubble, { key: start, e: group[0] }));
          i--;
        } else {
          bodyEls.push(h(Bubble, { key: i, e: entries[i] }));
        }
      }
      if(liveText || (streaming && !isSub && liveTool)){ bodyEls.push(h(LiveBubble, { text: liveText, tool: liveTool })); }
    }
    return h('div', { className: 'chatview' },
      h('div', { className: 'chat-head' },
        h('button', { className: 'chat-back', onClick: function(){ Store.selected = null; Store.emit(); } }, '← Overview'),
        session ? h(Crumb, { s: session }) : null,
        ag ? h('span', { className: 'chat-agent' }, h('span', { className: 'dot '+(ag.status||'idle') }), ag.name || ag.id, isSub ? h('span', { className: 'subbadge' }, 'subagent') : null) : null,
        h('span', { className: 'chat-meta' }, metaText)
      ),
      h('div', { className: 'chat-body', ref: bodyRef, onScroll: onScroll }, bodyEls),
      h(PromptDock, { snap: p.snap })
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
        tabBtn('timeline', '🧾 Timeline'),
        tabBtn('map', '🧭 Map'),
        h('div', { className: 'hq-tab' + (tab==='mailbox'?' active':''), onClick: function(){ Store.set({ tab:'mailbox' }); } }, '📬 Mailbox', unread? h('span', { className:'badge' }, unread):null)
      ),
      h('div', { className: 'hq-body' },
        tab==='map' ? h(FleetView, { snap: snap }) :
        tab==='timeline' ? h(GlobalTimelineView, { snap: snap }) :
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
  loadRecentTimeline();
  loadCommands();
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
    html += '<div class="hq-top"><div class="hq-brand">📋 WrongStack HQ</div><div class="hq-ui-badge" title="Served from packages/cli/src/hq-dashboard-html.ts">inline fallback</div>';
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
        var fbTool = (e.role==='tool'||e.role==='error');
        var fbFailed = e.isError||e.role==='error';
        var fbInfo = fbTool ? toolIconInfo(e.tool) : null;
        var fbAvatar = fbTool
          ? '<div class="bub-avatar tool'+(fbFailed?' error':'')+'" title="'+escAttr((e.tool||'tool')+' — '+fbInfo.l)+'"'+(fbFailed?'':' style="color:'+fbInfo.c+';border-color:'+fbInfo.c+'"')+'>'+escAttr(fbInfo.g)+'</div>'
          : '<div class="bub-avatar">'+escAttr(roleIcon(e.role))+'</div>';
        var head = '<div class="bub '+escAttr(e.role)+'">'+fbAvatar+'<div class="bub-content"><div class="bub-head"><span class="bub-role">'+escAttr(fbTool&&e.tool?e.tool:roleLabel(e.role))+'</span><span>'+fmtTime(e.ts)+'</span></div><div class="bub-card">';
        var body;
        if(fbTool){
          var fbSum = toolInputSummary(e.tool, e.toolInput);
          body = '<div class="tool-card"><div class="tool-head"><span class="tool-name">'+escAttr(e.tool||'tool')+'</span><span class="tool-cat">'+escAttr(fbInfo.l)+'</span>'+(fbSum?'<span class="tool-summary" title="'+escAttr(fbSum)+'">'+escAttr(fbSum)+'</span>':'')+'<span class="tool-status '+escAttr(fbFailed?'error':'')+'">'+escAttr(fbFailed?'failed':'done')+'</span>'+(e.durationMs!=null?'<span class="tool-duration">'+e.durationMs+'ms</span>':'')+'</div>';
          if(e.toolInput) body += '<details class="bub-fold"><summary>Input · '+e.toolInput.length+' chars</summary><pre class="bub-argpre">'+escAttr(e.toolInput)+'</pre></details>';
          if(e.text) body += '<details class="bub-fold"><summary>'+(e.isError?'Error output':'Output')+' · '+countLines(e.text)+' lines</summary><pre>'+escAttr(e.text)+'</pre></details>';
          body += '</div>';
        } else { body = '<div class="'+escAttr(e.role==='assistant'?'assistant-body':'txt')+'">'+escAttr(e.text||'')+'</div>'; }
        html += head + body + '</div></div></div>';
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

// The served HQ document: HQ_HTML_TEMPLATE with the shared tool-input
// summarizer injected at the placeholder. A replacer FUNCTION is used so any
// dollar sign in the injected source is not treated as a String.replace
// special replacement pattern.
export const HQ_HTML: string = HQ_HTML_TEMPLATE.replace(
  '/*__TOOL_SUMMARY_SRC__*/',
  () => SUMMARIZE_TOOL_INPUT_BROWSER_SRC,
);

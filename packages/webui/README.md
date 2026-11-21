# @wrongstack/webui

React 19 + Vite browser client for WrongStack. The WebSocket and HTTP backend is
published separately as [`@wrongstack/webui-server`](../webui-server); the CLI
starts both surfaces with `wstack --webui` (equivalent to `wstack webui`).

## Browser element context and independent automation checks

In the Browser dock, choose **Pick element**, select a point in the live
preview, then review the selector, visible text, computed styles and cropped
image. **Add to prompt** appends the context and image to the current
conversation's unsent draft; sending remains the usual composer action. The
picker reads the page without clicking it. It rejects another conversation's
browser and detects URL changes. The capture describes the live DOM at selection
time; it is not a source-component mapping. Open shadow roots are inspected;
closed roots and cross-origin frames expose their containing element.

The Automations screen in WebUI accepts one independent verification
command per line and shows actual check exits separately from agent completion.
See [the automation guide](../../docs/subcommands/automation.md) for its isolation
and evidence contract.

`bun packages/webui/tests/competitive-improvements-browser-smoke.mjs` checks the
real forms and context/image composer flow at desktop and phone widths, using a
fixture API/transport. The real DOM picker is covered by
`packages/browser-tools/tests/browser-live-view.test.ts`; the independent Docker proof is
`bun packages/runtime/scripts/automation-verification-smoke.ts --image <trusted-image-with-git>`.

In **Settings > MCP Servers > MCP tasks**, inspect tasks saved for the open
session, retry recovery, or request cancellation. Recovery observes the existing
remote task; it does not run the tool again. The server confirms final task status
after a cancellation acknowledgement. Status and result-collection updates arrive
over WebSocket. Reconnecting requests a fresh snapshot; hidden panels unsubscribe.
Legacy hosts or interrupted streams fall back to five-second refreshes while visible.

`bun packages/webui/tests/mcp-tasks-browser-smoke.mjs` checks the production panel
at desktop and phone widths through the real route handlers, task journal and MCP
registry against a local HTTP MCP server, using a real WebSocket connection and
checking live changes without clicking Refresh. Build `@wrongstack/mcp` and
`@wrongstack/webui-protocol` first; no provider credentials are required.

## Development commands

From the workspace root:

```bash
bun run --filter @wrongstack/webui dev
bun run --filter @wrongstack/webui build
bun run --filter @wrongstack/webui typecheck
bun run --filter @wrongstack/webui test
bun run --filter @wrongstack/webui test:coverage
```

The Vite development server serves the frontend. A functional agent session also
requires the WrongStack WebUI backend; use `wstack --webui` for the integrated
surface.

## Visual system and browser checks

`src/index.css` owns the theme palettes and the global square-corner contract;
radius tokens and rendered CSS corners stay at zero, including portaled overlays.
SVG artwork and provider brand paths retain their original shapes. `src/workbench.css`
defines shared surfaces, component motion and responsive welcome layouts.
`src/pages.css` defines page headers, metric cards, content panels and responsive
detail layouts. `WorkbenchArt.tsx` and `PageMotif.tsx` supply inline vectors that
follow the active palette and distinguish workflow, knowledge and system pages.
`src/interactions.css` adds state-driven tool indicators, disclosure transitions,
selection feedback, session tabs, queue cards and toast progress. `ActivitySignal`
renders running, success, error and pending states with inline SVG.
Motion respects `prefers-reduced-motion`, and animations pause in parked views.

Run `bun run --filter @wrongstack/webui test:workbench-visual-browser` with the
installed Playwright Chromium runtime to check light/dark layouts at desktop,
tablet and phone widths, launcher folding, navigation, dialog focus restoration,
menus and reduced motion. It discovers every route from `VIEW_REGISTRY` and
renders each at desktop/phone widths in both themes, including setup and
diagnostic views. Populated Kanban, agent and memory fixtures additionally check
card movement, usable agent details on mobile, and memory search.
Interaction checks cover 320/390/768/1440px in both themes: advancing tool motion,
result states, model search and Escape focus, real clipboard writes, queue
removal, inspector dismissal, toast lifetime styling and reduced motion.
Set `WEBUI_VISUAL_INTERACTIONS_ONLY=1` to run just these interaction checks.
Set `WEBUI_VISUAL_PROVIDERS_ONLY=1` to check provider key cards, catalog and saved
profiles at 320/390/1440px in both themes, including local SVG loading and custom
provider fallbacks. Logos live in `public/provider-logos/` with their pinned
source and license; `ProviderLogo` is shared by setup, settings and account sign-in.
Screenshots are saved under `.temp_files/webui-workbench-visual/` at the workspace
root. The fixture replaces the WebSocket transport; it does not validate live
provider requests or backend operations.

## Package boundaries

- `src/components/`, `src/hooks/`, and `src/stores/` implement the browser UI.
- `src/lib/` contains browser-side protocol and formatting utilities.
- `@wrongstack/webui-server` owns the Node.js server implementation used by the CLI.
- `src/server/index.ts` is a temporary compatibility re-export of
  `@wrongstack/webui-server`; it is not a second backend implementation.

See [TESTING.md](./TESTING.md) for the package test and coverage policy.

## License

MIT

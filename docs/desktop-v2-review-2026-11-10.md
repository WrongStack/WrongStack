# Desktop v2 product and WebUI parity review

Reviewed: **2026-11-10**. Source baseline: `a6211d4792ceb1758bb9f8116fa0dd8958b8e74f`, shared `main`, including the pre-existing working changes. Both frontend manifests and the Tauri configuration identify **1.5.6**. The baseline investigation preceded the implementation checkpoint below.

Desktop v2 already contains the major product workspaces. The remaining problem is the consistency of complete workflows: how users reach a capability, retain their place, understand its scope, recover from failure, and inspect its result. Adding more screens should follow closure of these workflow gaps.

The highest priorities are renderer fault containment, correct design-source classification, and acceptance of one identified native package. Navigation inventory is substantially covered, while action, lifecycle, visual and packaged-runtime parity remain separate questions.

## Current action matrix

The implementation checkpoints preserve their own receipts below, including each artifact and harness identity. This table tracks what they permit us to conclude now; it does not transfer a browser result to an untested native scenario.

| Findings | Current evidence | Remaining acceptance or decision |
| --- | --- | --- |
| R01, R02, R08 | Implemented; permanent regressions and browser failure/input/localization controls passed | Packaged renderer-failure recovery and localized shared-dialog controls |
| R04, R05 | Shared reference form and result actions implemented; native prepared-draft ownership, real extraction progress and artifact navigation passed on pair `d11e404d121f-759d13e29a40`. R24 adds scoped abrupt-interruption acceptance on its own pair | Native validation-pending owner changes and multi-page partial failures remain separate; reload check waits for host layout acknowledgement |
| R09 | R25 retains per-run reports and labels legacy aliases latest. R26 adds independent known-report navigation and closes the retained-report native gate on pair `298bab148af4-9a54b0cb2e61` | General service startup, project-level not-inspected/blocked state and brief-to-review continuity remain open. Overwritten legacy bytes are not recovered |
| R06 | Desktop retains grouped UI/code controls; fallback, terminal, Monaco and 800×600 native zoom were exercised | Independent WebUI font roles/presets remain an explicit product difference |
| R07 | Native Files/Run returns, disclosure/draft/focus and following-mode controls passed at 1280×840 and 800×600 on pair `f2f66f2c7c0a-759d13e29a40`; twelve paused-return measurements had 0 CSS px drift. Round 21 adds three native passes for pending-question arrival and retained conversation review on the same pair | R22 accepts typed question answers through renderer reload on its new pair. Reading-position restoration across reload, cross-session and app/engine restart remain separate |
| R03 | Dated Windows packages retain scoped native acceptance. R26 removes explorer-listing dependence; R27 proves and fixes a retired-socket error that can reject a replacement Session Catalog handshake, with source/public-Core regressions and three actual cold IPC cycles | General startup causes remain open. R27 is not in a rebuilt Desktop binary. Full Core has a FileHandle exception and unchanged test-type debt; complete native/platform/microphone acceptance remains separate |
| R10 | Shared contracts and narrow fixes retained; large component owners remain maintenance observations | Extract only when a measured defect or workflow change requires it |
| R11 | This current matrix separates implementation, package acceptance and historical findings; the older ledger links here and identifies itself as historical | Keep dated receipts and explicit remaining acceptance as work continues |
| R12 | Current installer size, startup, service memory and terminal/tree/transcript workloads measured | Size/startup/terminal targets remain unmet in the measured run; define a matched blank-idle workload for the RAM target |
| R13 | False-success guard implemented; isolated-controller standalone replacement passed three times and through the permanent command. Renamed-product removal still needed one retry | First-attempt removal reliability, broader shutdown cases and remaining release/platform acceptance stay open |
| R14, R15 | Failure reason no longer depends on the caller's saved register; both reasons use the seven-language NSIS catalog. Source-bound native message checks passed 31 cases on three runs | Actual Abort arguments and caller state are covered; visual installer layout and a deliberately persistent mapped-image refusal were not exercised |
| R16 | Standalone installer's native fixture now uses explicit process creation flags and verifies separation from the controller console; original failure reproduced, three passing verifications and permanent command | The full installer fixture already isolates its console; its first-attempt uninstall failure has a separate, unresolved cause |
| R17 | Native nested-package artifact failure reproduced with a passing root-session control; design cards now use the validated engine-reported root. The rebuilt UI and unchanged accepted engine passed the complete handoff scope | UI-only local package; the last full backend attempt failed plugin-panel declarations and was not rerun in R18. Other native scopes retain their dated pair/harness receipts |
| R18 | Main-window immediate reload selection loss fixed; old package failed the gated native assertion, and new pair `7ceef93287ab-759d13e29a40` passed with the same harness. Three repeated focused runs, full Desktop suite and types passed | Closing the whole app before the host save, project-window selection recovery and broader host-write ordering remain separate boundaries |
| R19 | Find with an expanded activity could hide the message above a short pane. Start alignment fixed it; real-Virtualizer RED/control/GREEN, three durable browser passes and same-harness native before/after receipts | Other native scenarios retain their dated pair/harness receipts; the separate growing-message defect is addressed in R20 |
| R20 | Automatic following could outlive a wheel pause and replay its end target. The original failing browser proof now passes; the same native harness fails the old UI and passes the new UI at both viewport sizes, with 0 px drift during message growth | Native stream acceptance deliberately holds measurement timeouts; ordinary browser timing also passed. R21/R22 add native question tool/reload controls; reading-position reload/restart/cross-session recovery remains separate |
| R22 | Typed answers were lost when the renderer reloaded a still-pending question. Request-owned native drafts now restore them; the same harness fails the old archive and passes three rebuilt-package runs, including six exact answer recoveries | R23 adds warm UI and cold host/engine restart acceptance for acknowledged free-text answers. Native conflict-choice/load-failure UI and other package scopes remain separate |
| R23 | Interrupted questions could remain actionable and reappear after reconnect. Host status and engine-epoch transitions now retire stale actions while preserving read-only answer recovery. The unchanged native harness fails the old archive and passes pair `689820a9bb3f-759d13e29a40`, including actual clipboard paste | Accepted for acknowledged free-text answers at the default native size. Native selected/delegated answers, multi-window conflicts, compact recovery and general profile-service recovery remain separate |
| R24 | A killed engine's extraction stayed live in Run activity. Host status now stops unfinished rows; recorded process boundaries retain that state during a new run and separate reused tool ids. The same native harness fails the old archive and passes pair `f3d89c4b1e1f-759d13e29a40` with two real extraction controls | Native compact recovery, actual partly written files and multi-page partial failures remain separate. Two startup/restart setup failures are retained as unresolved reliability concerns |
| R25 | Inspect/compare retain reports, input DNA and measured assets per run; canonical latest aliases remain compatible. R26 completes matched-H3 native acceptance: old archive FAIL 312 s, new pair `298bab148af4-9a54b0cb2e61` PASS 115 s with four genuine calls and both navigation pairs | Legacy overwritten bytes, pruning policy and broader service reliability remain open. R25's full Tools gate remains non-green; earlier failed native attempts retain their dated evidence |
| R26 | A known report could never be read if explorer listing stalled/refused. Caller-validated design files now open independently; separate loading states keep the explorer truthful. Preserved-source RED, three focused/browser repeats, full Desktop/types and the identified native archive pass | Listing-failure acceptance is source/browser; native acceptance uses normally responding services. General cold-start Session Catalog diagnosis remains the next bounded scope |
| R27 | An obsolete socket's late error could reject the next handshake. One socket-identity guard fixes the public-client race; four source/compiled cases pass three repeats and three real Windows cold daemon cycles complete | Broad gates stay non-green: one full-suite FileHandle exception; 229 identical before/after test-type diagnostics in 59 files. Native Desktop binaries were not rebuilt; no all-startup-failures or release PASS claim |

## Current implementation checkpoint

The first reliability batch implements **R01, R02 and R08**. The design workflow checkpoint below records the subsequent changes. Detailed findings preserve the original review baseline.

| Finding | Implemented behavior | Verification |
| --- | --- | --- |
| R01 | A workspace error retains the shell/navigation and offers Mission Control or an explicit window reload. Navigation resets the failed workspace boundary. A separate root boundary offers reload when the shell itself cannot render. Recovery text ships in all seven languages; reload warns about unsaved changes | Permanent App regression; six real Chromium cases cover module rejection, view render error and root error in EN/dark/1480×960 and TR/light/800×600, including navigation and reload recovery |
| R02 | Explicit HTTP(S) sources take precedence over HTML suffixes; local HTML suffix detection is case-insensitive | Eleven permanent source/workflow cases; original browser assertion now passes with the same HTTPS/local controls |
| R08 | Shared confirmation defaults follow the common translation catalog live; explicit caller labels remain intact | Permanent open-dialog language-switch and explicit-label/acknowledgement tests; original browser assertion now passes |

The three new test files passed **14 tests on three consecutive runs**. The three original audit contracts also passed unchanged against current source. No native executable was rebuilt or exercised for this batch, and no release parity claim follows from these frontend results. Source changes preserve the unrelated existing working changes.

Final package checks: **325 test files / 1,175 tests passed**, production types passed over **767 files**, and the frontend production build passed. Scoped Biome checks and `git diff --check` passed. The build retains its large-chunk advisory, and Biome reports the repository's existing schema/CLI version advisory; neither configuration was changed by this batch.

The durable browser check is `bun run --filter @wrongstack/desktop-v2 test:render-recovery`. Evidence for this batch is retained under `.temp_files/desktop-v2-reliability-2026-11-10/`; browser receipts and screenshots are under `.temp_files/desktop-render-recovery/`.

## Design workflow checkpoint 2026-11-11

**R04 and R05 are implemented in the Desktop source.** Conversation Tools opens the reference form in an existing conversation. Project Design Studio uses the same form and requires a conversation from that project. The launcher prepares an append to the draft and keeps sending under the user's control. Draft validation checks revision conflicts before saving. The conversation launcher also rejects an append if its draft or owner changes while validation is pending. The welcome screen retains its four-stage overview.

The form offers extraction alone, web theme generation and React Native theme generation. Its instructions use the actual reported `DESIGN.md` path for capture and explain that a pinned kit takes precedence during materialization. The live card reads progress from the journal and presents a file action for a reported project-relative specification after successful extraction. A failed or interrupted tool call has no completed artifact action. File navigation resolves the artifact at the owning project root, including from a nested working directory.

| Check | Observed result |
| --- | --- |
| Desktop test suite | **327 files / 1,193 tests passed** |
| Production typecheck and frontend build | **771 files without type errors**, production frontend build passed |
| Chromium workflow | Existing draft preserved, no `user_message` sent, React Native prompt prepared, journal progress advanced, the actual tool output routed to the correct project path, and Studio excluded foreign and terminal sessions |
| Visual check | English dark conversation and Turkish light Studio at 800×600. The development browser logged one ResizeObserver notification warning during the fixture run |
| Actual tool workflow on a local HTML fixture | Five viewport measurements produced a 10-section `DESIGN.md` that passed document lint. Capture read 90 token values. Web and React Native materialization wrote theme files. Rendered inspection reported 0 FAIL and 0 WARN. Comparing the fixture against its own reference matched 26/26 measured properties |

The Chromium scenario uses controlled engine responses and checks the route and file target. The extraction, capture, materialization, inspection and comparison commands ran separately against a real fixture. Evidence is under `.temp_files/desktop-design-flow-2026-11-11/`.

## Rendered review checkpoint 2026-11-11

The conversation and Run activity now show rendered inspection findings and fidelity scores for **R09**. The cards display the measured target, reference where applicable, viewport widths, and completion-frame time when present. A failed or interrupted call has no completed report action. A successful call can still report layout or accessibility findings. A clipped result without measurements shows an unavailable state. If the engine reports a write to a known artifact in the owning project, the user can open it from the card.

The shared reference form in Conversation Tools and Project Design Studio now offers rendered inspection and fidelity comparison. Inspection takes an implementation URL or local HTML file and a page or application surface. Comparison also takes an extracted reference name. Both prepare a conversation draft. Studio requires the user to choose an agent conversation in the current project.

| Check | Observed result |
| --- | --- |
| Actual `design_reference` tool on two local HTML pages at 1024 and 375 px | Clean page **0 FAIL / 0 WARN**. Broken page **3 FAIL / 0 WARN**. Comparing the reference to itself yielded **100%**, and comparing the altered page yielded **60%**. The tool wrote each expected Markdown report |
| Chromium with real tool output projected through the production serializer and path normalizer | Five scenarios passed across English dark and Turkish light layouts. Both prompts preserved the draft and sent no message. Conversation and Run activity routed the report to the owning project from a nested working directory. Studio required a same-project conversation |
| Desktop validation | **328 test files / 1,204 tests passed**. Production typecheck covered **773 files**. Frontend build and scoped Biome checks passed |

The browser fixture controls the engine connection and observes the Files route and file target. At this checkpoint the engine reused report paths on repeat runs, so an older card retained its measurements while opening newer bytes. R25 below fixes future result identity and labels legacy shared paths explicitly; its complete native acceptance remains open. A missing review call still has no project-level review status. Evidence, including the measured outputs, browser receipts and screenshots, is under `.temp_files/desktop-design-review-2026-11-11/`.

## Conversation reading position checkpoint 2026-11-11

**R07 is implemented for tool visits within a conversation.** Returning from Files or Run activity keeps the same visible message and offset, including an open tool disclosure. The Desktop keeps the virtualized transcript mounted and hidden during the visit. This preserves its measurements and disclosure state while the composer and tool panels retain their existing mount lifecycle. An earlier Find jump runs again only when a new target is selected, so background replies cannot recenter an old search result.

The Chromium regression drives the production conversation workspace, transcript, and engine reducer at 1280×840 and 800×600. The original Files return lost the message and jumped to `scrollTop: 0`. The fixed return stays within 2 CSS px of the recorded message offset. The scenarios also check keyboard return, hidden transcript controls, an unsent draft, incoming text while paused and while following, and a question that arrives during a Files visit.

Run the regression with `bun apps/desktop-v2/tests/transcript-tab-return-browser.mjs`. The fixture supplies the engine connection and the Files content boundary. The result covers in-session tab visits. Cross-session and restart restoration and the packaged Windows executable remain outside this verification. Evidence is under `.temp_files/desktop-reading-position/`.

## Typography and minimum-window zoom checkpoint 2026-11-11

**R06 retains the Desktop’s two font controls and native window zoom.** The interface choice covers the shell, chat reading text and the body of shared panels. The code choice covers inline code, code blocks, Monaco, the diff editor and xterm. The latter surfaces now use the same Cascadia Code → Consolas → monospace default shown in Appearance. A named installed font can fall back to the default stack, as the localized settings now explain. Shared display headings retain their existing display styles.

WebUI still exposes independent display, reading, editor and terminal families, ten presets with bundled or lazy-loaded fonts, and separate editor and terminal sizes and line heights. Desktop groups those choices and uses the machine’s installed font catalog for custom families. Monaco and code blocks use the code ligature setting. xterm uses its own rendering and font measurement.

At a physical client size of 800×600, 150% and 200% zoom yield 533×400 and 400×300 CSS px respectively on the tested Windows configuration. The previous body stayed 620 CSS px wide. The compact rail now opens the project and session explorer on demand, supports Escape and pointer dismissal, and restores keyboard focus on Escape. In a short viewport the focused workbench scrolls vertically so the transcript, input and send action remain reachable.

| Check | Observed result |
| --- | --- |
| Current-source Windows WebView2 development build | Native zoom at 100%, 125%, 150%, 175% and 200% fit the 800×600 client. At 200% the explorer opened and closed, a real terminal rendered PowerShell output and retained a measurable grid, and Ctrl+0 returned to 100% |
| Chromium font and layout checks | Geist rendered chat and shared interface text, including fallback for a missing named font. Code, Monaco, diff and terminal used the advertised default stack. Choosing Consolas updated the active widgets. The compact appearance controls and conversation send action remained reachable |
| Desktop package | 328 files and 1,204 tests passed with six workers. Production typecheck covered 773 files. Frontend build, scoped Biome and `git diff --check` passed |

The Windows test used a hidden development build from this checkout and an isolated profile and PTY. The first native editor attempt stopped before editing because the fixture file did not appear in the project tree. The editor font checks used the production Monaco components in Chromium. The package checkpoint below follows the missing file to its cause. Evidence for the typography round is under `.temp_files/desktop-typography/`.

## Windows package and project scope checkpoint 2026-11-11

The baseline packaged app opened the parent repository when Desktop registered a nested folder without a project marker. A sibling with its own marker opened normally. The project engine's `session.start` reported the parent root, and Files listed a file that only existed in the parent. Desktop now tells project and profile services to boot at the exact directory selected by the host. On the rebuilt package the engine reported the registered folder and Files showed its own TypeScript file. The parent-only file was absent from the tree.

The current Windows x64 NSIS installer was built locally with pinned Bun 1.4.3 and a source fingerprint check across the build. The archive is **52,143,112 bytes (49.73 MiB)**, above the historical 15 MB target. Its SHA-256 is `4b971e215580c5c76c643a5d0c015e0c8e90d32fc95e05dee4d220c1ba446793`. The engine payload matches the guarded build hash. The application payload differs from the portable application in three bytes, which are the Tauri NSIS bundle-type marker. The tested pair came from the installer archive and has identity `3019a97f5008-759d13e29a40`.

On that pair, both project cases opened in Monaco. At a real 800×600 Windows client size, 200% zoom produced a 400×300 CSS viewport. The editor displayed the expected TypeScript with Cascadia Code first in its font stack. The document width matched the available client width and Ctrl+0 restored the normal view. Core path-resolution and boot tests passed 31 cases. WebUI server boot tests passed 12 cases. Typechecks passed for Core, WebUI server and Desktop.

Four selected native scenarios completed on the installer payload. Files covered version-bound saves, index readback, stale edits, conflict variants, a 3,000-file virtual tree, bulk operations and Git history. Display preferences covered two-window synchronization and reload. Design covered draft recovery, project isolation, theme generation and disk readback. Performance exercised the native workload below. The four-scope receipt is `.temp_files/desktop-parity-acceptance/matrix-2026-11-11T01-13-10-743Z/matrix.json`.

The initial performance helper included unrelated processes through reused Windows parent PIDs and read the default portable directory while the run used an explicit package. The helper now checks process creation times before following a parent link and respects the selected package. A permanent regression covers stale PIDs, valid descendants and unknown creation times. The corrected performance rerun passed on the same payload with its own harness identity, recorded in `.temp_files/desktop-parity-acceptance/matrix-2026-11-11T01-26-28-597Z/matrix.json`.

| Corrected Windows workload | Observed result |
| --- | --- |
| Fresh native UI and host launch | Shell rendered in **5.533 s**, host connected in **5.559 s** |
| Reopen UI over the running host | Host connected in **3.178 s**. This measures a UI relaunch |
| Quiescent test profile and project services after setup | **3,318.5 MiB private bytes** across the owned UI, WebView2, native host and service processes. The workload includes initialized profile/project services |
| 20,000-file project tree | Refresh **1.880 s**, 1,000-file folder expansion **77 ms**, **37 mounted rows** |
| 3,000-line reply | Send-to-render **3.722 s**, scroll-frame p95 **17 ms** |
| Three terminals, 30,000 lines each | All finished in **4.678 s**, **19,239 lines/s combined**, visible-frame p95 **17 ms** |

The current 15 MB installer and 2 s cold-start targets were exceeded in this local workload. The 150 MB idle target needs an explicitly matched idle workload before comparison. The three-terminal run was below the historical 30,000 lines/s aggregate target. The measurements describe this Windows machine and run. Other native scopes, other operating systems and installer execution remain open.

The full Desktop suite passed **1,207 tests in 329 files**. The full WebUI server suite completed with **3,595 passing tests and three 60-second Git-test timeouts**, plus a locked temporary-directory cleanup error. The focused boot checks passed. Rust host tests passed **44**, with one ignored benchmark. The native scenarios above completed independently of the server unit-suite failures.

Evidence, the local installer and checksum records are under `.temp_files/desktop-native-acceptance/`.

## Installer engine release checkpoint 2026-11-11

**R13 is a newly reproduced package defect.** A single Restart Manager shutdown closed the main engine but left a background engine process holding the installed executable. The installer then returned **0** while leaving the old engine bytes in place. The full renamed-product installer test failed its new-engine-size assertion. A second, registry-free NSIS fixture reproduced the same failure with asynchronous installer execution: one engine process remained and NSIS reported a copy error. An unlocked-file control copied the exact expected bytes.

The Windows hooks now check the exact installed engine path again after shutdown and probe exclusive write access with `OPEN_EXISTING`, without changing the file. After a shutdown they allow ten file-release probes at 100 ms intervals before requesting another shutdown, with at most five process checks. Tauri's interactive consent is retained. An image that remains unwritable aborts with code **2**. Both install and uninstall use the check.

This distinction matters: an intermediate trace saw two successful shutdown calls while the image was still locked, followed by `RmShutdown` returning **350** on the next call. Microsoft identifies that value as [`ERROR_FAIL_NOACTION_REBOOT`](https://learn.microsoft.com/windows/win32/api/restartmanager/nf-restartmanager-rmshutdown). The hook now waits for file release separately from further process shutdown. The trace establishes the returned code on this fixture, not a requirement to reboot this machine. These checks do not represent every historical host version or a full operating-system upgrade matrix.

| Check | Observed result |
| --- | --- |
| Before-fix controls | Full generated NSIS and independent registry-free fixtures reproduced old bytes after a reported-success update. The unlocked copy control wrote the exact expected bytes |
| Final permanent regression assertions | First install, read-only-file refusal with code **2**, running-engine control and successful replacement passed on **three consecutive runs** against the final hook snapshot `ac9ae5c9d1f3…`. The live file matched that snapshot before and after acceptance. The same assertions rejected the previous committed hook, which returned success for the unwritable file |
| Full generated NSIS acceptance on the final hook | A uniquely named product installed, updated over a running engine and uninstalled over a running engine, all on the first attempt. Registration and shortcuts were removed. The existing WrongStack Desktop registration matched the before snapshot. An earlier intermediate-hook uninstall had needed the fixture's existing single retry; that recovered failure remains in its own receipt |
| Real conversation update | The explicit installer payload started an agent conversation. The legacy pinned engine was locked as expected; private host and engine copies allowed replacement while the conversation was running. A relaunch removed the previous host's private folder |
| Git tests from the previous timeout run | **3 files / 11 tests passed** unchanged with one worker and the original 60-second per-test limit |
| Full WebUI server rerun with four workers | **389 files / 3,596 tests passed**, with **two Git-test timeouts**. This full parallel run remains failed |
| Full WebUI server with one worker | **391 files / 3,598 tests passed**, using the original 60-second per-test limit and no excluded files |

The full installer fixture uses uncompressed copies of the generated script and distinct product/registration names. Compression is retained in the locally rebuilt product installer. The copy/release regression has no product registration or shortcut writes. Both fixtures use only owned test directories and a loopback provider.

The conversation update test now opens an actual conversation, honors `WRONGSTACK_DESKTOP_TEST_PORTABLE` and asserts cleanup completion. Its earlier command-line ownership filter also matched its own PowerShell query, causing needless cleanup waits. Only fixture executables and WebView2 processes carrying the fixture's data path now count as owned processes. The default `dist-native/latest.json` selection was unchanged. The release fixture also waits for owned process termination and the spawned engine's `close` event before preparing the next case; merely issuing `Stop-Process` had produced an `EBUSY` setup failure.

The hook changed concurrently during validation. The package/source comparison rejected that mismatch, and the concurrent edits were preserved. The final file was captured as an immutable snapshot and passed the same regression assertions three times; full installer acceptance used that snapshot and a unique product/publisher identity. The live source remained `ac9ae5c9d1f3aa7225afde7d579f0fc495ea155aa3bd86baf5f281d24f295f33` throughout those final checks and packaging.

The concurrent edit added a readable-file check and separate failure messages. Current assertions cover exit codes, executable bytes and process ownership. Message correctness and localization remain open. In particular, the source restores `$8` before its failure-message branch compares `$8`; that message-selection path needs a dedicated runnable proof. It is a source observation, not a newly certified runtime finding.

The replacement local installer is **52,146,566 bytes**, SHA-256 `0f326c804b941bba3d45174972821a6dcc8aa32422a69e4dd5326da43bc5f473`, under `.temp_files/desktop-native-followup/package-ac9ae5c9d1f3/`. Its archived UI and engine were extracted and verified against the same accepted pair `3019a97f5008-759d13e29a40`. The packaging-only rebuild uses the guarded build's generated script, unchanged executable payloads and a recorded copy of the accepted hook. The original installer remains the before-fix artifact; earlier local hook packages are preserved separately. These packages are local and unpublished. NSIS retained its seven missing legacy `choowHowToInstall` language-string warnings.

Follow-up receipts, the red/green regression evidence and source/package hashes are under `.temp_files/desktop-native-followup/`. Earlier matrix receipts cover four selected scopes on the byte-identical executable payload, each with its recorded harness fingerprint. The follow-up installer and conversation checks remain separate receipts. A complete current-harness matrix, other platforms and physical audio are still open.

## Native failure messages and journey checkpoint 2026-11-11

**R14 and R15 are reproduced and fixed.** The refusal branch restored caller register `$8` before using it as the probe result. The same readonly file therefore reported an unwritable installation when the saved value was 1, but a running engine when it was 0. The fix selects the reason before restoring caller registers on both branches. Separately, both Abort messages were hardcoded English. Native `LangString` entries now cover English, Turkish, German, French, Italian, Spanish and Brazilian Portuguese.

The permanent check is `bun run --filter @wrongstack/desktop-v2 test:native-installer-messages`. It compiles the production hook with observation-only writes immediately before Abort, selects the real NSIS language table during initialization, and records the actual argument. It uses Windows readonly permissions with writable and missing-file controls, verifies preserved bytes and caller registers, and exercises both install and uninstall hooks. All seven install refusal languages and English/Turkish uninstall refusals are exercised; both message catalog entries resolve in all seven languages. This verifies text and control flow rather than installer window layout. The held-image message's catalog is checked without manufacturing a permanently held image to force that branch. [NSIS documents Unicode file output](https://nsis.sourceforge.io/Docs/Chapter4.html?title=SetDetailsPrint) and [BOM-based source encoding detection](https://nsis.sourceforge.io/Docs/Chapter3.html).

| Check | Observed result |
| --- | --- |
| Unchanged permanent check against the captured pre-fix hook | **FAIL** on readonly English refusal with saved `$8=0`; writable/missing-file controls passed first |
| Separate locale proof against the pre-fix hook | **FAIL**: verified Turkish language table, actual English Abort argument |
| Current hook message checks | **31 cases passed on three consecutive runs**, bound to hook SHA-256 `f6b475f18b5c346bdf5a075e8e5f81109902304b48295ebdd83443d765e4f105` |
| Full generated NSIS fixture with unique product identity | Install and running-engine update passed; uninstall first returned **2**, then the existing one-retry allowance passed. Registration, shortcuts and fixture processes were removed; the installed WrongStack registration was unchanged |
| Packaged native Design | **PASS**, 131 s: kit selection, semantic theme editing, disk readback, verification status, draft recovery and project isolation |
| Packaged native Composer | **PASS**, 1,053 s: conversation/PTY reload and restart, draft ownership, questions, model/effort, queue/stop/steer, refinement, attachments, tool approvals, next steps and Code Assist write/compare/restore |
| Latest standalone real-engine release check | First install, readonly refusal and hook-free running-engine controls passed; hook-enabled update returned **2**, failing the required **0**. This gate remains **FAIL** |

The standalone engine needed 48.594 s and 46.524 s to become ready in the last run. Earlier runs failed the original approximately 20 s setup budget. Its functional setup allowance is now 50 s, matching the existing full installer fixture; the replacement assertion is unchanged. Startup performance remains a separate unmet target. The failed update's safe refusal does not establish reliable shutdown, and the full fixture's successful retry does not close this failure. No additional shutdown or process-killing behavior was added for these message fixes.

The local replacement installer is **52,136,639 bytes**, SHA-256 `60c03bdb2446c063c34f68853e129293291242db7736076221b3737c1a290974`, under `.temp_files/desktop-installer-messages/package-f6b475f18b5c/`. Packaging used the captured hook above and unchanged accepted UI/engine payloads. Extracted hashes are UI `3019a97f5008895be163b6802525db37ca807ceea916075bda2c6d45dad733cc` and engine `759d13e29a407d0181e275bd0f3e1f81546c83e910fb60f62d32331338f51c79`. The installer remains unpublished. The concurrent label-namespace edit was preserved; validation and packaging were repeated against its final source hash. The seven legacy `choowHowToInstall` compiler warnings remain.

The Design/Composer receipt is `.temp_files/desktop-parity-acceptance/matrix-2026-11-11T10-17-07-236Z/matrix.json`, pair identity `3019a97f5008-759d13e29a40`, harness SHA-256 `ea490b50254f6e1abae0c08e140f5a58f9e3eaf44d0ace05607bf2cfbcb1f836`. Later installer-fixture logging and startup-budget changes mean this is a dated two-scope receipt, not a complete current-harness matrix. The specific extraction/review-card native handoff and transcript reading-position journey are still open.

The preceding follow-up's complete WebUI server suite passed **391 files / 3,598 tests with one worker**. Its four-worker run had **389 passing files, 2 failing files / 3,596 passing tests and 2 Git-test timeouts**. Neither suite was rerun for these NSIS-only product changes. Desktop's earlier full-suite result likewise remains a dated checkpoint. Current proof scripts, snapshots, logs and package metadata are under `.temp_files/desktop-installer-messages/`.

Final focused validation: installer-hook Vitest **3/3 passed**; Biome checked the two native scripts and Desktop manifest successfully, retaining the existing schema/CLI advisory. `git diff --check` passed. Live hook, local installer and staged UI/engine hashes matched their recorded identities; all three 31-case receipts matched the final hook. No process remained in the installer fixture directories named by this round's logs. These checks do not override the failed standalone live-engine replacement gate above.

## Native test ownership checkpoint 2026-11-11

**R16 fixes a defect in the standalone installer test.** Its file-backed stdout launch under pinned Bun 1.4.3 attached the real compiled engine to the controller's console despite `windowsHide: true`. Native `sessions::hide` explicitly uses `CREATE_NO_WINDOW`. A read-only console probe found the controller PID in the engine's console before any shutdown. A separate diagnostic run stopped during `RmShutdown`, before its after-call trace and cleanup; three fixture daemons remained. This made that fixture unsafe as evidence of native host behavior.

The fixture now starts the same engine through the existing PowerShell/.NET runtime with `UseShellExecute=false` and `CreateNoWindow=true`, retaining engine logs. It records the actual engine PID and checks console ownership before calling the installer. The compiled engine can still have its own console; the assertion requires that it exclude the controller, and checks a valid engine attachment or the documented no-console error. The probe uses [AttachConsole](https://learn.microsoft.com/en-us/windows/console/attachconsole) and [GetConsoleProcessList](https://learn.microsoft.com/en-us/windows/console/getconsoleprocesslist). The native host's flag corresponds to the documented [Win32 process creation flag](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags).

The identical console-ownership assertion failed against the captured old fixture after first-install and readonly controls passed. It then passed on **three consecutive real-engine verification runs**; each retained the exact original return-code, replacement-hash, hook-free control and owned-process assertions. The permanent `bun run --filter @wrongstack/desktop-v2 test:native-installer-release` command passed **six checks** independently. This supersedes the preceding standalone failure as a current acceptance result. The 50 s setup allowance was unchanged in this round.

The full generated installer fixture was measured separately before applying any analogous change. Its ignored-stdio launch already excluded the controller from the engine console. That candidate was **not reproduced**, so the full fixture was preserved. Its engine update passed, but the first uninstall still returned **2** and the existing retry succeeded. The first-attempt removal problem is therefore still open and is not attributed to R16.

Only test inputs changed: `native-installer-release.mjs`, `native-engine-launch.ps1`, `native-engine-console.ps1`, and the matrix fingerprint's inclusion of native PowerShell helpers. The production NSIS hook remains SHA-256 `f6b475f18b5c346bdf5a075e8e5f81109902304b48295ebdd83443d765e4f105`; installer, UI and engine identities from the preceding checkpoint remain unchanged. No new product executable or installer was needed. Existing matrix receipts retain their own harness identity; this round does not certify all native scopes.

Proofs, rejected diagnostic hypotheses, input hashes and receipts are under `.temp_files/desktop-engine-release-followup/`. The new ownership assertions are permanent regressions, and no unrelated process, registry entry or working-tree change was removed.

Final validation for this checkpoint: Desktop **329 files / 1,209 tests passed**, production types passed over **773 files**, scoped Biome and PowerShell parsing passed, and `git diff --check` passed. The suite logged an unavailable jsdom canvas context; no test failed. Biome retained its existing schema/CLI advisory. Final hashes matched all captured test inputs, the unchanged hook and local installer; the proof's source snapshot matched the permanent fixture. No owned process remained. The final full-installer receipt is `full-installer-current.log`, workdir `.temp_files/desktop-v2-native/installer-hook-1794396919910`, including its first-uninstall exit 2 and successful retry. No frontend/Rust rebuild, WebUI suite, complete native matrix, publication or hosted CI was run for this test-only change.

## Native design handoff and nested-root checkpoint 2026-11-11

**R17 fixes a reproduced artifact-navigation defect.** Desktop registered the parent project, while the conversation's working directory contained its own package marker. The engine correctly reported that nested package as `session.start.projectRoot` and wrote its design outputs there. Desktop normalized the result against the registered parent, rejected the valid specification path and displayed "No DESIGN.md path was reported". Relative design links could also select a same-named parent artifact. A shortened journal result made the progress-file path necessary; increasing the preview size would have hidden the root mismatch.

`EngineWorkspace` now derives the design artifact root from the engine's session metadata and checks that it stays inside the registered project. Design extraction/review cards and their file actions use that root. The project file service retains its registered scope and receives the correct nested project-relative path. Missing metadata preserves legacy-host behavior; explicitly invalid or foreign roots suppress artifact actions. Eight added permanent cases cover the real truncated-output/progress shape, nested Windows roots, legacy metadata and invalid/foreign roots. No backend path contract was changed. An early producer-path hypothesis used the wrong bridge contract; its temporary changes and two invalid tests were withdrawn, with the rejected evidence retained in the round ledger.

The permanent native scope is `bun apps/desktop-v2/tests/native-matrix.mjs --design-handoff`, with `WRONGSTACK_DESKTOP_TEST_PORTABLE` selecting the exact archive payload. The loopback provider controls model tool choice; the bundled engine, production tools, Chromium measurements, IPC, journal and file service execute normally.

| Check | Observed result |
| --- | --- |
| Old accepted pair, project-root conversation control | **PASS**, 150 s. This mode stops after extraction and is not a complete review-handoff receipt |
| Same old pair, nested-package conversation | **FAIL**, expected one artifact action but found zero; the actual specification existed under the engine-reported nested root |
| Rebuilt UI with accepted engine, complete native handoff | **PASS**, 311 s, five semantic checks. Conversation prepared a React Native draft without sending; Studio required a same-project agent and excluded foreign/terminal sessions. Existing drafts survived a host-confirmed layout reload |
| Actual extraction and report navigation | Running extraction exposed no artifact action; completion opened the real nested `DESIGN.md`, with parent/foreign decoy files present. The failed missing-file extraction exposed no completed artifact action |
| Actual inspection and fidelity comparison | The deliberately broken HTML fixture measured **3 FAIL / 0 WARN** at 1024 and 375 px and **33% fidelity**. Cards matched the disk reports, showed target/reference/viewports/time, and opened the expected reports from the transcript and Run activity. These findings describe the fixture, not Desktop defects |
| Compact native WebView | No document-wide horizontal overflow at **800×600 CSS px**. The screenshot shows the report header; the expanded composer leaves metrics/actions below the fold. Those controls were verified through DOM assertions and actual native file navigation. This is not a physical-window/native-zoom recertification |
| Focused Desktop regressions | **2 files / 32 tests passed on three consecutive runs** |
| Full Desktop suite | Default-worker run: **326 passing files / 1,213 passing tests**, three 5 s timeouts and one subsequent language assertion failure. Those three files passed **15/15 tests** unchanged in isolation. The full suite then passed **329 files / 1,217 tests with six workers**, with the same per-test limits and no excluded files. The default-worker failure remains recorded; its cause was not proven |
| Production types and scoped checks | **773 files without type errors**, Biome checked 12 changed files, and `git diff --check` passed. Biome retained its existing schema/CLI advisory |

The complete native receipt is `.temp_files/desktop-parity-acceptance/matrix-2026-11-11T13-00-56-642Z/matrix.json`, pair `d11e404d121f-759d13e29a40`, harness SHA-256 `ae254e9c0ecd15d62456eeb36bedc9a6da163f01db14fc99c3ccc60e73a08553`. The passing root control and failing nested run are respectively `matrix-2026-11-11T12-51-21-186Z` and `matrix-2026-11-11T12-54-48-767Z`, under the same acceptance directory. Their scope and harness identity are recorded individually. Stable copies of the final receipt, generated files and screenshots are under `.temp_files/desktop-design-native-handoff/accepted-handoff/`.

The new local NSIS installer is **52,144,151 bytes**, SHA-256 `52bd3bcecf27c3841451259909b8a77cfbc2e8b0ce50bd20dda7763f78141d31`. Its actual archived UI is `d11e404d121fa3966442ee5c2566dca610235a5f5b8012e440af8d7b03d5e57d`; its engine remains `759d13e29a407d0181e275bd0f3e1f81546c83e910fb60f62d32331338f51c79`. The native test used these extracted bytes, not a development build. The installer is local and unpublished; this round did not execute its install/uninstall UI.

This is a **UI-only rebuild with the previously accepted engine**. A clean engine build stopped on a locked Kanban output directory. A supported incremental retry then failed the current plugin-panel declaration contracts in `packages/runtime/src/portable-commands/panel.ts`; those unrelated shared-checkout edits were preserved. The UI/NSIS build completed, but its whole-source fingerprint rejected concurrent changes to `packages/webui-server/tests/max-context-updater-price-cliff.test.ts` and `packages/webui-server/tsconfig.scope-check.json`. That rejection remains recorded. A separate UI-package check explicitly excluded only those two non-UI files, verified every other recorded input, and verified the installer archive bytes and preserved engine hash. It does not certify a full current backend build or release.

The native fixture also observed an older session selection after reloading before the 400 ms layout-save debounce completed. Waiting for the actual host acknowledgement made the draft-recovery scenario pass; arbitrary immediate reload durability remains open. Completed tool groups close by default, so the harness uses conversation Find and expands the owning group before checking a card. Validation-pending owner races, interrupted extraction, Turkish native handoff, project-level absence of reviews, the packaged reading-position journey, other operating systems, physical audio, hosted CI and a complete current-pair native matrix were not exercised here. Earlier Files, Design, Composer, zoom, performance and installer receipts retain their own older pair/harness identities.

## Immediate layout recovery checkpoint 2026-11-11

**R18 fixes the main window's pre-acknowledgement reload loss and passed native acceptance.** The main window only saved selection, tabs, project and page through a cancellable 400 ms timer. Reloading before that timer fired, or while its IPC response was outstanding, restored the older host layout. The original R17 handoff had avoided this boundary by waiting for the host acknowledgement; that older receipt remains limited to its actual scenario.

The controller now stages the visible layout synchronously before paint in window-local `sessionStorage`, under the existing layout key. It prefers that pending state during the same window's reload, then retains the existing debounced native save. A unique token clears the pending record only when its matching save succeeds. An older acknowledgement cannot delete a later pending selection, including an A → B → A change. Main and project layout keys remain separate. Draft text, references, attachments, revisions and host serialization are unchanged. The existing restoration checks still filter unknown sessions/projects and honor a project window's URL scope.

| Check | Observed result |
| --- | --- |
| Original real-controller reproduction | **2 controls passed / 4 assertions failed**: pre-debounce reload, explicitly held native save, older acknowledgement after a newer selection, and failed native save. Each restored the previous selection. IPC and clocks are the only relevant fake boundaries; controller, appearance and draft restoration are production code |
| Final focused regressions | **3 files / 14 tests passed on three runs**. Covers all original cases, matching acknowledgement cleanup, layout-key separation, unavailable storage, corrupt recovery values and A → B → A acknowledgement identity |
| Full Desktop suite | **331 files / 1,227 tests passed**, six workers, unchanged per-test limits and no excluded files |
| Types and frontend/native compilation | **774 files without type errors**. Vite and Rust release builds passed; NSIS produced the local installer. The large frontend-chunk advisory remains |
| Source/package identity | Whole-source guard **rejected** concurrent CLI/TUI edits. Separate UI-only validation confirmed none of those six paths is imported by the actual Vite graph and regenerated every frontend output byte-for-byte, without modifying files. Archive UI and unchanged accepted engine hashes were verified |
| Actual old-package native proof | **FAIL**, 73 s: host-acknowledged Beta control passed, then selecting Alpha and reloading while the actual save callback was held restored **Reload Beta**, violating the explicit **Reload Alpha** assertion. Renderer error list was empty |
| Actual new-package native verification | **PASS**, 67 s: acknowledged control, pre-persistence reload with Alpha's own draft while the host still selected Beta, subsequent recovered host save, preserved Beta draft and **800×600 CSS px** fit. No renderer errors. The screenshot records the final Beta draft check, rather than claiming to show the earlier Alpha recovery |
| Final scoped checks | Biome checked six source/test files and `git diff --check` passed. The existing Biome schema/CLI advisory remains |

The local UI-only installer is **52,147,107 bytes**, SHA-256 `bf5d118b4edc13098191783f91465b84be7eddb36258f54ee850c30ff90e748d`. The extracted pair is `7ceef93287ab-759d13e29a40`: UI `7ceef93287abcb924cfa1f30b6ebeb1612248f2434e70aedf6ae78ce0bb5232c`, engine `759d13e29a407d0181e275bd0f3e1f81546c83e910fb60f62d32331338f51c79`. It is local and unpublished. The current engine source was not rebuilt or certified by this UI-only round.

The original broad source guard rejected changes to `packages/cli/src/execution-tui.ts`, `packages/tui/src/app-view-prompts.tsx`, `packages/tui/src/graphics/image-preview-cache.ts`, `packages/tui/src/index.ts`, `packages/tui/src/standalone-modal-store.ts` and `packages/tui/src/components/plugin-prompt-modal.tsx`. Those unrelated changes were preserved. `frontend-module-graph.json` and `ui-graph-verification.json` record the narrower UI acceptance and emitted byte hashes; they do not turn the original rejection into a passing whole-repository build.

The permanent native scope is `bun apps/desktop-v2/tests/native-matrix.mjs --layout-reload`, selecting the exact archive payload through `WRONGSTACK_DESKTOP_TEST_PORTABLE`. The unchanged final harness SHA-256 is `62d21d12b29f8a17c50fdbc4b5feebfc2a610dd5572403f6677fc7be3949457c`. Before-proof receipt: `.temp_files/desktop-parity-acceptance/matrix-2026-11-11T13-52-01-764Z/matrix.json`, older pair `d11e404d121f-759d13e29a40`. Passing receipt: `.temp_files/desktop-parity-acceptance/matrix-2026-11-11T13-54-29-392Z/matrix.json`, new pair `7ceef93287ab-759d13e29a40`. One complete native verification ran; the three-repeat gate refers to the deterministic controller/helper regressions.

Setup attempts that used the engine socket for a Tauri draft endpoint, accepted an incomplete engine identity, or paused React's lazy-workspace timers are retained as fixture calibration, not product proofs. The final fixture holds only the real 400 ms WebView callbacks behind a cancellable barrier across reload while native IPC, lazy loading and normal rendering continue. It checks the actual host still contains the previous selection. Stable red and passing receipts/screenshots, source snapshots, logs and ledger are under `.temp_files/desktop-layout-reload/r18/`.

Window-local recovery covers reloading the same WebView. Closing the whole app before native persistence, native project-window selection recovery, arbitrary host-write ordering, packaged transcript reading position and other native scopes remain separate acceptance. If the WebView denies session storage, native persistence still works, but pending reload recovery is unavailable. Earlier design/file/composer/installer receipts keep their own pair and harness identities.

Final input verification matched both changed production files to the build snapshot, the current native harness to both receipts, and the actual installer/UI/engine hashes to package metadata. No process remained under the exact RED/GREEN fixture roots or the separately observed calibration root. Source snapshots, pre-existing dirty work and unrelated concurrent changes were preserved. This round did not run the WebUI suite, hosted CI, an installer execution, a full backend rebuild, other platforms or the complete native matrix.

## Packaged reading-continuity acceptance — round 19, 2026-11-11

**R19 is reproduced, fixed and verified in the Windows package.** The broader R07 exercise exposed a compact Find failure after a user had opened a completed activity disclosure. `scrollToMessage` centered the entire virtual row, including its long activity body. The requested message could consequently sit above the visible pane although Find marked it as current. The isolated real-Virtualizer proof passed its closed-activity control (message top **−10 px**, bottom **94 px** in a **102 px** pane) and failed the expanded case (top **−310 px**, bottom **−206 px**). No virtualizer or navigation algorithm was mocked.

The two navigation calls now align at the start of the row, where the message begins. Both unchanged proof cases place the message at **1 px** after the patch. The correction on content commit remains separate from background message updates, preserving the R07 rule against replaying an old search when new text arrives. The promoted `transcript-expanded-activity-browser.mjs` adds repeated/adjacent request controls and passed on three consecutive runs. The existing source tab-return and early-message navigation regressions also passed. Vite logged `ResizeObserver loop completed with undelivered notifications` messages during the tab-return script; the passing assertions do not imply an error-free browser run.

The new permanent native scope is `bun apps/desktop-v2/tests/native-matrix.mjs --reading-position`, with `WRONGSTACK_DESKTOP_TEST_PORTABLE` selecting the exact archive payload. Before evidence used `7ceef93287ab-759d13e29a40`; the rebuilt UI uses `a171232d2c09-759d13e29a40`. The fixture runs ten actual conversation turns, including a real `read` of the owning project's README. It uses production conversation Find to revisit the older tool turn, opens its activity disclosure, and repeats Files/Run activity returns three times at each CSS viewport. Real provider responses are held behind explicit barriers while the tools are open. The retained renderer must observe a held run and consume its completion before geometry is sampled. Paused reading uses a **2 CSS px tolerance**; following must return to the newest actual reply. Draft checks read the native revision-backed store. The hidden transcript must remain mounted while exposing no accessible pin controls. No renderer events, DOM state or production persistence functions are replaced.

Model output uses the existing completion marker to avoid unrelated next-step generation. Each submitted background prompt has a distinct repetition suffix, and each `run.result` is correlated to its input ID and required to have executed at least one iteration. The loopback fixture controls model content/tool choice and response release; the native engine, journal, IPC, virtual transcript and project file service execute normally. Draft editing and navigation use the real UI; populating the journal through the production engine route does not claim composer-send acceptance.

| Check | Observed result |
| --- | --- |
| Relevant before-package/source identity | Thirteen transcript/controller/CSS files matched the R18 package-build snapshot before editing. R19 then changed only the two navigation alignments and their explanatory comment in production |
| Current-source browser control | Both reading layouts and the short-workbench control passed, with the Vite notifications described above |
| Focused permanent source tests | **3 files / 10 tests passed**: transcript window, message presentation and turn tools |
| Production typecheck | **774 files without type errors** |
| Full Desktop suite after the production patch | **331 files / 1,227 tests passed**, six workers, unchanged per-test limits and no excluded files |
| Separate intra-message streaming browser gate | `transcript-follow-browser.mjs` failed its paused-position assertion on the frozen pre-fix source and on three after runs. This boundary is retained and remains unresolved; it is not attributed to R19 or declared fixed |
| Native fixture controls | Real HTTP checks passed for unchanged default provider output, explicitly completed reading output and a later unrelated instruction |
| Native before package | The synchronized old-pair run passed wide-layout return/following controls, then **failed** compact message reachability. This assertion is distinct from the earlier setup timeouts |
| Native after package | **PASS**, 170 s, five semantic checks and 18 actual completed turns. At **1280×840** and **800×600 CSS px**, three returns per tool retained the message, open disclosure, draft and Chat keyboard focus. All **12 paused-return measurements had 0 CSS px drift**. Following returned to the actual newest reply after Files visits. No renderer errors were recorded |

The unchanged native harness hash for the final before/after pair is `fa7b7b9305b426f6e18655587bd8b9ba1ce59e5e6c0332c10459f93e5a3674de`. Before: `.temp_files/desktop-parity-acceptance/matrix-2026-11-11T14-41-04-529Z/matrix.json`, **FAIL** on `7ceef93287ab-759d13e29a40`. After: `.temp_files/desktop-parity-acceptance/matrix-2026-11-11T14-53-06-583Z/matrix.json`, **PASS** on `a171232d2c09-759d13e29a40`. One full native after-run completed; repeated return cases are inside that run, and the three independent repeat verifications refer to the durable browser regression. Stable receipts and both paused-layout screenshots are in `.temp_files/desktop-reading-native/r19/native-accepted/`. At 800×600 the screenshot shows the requested message and draft; the activity remains open below the short visible pane, rather than being presented as fully visible in that still.

The new UI-only local build uses HEAD `198aade0b7e6c87909d4e33801d28de74f94c08f`. Vite, Rust release and NSIS compilation passed, and the full recorded source-input guard passed with **zero drift**. The installer is **52,144,277 bytes**, SHA-256 `ac679d75eebeee140ffa9c6fdc41256351a944e01179c66c367523ad0d4ea3af`. Actual archived UI SHA-256 is `a171232d2c097de3e0fb2528161d4f9c19b850bd661e3a1fd0d2dd7034d18889`; engine remains `759d13e29a407d0181e275bd0f3e1f81546c83e910fb60f62d32331338f51c79`. The archive bytes were checked against the fresh executable, allowing only the NSIS marker. The source guard passing does not imply that the current backend source was rebuilt: this package preserves the previously accepted engine. The earlier R18 package's broader rejection remains in its own historical checkpoint.

Calibration receipts are not new product findings: the first native setup waited for the wrong preference acknowledgement; a later repeated input was legitimately suppressed before reaching the provider; another locator omitted the new-message count in the correct jump-control label. The later synchronized compact assertion and isolated tall-activity proof established R19. A separate repeated-target/resize-only hypothesis passed its isolated control and was dropped. Partial measurements and rejected hypotheses remain in the ledger.

Evidence is under `.temp_files/desktop-reading-native/r19/`. Pausing within one growing assistant message still has the separate failing source fixture described above: a frozen-before diagnostic moved from scrollTop **18,756** to **39,756** during growth, a **21,000 px** jump to its end while the following flag stayed false. Waiting for the real `scrollend` event also failed; the unsettled-wheel hypothesis is therefore not accepted as an explanation. That case has not been verified in the packaged app or repaired here. Window reload, switching conversations, complete restart restoration, pending-question arrival and physical-window/native-zoom behavior remain outside this reading-position scenario. Older scope receipts keep their own executable and harness identities. No backend source rebuild, installer execution, publication, hosted CI, full WebUI suite or complete native matrix was run here.

## Growing-message reading acceptance — round 20, 2026-11-11

**R20 closes the intra-message growth failure retained by R19.** The unchanged `transcript-follow-browser.mjs` fails its position assertion before this patch and passes after it. Initial following and the real wheel-pause control pass first. Installed Virtua 0.54.2 keeps an imperative index-scroll target subscribed to later measurements until a 150 ms measurement window ends; wheel input does not cancel that target. The old `onResize` automatic `scrollToIndex(end)` could therefore replay after the reader had already paused following.

Automatic following now uses a single coalesced animation frame, checking the latest following/visibility ref at execution. Scheduled work is cancelled on unmount. Explicit Find/pin start alignment from R19 is preserved. The independent permanent `transcript-stream-pause-browser.mjs` passed three consecutive runs and the final browser batch. It covers repeated paused growth, explicit resume, a queued frame released after the reader pauses, and unmount cancellation, using the real Virtualizer and follow handlers.

The existing tab-return test exposed a regression in the first patch: a question arriving while Files was open could be displaced when the hidden virtualizer was measured again. A two-frame diagnostic still failed. Seven added caller lines now schedule a cancellable top reset after Chat becomes visible in question-focus mode. Conversation review mode remains selected across tool visits. The original assertion and added review/Focus questions controls passed three runs at **1280×840** and **800×600**. These are browser question controls, not packaged question acceptance. Vite ResizeObserver-loop notifications remain in the tab-return logs.

Native reproduction uses `bun apps/desktop-v2/tests/native-matrix.mjs --stream-pause`, a real local provider with two explicit partial-response barriers, actual engine events, native Markdown, wheel input and persisted draft readback. Measurement timeout completion is held deterministically while animation frames and the rest of the runtime remain live. The short real-provider control completes first. Before and after use the same harness, **`6fa8188e315cdc2311aadba24d32e8ae93934dd3234733c0556273658146780a`**.

| Native contract | Old UI `a171232d2c09-759d13e29a40` | New UI `f2f66f2c7c0a-759d13e29a40` |
| --- | --- | --- |
| Wheel pauses above a partially rendered reply | **FAIL**: Jump to latest appears, but the view returns to its end; gap **0 px** | **PASS**: gap **1,242 px** at both viewports |
| The same answer grows while paused | Not reached after the failed pause contract | **PASS**: message height **15,436.09375 → 31,831.921875 px**, scrollTop drift **0 px** and unchanged visible anchor at both sizes |
| Explicit resume and persisted draft | Not reached | **PASS**: follows the remaining reply and retains the native draft; all **3** actual turns complete |

Before receipt: `matrix-2026-11-11T16-38-38-186Z`, **67 s**. After receipt: `matrix-2026-11-11T16-44-56-721Z`, stream-pause **55 s**. The earlier before-run timeout was fixture calibration and is not counted as a RED proof. One complete native after-run covers this controlled partial-stream scope; the three repeated source verifications are separate evidence.

The accepted UI-only local build records stable HEAD **`153ac03c3f12d8095846f93f3b9ecce4e133b1af`**, with **zero drift** in the broad recorded source guard. The first compiled candidate was rejected because four shared files changed during the build; the retry kept the identical guard without exclusions. An independent website commit advanced main during the round and was preserved. Installer: **52,139,262 bytes**, SHA-256 **`5f9bf90c74bbc95911f64d78d4360b0f878725865710fc7f7e517369bcfcb2bd`**. Extracted UI: **`f2f66f2c7c0a64ddd1bc95792047c3043b7894c580b62c55a326b6ff446be3e9`**; accepted engine unchanged: **`759d13e29a407d0181e275bd0f3e1f81546c83e910fb60f62d32331338f51c79`**. Archive UI bytes match the fresh build allowing only the NSIS marker.

Final source batch passes original follow, independent stream pause, expanded activity, early navigation and tab-return. Full Desktop: **331 files / 1,227 tests PASS**; production types: **774 files PASS**. Scoped Biome and `git diff --check` pass, with the existing Biome schema/CLI advisory retained. Default/ordinary long provider responses remain unheld; actual HTTP controls pass. Evidence: `.temp_files/desktop-stream-pause/r20/`, with accepted native receipts/screenshots in `native-accepted/`.

The same after matrix also passed ordinary native `--reading-position` in **100 s**, preserving R19 Find reachability and R07 Files/Run continuity on this pair. Its **12** paused-return measurements have **0 CSS px drift**; open activity, focus and draft are retained, and explicit following reaches the actual new reply at both sizes. That scope completes **18** actual turns, including a real project-owned `read`; combined with stream-pause there are **21** completed turns. These are **two** selected native scopes, with no omitted case inside either scope. Package hashes, current owned source hashes, identical native harness and fresh receipt contracts were rechecked in `final-verification.json`.

A current backend source rebuild, complete native matrix, native pending-question acceptance, cross-session/restart restoration, installer execution, other operating systems, physical audio, WebUI/root suites, hosted CI and publication were not run. This round is not a release certificate.

## Native pending-question acceptance — round 21, 2026-11-11

**The pending-question tool-return boundary now has native evidence.** The current R20 production code passed this scenario without another production fix. A new permanent `--pending-question` scope uses the actual packaged engine and `clarify` tool, with real tool discovery when needed. Files is opened before the question turn starts; the actual `user.input_requested` event gates returning to Chat. The test does not inject renderer events, replace the clock or force a scroll before checking the heading.

Each run first renders a real long reply, then asks eight text questions while Files is open. At **1280×840** and **800×600**, the heading must appear inside the pane on return. Three cycles then exercise focused question returns and retained conversation review through Files/Run activity. The entered answer survives every cycle; keyboard focus stays on the returning Chat action. Submitting through the real form resolves the exact engine request, sends the answer back to the provider and resumes the actual run/following. The saved composer draft remains intact.

| Acceptance | Three independent native runs |
| --- | --- |
| Heading visible on initial arrival and after tool/review transitions | **42/42 measurements PASS**, scrollTop **0**, heading top **80 px**, bottom **105 px** |
| Focused and conversation-review tool returns | **36 returns PASS** across the two viewport sizes |
| Actual question submissions/resolutions and provider answer readback | **6/6 PASS** |
| Actual long-reply and question turns complete | **12/12 PASS** |

The unchanged package is **`f2f66f2c7c0a-759d13e29a40`**; installer/UI/engine hashes were reverified against the R20 receipt. All **643** recorded Desktop UI/Rust source files match the accepted build snapshot, so no UI or engine rebuild was required for this test-only addition. The new native harness is **`e8979df89865c6cc25baeaa5f5e80c24e9337e0b2777535a9e6e7050f89d7fc9`**. Runs: `matrix-2026-11-11T17-57-40-886Z` (**89 s**), `matrix-2026-11-11T17-59-50-802Z` (**89 s**), `matrix-2026-11-11T18-01-20-703Z` (**88 s**). All use identical package/harness bytes and fresh, separate receipts. Earlier native scopes retain their dated harness identities; this is not a rerun of the whole matrix.

Permanent coverage: `apps/desktop-v2/tests/native-pending-question.mjs`, registered in `native-smoke.mjs` and discovered by `native-matrix.mjs`. No new production defect was reproduced; the changes in this round are this test, its registration and reporting. The existing source tab-return browser control also passed. Its Vite ResizeObserver-loop notifications remain in the log. Full Desktop suite: **331 files / 1,227 tests PASS**, six workers; production typecheck: **774 files PASS**. Scoped Biome and `git diff --check` passed. The exact owned fixture roots and verified portable path have no remaining processes.

Evidence is under `.temp_files/desktop-pending-question/r21/`, with per-run receipts/screenshots in `native-accepted/run-N/`. `final-verification.json` checks package/source/harness identity and the actual request/resolution/sample contracts. Renderer reload with a typed question answer, whole-app restart and cross-session recovery remain unverified by this round. No new package build, installation, backend source certification, full WebUI/root suite, hosted CI or publication was performed.

## Pending-answer reload recovery — round 22, 2026-11-12

**R22 is reproduced, fixed and verified in a local native package.** Reloading the renderer reconstructed the same still-pending `clarify` request but lost the answer typed into it. The owning composer's saved draft survived the same reload. `useDesktop` kept question answers only in React state; that state disappeared when the renderer was reconstructed. Before copies of `useDesktop`, `EngineWorkspace` and `InputRequestCard` are byte-identical to the accepted R20 archive's recorded source, so the prior archive exercises the unchanged defect path even though current manifests have advanced to **1.6.0**.

The fix stores answers in the existing native project-form draft table, with a versioned owner envelope and hashed key for the project, desktop session and engine request. Existing compare-and-set revisions protect other windows' saved values. The form waits for saved answers to load before allowing edits/submission, offers retry/cancellation if loading fails, and exposes the existing conflict choices. The exact request's saved answers are retired only after the engine confirms `user.input_resolved`. No database schema or new host method was added; the native form-key allowlist gained one hashed prefix. The loading message ships in all seven Desktop languages. Existing in-window memory and prior navigation/following fixes remain intact.

The permanent `--question-reload` native scope extends the real question tool-return controls. After Files/Run and conversation-review returns, it reloads the renderer, waits for the same session's form to become editable and compares the exact answer. The composer readback is the unaffected control. It then submits through the real form, checks the exact engine resolution/provider answer and completes the run. No renderer events or question cards are faked.

| Contract | Before `f2f66f2c7c0a-759d13e29a40` | After `5ab1e937081f-759d13e29a40` |
| --- | --- | --- |
| Typed answer after renderer reload | **FAIL**: expected `Keep decision answer at 1280px.`, actual empty string | **6/6 PASS** across three runs at 1280×840 and 800×600 |
| Saved composer and ordinary question/review/tool returns | Controls pass before the failing answer assertion | Controls pass in all three runs |
| Real question submission/resolution/provider readback and continued following | Not reached after the failed assertion | **6/6 submissions PASS**, **12/12 actual turns complete** |
| Question heading remains visible, including after reload | Initial controls pass | **48/48 measurements PASS** |

Before: `matrix-2026-11-12T09-47-33-333Z`, **108 s**. After: `matrix-2026-11-12T10-11-17-369Z` (**277 s**), `matrix-2026-11-12T10-15-57-134Z` (**290 s**), `matrix-2026-11-12T10-20-47-479Z` (**228 s**). All use the identical harness **`de3c9c4f82ca38eb4481061838b58f42dcf2abaeaa041d714734f0eb4cf9b958`**. Per-run fresh receipts and both viewport screenshots are retained; the wide before/after stills visibly show the empty and restored answer. The old archive's update banner is a version difference, not the basis of the data-loss assertion.

Two shared-checkout builds compiled but were rejected because unrelated inputs changed while compilation ran. Their guards were preserved without exclusions. A stable source copy at `D:/Codebox/.wrongstack-build-r22-1794477799280` captures HEAD **`9ec93ad7f306ffb354ac4f6905402915c66999cf`** plus the dirty work. A frozen Bun install and recorded prebuilt workspace outputs reproduce the build inputs. All **27,067** guarded inputs stayed unchanged: **14,180 source/config files** and **12,887 existing generated workspace files**. The generated workspace outputs and engine are explicitly prebuilt inputs; this is not certification of a rebuild of current backend source. No git checkout or worktree was created.

Accepted local **1.6.0** installer: **52,149,137 bytes**, SHA-256 **`50a29a145720473c8649a56df5f5ea80a66962b4dba3a5bcf1157573c587dbf9`**. Actual archive UI: **`5ab1e937081f4633403c8e8087ddcc4445a619105926b8c8c6dd06606e8635d9`**; accepted engine unchanged: **`759d13e29a407d0181e275bd0f3e1f81546c83e910fb60f62d32331338f51c79`**. Archive bytes equal the fresh native UI allowing only the NSIS marker.

Validation: new answer codec plus existing durable-form cases pass **7 tests across 2 files on three consecutive runs**, including selected/delegated answers, foreign ownership, reconstruction, cleanup and a newer window's saved value. Full Desktop passes **332 files / 1,231 tests**; production types pass **775 files**. The final full-suite run uses three workers and has no worker-termination warning; an earlier passing run's shutdown warning and the separately passing workbench test remain recorded. Rust passes **44 tests**, with the existing `send_page_bench` ignored. Source browser question/review controls, scoped Biome and `git diff --check` pass; existing Biome schema and browser ResizeObserver notices are retained.

Evidence: `.temp_files/desktop-question-reload/r22/`, including `final-verification.json`, source/build-input records and `native-accepted/run-N/`. This native scope covers free-text answers through renderer reload while the engine stays alive. Model tests cover selected/delegated answers and revision conflicts; native conflict/load-failure UI and app/engine restart remain unexercised. Earlier native scopes keep their own package/harness identities. No complete native matrix, installer execution, full WebUI/root suite, hosted CI or publication was performed.

## Pending-answer process recovery — round 23, 2026-11-12

**R23 is reproduced, fixed and verified in a local native package.** After a real pending question, replacing the UI/WebView while keeping the host alive preserved the live question and its acknowledged answer. Replacing the host and engine also preserved the exact saved answer/composer, and correctly recorded the session as interrupted. The old UI nevertheless enabled the previous question's Submit action. Retained journal state was being treated as a live engine awaiter. The six affected state/form/workspace source owners match the accepted R22 archive's recorded before bytes; the footer's status branch also matches, while an independent branch/plugins addition is preserved.

The fix derives stopped controls from the actual host session status and archives the old question metadata for read-only recovery. Reset or a known process `eventEpoch` change retires runtime questions and approvals. Ordinary updates retain live interactions and the last known epoch. Only a genuinely reissued request becomes live again. Abort/unattended resolution retains unsent answers; an explicit user resolution keeps the existing exact-request cleanup. **Review saved answers** opens the original form in a read-only modal; **Copy saved answers** copies human question/option labels for reuse in the current conversation. It sends no obsolete question request. The footer reports the stopped engine, and all recovery labels/help/close actions ship in seven languages. No native schema, host method, engine or dependency change was added.

The first UI patch passed the interrupted-state assertion, but was rejected by the real native reconnect assertion: the replacement engine starts the same core conversation with a new epoch and **no reset flag**. The old question reappeared after a completed control turn. Its journal and failure receipt are preserved. A new reducer case failed on that exact no-reset transition before the epoch fix. Native harness, assertions and deadlines stayed unchanged throughout.

| Contract | Old archive `5ab1e937081f-759d13e29a40` | Final archive `689820a9bb3f-759d13e29a40` |
| --- | --- | --- |
| Warm UI/WebView replacement with the same host | Live question, same core session and exact acknowledged drafts survive | **PASS**, including an editable live question |
| Cold UI/host/WebView replacement | Exact snapshots survive, session is interrupted, but obsolete Submit is enabled: **FAIL** | **PASS**, obsolete Submit is absent |
| Recorded conversation reconnects in a new process epoch | Not reached after the failed assertion; first intermediate patch fails here | **PASS**, same core session, new epoch and no obsolete question action |
| Read saved answer and reuse it without submitting the old request | Not reached | **PASS**, exact SQLite snapshot, readable saved card and actual clipboard paste into the same composer; unrelated draft restored |
| Real completion controls before and after interruption | Initial control passes | **2/2 PASS**; the intentionally interrupted question is not counted as completed |

Before: `matrix-2026-11-12T14-43-15-050Z`, **204 s**. Final after: `matrix-2026-11-12T15-22-10-943Z`, **199 s**, **one complete native run** with warm and cold replacements. Both use harness **`51cf3963903505c6a3b04d1b418adeebe5a7f93710e85448383982331351b5c3`**. Fresh receipts identify the changed UI/host PIDs and exact saved snapshots. The native still was inspected at the default **1480×960** size; compact read-only/close/copy controls are covered by the source browser, not a native compact test.

Final local **1.6.0** installer: **52,161,574 bytes**, SHA-256 **`d9b3e3e4409b4cc479b645482d3ea668b922c5ee8cd67d8445850b76023feeeb`**. Actual archive UI: **`689820a9bb3fe848c1b3ef4d411332fc6b4d490d0ba5b00dfa512b63a6bba72b`**; accepted engine unchanged: **`759d13e29a407d0181e275bd0f3e1f81546c83e910fb60f62d32331338f51c79`**. The protected copy at `D:/Codebox/.wrongstack-build-r23-1794496499492` captures HEAD **`b2b9007096c042a1519fe639ad978e0a394367da`** plus dirty work. A frozen install, Vite/Rust/NSIS build and actual payload extraction passed. All **27,089** guarded source/config/prebuilt inputs stayed unchanged. Existing generated workspace outputs and the engine are prebuilt inputs, not certification of current backend source. Earlier intermediate build evidence remains immutable and separate.

Validation: permanent lifecycle/answer/durable-form cases pass **3 files / 12 tests on three consecutive runs**; full Desktop passes **333 files / 1,236 tests** in **248 s**, three workers, no exclusions or raised timeouts. Types pass **780 files**. Three consecutive serial production-browser runs pass at **1280×840**, **800×600**, and the existing **400×300** short-workbench control. They assert disabled saved fields, no obsolete submit/send, correct copied labels and modal bounds/close. Scoped Biome and `git diff --check` pass. One earlier browser repetition failed the older compact reading setup before recovery; its assertion was retained unchanged and final serial repeats passed. Existing ResizeObserver, large-chunk and Biome schema advisories remain recorded.

A separate first native attempt never reached the scenario because the profile engine's SAGE handshake timed out. The intermediate package's subsequent native reconnect failure is a real incomplete-fix result, not a setup error. Neither failure is counted as a successful native run. Evidence is under `.temp_files/desktop-question-restart/r23/`: `report.md`, `ledger.md`, `final-build/`, `native-accepted/` and `final-verification.json`. The verifier rechecks immutable build inputs, current owned production bytes, matching before/after harness, process identities, exact snapshots, both completed controls and clipboard content.

Unacknowledged writes, native selected/delegated/conflict/load-failure recovery, compact native recovery and general profile-service recovery remain separate. Earlier native scenarios retain their dated identities. No Rust test rerun, full native matrix, installer execution, full WebUI/root suite, hosted CI, installation or publication is claimed. The next design-workflow scope is interrupted reference extraction and truthful presentation of partial results.

## Interrupted extraction recovery — round 24, 2026-11-12

**R24 is reproduced, fixed and verified within the local extraction scope.** A real completed extraction wrote its DESIGN.md and exposed its result action. A second real extraction reached a gated local reference. After forced UI/host/engine replacement, the session and footer correctly said the engine had stopped, but Run activity still showed that extraction and its iteration as running. Native before **`matrix-2026-11-12T15-40-12-633Z`**, pair **`689820a9bb3f-759d13e29a40`**, fails in **245 s**: expected zero running stages, actual one. The four affected production owners match the accepted R23 archive's recorded before source.

The full Run activity view did not receive stopped host status, and its history had no process boundary to retire unfinished tools when the same recorded conversation resumed in a new engine. Normal `run.result: aborted` and explicit failed tool handling already worked. The patch passes known host interruption into the view and records a **local presentation boundary** on a proven epoch replacement or explicit reset. The fold stops unfinished tools/iterations, closes the old tool-id namespace and preserves completed results. It neither emits a new native/wire event nor fabricates a successful tool/run result. A later same-id tool starts with its own progress/files; bounded-history trimming does not require the old start frame to remain present. Existing localized stopped labels are reused.

| Contract | Before | Final identified package |
| --- | --- | --- |
| Actual successful extraction and written specification | Passing control | **PASS**, completed artifact action remains available after interruption |
| Incomplete extraction after cold UI/host replacement | **FAIL**, still running despite an interrupted session | **PASS**, zero running stages and no completed spec action |
| Same recorded conversation resumes in a new epoch | Not reached after the failed assertion | **PASS**, same core id, new epoch, acknowledged composer preserved |
| Another genuine extraction is live after reconnect | Not reached | **PASS**, old running stages = **0**, new running stages = **1** |
| Successful extraction controls | One control before the failing assertion | **2/2 complete**, three real tool calls including the deliberately interrupted operation |

Final native acceptance: **`matrix-2026-11-12T16-11-00-552Z`**, **322 s**, **one complete run** on pair **`f3d89c4b1e1f-759d13e29a40`**. Before and after use identical harness **`653519bb926928b1793d6dd592c1a738d2d4adb525e456a40e761c9609ca2230`**, unchanged assertions and deadlines. UI PID **139832 → 77132**, authenticated host PID **180332 → 154492**; the existing helper verifies new authentication and the old endpoint's closure. The default **1480×960** native before/after stills were inspected. Native receipt and real tool results confirm separation during the next extraction; native compact layout is not accepted by this round.

Two earlier after attempts remain failures, not successful coverage: the first stopped in the shared Prompt library prelude after **226 s**, with `Session Catalog handshake timed out`; the second passed the real extraction control but its replacement Tauri shell page missed the unchanged **30 s** readiness boundary, ending after **377 s** before the stopped-card assertion. No timeout or test assertion was relaxed. A read-only observer on the accepted run recorded the new WebView page moving from `about:blank` to `tauri.localhost`; authenticated RPC receipts own the accepted host identities. These service/shell startup reliability concerns remain open under R03; no cause or fix is claimed for them.

Source verification: **4 focused files / 38 tests pass on three consecutive runs**, covering same-engine updates, normal abort, completed artifacts, reset/replacement, reused ids and bounded history. Full Desktop passes **334 files / 1,242 tests**, **457 s**, three workers, no exclusions or raised timeouts. Types pass **780 files**. Three consecutive browser runs assert status separation, partial-path refusal and completed-artifact navigation at **1280×840** and **800×600**; these are controlled state/navigation fixtures. Scoped Biome checks **9 files** and the diff check pass. Existing ResizeObserver, chunk-size and schema advisories remain recorded.

Final local **1.6.0** installer: **52,158,483 bytes**, SHA-256 **`7a0be815fea9435fe5dcf94452b060588aa07e7223dbc376290c8ae0f455617d`**. Actual UI **`f3d89c4b1e1f8bdc4b656e755224014350b6e1c78b784f191ffd216767f7d94f`**; accepted engine unchanged **`759d13e29a407d0181e275bd0f3e1f81546c83e910fb60f62d32331338f51c79`**. A frozen install and Vite/Rust/NSIS build in `D:/Codebox/.wrongstack-build-r24-1794498419755` passed; all **27,092** guarded source/config/prebuilt inputs stayed unchanged. Native host source also matches the prior protected snapshot. Generated workspace outputs and the accepted engine are prebuilt inputs, not current backend-source rebuild certification.

Evidence: `.temp_files/desktop-design-interruption/r24/`, including `report.md`, `ledger.md`, `native-before/`, `native-accepted/`, both failed-attempt directories, `final-build/` and `final-verification.json`. The verifier rechecks package/source/harness identity, fresh receipts, process replacement, six browser samples, incomplete versus fresh tool state and both actual completed extraction controls.

The native gate interrupts before the reference response completes; actual recovery of partly written disk files and multi-page partial failure remain separate. Source/browser cases cover reported partial file metadata. General service recovery, other platforms, Rust suite rerun, full native matrix, installer execution, full WebUI/root suites, hosted CI, installation and publication were not exercised. Earlier scenarios retain their dated identities. Next scope: historical design-report identity, so an older result card cannot silently open a newer run's overwritten report.

## Historical review report identity — round 25, 2026-11-12

**Later checkpoint:** R26 below completes this retained-report native gate on an identified new UI/unchanged R25 engine with the original H3 harness. The incomplete status and failed attempts described here remain the dated R25 outcome. General startup reliability stays open.

**R25 is implemented with passing source, package-identity and actual disk-retention evidence; complete native navigation acceptance remains OPEN.** Inspect and compare previously returned a shared report path reused by later calls. Older cards retained their original metrics/time while opening newer bytes. A real saved-DNA writer proof reproduces the overwrite with a valid second/latest control; the original reader also rejects retained paths and mislabels legacy paths. This is one report-ownership defect.

New successful inspect/compare calls allocate a unique `runs/<UUID>` directory. Inspection retains Markdown, JSON and measured screenshots; comparison retains its Markdown, input DNA and any measured implementation assets. The returned path and completed file target identify that run. Existing canonical files still update as compatible latest aliases, identified separately by `latestPath`. No action/input schema, host API, database or dependency is added. These are tool-owned retained files, not an OS read-only guarantee or automatic pruning policy.

Desktop validates project/action-scoped UUID paths. New snapshot cards say **Open report**. Legacy shared paths say **Open latest report**, with seven-language help explaining that newer content may be present while the displayed metrics belong to the recorded result. A valid legacy target named `runs` is covered. Failed/invalid results expose no completed report action. Already overwritten legacy bytes are not reconstructed or attributed to older cards.

Final native before: **`matrix-2026-11-12T18-17-26-854Z`**, old pair **`f3d89c4b1e1f-759d13e29a40`**, **FAIL 312 s** on the unchanged preserved-report assertion after a passing actual first inspection and native file-open control. Final harness **`6297cdc5a71b492ca37ddf300ad72ef3ceb371dfd2557458c65e32854a4e283b`** is identical across the following new-package attempts. None is a complete PASS.

| New package attempt | Observed outcome | Evidence boundary |
| --- | --- | --- |
| `matrix-2026-11-12T18-08-47-239Z`, earlier H2 harness | **FAIL 149 s** on an ambiguous test Tools selector. All four real calls complete; four distinct reports and the first measured PNG remain unchanged. Both inspector cards open their own files after the later review. Comparisons score 100% then 67%, with retained original bytes | Actual tool/disk and inspector-navigation evidence only. Comparison navigation is not completed; this is not transferred into final H3 acceptance |
| `matrix-2026-11-12T18-22-56-859Z`, final H3 | **FAIL 308 s**. Both genuine inspection reports remain intact, but Files displays **The engine did not acknowledge this request** while navigating cards | R03 file-service failure; complete history navigation does not pass |
| `matrix-2026-11-12T18-29-17-338Z`, final H3 | **FAIL 209 s**, shared Prompt library cannot expose New template within its existing 100 s deadline | Setup failure before the history scenario, not F25 product evidence |
| `matrix-2026-11-12T18-33-20-696Z`, final H3 | **FAIL 306 s**. First genuine inspection completes, but its report-open control hits the same file acknowledgement error | R03 file-service failure; no completed native history acceptance |

The external native helper corrects only the ambiguous selector by scoping Tools to the agent navigation. No production assertion, fixture or deadline is relaxed. Failed attempts remain separately archived; they are not hidden by retrying. The immutable package/build snapshot is neither edited nor rebuilt for test-only changes. The final verifier binds external test identity separately and records **zero complete final native passes**.

Source verification: writer **15 tests** and Desktop readers **21 tests in two files**, each on **three consecutive runs**. Tools types **400 files**, Desktop types **780 files**. Full Desktop **335 files / 1,254 tests PASS**, **352 s**, three workers, no exclusions or raised timeouts. Three final styled-browser runs pass **EN/dark/1280×840** and **TR/light/800×600**, including snapshot/latest actions, target/content, production stylesheet presence and overflow. Scoped Biome **17 files** passes with the existing schema advisory. The original styled before code still fails the legacy-label assertion with valid style controls.

Visual inspection caught incomplete CSS loading in the original standalone browser fixture. The browser-only helper now loads production styles explicitly and records its own SHA-256, **`d99cd32816016b4653f043175f0d8034511679ecd5be4860ef5cbcd5cecf52f8`**, in all six final samples. Final styled EN/TR stills were inspected; initial unstyled samples remain functional evidence only. Native partial/failure stills were inspected at **1480×960**. These samples do not certify comprehensive theme/contrast behavior or native compact layout.

The **full Tools target remains non-green**: **384 passing / 4 failing / 2 skipped files**, **5,621 passing / 7 failing / 29 skipped tests**, **1,412 s**. Failures are the 60 s indexing benchmark timeout, index-worker handshake, two idle-exit failures and three PowerShell EUNKNOWN spawn failures. In separate protected-copy runs with the preserved old writer substituted, the benchmark still times out; PowerShell and index-worker pass (**18 pass / 1 fail** total), and idle tests separately pass **3**. The changed writer was not loaded. These isolated results do not turn the full target green or establish a cause for the other full-run failures. No unrelated implementation, timeout or assertion is changed.

Local **1.6.0** installer: **52,255,454 bytes**, SHA-256 **`0c64307f261b193b38422777dcc508e3a67a07647c9e5f7a7e3b1f06ad00a4b1`**. Actual UI **`29342fcc1f7a0427ea964e249edb02166bb36a8d79e8a35d9e635e2a78dea309`**, fresh engine **`9a54b0cb2e61ea9e9a8aa72e6ff78d790eb47f7899949a67988580dc14dacb3a`**, pair **`29342fcc1f7a-9a54b0cb2e61`**. Protected copy `D:/Codebox/.wrongstack-build-r25-1794505162753` captures HEAD **`b627142818ec12dd73e9978943ac9a9c8a6079e2`** plus dirty work. Frozen install, normal Tools JavaScript/declaration build, fresh standalone engine, Vite/Rust/NSIS and actual extraction pass. **27,099** guarded inputs remain unchanged. **11,781** other generated dependency files are unchanged prebuilt inputs; this is a scoped Tools rebuild/fresh engine, not full current-backend source certification.

Evidence: `.temp_files/desktop-review-history/r25/`, including `report.md`, `ledger.md`, `native-before-h3/`, all failed-attempt directories, `final-build/`, `package-verification.json`, `owned-process-check.json` and **`final-status.json`**. The independent verifier checks package/source identity, matching final native harness, fresh failure records, partial genuine tool results, preserved report/screenshot hashes and six styled browser samples. A read-only Win32_Process inventory finds **zero references to eight owned fixture directories**, without terminating unowned processes. Overall status is **INCOMPLETE_NATIVE_ACCEPTANCE**; no complete-native `final-verification.json` is manufactured.

Next priority is a separate **R03 root-cause round for file acknowledgement and Session Catalog startup**, followed by unchanged F25 native acceptance. Repeating failing setup is not counted as more product coverage. Project-level not-inspected/blocked state, brief/objective continuity, compact native styling, comprehensive contrast acceptance and pruning policy remain open. No full native matrix, backend-wide rebuild, installer execution, other-platform run, full WebUI/root suites, hosted CI, installation or publication is claimed. Earlier native scenarios retain their own dated identities.

## Independent report navigation — round 26, 2026-11-12

**R26 fixes one proved navigation dependency and completes R25 retained-report native acceptance.** The file manager waited for the entire project tree before sending a read for a known report. A delayed/refused explorer listing therefore prevented a readable report from being attempted. R25's final failed attempt contains late tree replies and no file read; controlled production-component and full card-to-files browser proofs isolate the dependency without relying on machine timing.

The caller supplies explicit known-file metadata only after validating a design specification/review path and normalizing its owning root. FileWorkspace reads that file immediately while explorer loading continues independently. Generic paths retain directory discovery and ignored-file behavior. A refused file read still reports failure; it does not create content. Separate tree/file loading state prevents a false empty explorer while a report is already visible. The patch is limited to FileWorkspace, ProjectSessionTools and EngineWorkspace, plus regressions and evidence; no native/wire/schema/dependency change.

| Boundary | Before | After |
| --- | --- | --- |
| Normal tree and measured report | Passing control | PASS |
| Known report while tree completion is gated | No files.read; report remains inaccessible | PASS, one actual boundary read and visible original content before releasing the tree |
| Refused tree listing | Readable report never attempted | PASS, report remains accessible |
| Automatic directory navigation | Passing control | PASS, waits for directory metadata without treating a folder as a file |
| Refused report read | Hidden behind the pending tree | PASS, the real file error is visible and no report contents are invented |

The final preserved-source proof has **3 failing / 2 passing cases**; all five pass after the fix. Together with existing refresh/StrictMode and path-validation tests, **3 files / 19 tests pass on three consecutive runs**. The actual Run activity card → EngineWorkspace → ProjectSessionTools → FileWorkspace browser route passes three repeats: **15 states**, including EN/dark/1280×840 and TR/light/800×600 with held/refused listing. It checks exact file/content, no duplicate read after gate release, truthful explorer loading, page errors and horizontal overflow. Final styled stills were inspected. Existing Vite ResizeObserver notifications remain recorded; they are not a product fix claim.

Full Desktop passes **336 files / 1,259 tests**, **126 s**, three workers, no exclusions or raised timeouts; authoritative types pass **780 files**. The same guarded source is checked in a separate immutable validation copy. An initial attempt inside the build copy had six setup failures because its source-copy filter omitted the CI workflow used by static packaging tests. Validation adds only the exact recorded-head .github/workflows/desktop.yml blob, identified in validation-copy.json, without editing the build snapshot. The complete rerun passes. Static workflow checks do not certify hosted CI or macOS signing. Scoped Biome **5 files** passes, with the existing schema advisory.

Final native: **matrix-2026-11-12T21-45-19-675Z**, **one complete PASS in 115 s**, pair **298bab148af4-9a54b0cb2e61**. It uses the same final H3 harness **6297cdc5a71b492ca37ddf300ad72ef3ceb371dfd2557458c65e32854a4e283b** as R25's old-archive **FAIL 312 s** at matrix-2026-11-12T18-17-26-854Z. Native assertions, fixtures and deadlines are unchanged. Four genuine calls complete: inspect **0 FAIL → 2 FAIL**, compare **100% → 67%**. Four distinct retained reports and the first measured PNG keep their original bytes; both inspector and both comparison cards open their original report after the later call. This closes R25's history gate on this identified package. The deliberately held/refused tree boundary is source/browser acceptance; the native run uses normally responding services. Default **1480×960** native inspect/compare stills were inspected; compact native layout remains separate.

Local **1.6.0** installer: **52,271,146 bytes**, SHA-256 **78aca4c7f99296925f8a0fdc089f880a438a24ed3c07865b93e751079ff8b9af**. Actual UI **298bab148af4535c3d74630970013ccd41d76acb4555f55e20bc91743bdbd485**; accepted R25 engine unchanged **9a54b0cb2e61ea9e9a8aa72e6ff78d790eb47f7899949a67988580dc14dacb3a**. Frozen install, Vite/Rust/NSIS and actual extraction pass. Protected source D:/Codebox/.wrongstack-build-r26-1794519618683 records HEAD **d543b235f47b34ab86830481e0541b1fbe811818** plus working changes, **27,101** guarded inputs and **12,894** prebuilt workspace files. This is a fresh UI/host with a preserved accepted engine and generated dependencies, not full current-backend source certification.

R03 investigation remains honest: the old Session Catalog startupReady idle fix exists in both current source and the packaged daemon. Direct real-engine and native-host controls pass; two diagnostic history runs also pass with their separate harnesses. No focused proof establishes the cause of the earlier startup timeouts. One initial tracer was inert because Tauri invoke is read-only; a corrected self-checking tracer records **2,016** requests. All temporary native tracing is removed before final acceptance. No native timeout is increased and no unproved daemon patch is applied.

Evidence: **.temp_files/desktop-service-ack/r26/**, including report.md, ledger.md, before snapshots, permanent proofs/browser logs, native-accepted/, final-build/, validation-copy.json and **final-verification.json**. The independent verifier checks archive/source/current-owner identity, matched native harness, fresh actual tool receipts, retained report/PNG hashes, fifteen final browser states and full source gates. A read-only Win32_Process inventory finds zero references to **14** exact owned fixture directories. During a concurrent commit, Desktop files temporarily disappeared and then returned without this agent restoring them; their owner hashes match the protected source. The user confirms three agents share main; no unrelated edit, stash, commit or process is changed by this round.

General Session Catalog startup/file-service reliability remains open. R25's **7 full Tools failures** remain dated non-green evidence and are not rerun for this frontend-only patch. No full native matrix, installer execution, full WebUI/root suites, other-platform run, hosted CI, installation or publication is claimed. Next scope is a focused cold-start Session Catalog failure with endpoint/owner/metadata timing, not another blind replay of the complete design journey. Project-level not-inspected/blocked status and brief-to-review continuity remain product gaps.

## Session Catalog socket ownership — round 27, 2026-11-13

**R27 verifies one client race fix; broad package verification remains non-green.** A retry replaces the current socket and its shared handshake callbacks. If the retired transport emits a late error while the replacement is still waiting for hello, its old listener can call the newer connectReject. The valid replacement hello/correlated response no longer completes that public call. Existing data and close listeners already check socket identity; the error listener did not.

The production change is one guard in **packages/core/src/session-catalog/client.ts**: ignore an error whose captured socket is no longer current. No public API, wire format, metadata/SQLite format, retry policy, 750 ms handshake timeout or 10 s startup window changes. The permanent **session-catalog-client-stale-error.test.ts** exercises public callExisting with a controlled transport and only the existing fake-clock retry step. It models the allowed event order, not an arbitrary throw inside the client. Normal current-handshake, current-error rejection and obsolete data/close controls remain intact.

| Check | Observed result |
| --- | --- |
| Preserved before implementation, unchanged final fixtures | **1 assertion FAIL / 3 valid controls PASS**; the valid replacement call stays pending |
| Patched source | **4 tests PASS, three repeats** |
| Freshly built public Core session-catalog/index.js | **Same 4 tests PASS, three repeats**; the resolver records that actual compiled entry |
| Core standard build | **PASS**, JavaScript and TypeScript declarations |
| Actual Windows named-pipe cold IPC | **3/3 PASS**, distinct owners/instance ids, live observer reuse, acknowledged shutdown, metadata removed and each PID exited |
| Core production types | **648 files PASS** |
| Complete Core test target | **NON-GREEN**: **709 files passed / 1 skipped**; **10,631 tests passed / 9 skipped**; **1 uncaught FileHandle finalization error**, **749 s**, three workers |
| Core test-source types | **NON-GREEN**: **229 diagnostics in 59 files**, exactly the same with the captured before client; **0 diagnostics in the changed client/new regression** |

The full-run exception is ERR_INVALID_STATE: a FileHandle was closed during garbage collection, naming **storage/session-registry-lock-faults.test.ts** and its registry lock fixture. The unchanged ordinary isolated target against the before implementation passes **6 tests**. This does not disprove the full-run error, reproduce its GC trigger independently or establish its cause. No unrelated source/test, assertion, skip, timeout or baseline is modified to turn that gate green. The test-type comparison uses a separate copy with only client.ts restored to captured before bytes and the same final tests/frozen dependencies; its diagnostic multiset is identical. Those 59 files are explicit existing debt for this comparison, not part of this patch.

Protected copy: **D:/Codebox/.wrongstack-core-r27-1794522570123**, HEAD **760db1de8252d587df1bec6ec17a7e8f54969b9f** plus pre-existing dirty work. Frozen install passes. **14,969** Git-listed source/config inputs, **1,584** rebuilt Core files and **11,310** unchanged prebuilt workspace files form **27,863** guarded inputs. The first compiled proof accidentally named private client.js (a declaration-only path); that zero-test setup failure was corrected to the real public index.js before any compiled behavior claim. Shared main is never rolled back to manufacture RED; current client/regression hashes match the guarded source.

Real cold daemons have PIDs **90572**, **24180** and **110884**, with distinct instance identities. A second client calls the existing owner without spawning another; closing that observer leaves the first client usable. Each acknowledged shutdown removes metadata and exits its recorded owner. The fixture and opt-in daemon log are retained without auth tokens in receipts. A separate read-only Win32_Process check finds zero references to the exact owned cold fixture root. No unowned process, stash, index, commit or unrelated edit is changed. Scoped Biome **2 files** and diff checks pass, with the existing schema advisory.

Evidence: **.temp_files/desktop-catalog-startup/r27/** — report.md, ledger.md, before snapshots, source/compiled proof logs, protected/built input manifests, cold-ipc-receipt.json, baseline comparisons and **final-verification.json**. Its outcome is deliberately **FIX_VERIFIED_BROAD_GATES_NON_GREEN**, not a full Core or Desktop PASS.

The previous server startupReady idle-shutdown repair is present and untouched. This proves one client event-ownership defect; it does not tie every earlier R24/R25 native timeout to that order. Healthy cold IPC is a real integration control, not an injected late-OS-error reproduction. **No Desktop engine/UI binary is rebuilt or installed in R27.** R26's accepted package keeps its original hash and dated scope; it cannot certify the new guard. Integrated Desktop engine acceptance, general startup reliability, full WebUI/root suites, hosted CI, installation and publication remain separate. Next bounded scope: independently reproduce the session-registry lock-fault FileHandle lifecycle error so the full Core gate can close without hiding cleanup failures.

## Evidence and limits

| Check | Observed result |
| --- | --- |
| Desktop suite, `bun run --filter @wrongstack/desktop-v2 test` | **322 files / 1,161 tests passed**, no skipped tests reported |
| Desktop types, `bun run --filter @wrongstack/desktop-v2 typecheck` | **766 files, no type errors** |
| Browser review harness | Completed; normal component fixtures had no page errors |
| Contract assertions against browser observations | **3 failures reproduced**, with passing shell, HTTPS-domain and local-HTML controls |
| Component layout samples | Welcome, Design Studio and activity at **1480×960 dark English** and **800×600 light Turkish**; no horizontal overflow or controls extending beyond the viewport in these samples |
| Git state during investigation | HEAD and tracked/untracked status entries matched the captured starting state before this report was added |
| Runtime | Installed Bun **1.4.4**; repository pin **1.4.3**. No runtime or dependency installation/change |
| Not exercised | Current native executable, engine extraction against a real site, actual native zoom, physical microphone, macOS/Linux native behavior, full WebUI/root suites, complete release matrix or hosted CI |

The browser fixtures render production components with controlled data. Their 264 px reserved left gutter tests a constrained work area; it is not a complete native-window layout simulation. Design Studio's native-storage warning in this fixture is expected because the fixture has no Tauri host. It is not reported as a product failure. The renderer fault test uses the actual browser-preview `App`, with one lazy module request deliberately rejected.

Evidence and rerunnable scripts: [review artifacts](../.temp_files/desktop-v2-review-2026-11-10/). In that directory, `browser-review.json`, `assert-review.log`, `desktop-tests.log` and `desktop-types.log` contain the observations. Run from the repository root:

```powershell
bun .temp_files/desktop-v2-review-2026-11-10/browser-review.mjs
bun .temp_files/desktop-v2-review-2026-11-10/assert-review.mjs
```

At the review baseline, the second command exited **1** because three contracts failed. After the reliability fixes, the same assertions exit **0**. A successful inspection harness alone is not a passing product acceptance gate.

## Product structure and ownership

```mermaid
flowchart TD
  P[Project] --> C[Conversation and native engine]
  P --> W[Project workspaces]
  A[Profile settings] --> C
  A --> W
  C --> T[Transcript, tools, approvals and questions]
  C --> S[Session context, usage, history and story]
  W --> E[Goals, Kanban, SDD and automation]
  W --> K[Files, changes, memory and code intelligence]
  W --> D[Design Studio and reviews]
```

The shell, conversation and native tools are Desktop-owned. SAGE, Kanban, Atlas, Office, Story, setup, context, analytics and diagnostics reuse substantial presentation code from `@wrongstack/project-surfaces`. Transport still differs: Desktop goes through Tauri IPC, retained native hosts, journal readers and adapters; WebUI uses its own WebSocket client and browser state.

This separation is useful. A shared component removes one source of presentation drift, but it does not establish equivalent session ownership, acknowledgements, live subscriptions, persistence or restart behavior. For example, [ProjectOffice](../apps/desktop-v2/src/ProjectOffice.tsx) aggregates project conversations, while [desktopStoryFeed](../apps/desktop-v2/src/desktop-story-feed.ts) describes one conversation. Those populations should not be compared as if they were identical.

The renderer also has a different trust boundary. [Tauri configuration](../apps/desktop-v2/src-tauri/tauri.conf.json) limits network/media sources; [shell capabilities](../apps/desktop-v2/src-tauri/capabilities/shell.json) grant host operations to the main/project windows rather than preview windows. This explains some deliberate differences, including external Markdown images opening through an action. Preserve that separation when adding result cards or previews. Configuration inspection is not a penetration test of native commands, preview navigation or filesystem authorization.

## Coverage by user journey

| Journey | Desktop implementation inspected | Assessment and remaining acceptance |
| --- | --- | --- |
| Open project and start work | `App`, `Sidebar`, `useDesktop`, `RuntimeGate`, native project/session registry | Multi-project shell exists. Test host-start failure, restart, reattach and project switching on the current package |
| Configure providers | `WrongStackSettings`, provider/OAuth/model editors, shared setup | Substantial settings coverage; vault/OAuth and profile/window draft conflicts require native acceptance |
| Compose and run | `SessionComposer`, references/attachments, refinement, command routing, approval/question UI | R21 verifies native pending-question arrival/review/submission; R22 adds exact typed-answer recovery through renderer reload. Both retain the composer draft. Other busy/error/session transitions and complete app/engine restart need separate acceptance |
| Read and revisit results | `TranscriptMessage`, `TranscriptVirtualizer`, pins/find, `SessionRecovery` | R07 tool-visit continuity and R19 expanded-activity Find passed again on the identified R20 native pair. R20 closes paused reading during message growth in Chromium and its native partial-stream scope. Restart and cross-session restoration remain open |
| Inspect tools and media | `SessionActivity`, `ToolInputView`, shared tool overviews, `GeneratedImages` | Design extraction/review artifact actions passed the identified native handoff scope, R04/R09/R17. Markdown images are represented by a label/open action rather than inline remote loading |
| Edit files and review changes | `FileWorkspace`, Monaco editors, version-bound saves, Git/worktree views | Monaco and editable diffs are present. External writers, binary/unsupported partial operations and large trees need their own cases |
| Execute structured work | `ProjectGoals`, `ProjectMission`, `ProjectKanban`, `ProjectSdd`, `AutomationWorkspace` | All major entry points exist. Goal/SDD mirror-board ownership, refusal and cancellation must be tested as joined workflows |
| Knowledge and project intelligence | SAGE, Chronicle, Atlas, Project Kit, TechStack, dead-code tools | Shared surfaces plus Desktop adapters are present. Live data, scale, mutation errors and retained state remain host-specific |
| Fleet and collaboration | Agent roster, live fleet, Office, transcripts, `SessionCollab`, mailbox | UI coverage exists. Check two actual participants, role refusal, foreign ownership, completed workers and reconnect |
| Understand context and spend | Session usage/context/Story and project analytics | Dedicated screens exist. Session/project/profile populations and unavailable prices must remain explicit; interface-event instrumentation is a separate issue |
| Design a product | Welcome launcher, `ProjectDesignStudio`, design tools and core design engine | Backend capability is broader than the visible continuous workflow; see the stage review below |
| Recover and distribute | Diagnostics, recovery log, durable drafts, native bundle/installer tooling | Strong infrastructure, but source tests and installer production do not replace native action acceptance |

The passing [feature-parity test](../apps/desktop-v2/tests/feature-parity.test.ts), lines 21–26, compares metadata arrays: **32 views, 7 activities and 16 settings tabs**. It does not execute the router or those actions. Its next test checks registered operation names. The seven WebUI dock sections need a separate action/ownership matrix. The metadata files `feature-catalog.ts` and `feature-actions.ts` are not production UI implementation merely because their tests pass.

## Prioritized findings

P1 means the next reliability or acceptance batch; P2 means the next workflow batch; P3 means a measured product decision. These priorities are not security severity ratings.

R01–R12 preserve the original investigation findings; the current action matrix and dated implementation checkpoints above state what has since been fixed or verified. R13 onward were discovered during the subsequent acceptance rounds.

| ID | Priority | Evidence class | Finding |
| --- | --- | --- | --- |
| R01 | P1 | Reproduced renderer fault | A rejected lazy settings import removes the entire app shell |
| R02 | P1 | Reproduced input bug | An HTTPS URL ending in `.html` is written as a local-file extraction request |
| R03 | P1 | Acceptance gap | Native evidence belongs to different artifacts; current 1.5.6 source is not certified by the old matrix |
| R04 | P2 | Source and rendered fixture | Design extraction lacks the WebUI progress/artifact action card |
| R05 | P2 | Source comparison | Design entry points and React Native quick-start differ between clients |
| R06 | P2 | Source comparison | Desktop typography settings cover less than the current WebUI role/preset system |
| R07 | P2 | Source-supported lifecycle concern | Switching away from chat unmounts the transcript and its local view state |
| R08 | P2 | Reproduced localization bug | Turkish shared-surface confirmations fall back to English `Cancel` |
| R09 | P2 | Shared workflow gap | Extraction, source verification and rendered acceptance are not one visible review loop |
| R10 | P2 | Architecture/maintenance observation | Parallel UI/CSS implementations and large owners make parity costly to maintain |
| R11 | P2 | Documentation mismatch | The current parity report opens with an obsolete 1.5.2 manifest claim and mixes many acceptance checkpoints |
| R12 | P3 | Measurement/requirements gap | Original size, startup, memory and throughput targets need a current executable baseline |
| R13 | P1 | Reproduced installer defect, follow-up | A successful engine shutdown can leave a daemon holding the installed image, and NSIS reports success with the old engine still installed |
| R14 | P2 | Reproduced native refusal-message defect, fixed | Restoring a caller register before choosing the failure reason labels the same readonly file as a running engine |
| R15 | P2 | Reproduced native localization defect, fixed | Installer refusal messages ignore the selected language and remain English |
| R16 | P2 | Reproduced native fixture ownership defect, fixed | File-backed engine output makes the standalone installer test share its controller console, unlike the native host launch |
| R17 | P2 | Reproduced packaged design artifact defect, fixed | Cards normalize nested-engine outputs against the parent project and omit a valid artifact action or open a parent decoy |
| R18 | P2 | Reproduced controller and packaged lifecycle defect, fixed | Reload before the debounced host layout save restores an older selected conversation |
| R19 | P2 | Reproduced browser/native message-reachability defect, fixed | Centering a row with expanded activity can place the searched message above a short viewport |

### R01 Renderer failures escape the workspace

[App.tsx](../apps/desktop-v2/src/App.tsx), lines 151–159, wraps lazy workspaces in `Suspense`, without a shell/workspace error boundary. The Monaco slot has its own fallback boundary, but that does not protect settings or other project views.

Control: normal `App` renders one `.app-shell`. Trigger: navigate to settings while rejecting its lazy module request. Actual: **0 app shells and 0 children under `#root`**, with `Failed to fetch dynamically imported module`. This is injected browser failure evidence, not an observed spontaneous native crash. It demonstrates the containment gap for that failure path.

WebUI uses panel boundaries in [MainViewSlot](../packages/webui/src/components/MainViewSlot.tsx), line 70, and [ViewRouter](../packages/webui/src/components/ViewRouter.tsx), line 57. Add a named Desktop workspace boundary plus a shell fallback that retains navigation and an explicit recovery action. Close only after a rejected chunk and a component render exception both preserve usable recovery UI.

### R02 Design source normalization reverses valid inputs

[design-dna-prompt.ts](../apps/desktop-v2/src/design-dna-prompt.ts), lines 9–18, tests the `.html` suffix before giving an explicit HTTP(S) scheme precedence.

| Input | Actual generated extraction argument | Expected |
| --- | --- | --- |
| `https://example.com` | `url: "https://example.com"` | URL; passing control |
| `index.html` | `file: "index.html"` | File; passing control |
| `https://example.com/index.html` | `file: "https://example.com/index.html"` | URL |
| `INDEX.HTML` | `url: "https://INDEX.HTML"` | Local HTML file |

The actual Welcome input and preparation button produce these prompts. This proves a malformed UI instruction, not a real extraction-backend failure; a model could compensate. WebUI's [normalizeDesignSourceInput](../packages/webui/src/lib/design-dna-message.ts) checks the HTTP(S) scheme first and handles the HTML suffix case-insensitively. Use a shared pure contract, retaining each client's send/draft behavior. Include an explicit unsupported-input policy rather than manufacturing an HTTPS target for every unrecognized string.

### R03 Accept one immutable current package

The locally read historical state file `.temp_files/desktop-parity-finish/tree-scale-isolated/current-native-state.json` identifies portable `52d3697b278a-c86179698276`: **Files and Roster passed; MCP Tasks and Fleet failed; 39 scopes were not run**. Its saved `running` marker is historical state, not proof that its recorded controller is still active.

Current `dist-native/latest.json` instead names `8fef39c8beac-d0e9611f1c6f`. Neither the historical failures nor its passes can be transferred to that executable, or to today's dirty source. Root causes of the old native failures were not re-established in this investigation.

[desktop.yml](../.github/workflows/desktop.yml) builds platform bundles and includes engine smoke/signing-related checks; it does not invoke the Desktop UI matrix. The native matrix is available separately in [native-matrix.mjs](../apps/desktop-v2/tests/native-matrix.mjs). Finish a package/hash/harness-bound acceptance receipt before claiming production parity. This review does not establish a current full native receipt or current hosted CI state.

### R04 Extraction output needs a usable result surface

WebUI's [ToolLedgerCard](../packages/webui/src/components/MessageBubble/ToolLedgerCard.tsx), lines 189–196, mounts [DesignReferenceCard](../packages/webui/src/components/MessageBubble/DesignReferenceCard.tsx): four extraction stages and actions to open the generated `DESIGN.md` or return to Design Studio.

Desktop [SessionActivity](../apps/desktop-v2/src/SessionActivity.tsx), lines 152–236, renders the shared tool overview, specialized input, progress text and generic output. Its current shared summary already extracts some design facts; it is incorrect to say Desktop shows no design information. However, the completed extraction fixture provides **Copy/Save**, without the dedicated generated-spec or Studio actions. This makes a successful tool result harder to continue from.

Share the result/progress projection with explicit Desktop file/navigation callbacks. Do not import the WebUI card unchanged: it currently dispatches a WebUI file event and uses `showPanel`. Close with running/error/completed/replayed cases and correct project/session file ownership.

### R05 Keep design work reachable after the first prompt

Desktop's URL/page/workflow form is in [ConversationWelcome](../apps/desktop-v2/src/ConversationWelcome.tsx), an empty-conversation surface. The persistent [ProjectDesignStudio](../apps/desktop-v2/src/ProjectDesignStudio.tsx), lines 272–278, offers an extraction callout with a slash example rather than the equivalent source form. WebUI retains a source/page form in [DesignStudioPanel](../packages/webui/src/components/SidePanel/DesignStudioPanel.tsx), lines 137–149.

The Desktop quick prompt type offers `extract` and `materialize-web`; WebUI also offers `materialize-rn`. Desktop's full Studio already offers supported kit stacks, so this is **a missing quick-start option, not absence of React Native materialization**.

Provide one discoverable design workflow entry that remains available in an ongoing conversation. Show the target conversation before sending from a project-owned page. Preserve the deliberate Desktop contract that a starter prepares the draft; WebUI's panel sends directly. Harmonize task options and terminology without accidentally adopting different submission semantics.

### R06 Typography is only partially equivalent

[appearance-fonts.ts](../apps/desktop-v2/src/appearance-fonts.ts), lines 7–27, models UI/code families, installed custom names, whole-window text zoom and ligatures. [WebUI fonts](../packages/webui/src/lib/fonts.ts), lines 42–93, model **UI, display, reading, code, editor and terminal** separately, with ten named presets, numeric size settings and self-hosted family loading.

Desktop ships Geist and relies on installed/fallback fonts for its other choices. A typed custom font name is not evidence that the face is present. The same saved intent can therefore produce a different hierarchy across surfaces or machines.

Decide whether Desktop intentionally keeps a smaller typography product. If parity is required, share the role/preset contract and font-loading policy while retaining native editor/terminal measurement hooks. Test actual font availability, fallback and native zoom; this review did not certify those native states.

### R07 Preserve reading position across tool visits

[EngineWorkspace](../apps/desktop-v2/src/EngineWorkspace.tsx), line 371, conditionally mounts chat. [TranscriptVirtualizer](../apps/desktop-v2/src/TranscriptVirtualizer.tsx) keeps focus/find targets in component state and receives no saved scroll snapshot. The inspected chat path has no equivalent session-scoped scroll restoration on remount. WebUI's [ViewRouter](../packages/webui/src/components/ViewRouter.tsx), lines 43–59, parks chat to retain its transcript and local reading state.

This is a source-supported continuity concern, not a newly executed native scroll defect. It does not imply composer text or journal data is lost: Desktop has durable draft writers and retained backend streams. Acceptance should scroll into an older answer, open Files/Usage, return, and compare the visible message/offset, open tool details and keyboard focus. Choose parked views or explicit bounded view-state persistence; do not preserve every expensive workspace indefinitely by default.

### R08 Confirmation defaults bypass localization

[SurfaceFrame](../apps/desktop-v2/src/SurfaceFrame.tsx), lines 81 and 87, defaults to literal `Cancel` and `Confirm`. The real SAGE discard path in [useMemoryManagerState](../packages/project-surfaces/src/sage/useMemoryManagerState.ts), lines 422–428, supplies a translated confirmation label but omits the cancellation label. WebUI's [ConfirmModal](../packages/webui/src/components/ConfirmModal.tsx), line 171, translates that default.

A Turkish Desktop frame with the same options shape renders **Cancel / Vazgeç / Kapat**. The translated Radix close button is a control showing that the selected language reached the surface. Translate defaults in the host frame; callers should not have to repair each missing label. The activity fixture also shows product-authored English design summary strings inside Turkish UI; upstream tool output itself should remain unchanged.

### R09 Make design evidence continuous

The engine supports reference extraction, token capture/materialization, semantic document diff, source verification, rendered inspection and fidelity comparison. The Desktop page directly exposes kit selection/tuning/materialization and `design.verify`; extraction is routed through a prompt, while inspect/compare/diff remain tool/command workflows. This is partly shared product debt, not entirely WebUI-only capability.

The [design turn gate](../packages/core/src/execution/design-turn-gate.ts), lines 13–21 and 138 onward, deliberately stays silent without an available inspect tool and known served/static target. A silent gate must not appear to the user as completed visual review. Expose a compact state: **not inspected / blocked with reason / inspected with findings**, plus target, viewport/theme and evidence time. Keep source color adherence distinct from rendered accessibility or reference fidelity.

### R10 Reduce drift through ownership, not a broad rewrite

Desktop has parallel shell CSS layers (`styles.css`, `workbench.css`, `shell.css`, `controls.css`) and a framed bridge to shared styles in [surfaces.css](../apps/desktop-v2/src/surfaces.css). It also keeps separate design source builders, gallery components and local UI state. These are maintenance costs with different causes; none is automatically dead code.

Large owners concentrate several responsibilities: `FileWorkspace.tsx` **2,068 lines**, `ProjectAgentRoster.tsx` **1,588**, `ProjectGoals.tsx` **1,079**, `SessionComposer.tsx` **1,071** at inspection. Line count is a maintenance signal, not a demonstrated runtime bug.

Prefer narrow shared contracts for source normalization, artifact/result models, font roles and action acceptance. Retain Desktop-owned host/lifecycle semantics. Extract owners only while closing a measured defect or workflow gap; a full UI rewrite would create another parity surface.

### R11 Keep the present assessment separate from history

[desktop-v2-vs-webui.md](desktop-v2-vs-webui.md) has **1,616 lines** and opens with “Both frontend manifests now identify 1.5.2”; current manifests identify 1.5.6. It contains valuable historical evidence, but old missing-feature descriptions, implementations, package receipts and later continuation results are interleaved.

Keep stable finding IDs, but maintain one short current status table with source version, artifact identity, last accepted scenario and exact next acceptance. Preserve dated logs as history. The older “Monaco absent”, “analytics absent”, “collaboration absent”, “redo absent” or “Office always empty” claims should not be restored as current findings.

### R12 Rebaseline measurable product targets

[desktop-v2-analysis.md](desktop-v2-analysis.md), section 6.3, sets targets including ≤2 s cold start, ≤150 MB idle RAM, ≤15 MB installer, ≤500 ms reattach and three terminals at 10k lines/s each. Current local latest portable contains **18,908,160 bytes of UI executable and 151,895,552 bytes of engine**. These are uncompressed executable sizes, not installer download size or resident RAM.

Measure each target with a fixed workload and identified package. If the complete bundled engine changes the product's acceptable footprint, revise the requirement explicitly. Do not infer a performance failure from file size, a passing navigation test, or an old partial benchmark. Include long streaming Markdown, large transcript revisit and minimum-window/native-zoom tests; WebUI's stable-prefix streaming renderer is an existing comparison point, not proof of a Desktop performance regression.

## Design workflow stage review

| Stage | Existing capability | Missing continuity or decision |
| --- | --- | --- |
| Product brief and direction | Product/design guidance, `PRODUCT.md` and `.design/brief.md` workflow | Show the current project's objective and review criteria; avoid forcing a kit migration for small edits to an established system |
| Reference input | Shared Welcome/conversation/Studio form; explicit HTTP(S) classification fixed | Native prepared drafts preserve text and ownership. Validation-pending owner changes still need native acceptance |
| Extraction | Multi-page/breakpoint DNA engine and live progress card | Dated native running/success/failed-file cases passed. R24 adds cold-process interruption and subsequent genuine extraction acceptance on its own pair. Actual partly written files and multi-page partial failures remain separate; preparation text is not completion |
| Inspect generated specification | Native card opens the actual engine-root `DESIGN.md`, including a nested package | R17 fixed parent-root confusion. An explicit reference picker and review of all extracted pages remain product decisions |
| Capture or select tokens | Existing design tools and kit catalog | Make captured reference versus pinned kit ownership visible; a callout alone is not a capture control |
| Tune and generate themes | Color/tuning controls, expected-kit protection, readback and stack selection; shared form prepares web and React Native materialization | Keep those protections. Native React Native draft preparation passed; the preview remains a token sample rather than proof of a whole product's design |
| Implement product UI | Shared design guidance and agent execution | Preserve actual product content, existing components and explicit user direction |
| Verify source | `design.verify`, findings, color score and no-signal reporting | Keep heuristic limits visible; no-signal or color score is not visual acceptance |
| Inspect and compare rendered output | Shared form, measured result cards, actual report actions and turn gate; native handoff passed | Project-level absence/blocked status remains open. Preserve measurement limits, screenshot/viewport/theme context and distinguish source verification from rendered review |
| Review and handoff | Conversation and Run activity connect outputs and measurements. R25 retains per-run evidence; R26 opens validated reports independently of explorer listing and accepts the identified normal native history journey | General service startup, project-level absence/blocked state and brief/objective/criteria continuity remain incomplete. Overwritten legacy bytes cannot be recovered; pruning policy remains undecided |

The useful completion unit is **one project design task from brief to inspected output**, not the number of kits, badges, token controls or extraction stages shown.

## What to simplify and what to preserve

- Keep project/profile/session scope differences, but state them beside settings, metrics and actions. Do not flatten them merely to mimic WebUI navigation.
- Keep the compact launcher and group secondary tools. Prioritize conversation → inspect result → edit/review → resume, and brief → reference → implement → inspect. Avoid promoting every subsystem to another permanent rail button.
- Keep Desktop's durable drafts, revision checks, retained hosts, native previews and version-bound file operations. Their separate lifecycle is part of the product.
- Treat full-screen replacement of chat for brief tool visits as a continuity decision, R07. A secondary inspector is useful only where the user benefits from seeing the conversation alongside it.
- Keep shared branding and palettes. The inspected samples do not justify a new visual identity or wholesale palette replacement.
- Preserve the current theme preview's radius, display font, spacing and shadow bindings; those tokens already exist. An early apparent starter-card contrast problem disappeared after waiting for theme transitions, so it is not retained as a finding.

## Bounded delivery sequence

| Batch | Scope | Acceptance that permits moving on |
| --- | --- | --- |
| 1. Reliability | R01, R02, R08 | Same failing proofs pass after narrow fixes; durable tests cover controls, language and faults; navigation/drafts remain usable |
| 2. One complete design journey | R04, R05, visible review state from R09 | Ongoing conversation → reference → progress → correct generated document → captured/materialized theme → rendered inspect/compare → preserved conversation/draft |
| 3. Reading and appearance | R07, explicit R06 typography decision | Older message position survives a tool visit; actual fonts/fallback and minimum-window native zoom pass |
| 4. Current package acceptance | R03, R12 | One immutable executable/harness receipt; native action and failure scenarios, resources/performance, required platform checks and audio boundary reported separately |
| 5. Sustainable parity tracking | R10, R11 | Small current action matrix, historical logs separated, only proven maintenance extractions |

The acceptance matrix should track **open → read → act → acknowledgement → failure/refusal → revisit/restart** for each critical journey, and name its project/profile/session owner. Add visible polish after those steps hold. This keeps the work focused while still covering the detail that determines whether a screen is actually usable.

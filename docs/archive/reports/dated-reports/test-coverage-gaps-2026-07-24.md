# Non-Web UI Test Coverage Gap Report

Generated: 2026-07-24T21:49:32.105Z

## Scope

- Included: root Vitest coverage inventory under `packages/*/src/**/*.{ts,tsx}`.
- Excluded by request: `packages/webui`, `packages/simpleui`, `packages/webui-hq`, and the `website` workspace.
- Preserved: all existing exclusions in `vitest.config.ts` (barrels, interactive entry points, type-only files, live-LSP parsers, and other documented exceptions).
- `packages/webui-server` remains in scope because it is backend/server code.

## Executive findings

- **Seven files have confirmed 0% line coverage** in completed V8 reports. Add these tests first:
  1. `packages/sage/tests/embeddings/hashing.test.ts` for `packages/sage/src/embeddings/hashing.ts`.
  2. `packages/tools/tests/tool-tier.test.ts` for `packages/tools/src/tool-tier.ts`.
  3. `packages/sage/tests/embeddings/provider.test.ts` for `packages/sage/src/embeddings/provider.ts`.
  4. `packages/kanban/tests/verification/plugins/agent.test.ts` for `packages/kanban/src/verification/plugins/agent.ts`.
  5. `packages/kanban/tests/verification/plugins/council.test.ts` for `packages/kanban/src/verification/plugins/council.ts`.
  6. Extend `packages/plugins/tests/index-exports.test.ts` for `packages/plugins/src/factories/index.ts`.
  7. Extend `packages/plugins/tests/index-exports.test.ts` for `packages/plugins/src/audit/index.ts`.
- **Thirteen additional files are below 25% line coverage.** The highest-impact additions are the Kanban verifier plugins, provider OAuth flows, `packages/tools/src/kanban.ts`, language-profile adapters, persistent process registry, and TechStack research search. Exact lines, functions, branches, and target test files are listed below.
- **Branch coverage is the limiting metric:** 78.44% across completed reports, leaving 6,589 uncovered branches. Tools (66.75%), TechStack (65.25%), providers (73.65%), Kanban (74.10%), and plugins (77.65%) need explicit error, fallback, boundary, and platform-path tests.
- **Five completed packages are at 100% in all metrics:** bench, persistence, plug-lsp, runtime, and SDD. Security Scanner, Telegram, and Sage are near 100% but still have exact residual statement, branch, or file-level gaps below.
- **Five packages need a dedicated idle-machine coverage rerun:** CLI, core, MCP, TUI, and webui-server. Their JSON reporters did not complete within bounded runs; 389 conservative no-direct-test candidates are listed instead (core 131, CLI 116, TUI 74, webui-server 65, MCP 3).

## Priority queue

### P0 — confirmed zero-coverage files

Implement the seven test additions listed above. Their exact uncovered statements, functions, and branches start in the first seven entries of the V8 appendix.

### P1 — confirmed files below 25% lines

| Source file | Lines | Branches | Add or extend tests in |
|---|---:|---:|---|
| `packages/kanban/src/verification/plugins/git-diff.ts` | 7.89% | 0% | `packages/kanban/tests/verification/plugins/git-diff.test.ts` |
| `packages/kanban/src/verification/evidence-validator.ts` | 9.52% | 0% | `packages/kanban/tests/verification/evidence-validator.test.ts` |
| `packages/tools/src/kanban.ts` | 11.02% | 6.70% | `packages/tools/tests/kanban-completion-gate.test.ts` and related Kanban tool tests |
| `packages/kanban/src/verification/plugins/file-matches.ts` | 12.00% | 0% | `packages/kanban/tests/verification/plugins/file-matches.test.ts` |
| `packages/tools/src/languages/profiles/additional.ts` | 13.86% | 1.28% | `packages/tools/tests/languages/profiles/additional.test.ts` |
| `packages/providers/src/oauth/index.ts` | 14.28% | 0% | `packages/providers/tests/oauth/index.test.ts` |
| `packages/providers/src/oauth/shared.ts` | 15.55% | 16.27% | `packages/providers/tests/oauth/shared.test.ts` |
| `packages/kanban/src/verification/plugins/metric.ts` | 15.78% | 0% | `packages/kanban/tests/verification/plugins/metric.test.ts` |
| `packages/kanban/src/verification/plugins/test.ts` | 16.66% | 0% | `packages/kanban/tests/verification/plugins/test.test.ts` |
| `packages/providers/src/oauth/copilot.ts` | 21.25% | 20.96% | `packages/providers/tests/github-copilot.test.ts` |
| `packages/techstack/src/research/search.ts` | 22.22% | 0% | `packages/techstack/tests/research/search.test.ts` |
| `packages/tools/src/process-registry-persistent.ts` | 23.47% | 11.45% | `packages/tools/tests/process-registry-persistent.test.ts` |
| `packages/providers/src/oauth/claude.ts` | 24.48% | 0% | `packages/providers/tests/oauth/claude.test.ts` |

### P2 — rerun incomplete packages, then replace static candidates with V8 evidence

Run one package at a time on an idle machine. Start with the largest conservative no-direct-test candidates:

- Core: `coordination/agents/project-agent-identity.ts`, `tools/fallback-manage-tools.ts`, and `coordination/mailbox-types.ts`.
- CLI: `execution.ts`, `slash-commands/memory.ts`, `hq-server/routes.ts`, and `subcommands/handlers/modeldiag.ts`.
- TUI: `components/history/utils.tsx`, `components/settings-picker.tsx`, `app-state.ts`, `components/history/code-block.tsx`, and `hooks/use-picker-keys.ts`.
- webui-server: `server/kanban-routes.ts`, `server/start-webui.ts`, `server/memory-handlers.ts`, `server/goal-ws-handler.ts`, and `server/backend-services.ts`.
- MCP: all three candidates in the static appendix.

## Method and limitations

- The monolithic root coverage command exceeded the 30-minute execution window and emitted no final JSON. Coverage was therefore rerun as package-scoped V8 shards with the same root config and source exclusions.
- Fourteen package reporters produced valid `coverage-final.json` and `coverage-summary.json`; their results are exact for those shard runs. CLI, core, MCP, TUI, and webui-server did not produce complete reports within their 15–20 minute bounds.
- Package sharding can **understate** coverage from tests in another package. A line shown uncovered here may be exercised only by a cross-package integration test that was not part of that package's shard. It cannot overstate an uncovered line within the completed shard.
- The static appendix is a conservative source-to-test filename/path match. “No direct test” does **not** prove 0% runtime coverage; integration tests can execute the source indirectly.
- The checkout was heavily and concurrently modified during this audit. Results describe the working-tree snapshot used by each shard on 2026-07-24, not a clean immutable commit. Re-run after the shared tree settles before enforcing 100% thresholds.
- Existing exclusions from `vitest.config.ts` remain excluded. Reaching “100%” means 100% of that declared denominator, not every repository line.

## Audit-side hardening completed

Mandatory review during the audit identified two security regressions in concurrently modified code. They were fixed and verified before this report was finalized:

- Directory permission rules now evaluate every array, comma-separated plural, source, and destination path; a protected secondary target can no longer hide behind an allowed first target. `evaluate()` and `explain()` return matching denial decisions and subjects.
- PostgreSQL credential detection now covers bounded literal and percent-encoded `password` query-parameter names in first, middle, and last positions across secret-scanner and prompt-firewall paths.

Verification: 116 focused tests passed across four files; `@wrongstack/core` and `@wrongstack/plugins` typechecks passed; scoped Biome lint and format checks passed.

## Completed V8 shard aggregate

| Metric | Covered / total | Coverage | Remaining |
|---|---:|---:|---:|
| lines | 32914 / 36428 | 90.35% | 3514 |
| statements | 36418 / 41100 | 88.61% | 4682 |
| functions | 5790 / 6443 | 89.86% | 653 |
| branches | 23968 / 30557 | 78.44% | 6589 |

These totals cover only packages whose JSON reporter completed; they are not a monorepo-wide percentage.

## Package results

| Package | Lines | Statements | Functions | Branches |
|---|---:|---:|---:|---:|
| acp | 95.69% | 95.25% | 98.19% | 90.43% |
| bench | 100% | 100% | 100% | 100% |
| kanban | 84.5% | 82.33% | 86.72% | 74.1% |
| persistence | 100% | 100% | 100% | 100% |
| plug-lsp | 100% | 100% | 100% | 100% |
| plugins | 92.49% | 89.92% | 92.88% | 77.65% |
| providers | 83.97% | 81.55% | 78.16% | 73.65% |
| runtime | 100% | 100% | 100% | 100% |
| sage | 97.99% | 97.92% | 98.78% | 98.93% |
| sdd | 100% | 100% | 100% | 100% |
| security-scanner | 100% | 99.88% | 100% | 99.82% |
| techstack | 84.51% | 81.18% | 80.86% | 65.25% |
| telegram | 99.65% | 99.68% | 100% | 99.83% |
| tools | 83.44% | 81.5% | 80.55% | 66.75% |

## Incomplete reporter packages

- `cli`: no complete JSON report (ENOENT); use the static no-direct-test appendix below and rerun this package on an idle machine.
- `core`: no complete JSON report (ENOENT); use the static no-direct-test appendix below and rerun this package on an idle machine.
- `mcp`: no complete JSON report (ENOENT); use the static no-direct-test appendix below and rerun this package on an idle machine.
- `tui`: no complete JSON report (ENOENT); use the static no-direct-test appendix below and rerun this package on an idle machine.
- `webui-server`: no complete JSON report (ENOENT); use the static no-direct-test appendix below and rerun this package on an idle machine.

## Exact V8 gaps (273 files below 100%)

### `packages/sage/src/embeddings/hashing.ts`

- Coverage: lines 0%, statements 0%, functions 0%, branches 0%.
- Add tests in: `packages/sage/tests/embeddings/hashing.test.ts`.
- Uncovered statement lines: 27-28, 30, 38-41, 43, 65-67, 71-72, 84-86, 88, 92-93, 97, 101, 104-107, 111-112, 116-118, 120-123, 127.
- Uncovered functions: `fnv1a` (line 37), `constructor` (line 64), `embed` (line 83), `embedOne` (line 91), `(anonymous_4)` (line 101).
- Uncovered branch lines: 64-66, 72, 86, 93, 121.

### `packages/tools/src/tool-tier.ts`

- Coverage: lines 0%, statements 0%, functions 0%, branches 0%.
- Add tests in: `packages/tools/tests/tool-tier.test.ts`.
- Uncovered statement lines: 7, 18, 20, 23-24, 27-29, 32-35, 37, 54, 58-59.
- Uncovered functions: `toolNameSet` (line 6), `(anonymous_1)` (line 7), `selectBuiltinToolsForTier` (line 14), `(anonymous_3)` (line 24), `(anonymous_4)` (line 29), `(anonymous_5)` (line 35), `registerBuiltinToolTier` (line 53).
- Uncovered branch lines: 7, 19, 21-22, 26, 29, 31, 37-39, 56, 58.

### `packages/sage/src/embeddings/provider.ts`

- Coverage: lines 0%, statements 0%, functions 0%, branches 0%.
- Add tests in: `packages/sage/tests/embeddings/provider.test.ts`.
- Uncovered statement lines: 25-33, 35-36.
- Uncovered functions: `cosineSimilarity` (line 24).
- Uncovered branch lines: 35.

### `packages/kanban/src/verification/plugins/agent.ts`

- Coverage: lines 0%, statements 0%, functions 0%, branches 100%.
- Add tests in: `packages/kanban/tests/verification/plugins/agent.test.ts`.
- Uncovered statement lines: 16-17, 20, 40.
- Uncovered functions: `canHandle` (line 19), `verify` (line 23).
- Uncovered branch lines: none reported.

### `packages/kanban/src/verification/plugins/council.ts`

- Coverage: lines 0%, statements 0%, functions 0%, branches 100%.
- Add tests in: `packages/kanban/tests/verification/plugins/council.test.ts`.
- Uncovered statement lines: 14-15, 18, 26.
- Uncovered functions: `canHandle` (line 17), `verify` (line 21).
- Uncovered branch lines: none reported.

### `packages/plugins/src/factories/index.ts`

- Coverage: lines 0%, statements 0%, functions 0%, branches 100%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 4, 72-73.
- Uncovered functions: `(anonymous_0)` (line 72), `(anonymous_1)` (line 73).
- Uncovered branch lines: none reported.

### `packages/plugins/src/audit/index.ts`

- Coverage: lines 0%, statements 0%, functions 100%, branches 100%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 2.
- Uncovered functions: none reported.
- Uncovered branch lines: none reported.

### `packages/kanban/src/verification/plugins/git-diff.ts`

- Coverage: lines 7.89%, statements 7.14%, functions 10%, branches 0%.
- Add tests in: `packages/kanban/tests/verification/plugins/git-diff.test.ts`.
- Uncovered statement lines: 23-26, 32-33, 35-36, 38-40, 44-46, 50-55, 60-64, 67-71, 75, 82-85.
- Uncovered functions: `verify` (line 18), `(anonymous_2)` (line 51), `(anonymous_3)` (line 52), `(anonymous_4)` (line 61), `(anonymous_5)` (line 68), `(anonymous_6)` (line 82), `(anonymous_7)` (line 83), `(anonymous_8)` (line 84), `(anonymous_9)` (line 85).
- Uncovered branch lines: 25, 38, 44, 50, 53, 60, 62, 67, 69, 98.

### `packages/kanban/src/verification/evidence-validator.ts`

- Coverage: lines 9.52%, statements 8.69%, functions 0%, branches 0%.
- Add tests in: `packages/kanban/tests/verification/evidence-validator.test.ts`.
- Uncovered statement lines: 42, 50, 60-61, 64-65, 72-73, 79-82, 84-85, 93-96, 104.
- Uncovered functions: `constructor` (line 41), `setRule` (line 46), `validate` (line 57), `(anonymous_3)` (line 80), `(anonymous_4)` (line 81), `(anonymous_5)` (line 95).
- Uncovered branch lines: 61, 64, 72, 79, 84, 87, 93, 95.

### `packages/tools/src/kanban.ts`

- Coverage: lines 11.02%, statements 10.36%, functions 22.22%, branches 6.7%.
- Add tests in: `packages/tools/tests/kanban-completion-gate.test.ts`, `packages/tools/tests/kanban-evidence-bridge.test.ts`, `packages/tools/tests/session-kanban.test.ts`.
- Uncovered statement lines: 505, 510-511, 518, 522, 530-531, 534-535, 538, 559-560, 576, 579-580, 591, 594-596, 599-600, 606-607, 611, 613, 616-618, 626-627, 638-639, 647-648, 650-651, 668, 677-679, 690, 700, 703-710, 712-713, 719, 727, 732, 739, 748, 751, 760, 763, 772, 779-780, 784, 787-789, 794, 797-799, 802, 805-808, 815-816, 818, 821-822, 824, 836, 841-842, 844, 862, 867-868, 870, 888, 893-895, 898-900, 906, 909, 916, 925-927, 930, 936, 939, 945, 965-966, 968, 973-974, 976, 983, 986-989, 992-993, 995, 1002, 1012-1013, 1015, 1020, 1030, 1036, 1041-1042, 1044, 1049, 1052-1054, 1060, 1064, 1095, 1130, 1133-1134, 1136, 1148, 1153-1154, 1160, 1190, 1200-1202, 1209, 1212, 1219-1220, 1222, 1228, 1231-1232, 1234, 1242, 1245-1246, 1248, 1262, 1265-1266, 1268, 1273, 1276-1277, 1279, 1291, 1294-1296, 1300, 1303-1305, 1310, 1313-1314, 1316, 1320-1323, 1325, 1330, 1337-1338, 1340-1341, 1343-1344, 1346-1347, 1358, 1360, 1363, 1366-1367, 1369, 1376, 1380, 1383, 1392-1393, 1398-1399, 1408-1409, 1411, 1414, 1419, 1426-1429, 1431, 1445, 1449, 1462-1466, 1479-1480, 1492-1495, 1497, 1500, 1513, 1517-1518, 1611, 1614-1615, 1619, 1637, 1661, 1686.
- Uncovered functions: `(anonymous_3)` (line 709), `(anonymous_5)` (line 1322), `(anonymous_6)` (line 1323), `(anonymous_7)` (line 1343), `(anonymous_8)` (line 1393), `atomicityNudge` (line 1425), `(anonymous_10)` (line 1428), `(anonymous_11)` (line 1429), `fail` (line 1444), `okBoard` (line 1448), `handleSplitTask` (line 1457), `(anonymous_17)` (line 1493), `(anonymous_18)` (line 1497), `requireBoard` (line 1509), `taskInput` (line 1516), `mergedDependsOn` (line 1610), `(anonymous_22)` (line 1614), `taskPatch` (line 1618), `assignmentInput` (line 1636), `hasAssignmentInput` (line 1660), `assignmentForTaskCreate` (line 1685).
- Uncovered branch lines: 505, 508-509, 515, 518, 529, 533, 535, 538, 541-543, 548, 551, 554, 558-559, 561-563, 565, 568, 571, 573-574, 576, 578-579, 581-583, 585-586, 588-589, 591, 593-594, 596, 598-599, 602-604, 609, 613, 615, 617, 625-626, 628-630, 632-633, 635-636, 638, 646-647, 652-657, 659-660, 662-663, 665-666, 669, 674, 676-677, 680-685, 687-688, 696, 703, 705-706, 712, 720, 725, 738, 750, 762, 778-779, 782, 784, 786-787, 790-792, 794, 796-797, 802, 804-805, 807, 814-815, 820-821, 827-828, 830-831, 833-834, 837-838, 840-841, 851-853, 855-856, 858-859, 863-864, 866-867, 877-879, 881-882, 884-885, 889-890, 892-893, 895, 897-898, 906, 908-914, 925, 928-934, 950-951, 953, 956, 958-959, 962, 965, 969-970, 972-973, 983, 985-986, 989, 991-992, 997, 999-1000, 1003, 1009, 1011-1012, 1018, 1021, 1027, 1029, 1031-1032, 1034, 1037-1038, 1040-1041, 1045-1047, 1049, 1051-1052, 1060, 1063, 1067, 1073-1084, 1092, 1095, 1101, 1107, 1109, 1132-1133, 1137-1138, 1145-1146, 1149-1150, 1152-1153, 1161-1164, 1166, 1169-1170, 1172, 1175, 1177, 1180, 1182, 1185, 1188, 1191, 1197, 1199-1200, 1208, 1210, 1218-1219, 1228, 1230-1231, 1236-1240, 1242, 1244-1245, 1254-1259, 1262, 1264-1265, 1273, 1275-1276, 1286-1288, 1291, 1293-1294, 1297, 1300, 1302-1303, 1307-1308, 1310, 1312-1313, 1318, 1320, 1326-1329, 1336-1337, 1340, 1344, 1346, 1353-1354, 1356, 1358, 1361-1362, 1365-1366, 1380, 1404, 1407-1408, 1413, 1419, 1426, 1448, 1465, 1483-1490, 1492, 1494, 1513, 1517, 1519, 1524, 1527-1537, 1539-1540, 1543, 1546, 1552, 1556, 1558, 1563-1567, 1571, 1573, 1577-1578, 1582, 1584, 1588, 1594, 1597, 1599-1602, 1605, 1612-1615, 1626, 1630-1632, 1662-1681, 1687-1695, 1697-1707.

### `packages/kanban/src/verification/plugins/file-matches.ts`

- Coverage: lines 12%, statements 11.53%, functions 50%, branches 0%.
- Add tests in: `packages/kanban/tests/verification/plugins/file-matches.test.ts`.
- Uncovered statement lines: 23-26, 32, 34-35, 41-42, 52-58, 60-63, 68, 83.
- Uncovered functions: `verify` (line 18).
- Uncovered branch lines: 25, 32, 36-37, 41, 54, 58, 62, 72, 78, 80, 89.

### `packages/tools/src/languages/profiles/additional.ts`

- Coverage: lines 13.86%, statements 13.46%, functions 15.27%, branches 1.28%.
- Add tests in: `packages/tools/tests/languages/profiles/additional.test.ts`.
- Uncovered statement lines: 48-49, 57, 63, 68, 73, 79, 92, 94, 100, 118-119, 128, 135-136, 138, 141-142, 156, 158, 170-171, 192-196, 204, 210, 216-220, 228-231, 234, 242-243, 248-249, 257, 263-264, 293, 300, 306, 313, 320, 328-329, 339, 346-347, 349, 352-355, 384, 391, 397, 434, 441, 448, 455, 479, 484, 495, 501, 508, 515, 521, 549, 556, 581-582, 584, 591, 598, 604, 626, 633, 640, 651.
- Uncovered functions: `(anonymous_1)` (line 47), `(anonymous_2)` (line 56), `(anonymous_3)` (line 62), `(anonymous_4)` (line 67), `(anonymous_5)` (line 72), `(anonymous_6)` (line 78), `(anonymous_7)` (line 91), `(anonymous_8)` (line 93), `(anonymous_9)` (line 99), `(anonymous_11)` (line 117), `(anonymous_12)` (line 127), `(anonymous_13)` (line 133), `(anonymous_14)` (line 138), `(anonymous_15)` (line 138), `hasGradleEvidence` (line 155), `(anonymous_17)` (line 156), `gradleRunner` (line 166), `(anonymous_20)` (line 191), `(anonymous_21)` (line 203), `(anonymous_22)` (line 209), `(anonymous_23)` (line 215), `(anonymous_24)` (line 227), `(anonymous_25)` (line 241), `(anonymous_26)` (line 256), `(anonymous_27)` (line 262), `(anonymous_29)` (line 292), `(anonymous_30)` (line 299), `(anonymous_31)` (line 305), `(anonymous_32)` (line 312), `(anonymous_33)` (line 319), `(anonymous_34)` (line 327), `(anonymous_35)` (line 338), `(anonymous_36)` (line 344), `(anonymous_37)` (line 349), `(anonymous_38)` (line 349), `(anonymous_40)` (line 383), `(anonymous_41)` (line 390), `(anonymous_42)` (line 396), `(anonymous_45)` (line 433), `(anonymous_46)` (line 440), `(anonymous_47)` (line 447), `(anonymous_48)` (line 454), `(anonymous_50)` (line 478), `(anonymous_51)` (line 483), `(anonymous_52)` (line 494), `(anonymous_53)` (line 500), `(anonymous_54)` (line 507), `(anonymous_55)` (line 514), `(anonymous_56)` (line 520), `(anonymous_58)` (line 548), `(anonymous_59)` (line 555), `(anonymous_61)` (line 580), `(anonymous_62)` (line 582), `(anonymous_63)` (line 583), `(anonymous_64)` (line 590), `(anonymous_65)` (line 597), `(anonymous_66)` (line 603), `(anonymous_68)` (line 625), `(anonymous_69)` (line 632), `(anonymous_70)` (line 639), `(anonymous_71)` (line 650).
- Uncovered branch lines: 48, 50, 54, 83, 86, 109, 120-121, 138, 141, 145-146, 158-162, 170, 193-195, 197, 217-219, 221, 229-230, 232-233, 235, 242, 265-266, 294, 298, 330-331, 349, 353-354, 358-359, 627, 631, 634, 638, 641, 645, 652, 657.

### `packages/providers/src/oauth/index.ts`

- Coverage: lines 14.28%, statements 14.28%, functions 0%, branches 0%.
- Add tests in: `packages/providers/tests/oauth/index.test.ts`.
- Uncovered statement lines: 49, 51, 53, 55, 57-58.
- Uncovered functions: `beginOAuthLogin` (line 44).
- Uncovered branch lines: 50, 52, 54, 56.

### `packages/providers/src/oauth/shared.ts`

- Coverage: lines 15.55%, statements 16.12%, functions 16.66%, branches 16.27%.
- Add tests in: `packages/providers/tests/oauth/shared.test.ts`.
- Uncovered statement lines: 37, 68-69, 80-81, 119-126, 130, 132-133, 135-137, 139-143, 145-151, 153-159, 161-164, 166-168, 171-174, 179-181, 184-186, 188-191, 197-199, 202, 207-212, 215, 217-220, 223, 227.
- Uncovered functions: `createState` (line 36), `callbackHtml` (line 79), `startLoopbackServer` (line 118), `(anonymous_6)` (line 120), `(anonymous_7)` (line 121), `(anonymous_8)` (line 123), `(anonymous_9)` (line 130), `(anonymous_10)` (line 171), `(anonymous_11)` (line 184), `(anonymous_12)` (line 188), `(anonymous_13)` (line 197), `(anonymous_14)` (line 202), `(anonymous_15)` (line 207), `(anonymous_16)` (line 217), `(anonymous_17)` (line 223).
- Uncovered branch lines: 57-58, 67, 70-71, 80, 119, 124, 133, 139, 147, 155, 161, 179-181, 210, 219, 227.

### `packages/kanban/src/verification/plugins/metric.ts`

- Coverage: lines 15.78%, statements 15%, functions 12.5%, branches 0%.
- Add tests in: `packages/kanban/tests/verification/plugins/metric.test.ts`.
- Uncovered statement lines: 22-24, 34-36, 38-41, 44-45, 51, 61-62, 64.
- Uncovered functions: `verify` (line 18), `(anonymous_2)` (line 34), `(anonymous_3)` (line 44), `(anonymous_4)` (line 51), `(anonymous_5)` (line 61), `(anonymous_6)` (line 62), `(anonymous_7)` (line 64).
- Uncovered branch lines: 22-23, 35, 38-40, 49, 57, 64.

### `packages/kanban/src/verification/plugins/test.ts`

- Coverage: lines 16.66%, statements 16.66%, functions 50%, branches 0%.
- Add tests in: `packages/kanban/tests/verification/plugins/test.test.ts`.
- Uncovered statement lines: 22-24, 34, 37-38, 40-41, 43-45, 47-49, 52.
- Uncovered functions: `verify` (line 18).
- Uncovered branch lines: 22-23, 38, 43, 47, 65.

### `packages/providers/src/oauth/copilot.ts`

- Coverage: lines 21.25%, statements 20.2%, functions 5.88%, branches 20.96%.
- Add tests in: `packages/providers/tests/github-copilot.test.ts`.
- Uncovered statement lines: 37-41, 47-49, 51, 56, 68-69, 75-76, 82, 87, 112-113, 115-116, 119-120, 134, 143-144, 147-150, 152-153, 158, 177, 180, 184, 189-191, 195-197, 208-214, 216, 224, 226, 233-237, 240-241, 243-244, 246-249, 258, 267.
- Uncovered functions: `sleep` (line 36), `(anonymous_1)` (line 37), `(anonymous_2)` (line 39), `(anonymous_3)` (line 47), `startDeviceFlow` (line 55), `pollForGitHubToken` (line 111), `(anonymous_6)` (line 134), `copilotModelRank` (line 188), `fetchCopilotModels` (line 194), `(anonymous_10)` (line 213), `(anonymous_11)` (line 214), `beginCopilotLogin` (line 220), `waitForCompletion` (line 232), `(anonymous_14)` (line 237), `completeWithCode` (line 266), `close` (line 271).
- Uncovered branch lines: 38, 65-66, 68, 76-80, 91, 143, 147-148, 152, 177, 180, 184, 189-190, 205-206, 208, 211, 234-237, 243, 248.

### `packages/techstack/src/research/search.ts`

- Coverage: lines 22.22%, statements 18.18%, functions 0%, branches 0%.
- Add tests in: `packages/techstack/tests/research/search.test.ts`.
- Uncovered statement lines: 35, 37-40, 49, 58.
- Uncovered functions: `createToolSearch` (line 34), `(anonymous_1)` (line 37), `(anonymous_2)` (line 49).
- Uncovered branch lines: 34-35, 38, 44, 47.

### `packages/tools/src/process-registry-persistent.ts`

- Coverage: lines 23.47%, statements 22.86%, functions 28.2%, branches 11.45%.
- Add tests in: `packages/tools/tests/process-registry-persistent.test.ts`.
- Uncovered statement lines: 26, 30, 37-38, 41, 113, 115-118, 121-122, 124-127, 129, 137-139, 143-144, 148-149, 151, 154, 176, 183-184, 187-189, 201, 209-212, 214, 217-218, 235-236, 248, 257, 265-266, 269, 272-273, 275, 278-279, 281, 284, 287, 294-297, 299-301, 303-304, 311, 313, 332, 345-346, 348, 355-357, 360, 363-364, 374, 376, 384-388, 390, 398, 400-402, 407, 409-411, 419-422, 425, 427-429, 432-433, 437-439, 441, 443, 451-455, 457-458, 460, 462-464, 467, 476, 481-483, 485, 488, 490, 498-501, 503, 506-507, 510, 512, 527-528, 547-553, 555-558, 560-561, 564, 571, 579, 596-601, 604, 620-622.
- Uncovered functions: `toErrorMessage` (line 25), `emitStructuredLog` (line 29), `(anonymous_6)` (line 138), `(anonymous_7)` (line 143), `(anonymous_8)` (line 148), `writeRegistryFile` (line 208), `(anonymous_12)` (line 210), `(anonymous_13)` (line 235), `(anonymous_15)` (line 247), `start` (line 264), `(anonymous_18)` (line 272), `(anonymous_19)` (line 278), `stop` (line 293), `registerMainProcess` (line 310), `registerChildProcess` (line 331), `updatePersistentEntry` (line 354), `unregister` (line 383), `heartbeat` (line 397), `(anonymous_26)` (line 401), `cleanup` (line 406), `(anonymous_28)` (line 410), `syncToPersistent` (line 418), `cleanupStaleEntries` (line 450), `isProtectedPid` (line 497), `getGlobalStatus` (line 541), `getInstanceId` (line 578), `addProtectedPattern` (line 595), `resetPersistentProcessRegistry` (line 619).
- Uncovered branch lines: 26, 37, 113, 118, 122, 125, 137, 175, 187, 192-193, 195-196, 198, 211, 257, 265, 295, 299, 331, 345, 398, 407, 428, 432, 460, 463, 465, 481, 503, 506, 527, 556, 560-561, 599, 620.

### `packages/providers/src/oauth/claude.ts`

- Coverage: lines 24.48%, statements 22.22%, functions 8.33%, branches 0%.
- Add tests in: `packages/providers/tests/oauth/claude.test.ts`.
- Uncovered statement lines: 59-61, 67-69, 75, 88, 103, 107-108, 119-123, 125, 133-134, 144, 157, 159-160, 162, 170, 176-179, 185, 188-190, 192-193, 199, 202.
- Uncovered functions: `readTokens` (line 58), `(anonymous_2)` (line 60), `exchangeAuthorizationCode` (line 82), `fetchClaudeModels` (line 106), `(anonymous_5)` (line 122), `(anonymous_6)` (line 123), `buildOutcome` (line 129), `beginClaudeLogin` (line 153), `waitForCompletion` (line 175), `completeWithCode` (line 187), `close` (line 201).
- Uncovered branch lines: 59, 62, 68, 100-101, 116-117, 119, 121, 123, 176, 178, 183, 185, 189, 192, 197, 199.

### `packages/techstack/src/service/enrich-phase.ts`

- Coverage: lines 25%, statements 21.05%, functions 16.66%, branches 9.43%.
- Add tests in: `packages/techstack/tests/service/enrich-phase.test.ts`.
- Uncovered statement lines: 17-18, 23-24, 27-28, 33, 40-41, 50-55, 61-65, 74, 78.
- Uncovered functions: `(anonymous_1)` (line 23), `(anonymous_2)` (line 51), `(anonymous_3)` (line 51), `(anonymous_4)` (line 54), `(anonymous_5)` (line 78).
- Uncovered branch lines: 17-18, 24, 33, 37-38, 40-41, 44, 46, 51-52, 54, 62, 64, 67-70, 74, 78.

### `packages/techstack/src/service/finding-factory.ts`

- Coverage: lines 26.66%, statements 31.25%, functions 33.33%, branches 0%.
- Add tests in: `packages/techstack/tests/service/finding-factory.test.ts`.
- Uncovered statement lines: 5, 10-11, 17-24.
- Uncovered functions: `(anonymous_1)` (line 5), `createFindingForStatus` (line 16).
- Uncovered branch lines: 5, 19-24.

### `packages/providers/src/oauth/chatgpt.ts`

- Coverage: lines 31.46%, statements 27.45%, functions 15%, branches 1.36%.
- Add tests in: `packages/providers/tests/oauth/chatgpt.test.ts`.
- Uncovered statement lines: 88-89, 97-99, 110-111, 115, 117, 122-126, 128, 130, 140, 143, 146-155, 163, 169-171, 177-179, 185, 199, 213, 223-225, 231-232, 243, 258-259, 261, 269, 271, 277-281, 284-286, 288-289, 295, 298.
- Uncovered functions: `filterCurrentCodexModelIds` (line 87), `(anonymous_4)` (line 89), `(anonymous_5)` (line 89), `fetchCodexModels` (line 92), `resolveCodexModels` (line 134), `(anonymous_8)` (line 151), `(anonymous_9)` (line 152), `(anonymous_10)` (line 153), `(anonymous_11)` (line 163), `readTokens` (line 168), `(anonymous_13)` (line 170), `exchangeAuthorizationCode` (line 193), `buildOutcome` (line 218), `beginChatGPTLogin` (line 254), `waitForCompletion` (line 276), `completeWithCode` (line 283), `close` (line 297).
- Uncovered branch lines: 97, 107-108, 110, 115, 117-121, 124, 126, 143, 146, 149, 151, 153, 155, 169, 172, 178, 197, 210-211, 223-224, 277, 279-281, 285, 288, 292, 295.

### `packages/kanban/src/verification/plugins/command.ts`

- Coverage: lines 33.33%, statements 33.33%, functions 50%, branches 0%.
- Add tests in: `packages/kanban/tests/verification/plugins/command.test.ts`.
- Uncovered statement lines: 22-24, 34, 39-40.
- Uncovered functions: `verify` (line 18).
- Uncovered branch lines: 22-23, 44, 51, 55-58.

### `packages/techstack/src/research/llm.ts`

- Coverage: lines 37.5%, statements 35.55%, functions 33.33%, branches 42.3%.
- Add tests in: `packages/techstack/tests/research/llm.test.ts`.
- Uncovered statement lines: 32-33, 35, 37-38, 40, 47-48, 52-53, 56-58, 60-62, 64, 66-70, 74-76, 102, 114.
- Uncovered functions: `createProviderLlm` (line 28), `(anonymous_1)` (line 35), `(anonymous_2)` (line 57), `(anonymous_3)` (line 61), `(anonymous_4)` (line 69), `(anonymous_5)` (line 70).
- Uncovered branch lines: 30, 32-33, 38, 47, 52, 102, 114, 119.

### `packages/kanban/src/verification/plugins/file-exists.ts`

- Coverage: lines 37.5%, statements 37.5%, functions 50%, branches 0%.
- Add tests in: `packages/kanban/tests/verification/plugins/file-exists.test.ts`.
- Uncovered statement lines: 22-24, 34-35.
- Uncovered functions: `verify` (line 17).
- Uncovered branch lines: 22-23, 39, 42-44, 46.

### `packages/kanban/src/verification/completion-protocol.ts`

- Coverage: lines 40.5%, statements 38.63%, functions 70%, branches 44.77%.
- Add tests in: `packages/kanban/tests/verification/completion-protocol.test.ts`.
- Uncovered statement lines: 78, 80, 91, 119, 140, 183-184, 186-188, 191-193, 195, 200-202, 204-205, 208-209, 211-214, 218, 226-227, 229, 236, 251-255, 261-262, 265-269, 278-280, 286, 290, 306, 313, 320.
- Uncovered functions: `verifySubtasks` (line 176), `verifyFileScope` (line 247), `(anonymous_6)` (line 279).
- Uncovered branch lines: 78, 80, 90, 118, 140, 148-149, 167, 183, 188, 200, 202, 206, 211, 226-227, 251, 268, 273, 279, 305, 312, 319.

### `packages/tools/src/codebase-index/index-service.ts`

- Coverage: lines 45.45%, statements 45.45%, functions 57.14%, branches 100%.
- Add tests in: `packages/tools/tests/codebase-index/index-service.test.ts`.
- Uncovered statement lines: 87-89, 91, 97-99, 101, 107-109, 111.
- Uncovered functions: `packageGraphService` (line 86), `fileGraphService` (line 96), `symbolGraphService` (line 106).
- Uncovered branch lines: none reported.

### `packages/kanban/src/verification/verifier-registry.ts`

- Coverage: lines 48.38%, statements 45.45%, functions 50%, branches 44.11%.
- Add tests in: `packages/kanban/tests/verification/verifier-registry.test.ts`.
- Uncovered statement lines: 32-35, 40, 45, 97, 100-101, 103-105, 107-109, 121, 128.
- Uncovered functions: `unregister` (line 31), `get` (line 39), `list` (line 44).
- Uncovered branch lines: 24, 34, 64-65, 69, 88-89, 100, 103, 108, 114, 116, 128.

### `packages/tools/src/languages/profiles/primary.ts`

- Coverage: lines 48.76%, statements 48%, functions 50%, branches 33.69%.
- Add tests in: `packages/tools/tests/languages/profiles/primary.test.ts`.
- Uncovered statement lines: 18, 20-21, 23-24, 28-30, 35-36, 47-49, 87-88, 95-96, 103-104, 112, 119-120, 122-123, 144, 158-161, 163, 166, 213, 239, 288, 295, 301, 315-318, 326, 349, 370, 381, 401, 408, 421-422, 432-433, 442, 530-531, 546, 591, 612, 647, 654, 698-699, 708, 716.
- Uncovered functions: `nodeManager` (line 17), `(anonymous_1)` (line 20), `(anonymous_2)` (line 21), `scriptPlan` (line 27), `(anonymous_8)` (line 86), `(anonymous_9)` (line 94), `(anonymous_10)` (line 102), `(anonymous_11)` (line 111), `(anonymous_12)` (line 119), `(anonymous_13)` (line 120), `(anonymous_14)` (line 121), `(anonymous_17)` (line 157), `(anonymous_21)` (line 212), `(anonymous_28)` (line 287), `(anonymous_29)` (line 294), `(anonymous_30)` (line 300), `(anonymous_32)` (line 314), `(anonymous_33)` (line 325), `(anonymous_34)` (line 348), `(anonymous_37)` (line 369), `(anonymous_39)` (line 380), `(anonymous_41)` (line 400), `(anonymous_42)` (line 407), `(anonymous_44)` (line 420), `(anonymous_45)` (line 431), `(anonymous_46)` (line 441), `(anonymous_53)` (line 529), `(anonymous_54)` (line 545), `(anonymous_57)` (line 590), `(anonymous_60)` (line 611), `(anonymous_63)` (line 646), `(anonymous_64)` (line 653), `(anonymous_67)` (line 697), `(anonymous_68)` (line 707), `(anonymous_69)` (line 715).
- Uncovered branch lines: 23-24, 29, 35, 45-48, 112-113, 118, 130, 132, 143, 145, 149, 159, 161, 164-165, 174, 182, 238, 261, 268, 316, 392, 395, 423-424, 434-435, 478, 490, 494, 515, 532-533, 636, 640, 671-673, 675, 677, 685-686, 700-701.

### `packages/tools/src/ps-slash.ts`

- Coverage: lines 56.35%, statements 50%, functions 55%, branches 37.83%.
- Add tests in: `packages/tools/tests/ps-slash.test.ts`.
- Uncovered statement lines: 105-112, 122, 127-129, 131, 153, 156-160, 163, 166-169, 172-175, 180-182, 184, 198, 215-216, 218-221, 245, 249, 254, 273, 325, 327-328, 330-333, 335, 340-341, 367-369, 371, 380-381, 390, 393-396, 398, 411-412, 414, 428-429, 434, 437-440, 442, 445-446, 448, 517-518.
- Uncovered functions: `matchGlob` (line 121), `(anonymous_5)` (line 156), `(anonymous_6)` (line 160), `(anonymous_7)` (line 163), `(anonymous_8)` (line 198), `(anonymous_11)` (line 245), `(anonymous_12)` (line 249), `(anonymous_13)` (line 273), `(anonymous_17)` (line 445).
- Uncovered branch lines: 104, 106, 108, 110, 153, 158-159, 168-169, 174, 180-182, 215, 219-221, 248, 254, 258, 325, 333, 366, 369, 374, 396, 424, 429, 434, 438-440, 467, 491, 517.

### `packages/tools/src/bash-kill-guard.ts`

- Coverage: lines 56.94%, statements 55.19%, functions 71.42%, branches 54.86%.
- Add tests in: `packages/tools/tests/bash-kill-guard-paths.test.ts`.
- Uncovered statement lines: 106, 129, 131, 139, 142, 145, 148, 150, 287, 331-335, 345-351, 353, 363-367, 377-381, 391-392, 394, 397, 404-406, 408-411, 416, 432-433, 435-437, 442-443, 445, 447, 449, 454-455, 463, 495-496, 501, 508-509, 511, 529.
- Uncovered functions: `getProtectedEntries` (line 403), `getBlockedKillMessage` (line 528).
- Uncovered branch lines: 105, 123, 129, 131, 139, 142, 145, 148, 162, 189, 286, 332, 336, 346-347, 349, 351, 364, 369, 378, 383, 392, 410, 431, 436, 442, 445, 453, 459, 485, 495, 508, 510, 514-515, 530.

### `packages/tools/src/codebase-index/rs-parser.ts`

- Coverage: lines 57.64%, statements 55.78%, functions 55.55%, branches 40%.
- Add tests in: `packages/tools/tests/codebase-index-rs-parser.test.ts`.
- Uncovered statement lines: 29-30, 72, 81-83, 86-87, 91, 93, 95, 97, 107-110, 113-115, 117-121, 123, 125-129, 134, 136-138, 141, 148.
- Uncovered functions: `(anonymous_1)` (line 29), `tryNativeParse` (line 80), `(anonymous_8)` (line 93), `(anonymous_9)` (line 107), `(anonymous_10)` (line 114), `(anonymous_11)` (line 117), `(anonymous_12)` (line 125), `(anonymous_13)` (line 141).
- Uncovered branch lines: 28, 30, 108, 118, 126, 136, 178, 193, 205, 207.

### `packages/techstack/src/advisory/osv.ts`

- Coverage: lines 59.52%, statements 50.9%, functions 60%, branches 14.89%.
- Add tests in: `packages/techstack/tests/advisory/osv.test.ts`.
- Uncovered statement lines: 77-84, 90-95, 98, 151, 156, 159.
- Uncovered functions: `mapSeverity` (line 72), `(anonymous_3)` (line 159).
- Uncovered branch lines: 77, 79, 81-84, 90, 92-95, 150, 156, 158, 161, 164, 166, 190.

### `packages/techstack/src/service/research-phase.ts`

- Coverage: lines 60%, statements 66.66%, functions 50%, branches 66.66%.
- Add tests in: `packages/techstack/tests/service/research-phase.test.ts`.
- Uncovered statement lines: 16, 21, 24, 26.
- Uncovered functions: `(anonymous_1)` (line 21).
- Uncovered branch lines: 15, 27.

### `packages/techstack/src/store/sqlite.ts`

- Coverage: lines 60.39%, statements 58.87%, functions 53.84%, branches 26.31%.
- Add tests in: `packages/techstack/tests/store/sqlite.test.ts`.
- Uncovered statement lines: 80, 93, 98-99, 135, 174, 198, 204-207, 209, 219, 223, 229, 235-236, 238-239, 241, 244, 249, 252-253, 260, 265, 283, 286-288, 293-294, 298, 303, 308, 311-312, 367-369, 375.
- Uncovered functions: `path` (line 173), `getSnapshot` (line 197), `listSnapshots` (line 228), `(anonymous_10)` (line 237), `(anonymous_11)` (line 244), `deleteSnapshotsBefore` (line 248), `saveJob` (line 259), `getJob` (line 282), `updateJobStatus` (line 292), `listJobs` (line 307), `(anonymous_17)` (line 312), `rowToJob` (line 365).
- Uncovered branch lines: 43, 49-57, 61-64, 66, 68-72, 74, 76, 87, 98, 130, 134, 205, 219, 228, 273, 275-277, 287, 293-296, 307, 367, 381-383, 385-387, 399.

### `packages/tools/src/browser/tools.ts`

- Coverage: lines 61.03%, statements 61.25%, functions 28%, branches 36.66%.
- Add tests in: `packages/tools/tests/browser-tools.test.ts`.
- Uncovered statement lines: 88, 91, 124, 143, 163, 190, 227-228, 237, 244, 278-280, 282-283, 305, 312, 330-331, 353-354, 380, 386, 408, 432, 440, 459, 486-488.
- Uncovered functions: `execute` (line 86), `execute_3` (line 123), `execute_4` (line 142), `execute_5` (line 162), `execute_6` (line 189), `execute_7` (line 226), `(anonymous_12)` (line 235), `(anonymous_13)` (line 242), `execute_8` (line 277), `execute_9` (line 304), `execute_10` (line 329), `execute_11` (line 352), `execute_12` (line 379), `execute_13` (line 407), `execute_14` (line 431), `execute_15` (line 458), `shutdownBrowserTools` (line 485), `(anonymous_24)` (line 488).
- Uncovered branch lines: 32, 39, 49, 88-90, 278-280.

### `packages/techstack/src/registry/client.ts`

- Coverage: lines 61.48%, statements 59%, functions 50%, branches 39.04%.
- Add tests in: `packages/techstack/tests/registry/client.test.ts`.
- Uncovered statement lines: 53-54, 86-87, 93, 98-101, 165, 167-168, 181, 183-184, 197, 199, 213-214, 218, 221, 223-229, 231-233, 235, 243, 256, 258-261, 266-270, 276, 278, 291, 293-294, 309-311, 316-318, 392, 402, 406, 413, 416, 421, 448, 482, 485.
- Uncovered functions: `(anonymous_4)` (line 86), `(anonymous_8)` (line 165), `(anonymous_9)` (line 166), `(anonymous_10)` (line 181), `(anonymous_11)` (line 182), `(anonymous_12)` (line 197), `(anonymous_13)` (line 198), `(anonymous_14)` (line 212), `(anonymous_15)` (line 216), `(anonymous_16)` (line 256), `(anonymous_17)` (line 257), `(anonymous_18)` (line 291), `(anonymous_19)` (line 292), `constructor` (line 309), `constructor_2` (line 316), `(anonymous_31)` (line 482).
- Uncovered branch lines: 52, 81, 93, 97, 99, 157, 169-171, 174, 185-186, 190, 200, 221, 225, 228, 231, 233, 235, 260, 268-269, 280-282, 295-298, 300, 392-393, 402, 406, 412, 415, 421-422, 482, 485.

### `packages/providers/src/wire-adapter.ts`

- Coverage: lines 62.5%, statements 62.5%, functions 45.83%, branches 66.66%.
- Add tests in: `packages/providers/tests/wire-adapter.test.ts`.
- Uncovered statement lines: 56, 77, 92, 130, 166, 172-173, 195, 229, 253-254, 257, 261-263, 265, 267, 269, 272-275, 284-287, 289, 291-294, 296-299, 301, 304, 319, 332-334, 353, 366-368, 388, 424.
- Uncovered functions: `logRawChunk` (line 86), `(anonymous_7)` (line 171), `wrapDebugStream` (line 249), `wrapDebugNodeStream` (line 260), `(anonymous_10)` (line 266), `wrapDebugWebStream` (line 281), `pull` (line 290), `cancel` (line 303), `wrapHangNodeStream` (line 324), `(anonymous_19)` (line 353), `(anonymous_20)` (line 366), `cancel_2` (line 387), `translateError` (line 423).
- Uncovered branch lines: 55, 67, 129, 166, 175, 194, 210, 228, 233, 253, 270-271, 292, 296, 318, 360, 363, 382.

### `packages/tools/src/exec-kill-guard.ts`

- Coverage: lines 62.87%, statements 61.43%, functions 71.42%, branches 54.26%.
- Add tests in: `packages/tools/tests/exec-kill-guard.test.ts`.
- Uncovered statement lines: 40, 56-59, 95, 129-131, 136, 153-155, 157-158, 164-165, 167-169, 174, 177, 192-196, 199, 210-211, 213-217, 221-224, 229, 285, 297-298, 303, 312, 336-338, 344, 347.
- Uncovered functions: `(anonymous_3)` (line 153), `(anonymous_4)` (line 222).
- Uncovered branch lines: 40, 49-50, 55, 57, 59, 68, 74, 84, 86, 88, 113, 116, 118, 128, 130, 136, 140, 142, 148, 154, 158, 163, 165, 168, 174, 188-190, 193, 196, 207, 210, 214, 217, 221, 223, 229, 254, 263, 284, 291, 297, 307, 311, 326-327, 337.

### `packages/tools/src/design.ts`

- Coverage: lines 63.63%, statements 62.5%, functions 57.14%, branches 51.64%.
- Add tests in: `packages/tools/tests/design.test.ts`.
- Uncovered statement lines: 36-41, 46, 82-83, 185-186, 215, 235-237, 239-241, 246-247, 251, 260, 268, 287, 296, 337, 342, 366-368, 373-375, 377-380, 382, 385, 391.
- Uncovered functions: `(anonymous_3)` (line 215), `(anonymous_4)` (line 251), `(anonymous_6)` (line 382).
- Uncovered branch lines: 36, 38, 81, 83, 179, 184, 193, 199, 201, 210, 214, 225, 234, 236, 240, 258-259, 267, 286, 293, 295, 324, 341, 361, 365, 367, 374, 388, 390, 405.

### `packages/plugins/src/process-guard/index.ts`

- Coverage: lines 63.82%, statements 59.61%, functions 66.66%, branches 39.02%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 78-79, 117-118, 122, 128-129, 138, 143, 148, 161, 225-227, 231, 233, 238-241, 245.
- Uncovered functions: `teardown` (line 224), `health` (line 244).
- Uncovered branch lines: 77, 81, 116, 127, 138, 140, 143, 145-146, 148, 154-159, 161, 225, 249-250.

### `packages/tools/src/codebase-index/go-parser.ts`

- Coverage: lines 64.93%, statements 63.41%, functions 75%, branches 40.9%.
- Add tests in: `packages/tools/tests/codebase-index-go-parser.test.ts`.
- Uncovered statement lines: 49-50, 53-58, 61-64, 67-69, 73, 89, 112, 395-397, 413-416, 421, 432, 458.
- Uncovered functions: `addFallbackSymbol` (line 76), `(anonymous_7)` (line 394), `(anonymous_9)` (line 412).
- Uncovered branch lines: 45, 50, 56-57, 62, 68, 111, 395, 413, 421, 431, 451, 453-454.

### `packages/techstack/src/service/inventory-phase.ts`

- Coverage: lines 66.66%, statements 60%, functions 100%, branches 20%.
- Add tests in: `packages/techstack/tests/service/inventory-phase.test.ts`.
- Uncovered statement lines: 46-48, 56-58.
- Uncovered functions: none reported.
- Uncovered branch lines: 46, 56.

### `packages/kanban/src/verification/verification-report.ts`

- Coverage: lines 67.6%, statements 68.75%, functions 100%, branches 45.09%.
- Add tests in: `packages/kanban/tests/verification/verification-report.test.ts`.
- Uncovered statement lines: 51-52, 102, 104, 130-133, 136-137, 139-141, 145, 150-152, 155-156, 158, 165, 167, 197-199.
- Uncovered functions: none reported.
- Uncovered branch lines: 47, 51-52, 75, 101, 103, 118-120, 129-130, 140, 142, 149, 159-164, 186-189, 196.

### `packages/tools/src/plan.ts`

- Coverage: lines 68.51%, statements 68.14%, functions 71.42%, branches 60.75%.
- Add tests in: `packages/tools/tests/e2e-plan.test.ts`, `packages/tools/tests/languages-plan.test.ts`, `packages/tools/tests/plan.test.ts`.
- Uncovered statement lines: 156, 160-161, 204-205, 213-214, 220-222, 224-227, 229, 234-235, 239-240, 255-256, 289-292, 296-297, 308-309, 317, 337, 344-345, 372.
- Uncovered functions: `(anonymous_2)` (line 289), `(anonymous_3)` (line 292).
- Uncovered branch lines: 153, 156, 162-163, 177, 203, 212, 219-220, 225, 233, 238, 254, 288, 290, 295, 302, 307, 319, 336, 343, 345, 356, 372.

### `packages/plugins/src/pr-drafter/index.ts`

- Coverage: lines 69.34%, statements 66.44%, functions 81.25%, branches 50%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 109-114, 166, 168, 172, 178-182, 189-191, 195-197, 219-222, 224-228, 230, 348-350, 377-383, 390-391.
- Uncovered functions: `resolveProjectPath` (line 108), `writeDraft` (line 218), `(anonymous_12)` (line 347).
- Uncovered branch lines: 99, 108-109, 111, 113, 133, 156, 161, 165, 168-169, 181-182, 188, 194, 200, 214, 220, 311, 322, 333, 348, 374, 378, 393.

### `packages/tools/src/codebase-index/spawn-gate.ts`

- Coverage: lines 71.42%, statements 71.42%, functions 50%, branches 100%.
- Add tests in: `packages/tools/tests/codebase-index/spawn-gate.test.ts`.
- Uncovered statement lines: 20, 27.
- Uncovered functions: `(anonymous_2)` (line 19), `resetSpawnGateForTests` (line 26).
- Uncovered branch lines: none reported.

### `packages/plugins/src/runtime/index.ts`

- Coverage: lines 71.77%, statements 68.55%, functions 76%, branches 67.08%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 172-173, 233, 289-291, 341, 354, 361, 382, 389, 392, 399, 431-432, 440-441, 444-445, 462, 466, 502, 535-540, 542-544, 547, 549-550, 552, 555-558, 560-561, 563, 565-568, 573-574, 598, 600, 607, 612, 616.
- Uncovered functions: `(anonymous_10)` (line 340), `(anonymous_12)` (line 430), `(anonymous_14)` (line 439), `(anonymous_15)` (line 443), `collectSourceFiles` (line 534), `walk` (line 546).
- Uncovered branch lines: 172-173, 214, 233, 288-290, 357, 381, 391, 407, 431, 437, 441, 444, 461, 502, 536, 538-539, 542-543, 547, 557, 565, 567, 595, 598, 607, 616.

### `packages/providers/src/tool-format/to-responses.ts`

- Coverage: lines 72.34%, statements 71.42%, functions 73.33%, branches 38.88%.
- Add tests in: `packages/providers/tests/tool-format/to-responses.test.ts`.
- Uncovered statement lines: 41, 48-52, 60-61, 69, 85, 97-98, 100, 109, 111.
- Uncovered functions: `toolsToResponses` (line 47), `(anonymous_2)` (line 50), `imageUrl` (line 68), `(anonymous_12)` (line 109).
- Uncovered branch lines: 41, 49, 70-71, 88, 93, 96-97, 103, 110, 124, 127, 136.

### `packages/kanban/src/verification/verification-context.ts`

- Coverage: lines 72.37%, statements 69.49%, functions 79.62%, branches 55.32%.
- Add tests in: `packages/kanban/tests/verification-context.test.ts`.
- Uncovered statement lines: 115, 117, 124-126, 128, 144-147, 150-151, 164, 186, 188, 192, 201, 334, 343, 349-352, 354, 377, 396, 403-405, 407, 417-419, 425, 457, 468, 472, 475, 484-486, 488-491, 499, 510, 518, 547, 577-579, 597, 608, 613-616, 618-621, 667-670, 675, 681-684, 717, 722, 735-737, 747, 765, 776, 788, 791, 798, 809-812, 816-818, 823-825, 827-828, 833-835, 837, 840-841, 843, 861, 880, 899, 922-923, 943, 982.
- Uncovered functions: `gitDiffForFiles` (line 348), `rejectedCommand` (line 596), `(anonymous_24)` (line 618), `(anonymous_30)` (line 666), `(anonymous_32)` (line 680), `(anonymous_36)` (line 716), `(anonymous_38)` (line 734), `(anonymous_40)` (line 746), `terminateProcessTree` (line 807), `(anonymous_43)` (line 816), `(anonymous_44)` (line 824).
- Uncovered branch lines: 114, 116, 123, 125, 127, 143-145, 149, 153, 164-165, 172, 186-187, 190-191, 200, 316, 333-334, 349, 395, 402, 416, 456, 467, 472-474, 477-478, 483-485, 490, 493, 508, 510, 538, 546, 560, 564, 581-582, 587-588, 608, 612, 616, 619, 621, 667, 675, 682, 722, 724, 742-743, 749, 764-765, 771, 786, 788, 791, 810, 825, 834, 836, 847, 861, 880, 883, 886, 899, 922-923, 953, 961-963, 967-969.

### `packages/tools/src/languages/package-tool.ts`

- Coverage: lines 75%, statements 72.46%, functions 83.33%, branches 48.83%.
- Add tests in: `packages/tools/tests/language-package-tool.test.ts`.
- Uncovered statement lines: 137, 145-147, 155, 159, 237, 249, 272, 277-278, 280-281, 283-284, 286-287, 315.
- Uncovered functions: `serialize` (line 271).
- Uncovered branch lines: 136, 138-140, 145, 155, 159, 167, 171-172, 178-179, 185, 215, 236, 252, 265, 273-275, 278, 281, 284, 286, 304, 315, 318, 321, 323.

### `packages/tools/src/languages/plan.ts`

- Coverage: lines 76.69%, statements 73.91%, functions 76.19%, branches 76.33%.
- Add tests in: `packages/tools/tests/e2e-plan.test.ts`, `packages/tools/tests/languages-plan.test.ts`, `packages/tools/tests/plan.test.ts`.
- Uncovered statement lines: 37, 67, 95-97, 99, 109, 130, 132, 134, 137, 144, 155, 176, 179-180, 182-183, 205, 209-210, 213, 216, 287-289, 291.
- Uncovered functions: `(anonymous_5)` (line 94), `(anonymous_9)` (line 179), `(anonymous_12)` (line 203), `(anonymous_13)` (line 210), `(anonymous_14)` (line 211).
- Uncovered branch lines: 36, 66, 82, 108, 130, 132-133, 136, 139, 151, 154, 175, 177-178, 180, 182, 196, 200, 205-206, 208, 213-214, 216, 282, 287, 291.

### `packages/tools/src/session-kanban.ts`

- Coverage: lines 76.94%, statements 71.42%, functions 83%, branches 55.58%.
- Add tests in: `packages/tools/tests/session-kanban.test.ts`.
- Uncovered statement lines: 98, 118, 121, 142, 168, 171, 186, 189, 199, 218, 246, 274, 303-304, 464-466, 494, 497, 519, 532, 547, 552, 554, 556-557, 579-584, 586-589, 594, 596, 602, 613, 624-625, 628-630, 633-634, 648, 653-660, 662, 666-667, 672, 675, 680, 682-687, 696-698, 717-722, 724-727, 729-732, 734, 748-750, 757, 773-774, 801, 846, 850, 877, 882, 909, 913, 929.
- Uncovered functions: `(anonymous_17)` (line 168), `(anonymous_19)` (line 170), `(anonymous_56)` (line 482), `mirrorSessionTasksToKanban` (line 514), `mirrorSessionPlanToKanban` (line 527), `(anonymous_65)` (line 578), `(anonymous_71)` (line 625), `(anonymous_72)` (line 627), `(anonymous_74)` (line 652), `(anonymous_75)` (line 660), `(anonymous_76)` (line 662), `(anonymous_77)` (line 671), `hydrateSessionKanban` (line 716), `(anonymous_84)` (line 772), `(anonymous_92)` (line 850), `(anonymous_95)` (line 882), `(anonymous_98)` (line 913).
- Uncovered branch lines: 73, 97-98, 118, 121, 141, 143, 146, 148, 186, 189-190, 199, 218, 246, 253, 258, 274, 302, 353-354, 377, 456, 462-463, 471, 490, 493-494, 496, 547, 549, 552-555, 563, 577, 580, 582, 584, 587, 589, 594, 596, 601-602, 613, 624, 642-645, 647, 656-659, 672, 677, 682, 696-698, 702, 717-718, 721, 725, 727, 730, 732, 747-749, 756, 775-780, 795-796, 809, 813-814, 817-818, 845-846, 850, 858, 861, 863, 874, 877, 882, 891-892, 894, 897, 903, 905-906, 909, 913, 923.

### `packages/plugins/src/api-compatibility-gate/index.ts`

- Coverage: lines 77.19%, statements 72.3%, functions 92%, branches 56.07%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 123-124, 130-131, 147, 152, 155-157, 166-167, 172-183, 188-190, 194, 198, 204, 208, 229-233, 240, 245, 251-254, 261, 295, 404-405.
- Uncovered functions: `(anonymous_11)` (line 229), `(anonymous_12)` (line 251).
- Uncovered branch lines: 122, 129, 147, 152, 155-157, 165, 173-176, 178, 180-181, 183, 190, 194-196, 208, 232-233, 244, 254, 380, 403, 509.

### `packages/plugins/src/lint-gate/index.ts`

- Coverage: lines 77.22%, statements 71.92%, functions 77.77%, branches 57.66%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 168, 172, 180, 208, 217, 224, 232-233, 268, 270, 273-274, 276, 310, 314-315, 317, 368-370, 379, 451, 471, 491-493, 495, 497, 512-513, 538, 544, 564, 570-577, 581, 587, 591, 617-619, 627-629, 632.
- Uncovered functions: `(anonymous_9)` (line 276), `(anonymous_11)` (line 317), `applyEdit` (line 367), `(anonymous_16)` (line 379), `(anonymous_22)` (line 574), `(anonymous_23)` (line 579).
- Uncovered branch lines: 101, 166-168, 172, 208, 217, 224, 261, 268, 270, 273, 299, 310, 314, 331-332, 334, 338, 344-346, 349-350, 369, 378-379, 450, 471, 473-474, 489, 497, 511, 535, 537, 552, 554, 563, 572, 576, 581, 598-599, 616, 618, 627, 686, 739.

### `packages/tools/src/process-guardian.ts`

- Coverage: lines 78.02%, statements 76.84%, functions 56.52%, branches 72.72%.
- Add tests in: `packages/tools/tests/process-guardian-fatal-handlers.test.ts`.
- Uncovered statement lines: 58-59, 66, 136-137, 162, 173, 240-242, 273, 275-276, 280-281, 294, 317, 324, 338, 353-354, 356.
- Uncovered functions: `(anonymous_0)` (line 58), `(anonymous_4)` (line 136), `(anonymous_7)` (line 172), `unregisterProcess` (line 239), `(anonymous_11)` (line 241), `heartbeat` (line 272), `isProtected` (line 316), `getProtectedPids` (line 323), `getStatus` (line 330), `getProcessGuardian` (line 352).
- Uncovered branch lines: 149, 162, 198, 280, 294, 353, 368.

### `packages/acp/src/client/acp-session.ts`

- Coverage: lines 78.03%, statements 75.05%, functions 88.7%, branches 57.03%.
- Add tests in: `packages/acp/tests/acp-session.test.ts`.
- Uncovered statement lines: 224, 230, 233, 236, 240, 301-302, 341-342, 378, 385, 426, 429, 435, 437, 444, 455, 458, 467, 488, 491, 498, 510, 526, 529, 535, 546, 565, 568, 580, 596, 599, 608, 628, 638, 642, 651, 655, 667, 675, 687, 691, 705, 709, 718, 722, 730, 734, 768, 771, 818-821, 823-824, 832, 856, 864, 877, 913-914, 938, 940-942, 963-964, 978-981, 1014, 1018, 1050, 1056-1057, 1059, 1063, 1065-1066, 1068, 1072-1073, 1077, 1079, 1092, 1145, 1156, 1221, 1228-1229, 1292, 1298, 1302-1303, 1330, 1335, 1346, 1376, 1382, 1401-1404, 1407-1410, 1413, 1416-1417, 1449, 1465.
- Uncovered functions: `(anonymous_17)` (line 437), `(anonymous_32)` (line 807), `(anonymous_37)` (line 939), `(anonymous_41)` (line 962), `(anonymous_42)` (line 977), `(anonymous_46)` (line 1057), `(anonymous_47)` (line 1066).
- Uncovered branch lines: 189, 224, 229, 232, 235, 239, 245-247, 301-302, 341, 377, 380, 408, 425, 428, 434, 443, 454, 457, 466, 487, 490, 496, 509, 525, 528, 534, 545, 564, 567, 576-577, 579, 584, 595, 598, 607, 615, 628, 634-635, 637, 641, 651, 654, 667, 674, 687, 690, 698, 705, 708, 718, 720-721, 730, 733, 767, 770, 780, 820, 823, 831, 834, 855, 863, 877, 881, 937-938, 940-941, 980, 1014, 1017-1018, 1044, 1050-1053, 1056, 1063, 1065, 1072, 1077, 1092, 1100, 1108, 1120, 1126, 1136, 1144, 1155-1156, 1160, 1165-1167, 1175, 1221, 1226-1227, 1240, 1276, 1298, 1301, 1317, 1325, 1329, 1331, 1333, 1338-1339, 1346-1347, 1357, 1371-1373, 1375, 1378, 1381, 1389, 1395, 1400-1401, 1406-1407, 1412, 1416, 1449, 1457, 1469.

### `packages/plugins/src/knowledge-graph/index.ts`

- Coverage: lines 78.18%, statements 74.8%, functions 78.94%, branches 77.77%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 100, 130, 150, 156-158, 160-162, 165-166, 170-171, 230-231, 235, 247-250, 252-253, 255, 258, 261, 364-367.
- Uncovered functions: `(anonymous_6)` (line 246), `(anonymous_7)` (line 249), `(anonymous_8)` (line 250), `(anonymous_9)` (line 253).
- Uncovered branch lines: 97, 114-115, 119-120, 130, 146-147, 155, 229, 247, 252, 259-260, 307, 364-367.

### `packages/tools/src/_redact-command.ts`

- Coverage: lines 78.57%, statements 78.57%, functions 100%, branches 50%.
- Add tests in: `packages/tools/tests/_redact-command.test.ts`.
- Uncovered statement lines: 47, 52, 58.
- Uncovered functions: none reported.
- Uncovered branch lines: 41-42, 47.

### `packages/tools/src/json.ts`

- Coverage: lines 79.06%, statements 76.63%, functions 94.11%, branches 72.57%.
- Add tests in: `packages/tools/tests/json.test.ts`.
- Uncovered statement lines: 225, 233, 236, 250, 272-274, 276, 282, 285, 299, 321-323, 325, 331, 334, 356, 389, 409, 434-435, 437, 446-447, 460, 464-465, 467-469, 475, 485-487, 490, 492-493, 496-497, 504, 519, 530-531, 535, 539, 543, 547, 551-552.
- Uncovered functions: `(anonymous_9)` (line 475).
- Uncovered branch lines: 177, 180, 195, 208, 235, 245, 271, 284, 293, 320, 333, 350, 384, 409, 433-434, 446-447, 460, 464-465, 467-469, 474, 480, 484-486, 489, 491-492, 495-496, 515, 517, 519, 529, 531, 534, 538, 542, 546, 550, 628.

### `packages/tools/src/browser/manager.ts`

- Coverage: lines 80%, statements 73.5%, functions 70.88%, branches 62.65%.
- Add tests in: `packages/tools/tests/browser-manager.test.ts`.
- Uncovered statement lines: 94-95, 99, 123, 129, 139-142, 180, 246-247, 282-284, 306, 313-315, 317-318, 328-330, 332-334, 336, 350, 361, 371, 377, 382, 387, 389, 400-401, 411, 422, 450, 471, 478, 481, 490-491, 502-506, 508, 517, 530, 547.
- Uncovered functions: `(anonymous_3)` (line 94), `(anonymous_4)` (line 98), `(anonymous_6)` (line 139), `press` (line 245), `(anonymous_25)` (line 247), `drag` (line 275), `(anonymous_31)` (line 283), `(anonymous_33)` (line 317), `evaluate` (line 322), `(anonymous_35)` (line 329), `(anonymous_37)` (line 350), `(anonymous_41)` (line 361), `(anonymous_44)` (line 371), `(anonymous_45)` (line 377), `(anonymous_50)` (line 399), `(anonymous_51)` (line 400), `(anonymous_52)` (line 401), `(anonymous_55)` (line 422), `(anonymous_59)` (line 449), `(anonymous_63)` (line 471), `(anonymous_65)` (line 481), `browserInstallationDiagnostics` (line 497), `(anonymous_78)` (line 547).
- Uncovered branch lines: 56, 74, 93, 108, 136, 187, 203, 206, 305, 310, 314, 333, 382-383, 387, 389, 411, 478, 490, 517, 530, 538, 544, 547.

### `packages/tools/src/codebase-index/py-parser.ts`

- Coverage: lines 80.3%, statements 74.35%, functions 76.47%, branches 46.66%.
- Add tests in: `packages/tools/tests/codebase-index-py-parser.test.ts`.
- Uncovered statement lines: 43, 277, 280, 291, 297-298, 301, 332-334, 349-352, 357, 395, 408, 435.
- Uncovered functions: `(anonymous_6)` (line 296), `(anonymous_7)` (line 301), `(anonymous_11)` (line 331), `(anonymous_13)` (line 348).
- Uncovered branch lines: 39, 43, 271, 277, 291, 332, 349, 357, 395, 406, 427, 429-430.

### `packages/kanban/src/boundary.ts`

- Coverage: lines 80.45%, statements 77.31%, functions 89.47%, branches 76.53%.
- Add tests in: `packages/kanban/tests/boundary.test.ts`.
- Uncovered statement lines: 39, 42-43, 106, 109, 112, 115, 129, 135, 138, 141, 161-164, 169-170, 172, 188-189, 195.
- Uncovered functions: `(anonymous_2)` (line 43), `describeKanbanBoundary` (line 160).
- Uncovered branch lines: 29, 39, 41, 97, 105, 108, 111, 114, 128, 134, 137, 140, 148, 161, 163, 169-170, 172, 187, 194, 212.

### `packages/techstack/src/policy/status.ts`

- Coverage: lines 80.72%, statements 76.53%, functions 100%, branches 60.55%.
- Add tests in: `packages/techstack/tests/policy/status.test.ts`.
- Uncovered statement lines: 88, 92-93, 95, 98, 100, 135, 144-148, 153, 165, 244, 248, 258-259, 264.
- Uncovered functions: none reported.
- Uncovered branch lines: 61, 63, 71-72, 86-88, 91-93, 95-96, 98, 129, 135, 143, 146-147, 152, 160, 236, 239, 258, 264, 301.

### `packages/techstack/src/registry/purl.ts`

- Coverage: lines 80.82%, statements 82.05%, functions 88.88%, branches 80%.
- Add tests in: `packages/techstack/tests/registry/purl.test.ts`.
- Uncovered statement lines: 95-96, 98, 102, 129-130, 137-143, 323.
- Uncovered functions: `(anonymous_1)` (line 96).
- Uncovered branch lines: 94, 101, 128, 136, 142, 189-190, 242, 251, 256.

### `packages/plugins/src/commit-validator/index.ts`

- Coverage: lines 81.81%, statements 80.76%, functions 100%, branches 68.57%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 155, 185, 203, 266, 362-363, 365-369, 378-379, 384, 389, 393, 397, 444-445, 456-460, 463.
- Uncovered functions: none reported.
- Uncovered branch lines: 152, 154, 178, 181, 184, 191, 202, 263-264, 266, 350-351, 355, 362-363, 366, 378, 393, 397, 443, 457, 549-551.

### `packages/tools/src/codebase-index/indexer.ts`

- Coverage: lines 82.43%, statements 80.43%, functions 84.21%, branches 71.77%.
- Add tests in: `packages/tools/tests/background-indexer.test.ts`, `packages/tools/tests/codebase-index-indexer.test.ts`.
- Uncovered statement lines: 196, 201-205, 207-209, 214-219, 221, 270, 328, 370, 439, 464, 471, 514-526, 528, 536.
- Uncovered functions: `assignRefsToSymbols` (line 200), `(anonymous_11)` (line 202), `(anonymous_17)` (line 328).
- Uncovered branch lines: 77, 135, 150, 194, 201-202, 208, 214-215, 217, 270, 290, 327, 361, 369, 394, 407, 438-439, 463, 514, 522, 524, 526, 537.

### `packages/techstack/src/trend.ts`

- Coverage: lines 82.53%, statements 75.67%, functions 70%, branches 61.22%.
- Add tests in: `packages/techstack/tests/remediation-apply-trend.test.ts`.
- Uncovered statement lines: 36-37, 40, 42-43, 74-76, 84, 103, 125-129, 131.
- Uncovered functions: `(anonymous_1)` (line 37), `(anonymous_5)` (line 103), `renderTrendMarkdown` (line 124).
- Uncovered branch lines: 36, 40-41, 43, 63, 68, 73, 75, 84, 98, 109, 112, 126, 129.

### `packages/tools/src/next-steps.ts`

- Coverage: lines 82.71%, statements 83.33%, functions 100%, branches 85.41%.
- Add tests in: `packages/tools/tests/next-steps.test.ts`.
- Uncovered statement lines: 233-235, 237-239, 241-242, 244-246, 249-250, 254.
- Uncovered functions: none reported.
- Uncovered branch lines: 225, 239, 242, 246.

### `packages/kanban/src/verification/completion-gate.ts`

- Coverage: lines 83.07%, statements 80%, functions 83.33%, branches 66.66%.
- Add tests in: `packages/kanban/tests/completion-gate.test.ts`.
- Uncovered statement lines: 87, 128-131, 135, 137-140, 142, 171, 179, 190.
- Uncovered functions: `attachVerificationReport` (line 122), `(anonymous_3)` (line 128).
- Uncovered branch lines: 87, 103, 130-133, 142, 170, 179, 183, 190, 198, 201, 210, 216-217, 233, 248, 251.

### `packages/providers/src/minimax.ts`

- Coverage: lines 83.33%, statements 83.33%, functions 87.5%, branches 75%.
- Add tests in: `packages/providers/tests/minimax.test.ts`.
- Uncovered statement lines: 57-59.
- Uncovered functions: `complete` (line 56).
- Uncovered branch lines: 57.

### `packages/techstack/src/adapters/npm.ts`

- Coverage: lines 83.55%, statements 80.92%, functions 90.9%, branches 83.08%.
- Add tests in: `packages/techstack/tests/npm-adapter.test.ts`.
- Uncovered statement lines: 84, 86, 150, 189-191, 193-196, 198-199, 203-206, 208-210, 217, 230, 233, 237, 257, 259, 341-346.
- Uncovered functions: `parseNpmLockVersions` (line 188).
- Uncovered branch lines: 84, 86, 145, 150, 178, 193, 196, 203, 206, 209, 230, 233, 237, 240, 256, 258, 336, 340.

### `packages/providers/src/tool-format/from-openai.ts`

- Coverage: lines 84.61%, statements 84.61%, functions 100%, branches 68.08%.
- Add tests in: `packages/providers/tests/tool-format/from-openai.test.ts`.
- Uncovered statement lines: 95-100.
- Uncovered functions: none reported.
- Uncovered branch lines: 40, 74, 76, 92, 95, 97, 99.

### `packages/tools/src/languages/execute-tool.ts`

- Coverage: lines 84.81%, statements 79.78%, functions 100%, branches 68.96%.
- Add tests in: `packages/tools/tests/languages/execute-tool.test.ts`.
- Uncovered statement lines: 116, 118, 120, 135, 139, 169-171, 204, 223, 244, 246-249, 277.
- Uncovered functions: none reported.
- Uncovered branch lines: 115, 117, 120, 135, 139, 143, 154-156, 163, 195, 204, 216-217, 219, 222, 224, 233, 235, 242-243, 245-248, 257-258, 276, 278, 289.

### `packages/plugins/src/plugin-stack-observer/index.ts`

- Coverage: lines 85%, statements 81.81%, functions 72.72%, branches 83.33%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 138-142, 144, 195.
- Uncovered functions: `(anonymous_4)` (line 137), `(anonymous_5)` (line 141), `(anonymous_9)` (line 195).
- Uncovered branch lines: 121, 138, 195.

### `packages/tools/src/tool-search.ts`

- Coverage: lines 85%, statements 81.81%, functions 75%, branches 80.64%.
- Add tests in: `packages/tools/tests/tool-search.test.ts`.
- Uncovered statement lines: 85-87.
- Uncovered functions: `(anonymous_2)` (line 86).
- Uncovered branch lines: 84-86.

### `packages/plugins/src/agent-handoff/index.ts`

- Coverage: lines 85.29%, statements 85.18%, functions 83.33%, branches 56.75%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 157-161, 163, 177-178, 270-271, 275-276, 314, 337-338, 355.
- Uncovered functions: `(anonymous_7)` (line 274), `execute_2` (line 354).
- Uncovered branch lines: 90, 94-95, 97, 106, 132-133, 135, 156, 159-160, 176, 181, 197, 269, 273, 277, 314, 320, 329, 334, 340.

### `packages/techstack/src/adapters/python.ts`

- Coverage: lines 85.4%, statements 83.79%, functions 83.33%, branches 71.33%.
- Add tests in: `packages/techstack/tests/adapters/python-adapter.test.ts`.
- Uncovered statement lines: 84, 141, 143, 171-181, 185, 200-205, 211, 294-300, 322, 335.
- Uncovered functions: `parsePipfileDeps` (line 170), `parsePipfileLock` (line 199), `(anonymous_16)` (line 299).
- Uncovered branch lines: 55, 73, 84, 89, 101, 111, 115, 125, 129, 138, 141, 143, 147, 163, 174, 177, 179-180, 194, 204-205, 285, 293, 296, 299, 311, 313, 322, 329, 332, 334, 339-340, 345, 348.

### `packages/tools/src/languages/profile-helpers.ts`

- Coverage: lines 85.71%, statements 85.71%, functions 80%, branches 90%.
- Add tests in: `packages/tools/tests/languages/profile-helpers.test.ts`.
- Uncovered statement lines: 91.
- Uncovered functions: `profileId` (line 90).
- Uncovered branch lines: 87.

### `packages/providers/src/openai-codex.ts`

- Coverage: lines 85.94%, statements 79.71%, functions 88.46%, branches 60.28%.
- Add tests in: `packages/providers/tests/openai-codex.test.ts`.
- Uncovered statement lines: 61, 73-74, 79, 85, 90-91, 96, 285-286, 288-289, 323, 331-333, 351, 370, 374-375, 435-436, 438, 440, 456, 467, 469, 473, 477, 486, 513-515, 548, 550, 581, 584, 590, 623.
- Uncovered functions: `refreshCodexAccessToken` (line 57), `(anonymous_1)` (line 74), `mapToolChoice` (line 328).
- Uncovered branch lines: 70-71, 73, 80, 90, 181, 197, 209, 214, 259, 270, 284, 288-289, 323, 331-332, 351, 357, 370, 372, 374, 432, 434, 438, 440, 442, 448, 450, 456, 467-468, 471, 473, 475, 479, 486, 493-494, 505, 511-514, 519-520, 530-531, 548-549, 552, 554, 557, 572, 578-579, 581-583, 589, 605, 613, 616, 623.

### `packages/tools/src/skill.ts`

- Coverage: lines 86.36%, statements 82.43%, functions 100%, branches 73.8%.
- Add tests in: `packages/tools/tests/skill.test.ts`.
- Uncovered statement lines: 139-140, 143, 146, 169, 178, 203, 208, 211, 215-216, 218, 222.
- Uncovered functions: none reported.
- Uncovered branch lines: 138, 141-142, 146, 168, 188, 203, 211, 214, 222, 224.

### `packages/techstack/src/remediation.ts`

- Coverage: lines 86.4%, statements 77.58%, functions 100%, branches 52.52%.
- Add tests in: `packages/techstack/tests/remediation-apply-trend.test.ts`, `packages/techstack/tests/remediation.test.ts`.
- Uncovered statement lines: 64, 69, 96, 140, 143, 146-147, 149-150, 152-153, 155-156, 158, 177, 182, 306, 309, 316, 321, 324, 338.
- Uncovered functions: none reported.
- Uncovered branch lines: 64, 68, 93, 137, 140, 143, 145-155, 157, 177, 182, 184, 190, 209-210, 271, 275, 282-283, 287, 306, 309, 314-315, 324, 330, 335, 341.

### `packages/techstack/src/advisory/native-audit.ts`

- Coverage: lines 86.79%, statements 85.88%, functions 100%, branches 61.47%.
- Add tests in: `packages/techstack/tests/advisory/native-audit.test.ts`.
- Uncovered statement lines: 38, 42-43, 51-54, 77, 136-137, 145, 171, 211, 225, 275, 280, 324, 392, 531-535.
- Uncovered functions: none reported.
- Uncovered branch lines: 38, 40, 42-43, 51-54, 71, 77, 87, 89-93, 102-103, 144, 158, 161-165, 203, 207, 211, 214-218, 256, 259, 264-265, 267-268, 270, 279, 305, 308, 312, 314-318, 354, 363, 366-370, 375, 380, 382-383, 449, 454, 510-513, 531-535.

### `packages/techstack/src/delivery/coordinator.ts`

- Coverage: lines 86.84%, statements 81.81%, functions 66.66%, branches 59.09%.
- Add tests in: `packages/techstack/tests/delivery-coordinator.test.ts`.
- Uncovered statement lines: 66, 95, 125, 127-130.
- Uncovered functions: `(anonymous_4)` (line 125), `(anonymous_5)` (line 129).
- Uncovered branch lines: 65, 71, 95, 102, 125-126, 130.

### `packages/tools/src/browser/network-guard-proxy.ts`

- Coverage: lines 86.91%, statements 81.1%, functions 74.28%, branches 64%.
- Add tests in: `packages/tools/tests/browser-network-guard-proxy.test.ts`.
- Uncovered statement lines: 36, 41-42, 45-46, 52-53, 81, 94, 103-104, 124, 127, 132, 136, 150, 167-168, 174-175, 178, 183-184, 219.
- Uncovered functions: `(anonymous_6)` (line 35), `(anonymous_9)` (line 44), `(anonymous_16)` (line 93), `(anonymous_18)` (line 103), `(anonymous_19)` (line 104), `(anonymous_21)` (line 124), `(anonymous_23)` (line 131), `(anonymous_28)` (line 173), `(anonymous_29)` (line 177).
- Uncovered branch lines: 41-42, 51, 80-81, 87, 98, 117, 122, 127, 147, 149, 159, 167-168, 209-210, 219.

### `packages/tools/src/languages/execute.ts`

- Coverage: lines 87.29%, statements 84.53%, functions 88%, branches 60.26%.
- Add tests in: `packages/tools/tests/language-execute.test.ts`, `packages/tools/tests/language-package-execute.test.ts`.
- Uncovered statement lines: 40, 42, 49, 71, 163, 167, 201, 203, 206-209, 212-213, 230, 312-313, 317-318, 321, 339, 364, 375, 398, 442, 504-505, 513, 532, 535.
- Uncovered functions: `(anonymous_12)` (line 363), `(anonymous_15)` (line 504), `(anonymous_16)` (line 505).
- Uncovered branch lines: 40-41, 49, 71, 103, 114, 126, 132, 134, 153, 163, 166, 175, 179, 187, 201, 203, 205, 208, 212, 222, 229, 240, 311, 316, 320, 338, 353, 374, 398, 410, 416, 418, 423, 438, 441, 443-446, 477, 484, 513, 532, 535, 537, 550, 565, 606.

### `packages/providers/src/oauth-refresh.ts`

- Coverage: lines 87.5%, statements 86.2%, functions 100%, branches 75%.
- Add tests in: `packages/providers/tests/oauth-refresh-coordinator.test.ts`, `packages/providers/tests/oauth-refresh.test.ts`.
- Uncovered statement lines: 62, 92-94.
- Uncovered functions: none reported.
- Uncovered branch lines: 62, 91.

### `packages/plugins/src/import-organizer/index.ts`

- Coverage: lines 87.65%, statements 81.62%, functions 82.35%, branches 70.17%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 100, 108, 112, 115, 118, 123, 130, 135-137, 142, 277, 287-288, 300-302, 315-317, 320-321, 324-325, 335, 374, 397, 404, 481, 554.
- Uncovered functions: `(anonymous_6)` (line 286), `(anonymous_7)` (line 319), `(anonymous_8)` (line 323).
- Uncovered branch lines: 100, 103, 112, 115, 117, 123, 130, 134-135, 137, 140, 142, 236-237, 277, 310, 321, 325, 335, 390, 397, 481, 486-487, 492, 499, 542, 547, 553, 628.

### `packages/tools/src/codebase-index/circuit-breaker.ts`

- Coverage: lines 88.09%, statements 88.88%, functions 100%, branches 88%.
- Add tests in: `packages/tools/tests/circuit-breaker-index.test.ts`, `packages/tools/tests/circuit-breaker.test.ts`.
- Uncovered statement lines: 102-103, 117-119.
- Uncovered functions: none reported.
- Uncovered branch lines: 101, 116, 121.

### `packages/plugins/src/format-on-save/index.ts`

- Coverage: lines 88.23%, statements 85.81%, functions 100%, branches 69.76%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 171, 252, 259-262, 264-265, 273, 300, 304, 310, 323, 341, 344, 354, 361, 375, 445.
- Uncovered functions: none reported.
- Uncovered branch lines: 129-130, 134-135, 171, 242, 260, 273, 279, 304, 337, 340, 344, 372, 444, 460-461, 474, 508, 513, 615-617.

### `packages/plugins/src/semantic-search-indexer/index.ts`

- Coverage: lines 88.31%, statements 82.85%, functions 84.84%, branches 70.28%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 152, 156, 183, 188, 225, 230, 237, 241, 271, 277, 287, 304, 311-312, 317, 319, 323, 326, 331, 335, 338, 359-360, 364-366, 377, 383-384, 386, 412, 427, 431, 438, 478, 563-564, 568, 673-674, 678.
- Uncovered functions: `(anonymous_2)` (line 152), `(anonymous_3)` (line 156), `yieldEventLoop` (line 236), `(anonymous_12)` (line 237), `(anonymous_22)` (line 383).
- Uncovered branch lines: 152, 156, 160, 183, 188, 197, 207, 225, 228, 241, 271, 287, 310, 317, 319, 323-324, 326, 334, 337, 363, 365, 367, 377, 382, 412, 427, 431, 438, 442, 457, 467, 478, 562, 614, 672.

### `packages/plugins/src/test-flake-detector/index.ts`

- Coverage: lines 88.35%, statements 88.12%, functions 100%, branches 73.04%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 139-144, 177, 199-200, 205-206, 211-212, 214-215, 232, 236, 276-277.
- Uncovered functions: none reported.
- Uncovered branch lines: 92-93, 120, 129, 131, 140, 142, 171, 177, 198, 201, 204, 207, 210, 213, 230-232, 235, 243, 250, 275, 281.

### `packages/techstack/src/adapters/go.ts`

- Coverage: lines 88.54%, statements 85.84%, functions 100%, branches 72.61%.
- Add tests in: `packages/techstack/tests/adapters/go-adapter.test.ts`.
- Uncovered statement lines: 72-75, 77, 108-109, 112-113, 120, 162, 181, 188, 211, 215.
- Uncovered functions: none reported.
- Uncovered branch lines: 70, 73, 87, 107, 111, 115, 120-122, 139, 160, 180-181, 211, 215, 246, 250.

### `packages/plugins/src/dependency-vulnerability-gate/index.ts`

- Coverage: lines 88.88%, statements 87.58%, functions 100%, branches 60.68%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 171-177, 186-190, 203, 218, 279, 296-297, 305.
- Uncovered functions: none reported.
- Uncovered branch lines: 110-111, 130, 132, 148, 150, 152, 154, 168-169, 171-173, 176, 185, 187, 189, 203, 218-220, 292, 295, 305, 417, 503.

### `packages/providers/src/openai-codex-account.ts`

- Coverage: lines 88.88%, statements 90%, functions 100%, branches 100%.
- Add tests in: `packages/providers/tests/openai-codex-account.test.ts`.
- Uncovered statement lines: 19.
- Uncovered functions: none reported.
- Uncovered branch lines: none reported.

### `packages/plugins/src/session-recap/index.ts`

- Coverage: lines 89.02%, statements 87.15%, functions 70.37%, branches 61.76%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 178, 188-193, 202, 226, 341, 344-346, 351, 435, 444, 462, 472, 560, 606, 640.
- Uncovered functions: `bumpToolCount` (line 177), `(anonymous_12)` (line 340), `(anonymous_16)` (line 435), `(anonymous_18)` (line 462), `(anonymous_19)` (line 472), `(anonymous_22)` (line 560), `(anonymous_24)` (line 606), `(anonymous_26)` (line 640).
- Uncovered branch lines: 141, 143-144, 147-148, 166, 178, 184, 190, 202, 242, 321, 329, 337, 345-346, 351, 367, 419, 442-444, 451, 471-472, 480, 507, 516.

### `packages/plugins/src/test-runner-gate/index.ts`

- Coverage: lines 89.42%, statements 86.46%, functions 95.65%, branches 67.75%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 161, 285, 309, 340, 354, 400, 409-412, 430, 474, 482-483, 485-486, 505, 508, 521-525, 690-692, 700-701.
- Uncovered functions: `(anonymous_2)` (line 161).
- Uncovered branch lines: 156-157, 160-161, 186, 280, 284, 340, 349-350, 400, 408-409, 411, 430, 471, 474, 483, 485-486, 491-494, 500, 502-503, 505, 508, 516, 523-524, 639, 661, 664, 679, 682, 684-686, 689, 699, 724, 727, 729-731, 746, 748, 842-844.

### `packages/tools/src/languages/diagnostics.ts`

- Coverage: lines 89.44%, statements 86.04%, functions 89.47%, branches 59.55%.
- Add tests in: `packages/tools/tests/language-diagnostics.test.ts`.
- Uncovered statement lines: 47-48, 69, 147, 209-212, 221, 230, 274, 319, 329, 353, 356, 396, 435, 444, 470, 474, 528, 530, 532, 540, 543, 579-581, 599, 631.
- Uncovered functions: `parseBiome` (line 208), `(anonymous_15)` (line 229), `emptySummary` (line 598), `severityRank` (line 630).
- Uncovered branch lines: 24, 46, 68, 73, 77-78, 80, 92, 94, 97-98, 147, 149, 152, 154, 156-157, 173, 197, 232, 248, 277, 291, 294, 296-297, 303, 305, 329, 339, 356, 367-368, 371, 375, 384, 396, 409, 412, 414-415, 419-420, 435, 443, 447, 452, 474, 476, 478-481, 484, 488, 521, 527, 529, 531, 538-539, 541-542, 561, 579-581, 586, 608-610, 622, 624, 626, 631.

### `packages/tools/src/_syntax-check.ts`

- Coverage: lines 89.58%, statements 81.66%, functions 100%, branches 70.21%.
- Add tests in: `packages/tools/tests/_syntax-check.test.ts`.
- Uncovered statement lines: 32, 70, 77, 94, 103, 140, 145-147.
- Uncovered functions: none reported.
- Uncovered branch lines: 32, 70, 77, 91, 93, 103, 107, 129, 140, 144, 146-147.

### `packages/providers/src/trusted-presets.ts`

- Coverage: lines 89.74%, statements 89.36%, functions 85.71%, branches 84%.
- Add tests in: `packages/providers/tests/trusted-presets.test.ts`.
- Uncovered statement lines: 573-575, 611, 618.
- Uncovered functions: `(anonymous_4)` (line 611).
- Uncovered branch lines: 572, 610, 617, 620, 641.

### `packages/tools/src/task.ts`

- Coverage: lines 89.78%, statements 89.4%, functions 85.71%, branches 80.58%.
- Add tests in: `packages/tools/tests/task.test.ts`.
- Uncovered statement lines: 194, 198-199, 242-246, 248, 255, 433, 463-464, 476.
- Uncovered functions: `(anonymous_6)` (line 243), `(anonymous_7)` (line 243).
- Uncovered branch lines: 41, 191, 194, 200-201, 210, 241, 244, 308-309, 435, 462, 464, 471, 478.

### `packages/tools/src/codebase-index/writer.ts`

- Coverage: lines 89.81%, statements 87.29%, functions 91.37%, branches 67.02%.
- Add tests in: `packages/tools/tests/codebase-index-writer.test.ts`.
- Uncovered statement lines: 51, 57, 60-61, 63, 136-137, 161, 175, 183, 202, 347, 487-488, 490-491, 500, 504, 543, 572, 604, 694-695, 734-735, 906, 1062-1066, 1090-1091, 1093, 1097-1104, 1106-1113, 1121, 1123-1125, 1127, 1144, 1147, 1234-1235, 1267, 1303, 1402-1403, 1446, 1452, 1486-1487, 1556, 1576-1580, 1582, 1616, 1660, 1686, 1715-1716, 1769, 1833, 1852, 1856, 1880, 1941, 1998.
- Uncovered functions: `(anonymous_3)` (line 51), `has` (line 160), `(anonymous_21)` (line 491), `getOrBuildBm25` (line 1061), `(anonymous_52)` (line 1093), `(anonymous_53)` (line 1098), `(anonymous_54)` (line 1100), `(anonymous_55)` (line 1106), `(anonymous_56)` (line 1123), `getMaxSymbolId` (line 1143).
- Uncovered branch lines: 51, 57, 60-61, 63, 175, 179, 181-182, 339, 477, 484, 486, 543, 548, 572, 604, 683, 703, 722, 906, 910, 973, 1062, 1084, 1091, 1101-1103, 1108, 1110, 1114-1118, 1147, 1162, 1167, 1228, 1267, 1302, 1312, 1365, 1444, 1452, 1466, 1521, 1545, 1571, 1574, 1577, 1580, 1588, 1602, 1635, 1639, 1655, 1658-1659, 1684-1686, 1689, 1693, 1709, 1714, 1718, 1766, 1769, 1795, 1797, 1799, 1833, 1844, 1852, 1856, 1861, 1865, 1880, 1887, 1891, 1902, 1941, 1953, 1998, 2003, 2007, 2018, 2036, 2053, 2055.

### `packages/plugins/src/notify-hub/index.ts`

- Coverage: lines 89.84%, statements 88.57%, functions 80.95%, branches 76.64%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 169, 176, 181, 190, 207, 228, 256, 419-421, 435-437, 439.
- Uncovered functions: `(anonymous_7)` (line 207), `(anonymous_10)` (line 255), `(anonymous_15)` (line 418), `(anonymous_16)` (line 435).
- Uncovered branch lines: 121-122, 162, 181, 200, 207, 211-212, 227, 231, 234, 236, 238, 258, 292, 409-410, 419, 422, 425, 434, 436, 479-480, 486, 502, 516, 521, 574.

### `packages/providers/src/sse.ts`

- Coverage: lines 90.06%, statements 86.18%, functions 86.66%, branches 79.82%.
- Add tests in: `packages/providers/tests/sse.test.ts`.
- Uncovered statement lines: 66, 68, 88-89, 93-94, 164-166, 174-175, 183, 202, 221, 272, 277, 300-302.
- Uncovered functions: `(anonymous_8)` (line 163), `(anonymous_9)` (line 192).
- Uncovered branch lines: 65, 67, 87, 89, 92-93, 129, 164-165, 173, 183, 199, 202, 221, 271, 277, 284, 299.

### `packages/plugins/src/checkpoint/index.ts`

- Coverage: lines 90.22%, statements 86.8%, functions 89.47%, branches 74.73%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 135-138, 140, 167, 172-173, 247, 252-253, 317, 425, 430, 436, 439, 456.
- Uncovered functions: `hashContent` (line 134), `(anonymous_16)` (line 436).
- Uncovered branch lines: 119, 167, 172, 245-247, 251, 259, 279, 316-317, 378, 425, 429, 432, 436, 438, 456.

### `packages/providers/src/google.ts`

- Coverage: lines 90.47%, statements 79.59%, functions 85.71%, branches 77.14%.
- Add tests in: `packages/providers/tests/google-explicit-cache.test.ts`, `packages/providers/tests/google.test.ts`, `packages/providers/tests/presets-anthropic-openai-google.test.ts`.
- Uncovered statement lines: 71, 89, 102, 123, 128, 131, 134-136.
- Uncovered functions: `(anonymous_6)` (line 123).
- Uncovered branch lines: 88-89, 102, 127-128, 131, 135.

### `packages/tools/src/patch.ts`

- Coverage: lines 90.66%, statements 85.39%, functions 80%, branches 70%.
- Add tests in: `packages/tools/tests/patch-spawn.test.ts`, `packages/tools/tests/patch.test.ts`.
- Uncovered statement lines: 129, 131-132, 160-163, 179, 181.
- Uncovered functions: `(anonymous_1)` (line 98), `(anonymous_2)` (line 129), `(anonymous_3)` (line 149).
- Uncovered branch lines: 114, 128, 131, 134, 160, 162, 179-181, 219, 228.

### `packages/providers/src/presets/openai.ts`

- Coverage: lines 90.67%, statements 84.89%, functions 81.81%, branches 75.15%.
- Add tests in: `packages/providers/tests/openai-codex.test.ts`, `packages/providers/tests/openai-compatible-policy.test.ts`, `packages/providers/tests/openai-compatible.test.ts`, `packages/providers/tests/openai.test.ts`.
- Uncovered statement lines: 17, 90-93, 96-97, 101, 104, 182-183, 275, 283, 285, 309, 317-319.
- Uncovered functions: `isOpenAIEffort` (line 308), `responseFormatToOpenAI` (line 316).
- Uncovered branch lines: 17, 23, 65, 77, 79, 90-93, 95, 97, 100, 103, 164, 181, 186, 201, 214, 248, 256-257, 260, 267, 275, 283-284, 317-318, 323, 325.

### `packages/techstack/src/store/schema.ts`

- Coverage: lines 90.9%, statements 90.9%, functions 100%, branches 83.33%.
- Add tests in: `packages/techstack/tests/store/schema.test.ts`.
- Uncovered statement lines: 89.
- Uncovered functions: none reported.
- Uncovered branch lines: 87.

### `packages/kanban/src/manager/assignment.ts`

- Coverage: lines 91.4%, statements 88.28%, functions 87.5%, branches 77.1%.
- Add tests in: `packages/kanban/tests/manager/assignment.test.ts`.
- Uncovered statement lines: 60, 66-68, 71-72, 89, 144, 181, 200-211, 223, 313, 448, 460, 505-507, 518, 521, 525, 528, 531, 603, 627.
- Uncovered functions: `(anonymous_18)` (line 505), `(anonymous_19)` (line 506), `(anonymous_20)` (line 506).
- Uncovered branch lines: 60, 66-68, 70-72, 84, 86-87, 89, 121, 138, 144, 152, 177, 179, 191, 200-201, 203, 205-206, 208-209, 211, 223, 228, 248, 260, 262, 266, 309, 311, 317, 340, 378, 382, 406, 410, 433, 446, 460, 462, 464, 468, 492-493, 504, 521, 524, 527, 530, 602, 621, 623-625.

### `packages/tools/src/e2e.ts`

- Coverage: lines 91.41%, statements 85.77%, functions 89.65%, branches 77.52%.
- Add tests in: `packages/tools/tests/e2e-plan.test.ts`.
- Uncovered statement lines: 77, 82, 84, 204, 207-208, 215, 243, 266, 278, 297, 299-300, 309, 324-328, 391, 393, 403, 414, 428-430, 474, 476, 505, 507, 551.
- Uncovered functions: `(anonymous_1)` (line 84), `(anonymous_16)` (line 323), `(anonymous_27)` (line 551).
- Uncovered branch lines: 77, 143-144, 151, 164, 166, 204, 206, 225, 243, 260, 277-278, 297, 299-300, 304, 327, 382, 391, 393, 403-404, 406, 414-415, 427, 429, 473, 476, 504, 506, 522, 526, 544, 551, 558.

### `packages/providers/src/presets/local-llm.ts`

- Coverage: lines 91.48%, statements 85.45%, functions 100%, branches 72.07%.
- Add tests in: `packages/providers/tests/local-llm-presets.test.ts`.
- Uncovered statement lines: 31, 153, 163-165, 217-218, 226-227, 242-243, 287, 291-292, 295, 297.
- Uncovered functions: none reported.
- Uncovered branch lines: 31, 37, 142, 151-152, 154, 163-165, 186, 216, 225, 230, 242-243, 245, 253, 262, 279-280, 287, 290, 295-296, 311.

### `packages/tools/src/browser/security.ts`

- Coverage: lines 91.52%, statements 84.61%, functions 90%, branches 78.26%.
- Add tests in: `packages/tools/tests/browser-security.test.ts`.
- Uncovered statement lines: 16, 58, 61, 66, 70, 74, 89, 104, 106, 138.
- Uncovered functions: `(anonymous_2)` (line 61).
- Uncovered branch lines: 15-16, 57, 61, 67, 70, 73, 89, 106, 121, 125.

### `packages/providers/src/tool-format/from-anthropic.ts`

- Coverage: lines 91.66%, statements 88.88%, functions 100%, branches 84.78%.
- Add tests in: `packages/providers/tests/tool-format/from-anthropic.test.ts`.
- Uncovered statement lines: 99-100.
- Uncovered functions: none reported.
- Uncovered branch lines: 60, 74, 92, 99.

### `packages/plugins/src/config-validator/index.ts`

- Coverage: lines 91.7%, statements 88.99%, functions 81.25%, branches 74.34%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 88-89, 128-129, 175, 190-191, 204, 219, 228-229, 259, 274, 309-312, 368, 374, 415.
- Uncovered functions: `(anonymous_1)` (line 88), `(anonymous_2)` (line 89), `execute` (line 414).
- Uncovered branch lines: 87-88, 92-93, 127-128, 174, 186, 189, 197, 199, 219, 221, 227, 240-241, 258, 274, 278, 291, 296, 308-311, 366-368, 374, 393, 398.

### `packages/plugins/src/schema-evolution-guard/index.ts`

- Coverage: lines 91.85%, statements 91.21%, functions 92.85%, branches 84.31%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 113, 139, 205, 310, 314, 326-327, 333-335, 337, 342-343.
- Uncovered functions: `(anonymous_1)` (line 113).
- Uncovered branch lines: 113, 138, 186, 190, 204, 218, 310, 312-314, 325, 333, 341, 351.

### `packages/plugins/src/dep-guard/index.ts`

- Coverage: lines 91.97%, statements 91.71%, functions 94.44%, branches 84.37%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 148, 333, 370-371, 379-383, 385, 388-389, 433.
- Uncovered functions: `execute` (line 432).
- Uncovered branch lines: 140-141, 148, 156, 161, 164, 331-333, 369, 380, 384, 412, 495.

### `packages/plugins/src/diff-summary/index.ts`

- Coverage: lines 92.03%, statements 90.24%, functions 100%, branches 77.88%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 229, 235, 243, 257, 265, 274, 280-281, 412-413, 417, 438.
- Uncovered functions: none reported.
- Uncovered branch lines: 229, 231, 242, 265-266, 274, 276-277, 352, 364-365, 387, 389-390, 395, 404, 411, 416, 436, 451, 529.

### `packages/providers/src/anthropic-oauth.ts`

- Coverage: lines 92.3%, statements 91.42%, functions 94.11%, branches 70.58%.
- Add tests in: `packages/providers/tests/anthropic-oauth.test.ts`.
- Uncovered statement lines: 111, 128, 230, 298-300.
- Uncovered functions: `(anonymous_5)` (line 111).
- Uncovered branch lines: 76, 83, 107, 117, 127, 201, 212, 225, 291, 295, 297, 299.

### `packages/tools/src/browser/artifacts.ts`

- Coverage: lines 92.3%, statements 86.2%, functions 81.81%, branches 100%.
- Add tests in: `packages/tools/tests/browser/artifacts.test.ts`.
- Uncovered statement lines: 32, 61-62.
- Uncovered functions: `(anonymous_3)` (line 32), `(anonymous_4)` (line 61).
- Uncovered branch lines: none reported.

### `packages/plugins/src/smart-rename/index.ts`

- Coverage: lines 92.42%, statements 88.88%, functions 100%, branches 88.88%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 74, 78-79, 167, 189-190, 201-202.
- Uncovered functions: none reported.
- Uncovered branch lines: 74, 78-79, 166, 238.

### `packages/providers/src/openai-compatible.ts`

- Coverage: lines 92.45%, statements 92.3%, functions 100%, branches 84.37%.
- Add tests in: `packages/providers/tests/openai-compatible-policy.test.ts`, `packages/providers/tests/openai-compatible.test.ts`.
- Uncovered statement lines: 108, 136, 147, 152, 154.
- Uncovered functions: none reported.
- Uncovered branch lines: 108, 135, 138, 145-146, 148, 151, 153, 189.

### `packages/techstack/src/registry/http-fetch.ts`

- Coverage: lines 92.59%, statements 90.32%, functions 84.61%, branches 82.75%.
- Add tests in: `packages/techstack/tests/http-fetch-body-cap.test.ts`.
- Uncovered statement lines: 42, 45-46, 102-103, 122.
- Uncovered functions: `(anonymous_3)` (line 44), `(anonymous_10)` (line 101).
- Uncovered branch lines: 33, 42, 92, 98-99, 111, 122-123, 129.

### `packages/techstack/src/adapters/cpp.ts`

- Coverage: lines 92.68%, statements 90.9%, functions 100%, branches 81.81%.
- Add tests in: `packages/techstack/tests/adapters/cpp.test.ts`.
- Uncovered statement lines: 39, 80, 91, 95.
- Uncovered functions: none reported.
- Uncovered branch lines: 38, 52, 90, 95.

### `packages/tools/src/languages/registry.ts`

- Coverage: lines 92.68%, statements 84%, functions 100%, branches 78.57%.
- Add tests in: `packages/tools/tests/languages-registry.test.ts`, `packages/tools/tests/process-registry.test.ts`.
- Uncovered statement lines: 59-60, 62, 64, 67, 77, 83, 86.
- Uncovered functions: none reported.
- Uncovered branch lines: 59-60, 62, 64, 66, 72, 77, 82, 85.

### `packages/plugins/src/duplicate-code-detector/index.ts`

- Coverage: lines 92.82%, statements 90.95%, functions 92%, branches 82.72%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 164, 182, 288, 311, 462, 474-475, 489, 519, 524, 536-537, 555, 559-560, 571-572, 586, 634-635.
- Uncovered functions: `(anonymous_1)` (line 164), `(anonymous_2)` (line 182).
- Uncovered branch lines: 164, 178, 182, 272, 288, 291, 311, 356, 473, 519, 522, 524, 543, 555, 558, 586, 624, 725.

### `packages/plugins/src/secret-scanner/index.ts`

- Coverage: lines 92.85%, statements 89.78%, functions 100%, branches 80.14%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 180, 193, 267, 279, 285, 319, 322, 332, 342, 368, 375, 393, 396, 401-405, 407, 418, 464, 468, 597.
- Uncovered functions: none reported.
- Uncovered branch lines: 266, 275, 278, 285, 319, 322, 334, 367, 372, 374, 393, 396, 400, 404, 409, 464, 468, 478, 486, 515, 556-557, 597, 602, 791, 855.

### `packages/kanban/src/storage.ts`

- Coverage: lines 93.01%, statements 91.38%, functions 96%, branches 74.35%.
- Add tests in: `packages/kanban/tests/gap-dependencies-storage.test.ts`, `packages/kanban/tests/storage-io.test.ts`, `packages/kanban/tests/storage.test.ts`.
- Uncovered statement lines: 28, 39, 87-88, 99, 146, 196-198, 200-201, 204, 264, 305, 325, 401.
- Uncovered functions: `(anonymous_8)` (line 87), `(anonymous_32)` (line 401).
- Uncovered branch lines: 27, 38, 79, 83, 98, 133, 146, 195, 200, 204, 251, 305, 325, 328, 347, 361, 384, 401, 403, 426, 436, 441, 447, 459, 466, 469, 474, 476, 478-483, 488-491.

### `packages/tools/src/glob.ts`

- Coverage: lines 93.05%, statements 89.41%, functions 100%, branches 81.48%.
- Add tests in: `packages/tools/tests/glob.test.ts`.
- Uncovered statement lines: 143, 154, 157-161, 168.
- Uncovered functions: none reported.
- Uncovered branch lines: 139, 143, 153-154, 161, 168, 175.

### `packages/plugins/src/performance-regression-gate/index.ts`

- Coverage: lines 93.12%, statements 87.5%, functions 100%, branches 74.57%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 125, 129-131, 136, 139, 152, 158, 179, 208, 348-349, 367-368, 382-383, 387-388.
- Uncovered functions: none reported.
- Uncovered branch lines: 125, 127, 129-131, 136, 138-139, 149-152, 155-158, 161-162, 165, 208, 217, 233-234, 346-347, 366, 380-381, 386, 457.

### `packages/plugins/src/auto-i18n-extractor/index.ts`

- Coverage: lines 93.16%, statements 91.66%, functions 88.23%, branches 80.26%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 107, 112, 149, 193, 284-285, 296-297, 345, 362-363.
- Uncovered functions: `(anonymous_2)` (line 107), `(anonymous_3)` (line 112).
- Uncovered branch lines: 107, 112, 125, 144, 149, 178-179, 282, 284-285, 295, 313, 344, 361, 368.

### `packages/providers/src/aggregate.ts`

- Coverage: lines 93.25%, statements 92.85%, functions 100%, branches 79.54%.
- Add tests in: `packages/providers/tests/aggregate.test.ts`.
- Uncovered statement lines: 79, 84, 115-117, 146, 160.
- Uncovered functions: none reported.
- Uncovered branch lines: 68, 73, 76-77, 82, 98, 114, 120, 133, 144, 153-154, 157, 160, 169, 177.

### `packages/providers/src/opencode-go.ts`

- Coverage: lines 93.47%, statements 91.48%, functions 80%, branches 89.74%.
- Add tests in: `packages/providers/tests/opencode-go.test.ts`.
- Uncovered statement lines: 65, 89-91.
- Uncovered functions: `(anonymous_1)` (line 65), `complete` (line 88).
- Uncovered branch lines: 132, 134, 159, 184.

### `packages/techstack/src/adapters/maven.ts`

- Coverage: lines 93.75%, statements 91.54%, functions 100%, branches 69.56%.
- Add tests in: `packages/techstack/tests/adapters/maven.test.ts`.
- Uncovered statement lines: 66, 92-94, 114, 123.
- Uncovered functions: none reported.
- Uncovered branch lines: 45, 51, 55, 66, 70, 79-80, 82, 92-94, 123, 128, 139.

### `packages/tools/src/_win32-resolve.ts`

- Coverage: lines 93.75%, statements 91.17%, functions 100%, branches 85.29%.
- Add tests in: `packages/tools/tests/_win32-resolve.test.ts`.
- Uncovered statement lines: 69, 80-81.
- Uncovered functions: none reported.
- Uncovered branch lines: 69, 78, 81, 132.

### `packages/providers/src/anthropic.ts`

- Coverage: lines 93.75%, statements 93.75%, functions 100%, branches 100%.
- Add tests in: `packages/providers/tests/anthropic-oauth.test.ts`, `packages/providers/tests/anthropic.test.ts`.
- Uncovered statement lines: 35.
- Uncovered functions: none reported.
- Uncovered branch lines: none reported.

### `packages/plugins/src/dead-code-detector/index.ts`

- Coverage: lines 93.91%, statements 93.08%, functions 92%, branches 82.6%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 104, 139, 263-265, 392, 407-408, 479-480.
- Uncovered functions: `(anonymous_2)` (line 104), `(anonymous_12)` (line 262).
- Uncovered branch lines: 104, 149, 151, 215-216, 264, 390, 392, 397, 464, 535.

### `packages/tools/src/codebase-index/codebase-stats-tool.ts`

- Coverage: lines 94.11%, statements 94.11%, functions 100%, branches 86.36%.
- Add tests in: `packages/tools/tests/codebase-index/codebase-stats-tool.test.ts`.
- Uncovered statement lines: 80.
- Uncovered functions: none reported.
- Uncovered branch lines: 79, 102, 107.

### `packages/kanban/src/manager/_internal.ts`

- Coverage: lines 94.45%, statements 92.72%, functions 92.18%, branches 83.62%.
- Add tests in: `packages/kanban/tests/manager/_internal.test.ts`.
- Uncovered statement lines: 201-202, 344, 348, 352, 401-402, 417-418, 421-422, 470, 472, 644, 835, 984-985, 987, 989, 991, 1002, 1007-1008, 1021-1027, 1033, 1036, 1040-1042, 1047, 1050, 1074, 1089-1090, 1130-1131, 1204.
- Uncovered functions: `(anonymous_12)` (line 201), `(anonymous_13)` (line 202), `(anonymous_23)` (line 472), `(anonymous_64)` (line 835), `(anonymous_82)` (line 1040), `(anonymous_83)` (line 1041), `(anonymous_84)` (line 1047), `(anonymous_91)` (line 1089), `(anonymous_92)` (line 1090), `(anonymous_95)` (line 1130).
- Uncovered branch lines: 89, 111, 113, 121, 148, 150, 170, 173, 175, 178, 181, 196-197, 223-224, 226-227, 229-230, 235-236, 238-239, 263, 269, 281, 344, 348-349, 352, 400-402, 416-418, 420-422, 470, 472, 479-483, 488, 490, 492, 494-501, 503, 505-514, 516, 518-527, 533-534, 536, 539, 644, 657, 665, 681, 724, 727, 829, 935-936, 939-940, 950, 952-957, 959, 963, 983, 987, 989, 991, 994, 998, 1001, 1006, 1021, 1024-1025, 1033, 1035-1036, 1042, 1048, 1050, 1074, 1087, 1101-1104, 1106-1107, 1130-1131, 1166, 1170, 1199, 1204, 1236, 1289, 1315.

### `packages/techstack/src/adapters/dart.ts`

- Coverage: lines 94.62%, statements 90.65%, functions 100%, branches 85.86%.
- Add tests in: `packages/techstack/tests/adapters/dart.test.ts`.
- Uncovered statement lines: 51, 83, 86, 111, 118, 162, 207-208, 214-215.
- Uncovered functions: none reported.
- Uncovered branch lines: 51, 58, 81, 83, 86, 111, 118, 128, 155, 206, 212, 223, 238.

### `packages/tools/src/search.ts`

- Coverage: lines 94.89%, statements 92.85%, functions 95.83%, branches 74.13%.
- Add tests in: `packages/tools/tests/search.test.ts`, `packages/tools/tests/tool-search.test.ts`.
- Uncovered statement lines: 215, 219, 352-353, 357, 360-363, 365, 430, 438, 475, 481, 495, 512.
- Uncovered functions: `(anonymous_39)` (line 430), `(anonymous_44)` (line 495).
- Uncovered branch lines: 215, 219, 237-238, 321, 336, 338-340, 351, 353, 357, 359, 363, 406-408, 431, 438, 441, 447, 449-451, 466, 475-476, 511.

### `packages/tools/src/bash.ts`

- Coverage: lines 94.9%, statements 93.57%, functions 91.66%, branches 83.88%.
- Add tests in: `packages/tools/tests/bash-backpressure.test.ts`, `packages/tools/tests/bash-kill-guard-paths.test.ts`, `packages/tools/tests/bash-spawn.test.ts`, `packages/tools/tests/bash-timeout-cleanup.test.ts`.
- Uncovered statement lines: 115, 145, 155, 251-252, 318, 348-350, 474, 491-492, 669, 702.
- Uncovered functions: `(anonymous_5)` (line 347), `(anonymous_9)` (line 490).
- Uncovered branch lines: 115, 144, 152, 233, 249, 251-252, 298, 309, 318, 321, 323, 331, 339, 348, 358, 360, 376, 406, 433, 473, 599, 649, 669, 702.

### `packages/tools/src/fetch.ts`

- Coverage: lines 94.93%, statements 92.3%, functions 87.5%, branches 85.96%.
- Add tests in: `packages/tools/tests/fetch-lookup.test.ts`, `packages/tools/tests/fetch-transport.test.ts`, `packages/tools/tests/fetch.test.ts`.
- Uncovered statement lines: 96, 106, 116, 139, 157, 185, 247.
- Uncovered functions: `(anonymous_4)` (line 139).
- Uncovered branch lines: 95, 105, 115, 157, 161, 185, 246, 267.

### `packages/plugins/src/accessibility-auditor/index.ts`

- Coverage: lines 94.96%, statements 92.98%, functions 93.75%, branches 74%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 103, 144-145, 153, 287-288, 302, 378, 383-384, 401, 434.
- Uncovered functions: `(anonymous_1)` (line 103).
- Uncovered branch lines: 103, 106-107, 121, 141, 145, 187, 197, 230, 234, 243, 275, 285, 301-302, 306, 378, 381, 383-384, 401, 433, 527.

### `packages/providers/src/provider-definitions.ts`

- Coverage: lines 95%, statements 95.65%, functions 100%, branches 73.07%.
- Add tests in: `packages/providers/tests/provider-definitions.test.ts`.
- Uncovered statement lines: 222.
- Uncovered functions: none reported.
- Uncovered branch lines: 192, 221, 249, 265-266, 271.

### `packages/tools/src/languages/tool.ts`

- Coverage: lines 95%, statements 95%, functions 100%, branches 80%.
- Add tests in: `packages/tools/tests/language-package-tool.test.ts`, `packages/tools/tests/language-tool.test.ts`, `packages/tools/tests/tool-diff.test.ts`, `packages/tools/tests/tool-help.test.ts`.
- Uncovered statement lines: 145.
- Uncovered functions: none reported.
- Uncovered branch lines: 144, 161, 165, 175-177.

### `packages/tools/src/spawn-background.ts`

- Coverage: lines 95%, statements 95%, functions 75%, branches 78.57%.
- Add tests in: `packages/tools/tests/spawn-background.test.ts`.
- Uncovered statement lines: 99.
- Uncovered functions: `(anonymous_1)` (line 96).
- Uncovered branch lines: 74-75, 106, 137, 150.

### `packages/plugins/src/security-hotspot-scanner/index.ts`

- Coverage: lines 95.07%, statements 91.61%, functions 94.11%, branches 68.83%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 101, 167, 211, 218, 230, 233, 239, 245, 247, 264, 366-367, 384.
- Uncovered functions: `(anonymous_1)` (line 101).
- Uncovered branch lines: 101, 108-109, 167, 211, 218, 233, 237, 239-243, 248, 263, 364, 366-367, 371, 383, 412, 542.

### `packages/tools/src/_edit-match.ts`

- Coverage: lines 95.17%, statements 91.44%, functions 100%, branches 80%.
- Add tests in: `packages/tools/tests/_edit-match.test.ts`.
- Uncovered statement lines: 99, 148-154, 225, 235, 261, 272-273, 346, 375.
- Uncovered functions: none reported.
- Uncovered branch lines: 99, 140, 152, 225, 235, 237, 261, 272-273, 326, 346, 366, 375.

### `packages/kanban/src/manager/presence.ts`

- Coverage: lines 95.23%, statements 95.83%, functions 90%, branches 90.24%.
- Add tests in: `packages/kanban/tests/presence.test.ts`.
- Uncovered statement lines: 27.
- Uncovered functions: `(anonymous_3)` (line 27).
- Uncovered branch lines: 45, 58, 60, 62.

### `packages/plugins/src/migration-planner/index.ts`

- Coverage: lines 95.26%, statements 92.1%, functions 94.73%, branches 75%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 95, 134, 175, 215, 247-250, 293, 304, 419-420, 424, 432, 494.
- Uncovered functions: `(anonymous_1)` (line 95).
- Uncovered branch lines: 95, 98-99, 104-106, 134, 173, 175, 183, 188, 211-212, 242, 246, 269, 289, 293, 297, 304, 309, 311, 419-420, 422, 424, 426-427, 490-493.

### `packages/plugins/src/feature-flag-tracker/index.ts`

- Coverage: lines 95.28%, statements 93.22%, functions 94.11%, branches 80%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 95, 280, 285-286, 298-299, 344-345.
- Uncovered functions: `(anonymous_1)` (line 95).
- Uncovered branch lines: 95, 114, 158, 160, 188, 280, 283, 285-286, 334, 423.

### `packages/kanban/src/manager/boards.ts`

- Coverage: lines 95.31%, statements 89.24%, functions 95.45%, branches 81.81%.
- Add tests in: `packages/kanban/tests/manager/boards.test.ts`.
- Uncovered statement lines: 58, 100, 114, 121-122, 125, 127, 133-134, 195, 236, 266, 282, 285.
- Uncovered functions: `(anonymous_21)` (line 282).
- Uncovered branch lines: 49-50, 52, 58, 65, 100, 114, 120-122, 124-125, 127, 129, 132-134, 162, 166-168, 195, 211, 236, 239, 266, 285.

### `packages/plugins/src/doc-sync-guard/index.ts`

- Coverage: lines 95.34%, statements 89.71%, functions 90.47%, branches 78.26%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 79, 82, 109, 112, 121, 134-135, 149, 225, 236.
- Uncovered functions: `(anonymous_1)` (line 79), `(anonymous_2)` (line 82).
- Uncovered branch lines: 79, 82, 109, 112, 121, 126, 128, 132-134, 142, 149, 225, 236.

### `packages/plugins/src/interface-contract-guard/index.ts`

- Coverage: lines 95.37%, statements 93.49%, functions 100%, branches 83.33%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 196, 282, 287-288, 300-301, 346-347.
- Uncovered functions: none reported.
- Uncovered branch lines: 111, 138, 164, 178, 282, 285, 287-288, 336, 430.

### `packages/providers/src/openai-compatible-policy.ts`

- Coverage: lines 95.45%, statements 92.12%, functions 100%, branches 70.83%.
- Add tests in: `packages/providers/tests/openai-compatible-policy.test.ts`.
- Uncovered statement lines: 47, 51-52, 105-106, 142, 158, 169-170.
- Uncovered functions: none reported.
- Uncovered branch lines: 47, 51-54, 63-64, 66, 89, 100, 102-103, 105, 108, 114, 131-132, 134, 136, 142, 144, 158-159, 162-164, 168, 190, 202, 204, 206, 209.

### `packages/plugins/src/branch-guard/index.ts`

- Coverage: lines 95.52%, statements 90.96%, functions 100%, branches 80.67%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 116, 118, 164, 172-174, 191, 232-233, 243, 335, 346.
- Uncovered functions: none reported.
- Uncovered branch lines: 91, 100, 105, 116, 118-120, 162, 164, 168, 172, 191, 231-232, 242, 307, 317-318, 335, 346, 488.

### `packages/plugins/src/cost-tracker/index.ts`

- Coverage: lines 95.52%, statements 94.16%, functions 92.85%, branches 83.33%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 311, 337, 417-418, 420-421, 431, 433.
- Uncovered functions: `(anonymous_4)` (line 418).
- Uncovered branch lines: 167-168, 311, 337, 412, 414-415, 429, 645.

### `packages/tools/src/exec.ts`

- Coverage: lines 95.54%, statements 95%, functions 100%, branches 79.16%.
- Add tests in: `packages/tools/tests/exec-kill-guard.test.ts`, `packages/tools/tests/exec-spawn.test.ts`, `packages/tools/tests/exec.test.ts`.
- Uncovered statement lines: 319, 328, 442, 498, 635-636, 644-645, 655.
- Uncovered functions: none reported.
- Uncovered branch lines: 189, 224, 226, 319, 328-329, 441, 444, 497, 502, 600, 626, 681, 683, 687, 693, 719, 728, 736, 742, 745, 752.

### `packages/plugins/src/changelog-writer/index.ts`

- Coverage: lines 95.58%, statements 92.71%, functions 100%, branches 74.4%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 240, 301, 333, 340, 344-346, 385, 447, 467.
- Uncovered functions: none reported.
- Uncovered branch lines: 125, 128-129, 172, 186, 236, 300, 333, 340-345, 348-351, 384-385, 413, 423, 447, 469.

### `packages/tools/src/tool-diff.ts`

- Coverage: lines 95.61%, statements 94.81%, functions 100%, branches 87.28%.
- Add tests in: `packages/tools/tests/tool-diff.test.ts`.
- Uncovered statement lines: 41, 44, 47, 60, 126, 269-270.
- Uncovered functions: none reported.
- Uncovered branch lines: 36, 39, 46, 60, 69-70, 77, 83, 251-253, 268.

### `packages/providers/src/presets/google.ts`

- Coverage: lines 95.65%, statements 93.33%, functions 88.23%, branches 86.36%.
- Add tests in: `packages/providers/tests/google-explicit-cache.test.ts`, `packages/providers/tests/google.test.ts`, `packages/providers/tests/presets-anthropic-openai-google.test.ts`.
- Uncovered statement lines: 114, 179, 228-230, 246-249, 253.
- Uncovered functions: `(anonymous_12)` (line 247), `(anonymous_13)` (line 248).
- Uncovered branch lines: 114, 125, 164, 178, 183, 196, 228-230, 239, 244-245, 249, 252, 275, 286, 294, 302, 306, 317.

### `packages/plugins/src/runtime/bounded-map.ts`

- Coverage: lines 95.65%, statements 92.3%, functions 100%, branches 80.76%.
- Add tests in: `packages/plugins/tests/runtime-bounded-map.test.ts`.
- Uncovered statement lines: 77, 85-86, 97.
- Uncovered functions: none reported.
- Uncovered branch lines: 47, 77, 84, 97, 127.

### `packages/plugins/src/refactor-suggester/index.ts`

- Coverage: lines 95.74%, statements 92.4%, functions 94.44%, branches 79.31%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 117, 186, 209, 237, 363, 368-369, 382, 389-390, 435-436.
- Uncovered functions: `(anonymous_2)` (line 117).
- Uncovered branch lines: 107, 117, 134, 150, 186, 208, 237, 261, 363, 366, 368-369, 382, 425, 516.

### `packages/techstack/src/adapters/php.ts`

- Coverage: lines 95.74%, statements 94.64%, functions 100%, branches 93.47%.
- Add tests in: `packages/techstack/tests/adapters/php.test.ts`.
- Uncovered statement lines: 109, 119, 143.
- Uncovered functions: none reported.
- Uncovered branch lines: 60, 102, 143.

### `packages/kanban/src/manager/tasks.ts`

- Coverage: lines 95.85%, statements 89.91%, functions 90.69%, branches 80.57%.
- Add tests in: `packages/kanban/tests/gap-internal-tasks.test.ts`.
- Uncovered statement lines: 64-65, 125, 127, 190, 261, 270-271, 274, 276-277, 279, 282, 284, 364, 436, 438, 440, 502, 531, 561.
- Uncovered functions: `(anonymous_2)` (line 64), `(anonymous_3)` (line 65), `(anonymous_21)` (line 270), `(anonymous_22)` (line 276).
- Uncovered branch lines: 56-57, 98, 125, 127, 157-158, 178, 181-182, 190, 193, 245, 261, 265, 267, 269, 271, 273-275, 279, 281-282, 284, 363-364, 366, 376-379, 403, 405-406, 435, 437-440, 473-475, 502, 517-518, 531, 547-548, 561, 571-572.

### `packages/plugins/src/prompt-firewall/index.ts`

- Coverage: lines 95.9%, statements 93.38%, functions 86.36%, branches 86.36%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 144, 185, 212, 214-215, 217, 377, 380.
- Uncovered functions: `(anonymous_6)` (line 144), `(anonymous_12)` (line 212), `(anonymous_13)` (line 213).
- Uncovered branch lines: 144, 178, 211-212, 334, 362, 377, 380.

### `packages/plugins/src/code-metrics/index.ts`

- Coverage: lines 96%, statements 94.28%, functions 100%, branches 83.05%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 135, 153, 284, 289, 302-303, 344-345.
- Uncovered functions: none reported.
- Uncovered branch lines: 102, 152, 180, 191, 214, 284, 287, 289, 334, 416.

### `packages/plugins/src/type-gate/index.ts`

- Coverage: lines 96.07%, statements 90.99%, functions 80%, branches 73.91%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 116, 209, 215, 226, 232, 245, 342, 346-347, 410.
- Uncovered functions: `(anonymous_1)` (line 116), `execute` (line 409).
- Uncovered branch lines: 116, 127-128, 132-133, 187, 207-208, 214, 226, 232, 245, 342, 344, 346-347, 351, 384, 413, 470.

### `packages/providers/src/oauth-refresh-coordinator.ts`

- Coverage: lines 96.15%, statements 93.75%, functions 87.5%, branches 92.85%.
- Add tests in: `packages/providers/tests/oauth-refresh-coordinator.test.ts`.
- Uncovered statement lines: 146, 175.
- Uncovered functions: `setExpiresAt` (line 145).
- Uncovered branch lines: 175.

### `packages/techstack/src/adapters/rust.ts`

- Coverage: lines 96.29%, statements 93.49%, functions 100%, branches 79.43%.
- Add tests in: `packages/techstack/tests/adapters/rust-adapter.test.ts`.
- Uncovered statement lines: 76, 78, 85, 100, 162, 164, 192, 232.
- Uncovered functions: none reported.
- Uncovered branch lines: 55, 76, 78, 85, 87, 94-95, 100, 134, 137, 140, 146, 161, 163, 183, 232, 241, 250, 263.

### `packages/tools/src/codebase-index/generic-parser.ts`

- Coverage: lines 96.29%, statements 90.9%, functions 80%, branches 75.8%.
- Add tests in: `packages/tools/tests/codebase-index/generic-parser.test.ts`.
- Uncovered statement lines: 239, 244, 304, 307, 310, 348.
- Uncovered functions: `parseSymbols` (line 343).
- Uncovered branch lines: 231, 239, 244, 287, 296, 301, 304, 307, 309, 319-320.

### `packages/techstack/src/adapters/gradle.ts`

- Coverage: lines 96.38%, statements 86.4%, functions 88.88%, branches 66.31%.
- Add tests in: `packages/techstack/tests/adapters/gradle-swift.test.ts`.
- Uncovered statement lines: 25-26, 42, 45, 52-54, 56, 71, 73, 81, 83, 85, 108.
- Uncovered functions: `(anonymous_2)` (line 50).
- Uncovered branch lines: 25-26, 38, 42, 45, 48-50, 54, 56, 59, 71, 73, 81, 83, 85, 107-108, 111, 113-114, 116, 123, 130, 137, 144.

### `packages/plugins/src/todo-tracker/index.ts`

- Coverage: lines 96.44%, statements 90.3%, functions 92%, branches 71.29%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 100, 105, 158, 182, 273, 284, 323, 388, 390, 425, 427, 429, 433, 461, 463, 465, 489, 519.
- Uncovered functions: `notConfiguredError` (line 181), `(anonymous_12)` (line 284).
- Uncovered branch lines: 82, 99, 104, 153, 160, 174, 246, 273, 277, 283, 323-324, 336-337, 388-390, 425-427, 429, 432, 461-463, 465, 489-490, 495, 519.

### `packages/providers/src/presets/anthropic.ts`

- Coverage: lines 96.49%, statements 95.41%, functions 100%, branches 79.73%.
- Add tests in: `packages/providers/tests/anthropic-oauth.test.ts`, `packages/providers/tests/anthropic.test.ts`.
- Uncovered statement lines: 115, 289, 300, 304, 308, 310.
- Uncovered functions: none reported.
- Uncovered branch lines: 57, 75-76, 92, 115, 117, 136, 143, 150, 157, 161, 175, 190, 196, 202, 205, 218, 229, 256, 258, 263, 288, 290-291, 300, 303, 305-307, 309.

### `packages/plugins/src/spec-linker/index.ts`

- Coverage: lines 96.73%, statements 93.88%, functions 94.73%, branches 83.67%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 120, 148, 162, 271, 358, 370, 373-374, 413, 420, 422.
- Uncovered functions: `(anonymous_1)` (line 120).
- Uncovered branch lines: 120, 144, 162, 204, 270, 284, 353, 356, 358, 370, 389, 413, 418, 420, 422.

### `packages/providers/src/presets/mistral.ts`

- Coverage: lines 96.73%, statements 94.33%, functions 100%, branches 84.21%.
- Add tests in: `packages/providers/tests/mistral-preset.test.ts`.
- Uncovered statement lines: 51, 62-63, 68, 125, 173.
- Uncovered functions: none reported.
- Uncovered branch lines: 40, 49-51, 62-63, 67, 123-126, 131, 171-172, 202.

### `packages/telegram/src/outbound-queue.ts`

- Coverage: lines 96.87%, statements 97.05%, functions 100%, branches 97.36%.
- Add tests in: `packages/telegram/tests/unit/outbound-queue.test.ts`.
- Uncovered statement lines: 142-143, 146.
- Uncovered functions: none reported.
- Uncovered branch lines: 139.

### `packages/techstack/src/service/techstack-engine.ts`

- Coverage: lines 96.87%, statements 97.05%, functions 90%, branches 84.21%.
- Add tests in: `packages/techstack/tests/service/techstack-engine.test.ts`.
- Uncovered statement lines: 81.
- Uncovered functions: `(anonymous_9)` (line 81).
- Uncovered branch lines: 89.

### `packages/tools/src/batch-tool-use.ts`

- Coverage: lines 96.87%, statements 97.29%, functions 100%, branches 87.5%.
- Add tests in: `packages/tools/tests/batch-tool-use.test.ts`.
- Uncovered statement lines: 160.
- Uncovered functions: none reported.
- Uncovered branch lines: 156, 163.

### `packages/plugins/src/shell-check/index.ts`

- Coverage: lines 96.93%, statements 96.33%, functions 100%, branches 90.41%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 32, 152-153, 161.
- Uncovered functions: none reported.
- Uncovered branch lines: 32, 143-145, 349, 356, 447.

### `packages/techstack/src/discovery/workspace.ts`

- Coverage: lines 96.96%, statements 97.36%, functions 100%, branches 91.42%.
- Add tests in: `packages/techstack/tests/discovery/workspace.test.ts`.
- Uncovered statement lines: 90.
- Uncovered functions: none reported.
- Uncovered branch lines: 89, 130, 187.

### `packages/tools/src/_shell-pick.ts`

- Coverage: lines 97.01%, statements 90%, functions 100%, branches 88%.
- Add tests in: `packages/tools/tests/_shell-pick.test.ts`.
- Uncovered statement lines: 136-139, 146, 174, 189, 218, 223.
- Uncovered functions: none reported.
- Uncovered branch lines: 136-139, 145, 174, 189, 218, 222, 343, 356, 363.

### `packages/tools/src/languages/legacy-bridge.ts`

- Coverage: lines 97.05%, statements 97.72%, functions 100%, branches 84%.
- Add tests in: `packages/tools/tests/legacy-bridge.test.ts`.
- Uncovered statement lines: 75.
- Uncovered functions: none reported.
- Uncovered branch lines: 59, 74, 107, 142.

### `packages/providers/src/github-copilot.ts`

- Coverage: lines 97.14%, statements 97.14%, functions 100%, branches 89.47%.
- Add tests in: `packages/providers/tests/github-copilot-token.test.ts`, `packages/providers/tests/github-copilot.test.ts`.
- Uncovered statement lines: 140.
- Uncovered functions: none reported.
- Uncovered branch lines: 135, 187.

### `packages/tools/src/write.ts`

- Coverage: lines 97.22%, statements 97.22%, functions 83.33%, branches 92.85%.
- Add tests in: `packages/tools/tests/write.test.ts`.
- Uncovered statement lines: 172.
- Uncovered functions: `(anonymous_5)` (line 172).
- Uncovered branch lines: 111, 183.

### `packages/providers/src/tool-format/to-openai.ts`

- Coverage: lines 97.26%, statements 96.55%, functions 100%, branches 84.21%.
- Add tests in: `packages/providers/tests/tool-format/to-openai.test.ts`.
- Uncovered statement lines: 34, 228, 251.
- Uncovered functions: none reported.
- Uncovered branch lines: 34, 150, 203, 211, 227, 244, 247-248.

### `packages/providers/src/openai.ts`

- Coverage: lines 97.52%, statements 93.07%, functions 94.44%, branches 83.41%.
- Add tests in: `packages/providers/tests/openai-codex.test.ts`, `packages/providers/tests/openai-compatible-policy.test.ts`, `packages/providers/tests/openai-compatible.test.ts`, `packages/providers/tests/openai.test.ts`.
- Uncovered statement lines: 21, 69, 111, 120-121, 131, 161, 163-164, 177-178, 326, 360, 362, 424, 529.
- Uncovered functions: `(anonymous_10)` (line 161).
- Uncovered branch lines: 21, 27, 68, 97, 110-111, 120-121, 129, 131, 160, 177-178, 185, 326, 328, 360, 362, 398, 424, 430, 445, 458, 493, 504-505, 508, 515, 529, 550.

### `packages/tools/src/tool-summary.ts`

- Coverage: lines 97.61%, statements 97.89%, functions 100%, branches 89.36%.
- Add tests in: `packages/tools/tests/tool-summary.test.ts`.
- Uncovered statement lines: 53, 76.
- Uncovered functions: none reported.
- Uncovered branch lines: 41, 68, 75, 94-95, 108, 113, 126-127, 130, 136, 138, 160, 168, 181.

### `packages/techstack/src/adapters/elixir.ts`

- Coverage: lines 97.67%, statements 93.87%, functions 100%, branches 86.11%.
- Add tests in: `packages/techstack/tests/adapters/elixir.test.ts`.
- Uncovered statement lines: 44, 80, 102.
- Uncovered functions: none reported.
- Uncovered branch lines: 44, 46, 102, 110, 130.

### `packages/kanban/src/manager/dependencies.ts`

- Coverage: lines 97.72%, statements 91.76%, functions 91.17%, branches 72.28%.
- Add tests in: `packages/kanban/tests/manager/dependencies.test.ts`.
- Uncovered statement lines: 73, 82, 129, 174, 228, 256-258, 260, 269, 272-273, 277, 288.
- Uncovered functions: `(anonymous_12)` (line 174), `(anonymous_24)` (line 272), `(anonymous_25)` (line 273).
- Uncovered branch lines: 73, 77, 82, 97, 99-100, 102-103, 105-106, 115-117, 119-120, 129, 140, 157-158, 172, 183-185, 187-188, 190-191, 217-218, 227, 242, 256-261, 269, 272-273, 275, 288, 295, 301.

### `packages/plugins/src/token-throttle/index.ts`

- Coverage: lines 97.72%, statements 95.95%, functions 94.44%, branches 88.46%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 151, 177, 185-186.
- Uncovered functions: `onAbort` (line 184).
- Uncovered branch lines: 151, 177, 272, 291.

### `packages/plugins/src/loop-breaker/index.ts`

- Coverage: lines 97.79%, statements 93.84%, functions 100%, branches 87.12%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 214, 219, 244, 278, 285-286, 449, 503, 506, 545, 547.
- Uncovered functions: none reported.
- Uncovered branch lines: 156, 219, 244, 278, 283, 285, 414, 448, 503-504, 506, 515, 545-547.

### `packages/plugins/src/llm-cache/index.ts`

- Coverage: lines 97.82%, statements 95.83%, functions 91.66%, branches 83.54%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 163, 175, 209, 218.
- Uncovered functions: `(anonymous_3)` (line 175).
- Uncovered branch lines: 163, 167-168, 173, 175, 208, 218, 309, 321-322, 429.

### `packages/plugins/src/test-generator/index.ts`

- Coverage: lines 97.84%, statements 94.77%, functions 100%, branches 81.05%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 104, 108-109, 182, 277, 393, 405-406.
- Uncovered functions: none reported.
- Uncovered branch lines: 92-94, 104, 108-109, 143, 151, 167, 181-183, 225, 241, 262, 277, 392, 477.

### `packages/plugins/src/semver-bump/index.ts`

- Coverage: lines 97.89%, statements 97.68%, functions 96.66%, branches 93.66%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 119, 405, 413, 464, 592, 649.
- Uncovered functions: `(anonymous_20)` (line 464).
- Uncovered branch lines: 151, 375, 412, 500, 588, 591, 643, 648, 727.

### `packages/plugins/src/test-coverage-gate/index.ts`

- Coverage: lines 97.89%, statements 97.05%, functions 100%, branches 84.12%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 162, 301, 315.
- Uncovered functions: none reported.
- Uncovered branch lines: 136, 162, 244, 251, 277, 295, 300, 308, 360, 391.

### `packages/tools/src/languages/detect.ts`

- Coverage: lines 97.93%, statements 93.56%, functions 100%, branches 86.13%.
- Add tests in: `packages/tools/tests/danger-detect.test.ts`, `packages/tools/tests/languages-detect.test.ts`.
- Uncovered statement lines: 105-106, 112, 123, 133, 214, 228, 289, 338, 348, 374.
- Uncovered functions: none reported.
- Uncovered branch lines: 59, 104, 123, 133, 190, 214, 223, 225-228, 279, 289, 338, 348, 357, 374, 381, 389.

### `packages/plugins/src/path-guard/index.ts`

- Coverage: lines 97.95%, statements 95.41%, functions 93.75%, branches 83.54%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 128, 265, 275, 277, 303.
- Uncovered functions: `execute` (line 302).
- Uncovered branch lines: 127, 162, 260-261, 264-265, 273-275, 277-278, 350.

### `packages/techstack/src/adapters/ruby.ts`

- Coverage: lines 98.03%, statements 93.75%, functions 100%, branches 88.67%.
- Add tests in: `packages/techstack/tests/adapters/ruby.test.ts`.
- Uncovered statement lines: 63, 89, 111.
- Uncovered functions: none reported.
- Uncovered branch lines: 44, 63, 66-67, 111.

### `packages/techstack/src/adapters/dotnet.ts`

- Coverage: lines 98.11%, statements 94.91%, functions 100%, branches 82.35%.
- Add tests in: `packages/techstack/tests/adapters/dotnet.test.ts`.
- Uncovered statement lines: 53, 123, 144.
- Uncovered functions: none reported.
- Uncovered branch lines: 49, 53, 75, 79, 82, 144.

### `packages/tools/src/codebase-index/refs-extractor.ts`

- Coverage: lines 98.14%, statements 96.61%, functions 100%, branches 80.95%.
- Add tests in: `packages/tools/tests/codebase-index-refs-extractor.test.ts`.
- Uncovered statement lines: 164, 172.
- Uncovered functions: none reported.
- Uncovered branch lines: 110, 164, 167.

### `packages/tools/src/codebase-index/background-indexer.ts`

- Coverage: lines 98.16%, statements 95.52%, functions 100%, branches 80.61%.
- Add tests in: `packages/tools/tests/background-indexer-worker.test.ts`, `packages/tools/tests/background-indexer.test.ts`.
- Uncovered statement lines: 212, 220, 225, 373, 437, 477, 514, 631, 634, 688.
- Uncovered functions: none reported.
- Uncovered branch lines: 210-211, 220, 225, 244, 292, 345, 372, 380, 406, 409, 437, 477, 510, 560, 603, 634.

### `packages/plugins/src/file-watcher/index.ts`

- Coverage: lines 98.18%, statements 95.83%, functions 95%, branches 89.7%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 27, 31-32, 213, 466.
- Uncovered functions: `(anonymous_19)` (line 465).
- Uncovered branch lines: 27, 31-32, 193, 205, 210, 215.

### `packages/tools/src/codebase-index/bm25.ts`

- Coverage: lines 98.18%, statements 93.93%, functions 100%, branches 71.42%.
- Add tests in: `packages/tools/tests/codebase-index/bm25.test.ts`.
- Uncovered statement lines: 86, 117, 141, 153.
- Uncovered functions: none reported.
- Uncovered branch lines: 86, 116-117, 133, 141, 145, 150, 153.

### `packages/providers/src/cache-breakpoint-cap.ts`

- Coverage: lines 98.21%, statements 92.4%, functions 100%, branches 86%.
- Add tests in: `packages/providers/tests/cache-breakpoint-cap.test.ts`.
- Uncovered statement lines: 40, 44, 68, 118, 122, 132.
- Uncovered functions: none reported.
- Uncovered branch lines: 35, 40, 68, 82, 118, 122, 132.

### `packages/plugins/src/runtime/local-bin.ts`

- Coverage: lines 98.3%, statements 95.31%, functions 100%, branches 83.05%.
- Add tests in: `packages/plugins/tests/runtime-local-bin.test.ts`.
- Uncovered statement lines: 128, 175, 218.
- Uncovered functions: none reported.
- Uncovered branch lines: 124, 127-128, 175, 210, 230-231, 236.

### `packages/plugins/src/release-notes-generator/index.ts`

- Coverage: lines 98.36%, statements 97.1%, functions 100%, branches 91.46%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 110, 152, 259-260.
- Uncovered functions: none reported.
- Uncovered branch lines: 109, 170, 193, 259-260, 403, 445.

### `packages/plugins/src/model-router/index.ts`

- Coverage: lines 98.57%, statements 98.7%, functions 100%, branches 95.08%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 132.
- Uncovered functions: none reported.
- Uncovered branch lines: 131, 238, 243.

### `packages/tools/src/process-registry.ts`

- Coverage: lines 98.61%, statements 98.17%, functions 100%, branches 93%.
- Add tests in: `packages/tools/tests/process-registry-killtree.test.ts`, `packages/tools/tests/process-registry-posix.test.ts`, `packages/tools/tests/process-registry.test.ts`.
- Uncovered statement lines: 342, 434, 559.
- Uncovered functions: none reported.
- Uncovered branch lines: 121, 331, 341, 434, 493, 528, 558.

### `packages/tools/src/_danger-detect.ts`

- Coverage: lines 98.71%, statements 98.13%, functions 100%, branches 95.83%.
- Add tests in: `packages/tools/tests/_danger-detect.test.ts`.
- Uncovered statement lines: 200.
- Uncovered functions: none reported.
- Uncovered branch lines: 199-200, 383, 392.

### `packages/tools/src/read.ts`

- Coverage: lines 98.73%, statements 97.59%, functions 100%, branches 93.87%.
- Add tests in: `packages/tools/tests/read.test.ts`.
- Uncovered statement lines: 260, 275.
- Uncovered functions: none reported.
- Uncovered branch lines: 260, 271, 296.

### `packages/kanban/src/manager/decomposition.ts`

- Coverage: lines 98.75%, statements 92.78%, functions 100%, branches 85.36%.
- Add tests in: `packages/kanban/tests/decomposition.test.ts`.
- Uncovered statement lines: 102, 125, 144, 193, 224, 235, 242.
- Uncovered functions: none reported.
- Uncovered branch lines: 69, 74, 96, 102, 125-126, 144, 157, 192, 224, 235, 242.

### `packages/tools/src/edit.ts`

- Coverage: lines 98.8%, statements 96.66%, functions 80%, branches 96.1%.
- Add tests in: `packages/tools/tests/edit-match.test.ts`, `packages/tools/tests/edit.test.ts`.
- Uncovered statement lines: 166, 181, 314.
- Uncovered functions: `(anonymous_4)` (line 314).
- Uncovered branch lines: 138, 165, 181.

### `packages/providers/src/error-parse.ts`

- Coverage: lines 98.85%, statements 94.49%, functions 100%, branches 80.18%.
- Add tests in: `packages/providers/tests/error-parse.test.ts`.
- Uncovered statement lines: 31, 92, 109, 113, 185.
- Uncovered functions: none reported.
- Uncovered branch lines: 31, 59, 92, 102, 109, 113, 163-164, 171-172, 181-183, 185, 188, 236, 243.

### `packages/plugins/src/template-engine/index.ts`

- Coverage: lines 98.98%, statements 99.07%, functions 100%, branches 97.05%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 128.
- Uncovered functions: none reported.
- Uncovered branch lines: 94, 127.

### `packages/kanban/src/manager/task-graph-bridge.ts`

- Coverage: lines 99.08%, statements 91.93%, functions 100%, branches 82.82%.
- Add tests in: `packages/kanban/tests/manager/task-graph-bridge.test.ts`.
- Uncovered statement lines: 81, 85, 89, 126-128, 154, 156, 231, 243.
- Uncovered functions: none reported.
- Uncovered branch lines: 76, 81, 85, 88-89, 118-119, 125, 127-128, 151, 154-156, 231, 243, 257.

### `packages/kanban/src/manager/lifecycle.ts`

- Coverage: lines 99.09%, statements 98.46%, functions 100%, branches 96.85%.
- Add tests in: `packages/kanban/tests/lifecycle.test.ts`.
- Uncovered statement lines: 174, 213.
- Uncovered functions: none reported.
- Uncovered branch lines: 173, 213, 225, 228.

### `packages/plugins/src/auto-doc/index.ts`

- Coverage: lines 99.31%, statements 98.05%, functions 100%, branches 90.47%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 23, 195, 224.
- Uncovered functions: none reported.
- Uncovered branch lines: 23, 195-196, 222-223, 230, 237, 239, 254, 507.

### `packages/plugins/src/git-autocommit/index.ts`

- Coverage: lines 99.43%, statements 98.42%, functions 100%, branches 90.9%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 159, 270, 502.
- Uncovered functions: none reported.
- Uncovered branch lines: 85, 148, 154, 156, 270, 298, 303-304, 316, 502, 539, 690.

### `packages/tools/src/_spawn-stream.ts`

- Coverage: lines 100%, statements 100%, functions 100%, branches 89.77%.
- Add tests in: `packages/tools/tests/_spawn-stream.test.ts`.
- Uncovered statement lines: none reported.
- Uncovered functions: none reported.
- Uncovered branch lines: 82, 158, 191, 193, 222, 242, 282.

### `packages/tools/src/replace.ts`

- Coverage: lines 100%, statements 93.18%, functions 78.94%, branches 82.85%.
- Add tests in: `packages/tools/tests/replace-rg.test.ts`, `packages/tools/tests/replace.test.ts`.
- Uncovered statement lines: 118, 134, 147, 150-151, 197, 285, 334, 341.
- Uncovered functions: `(anonymous_1)` (line 118), `(anonymous_3)` (line 150), `(anonymous_4)` (line 197), `(anonymous_11)` (line 285).
- Uncovered branch lines: 109, 129, 134, 147, 151, 198, 215, 334, 341, 350, 352.

### `packages/plugins/src/license-audit-gate/index.ts`

- Coverage: lines 100%, statements 95.62%, functions 100%, branches 85.33%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 105, 138, 140, 142, 254, 283.
- Uncovered functions: none reported.
- Uncovered branch lines: 105, 114, 136, 138, 140, 142, 147, 254, 256, 283, 377.

### `packages/plugins/src/error-lens/index.ts`

- Coverage: lines 100%, statements 98.18%, functions 100%, branches 77.9%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 272, 282.
- Uncovered functions: none reported.
- Uncovered branch lines: 107-108, 175, 192, 272-273, 282, 296, 299, 314-315, 330-331, 336, 367.

### `packages/techstack/src/research/researcher.ts`

- Coverage: lines 100%, statements 93.27%, functions 96%, branches 73.75%.
- Add tests in: `packages/techstack/tests/research/researcher.test.ts`.
- Uncovered statement lines: 184, 187-189, 272, 314, 341, 359.
- Uncovered functions: `(anonymous_20)` (line 341).
- Uncovered branch lines: 145-146, 181, 183-185, 187-189, 203, 272, 284, 287, 299, 314, 341, 359, 363.

### `packages/tools/src/codebase-index/json-parser.ts`

- Coverage: lines 100%, statements 100%, functions 100%, branches 82.85%.
- Add tests in: `packages/tools/tests/codebase-index-json-parser.test.ts`.
- Uncovered statement lines: none reported.
- Uncovered functions: none reported.
- Uncovered branch lines: 59, 99, 101, 170, 188, 190, 196, 224, 241, 268, 286.

### `packages/plugins/src/cron/index.ts`

- Coverage: lines 100%, statements 100%, functions 100%, branches 97.29%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: none reported.
- Uncovered functions: none reported.
- Uncovered branch lines: 380.

### `packages/plugins/src/token-budget/index.ts`

- Coverage: lines 100%, statements 98.97%, functions 100%, branches 91.04%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 97.
- Uncovered functions: none reported.
- Uncovered branch lines: 97, 109, 191-192, 200, 383.

### `packages/tools/src/git.ts`

- Coverage: lines 100%, statements 99.03%, functions 100%, branches 90.97%.
- Add tests in: `packages/tools/tests/git-spawn.test.ts`, `packages/tools/tests/git.test.ts`.
- Uncovered statement lines: 281.
- Uncovered functions: none reported.
- Uncovered branch lines: 213, 275, 281, 308, 313, 325-326, 329, 337, 358-359, 391.

### `packages/tools/src/logs.ts`

- Coverage: lines 100%, statements 99%, functions 100%, branches 75%.
- Add tests in: `packages/tools/tests/logs-docker.test.ts`, `packages/tools/tests/logs.test.ts`.
- Uncovered statement lines: 154.
- Uncovered functions: none reported.
- Uncovered branch lines: 82, 120, 154, 173, 176, 227, 252, 257, 276, 288-290, 300-301.

### `packages/tools/src/codebase-index/ts-parser.ts`

- Coverage: lines 100%, statements 100%, functions 100%, branches 88.09%.
- Add tests in: `packages/tools/tests/codebase-index-ts-parser.test.ts`.
- Uncovered statement lines: none reported.
- Uncovered functions: none reported.
- Uncovered branch lines: 37, 83, 97, 105, 204, 209, 213, 217, 238, 246.

### `packages/plugins/src/context-pins/index.ts`

- Coverage: lines 100%, statements 96.8%, functions 100%, branches 87.34%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 87, 256, 292.
- Uncovered functions: none reported.
- Uncovered branch lines: 87, 107-108, 132-133, 224, 255-256, 292-293.

### `packages/plugins/src/todo-listener/index.ts`

- Coverage: lines 100%, statements 100%, functions 100%, branches 82.6%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: none reported.
- Uncovered functions: none reported.
- Uncovered branch lines: 101, 119, 203-204, 252, 265, 296, 338.

### `packages/tools/src/test.ts`

- Coverage: lines 100%, statements 93.47%, functions 100%, branches 85.54%.
- Add tests in: `packages/tools/tests/test.test.ts`.
- Uncovered statement lines: 72, 76, 173, 179, 220-221.
- Uncovered functions: none reported.
- Uncovered branch lines: 72, 76, 80, 96, 101, 153, 173, 179, 220-221, 244.

### `packages/tools/src/_output-spool.ts`

- Coverage: lines 100%, statements 98.7%, functions 100%, branches 92.1%.
- Add tests in: `packages/tools/tests/_output-spool.test.ts`.
- Uncovered statement lines: 122.
- Uncovered functions: none reported.
- Uncovered branch lines: 109-110, 122.

### `packages/tools/src/codebase-index/yaml-parser.ts`

- Coverage: lines 100%, statements 100%, functions 100%, branches 71.42%.
- Add tests in: `packages/tools/tests/codebase-index-yaml-parser.test.ts`.
- Uncovered statement lines: none reported.
- Uncovered functions: none reported.
- Uncovered branch lines: 33, 52, 54, 72, 74, 93, 97, 99, 102, 109-110, 121, 123, 143, 145.

### `packages/tools/src/_fetch-guard.ts`

- Coverage: lines 100%, statements 98.57%, functions 100%, branches 93.65%.
- Add tests in: `packages/tools/tests/_fetch-guard.test.ts`.
- Uncovered statement lines: 207.
- Uncovered functions: none reported.
- Uncovered branch lines: 58, 124, 207, 245.

### `packages/tools/src/tree.ts`

- Coverage: lines 100%, statements 98.76%, functions 91.66%, branches 98.36%.
- Add tests in: `packages/tools/tests/tree.test.ts`.
- Uncovered statement lines: 153.
- Uncovered functions: `(anonymous_5)` (line 153).
- Uncovered branch lines: 155.

### `packages/tools/src/diff.ts`

- Coverage: lines 100%, statements 100%, functions 100%, branches 97.36%.
- Add tests in: `packages/tools/tests/diff.test.ts`, `packages/tools/tests/tool-diff.test.ts`.
- Uncovered statement lines: none reported.
- Uncovered functions: none reported.
- Uncovered branch lines: 169.

### `packages/tools/src/install.ts`

- Coverage: lines 100%, statements 100%, functions 100%, branches 89.47%.
- Add tests in: `packages/tools/tests/install.test.ts`.
- Uncovered statement lines: none reported.
- Uncovered functions: none reported.
- Uncovered branch lines: 122, 125, 127, 204, 249, 259-260.

### `packages/tools/src/outdated.ts`

- Coverage: lines 100%, statements 98.27%, functions 88.88%, branches 64.51%.
- Add tests in: `packages/tools/tests/outdated.test.ts`.
- Uncovered statement lines: 121.
- Uncovered functions: `(anonymous_1)` (line 121).
- Uncovered branch lines: 83, 93, 120, 123-125, 130, 134-135, 179, 182, 185, 219-222.

### `packages/providers/src/capabilities.ts`

- Coverage: lines 100%, statements 100%, functions 100%, branches 97.77%.
- Add tests in: `packages/providers/tests/capabilities.test.ts`, `packages/providers/tests/family-capabilities.test.ts`, `packages/providers/tests/with-catalog-capabilities.test.ts`.
- Uncovered statement lines: none reported.
- Uncovered functions: none reported.
- Uncovered branch lines: 30, 85.

### `packages/plugins/src/injection-shield/index.ts`

- Coverage: lines 100%, statements 98.14%, functions 100%, branches 83.78%.
- Add tests in: `packages/plugins/tests/index-exports.test.ts`.
- Uncovered statement lines: 221.
- Uncovered functions: none reported.
- Uncovered branch lines: 94-95, 221, 229, 235, 241.

### `packages/tools/src/tool-help.ts`

- Coverage: lines 100%, statements 100%, functions 100%, branches 97.22%.
- Add tests in: `packages/tools/tests/tool-help.test.ts`.
- Uncovered statement lines: none reported.
- Uncovered functions: none reported.
- Uncovered branch lines: 94.

### `packages/providers/src/_tool-input.ts`

- Coverage: lines 100%, statements 98.18%, functions 100%, branches 90.47%.
- Add tests in: `packages/providers/tests/_tool-input.test.ts`.
- Uncovered statement lines: 79.
- Uncovered functions: none reported.
- Uncovered branch lines: 58, 68, 79, 121, 123, 137.

### `packages/tools/src/todo.ts`

- Coverage: lines 100%, statements 100%, functions 100%, branches 97.5%.
- Add tests in: `packages/tools/tests/todo.test.ts`.
- Uncovered statement lines: none reported.
- Uncovered functions: none reported.
- Uncovered branch lines: 90.

### `packages/tools/src/document.ts`

- Coverage: lines 100%, statements 100%, functions 100%, branches 78.57%.
- Add tests in: `packages/tools/tests/document.test.ts`.
- Uncovered statement lines: none reported.
- Uncovered functions: none reported.
- Uncovered branch lines: 70, 91, 98, 102, 117, 121, 157, 167, 193.

### `packages/plugins/src/notify-hub/webhook-channel.ts`

- Coverage: lines 100%, statements 100%, functions 100%, branches 95.83%.
- Add tests in: `packages/plugins/tests/webhook-channel.test.ts`.
- Uncovered statement lines: none reported.
- Uncovered functions: none reported.
- Uncovered branch lines: 139.

### `packages/kanban/src/manager/serialization.ts`

- Coverage: lines 100%, statements 97.95%, functions 100%, branches 91.11%.
- Add tests in: `packages/kanban/tests/manager/serialization.test.ts`.
- Uncovered statement lines: 68.
- Uncovered functions: none reported.
- Uncovered branch lines: 34, 68, 79, 101.

### `packages/providers/src/auto-discover.ts`

- Coverage: lines 100%, statements 96.07%, functions 85.71%, branches 80.95%.
- Add tests in: `packages/providers/tests/auto-discover.test.ts`.
- Uncovered statement lines: 126, 144.
- Uncovered functions: `(anonymous_6)` (line 126).
- Uncovered branch lines: 67, 93, 95, 101-102, 121, 123, 126, 140, 143-144, 147-148, 163.

### `packages/tools/src/audit.ts`

- Coverage: lines 100%, statements 100%, functions 100%, branches 90.9%.
- Add tests in: `packages/tools/tests/audit.test.ts`.
- Uncovered statement lines: none reported.
- Uncovered functions: none reported.
- Uncovered branch lines: 82, 93, 97-98.

### `packages/techstack/src/adapters/swift.ts`

- Coverage: lines 100%, statements 95.83%, functions 100%, branches 60.71%.
- Add tests in: `packages/techstack/tests/adapters/gradle-swift.test.ts`.
- Uncovered statement lines: 31, 72.
- Uncovered functions: none reported.
- Uncovered branch lines: 31, 35, 55-58, 71-72, 74-75, 77, 85, 91, 98-99, 105.

### `packages/kanban/src/atomicity/criteria.ts`

- Coverage: lines 100%, statements 97.5%, functions 100%, branches 95.23%.
- Add tests in: `packages/kanban/tests/atomicity/criteria.test.ts`.
- Uncovered statement lines: 76.
- Uncovered functions: none reported.
- Uncovered branch lines: 76, 151.

### `packages/tools/src/format.ts`

- Coverage: lines 100%, statements 100%, functions 100%, branches 94.28%.
- Add tests in: `packages/tools/tests/format.test.ts`.
- Uncovered statement lines: none reported.
- Uncovered functions: none reported.
- Uncovered branch lines: 71, 84.

### `packages/tools/src/typecheck.ts`

- Coverage: lines 100%, statements 100%, functions 100%, branches 93.93%.
- Add tests in: `packages/tools/tests/typecheck.test.ts`.
- Uncovered statement lines: none reported.
- Uncovered functions: none reported.
- Uncovered branch lines: 85, 142.

### `packages/tools/src/codebase-index/gitignore.ts`

- Coverage: lines 100%, statements 97.22%, functions 100%, branches 95.45%.
- Add tests in: `packages/tools/tests/gitignore.test.ts`.
- Uncovered statement lines: 58.
- Uncovered functions: none reported.
- Uncovered branch lines: 58.

### `packages/techstack/src/research/triage.ts`

- Coverage: lines 100%, statements 100%, functions 100%, branches 84.84%.
- Add tests in: `packages/techstack/tests/research/triage.test.ts`.
- Uncovered statement lines: none reported.
- Uncovered functions: none reported.
- Uncovered branch lines: 35, 47, 88.

### `packages/providers/src/stream-debug-state.ts`

- Coverage: lines 100%, statements 100%, functions 100%, branches 90%.
- Add tests in: `packages/providers/tests/stream-debug-state.test.ts`.
- Uncovered statement lines: none reported.
- Uncovered functions: none reported.
- Uncovered branch lines: 41, 51.

### `packages/techstack/src/adapters/parse-utils.ts`

- Coverage: lines 100%, statements 81.81%, functions 100%, branches 78.12%.
- Add tests in: `packages/techstack/tests/adapters/parse-utils.test.ts`.
- Uncovered statement lines: 13-14, 19, 32.
- Uncovered functions: none reported.
- Uncovered branch lines: 13-14, 19, 32, 35, 44.

### `packages/techstack/src/service/report-generator.ts`

- Coverage: lines 100%, statements 100%, functions 100%, branches 94.73%.
- Add tests in: `packages/techstack/tests/service/report-generator.test.ts`.
- Uncovered statement lines: none reported.
- Uncovered functions: none reported.
- Uncovered branch lines: 29.

### `packages/plugins/src/runtime/llm.ts`

- Coverage: lines 100%, statements 100%, functions 100%, branches 89.47%.
- Add tests in: `packages/plugins/tests/llm-cache.test.ts`.
- Uncovered statement lines: none reported.
- Uncovered functions: none reported.
- Uncovered branch lines: 82, 87.

### `packages/kanban/src/atomicity/assess.ts`

- Coverage: lines 100%, statements 100%, functions 100%, branches 94.11%.
- Add tests in: `packages/kanban/tests/atomicity/assess.test.ts`.
- Uncovered statement lines: none reported.
- Uncovered functions: none reported.
- Uncovered branch lines: 77.

### `packages/tools/src/codebase-index/worker.ts`

- Coverage: lines 100%, statements 95.65%, functions 100%, branches 91.66%.
- Add tests in: `packages/tools/tests/background-indexer-worker.test.ts`, `packages/tools/tests/codebase-index-worker.test.ts`.
- Uncovered statement lines: 26.
- Uncovered functions: none reported.
- Uncovered branch lines: 26.

### `packages/tools/src/_session-shell.ts`

- Coverage: lines 100%, statements 96.77%, functions 80%, branches 88.23%.
- Add tests in: `packages/tools/tests/_session-shell.test.ts`.
- Uncovered statement lines: 74.
- Uncovered functions: `(anonymous_2)` (line 74).
- Uncovered branch lines: 74, 100-101, 109.

### `packages/providers/src/github-copilot-token.ts`

- Coverage: lines 100%, statements 100%, functions 100%, branches 94.44%.
- Add tests in: `packages/providers/tests/github-copilot-token.test.ts`.
- Uncovered statement lines: none reported.
- Uncovered functions: none reported.
- Uncovered branch lines: 60.

### `packages/tools/src/_regex.ts`

- Coverage: lines 100%, statements 100%, functions 100%, branches 91.66%.
- Add tests in: `packages/tools/tests/_regex.test.ts`.
- Uncovered statement lines: none reported.
- Uncovered functions: none reported.
- Uncovered branch lines: 74.

### `packages/kanban/src/manager/atomicity.ts`

- Coverage: lines 100%, statements 92.85%, functions 100%, branches 72.72%.
- Add tests in: `packages/kanban/tests/atomicity.test.ts`.
- Uncovered statement lines: 39.
- Uncovered functions: none reported.
- Uncovered branch lines: 39, 62, 65.

### `packages/security-scanner/src/redaction-diagnostic.ts`

- Coverage: lines 100%, statements 92.3%, functions 100%, branches 91.66%.
- Add tests in: `packages/security-scanner/tests/redaction-diagnostic.test.ts`.
- Uncovered statement lines: 29.
- Uncovered functions: none reported.
- Uncovered branch lines: 29.

### `packages/techstack/src/adapters/paths.ts`

- Coverage: lines 100%, statements 100%, functions 100%, branches 75%.
- Add tests in: `packages/techstack/tests/adapters/paths.test.ts`.
- Uncovered statement lines: none reported.
- Uncovered functions: none reported.
- Uncovered branch lines: 31.

### `packages/kanban/src/manager/board-health.ts`

- Coverage: lines 100%, statements 100%, functions 100%, branches 66.66%.
- Add tests in: `packages/kanban/tests/manager/board-health.test.ts`.
- Uncovered statement lines: none reported.
- Uncovered functions: none reported.
- Uncovered branch lines: 12, 18.

### `packages/tools/src/kanban-evidence-bridge.ts`

- Coverage: lines 100%, statements 100%, functions 100%, branches 50%.
- Add tests in: `packages/tools/tests/kanban-evidence-bridge.test.ts`.
- Uncovered statement lines: none reported.
- Uncovered functions: none reported.
- Uncovered branch lines: 40.

### `packages/techstack/src/sbom.ts`

- Coverage: lines 100%, statements 100%, functions 100%, branches 58.33%.
- Add tests in: `packages/techstack/tests/snapshot-diff-sbom.test.ts`.
- Uncovered statement lines: none reported.
- Uncovered functions: none reported.
- Uncovered branch lines: 47-48, 85-86, 88.

## Static no-direct-test candidates in incomplete packages (389)

These are conservative source-to-test path matches, not V8 proof of zero execution; integration tests may cover them indirectly.

- `packages/core/src/coordination/agents/project-agent-identity.ts` (2483 LOC) → add `packages/core/tests/coordination/agents/project-agent-identity.test.ts`.
- `packages/tui/src/components/history/utils.tsx` (2335 LOC) → add `packages/tui/tests/components/history/utils.test.ts`.
- `packages/cli/src/execution.ts` (2271 LOC) → add `packages/cli/tests/execution.test.ts`.
- `packages/cli/src/slash-commands/memory.ts` (1772 LOC) → add `packages/cli/tests/slash-commands/memory.test.ts`.
- `packages/tui/src/components/settings-picker.tsx` (1619 LOC) → add `packages/tui/tests/components/settings-picker.test.ts`.
- `packages/core/src/tools/fallback-manage-tools.ts` (1555 LOC) → add `packages/core/tests/tools/fallback-manage-tools.test.ts`.
- `packages/tui/src/app-state.ts` (1505 LOC) → add `packages/tui/tests/app-state.test.ts`.
- `packages/cli/src/hq-server/routes.ts` (1380 LOC) → add `packages/cli/tests/hq-server/routes.test.ts`.
- `packages/webui-server/src/server/kanban-routes.ts` (1327 LOC) → add `packages/webui-server/tests/server/kanban-routes.test.ts`.
- `packages/cli/src/subcommands/handlers/modeldiag.ts` (1181 LOC) → add `packages/cli/tests/subcommands/handlers/modeldiag.test.ts`.
- `packages/tui/src/components/history/code-block.tsx` (1133 LOC) → add `packages/tui/tests/components/history/code-block.test.ts`.
- `packages/tui/src/hooks/use-picker-keys.ts` (1033 LOC) → add `packages/tui/tests/hooks/use-picker-keys.test.ts`.
- `packages/core/src/coordination/mailbox-types.ts` (940 LOC) → add `packages/core/tests/coordination/mailbox-types.test.ts`.
- `packages/webui-server/src/server/start-webui.ts` (894 LOC) → add `packages/webui-server/tests/server/start-webui.test.ts`.
- `packages/cli/src/slash-commands/fix-classifier.ts` (694 LOC) → add `packages/cli/tests/slash-commands/fix-classifier.test.ts`.
- `packages/tui/src/app-key-handler.ts` (694 LOC) → add `packages/tui/tests/app-key-handler.test.ts`.
- `packages/tui/src/submit-controller.ts` (679 LOC) → add `packages/tui/tests/submit-controller.test.ts`.
- `packages/tui/src/app-props.ts` (677 LOC) → add `packages/tui/tests/app-props.test.ts`.
- `packages/webui-server/src/server/memory-handlers.ts` (675 LOC) → add `packages/webui-server/tests/server/memory-handlers.test.ts`.
- `packages/webui-server/src/server/goal-ws-handler.ts` (674 LOC) → add `packages/webui-server/tests/server/goal-ws-handler.test.ts`.
- `packages/webui-server/src/server/backend-services.ts` (651 LOC) → add `packages/webui-server/tests/server/backend-services.test.ts`.
- `packages/tui/src/hooks/use-director-fleet-bridge.ts` (636 LOC) → add `packages/tui/tests/hooks/use-director-fleet-bridge.test.ts`.
- `packages/webui-server/src/server/http-server/api-handlers.ts` (629 LOC) → add `packages/webui-server/tests/server/http-server/api-handlers.test.ts`.
- `packages/tui/src/app-view.tsx` (618 LOC) → add `packages/tui/tests/app-view.test.ts`.
- `packages/cli/src/slash-commands/command-context.ts` (590 LOC) → add `packages/cli/tests/slash-commands/command-context.test.ts`.
- `packages/webui-server/src/server/session-handlers.ts` (583 LOC) → add `packages/webui-server/tests/server/session-handlers.test.ts`.
- `packages/tui/src/hooks/use-tui-slash-commands.ts` (579 LOC) → add `packages/tui/tests/hooks/use-tui-slash-commands.test.ts`.
- `packages/core/src/coordination/index.ts` (564 LOC) → add `packages/core/tests/coordination/index.test.ts`.
- `packages/tui/src/reducers/settings-values.ts` (562 LOC) → add `packages/tui/tests/reducers/settings-values.test.ts`.
- `packages/webui-server/src/server/kanban-run-mirror.ts` (554 LOC) → add `packages/webui-server/tests/server/kanban-run-mirror.test.ts`.
- `packages/cli/src/config-doctor.ts` (533 LOC) → add `packages/cli/tests/config-doctor.test.ts`.
- `packages/webui-server/src/server/pre-context-services.ts` (503 LOC) → add `packages/webui-server/tests/server/pre-context-services.test.ts`.
- `packages/cli/src/wiring/fleet-command-handlers.ts` (494 LOC) → add `packages/cli/tests/wiring/fleet-command-handlers.test.ts`.
- `packages/core/src/tasking/task-tracker.ts` (482 LOC) → add `packages/core/tests/tasking/task-tracker.test.ts`.
- `packages/cli/src/hq-server/snapshot.ts` (479 LOC) → add `packages/cli/tests/hq-server/snapshot.test.ts`.
- `packages/core/src/coordination/mailbox-tool.ts` (463 LOC) → add `packages/core/tests/coordination/mailbox-tool.test.ts`.
- `packages/cli/src/wiring/brain-and-orchestration.ts` (455 LOC) → add `packages/cli/tests/wiring/brain-and-orchestration.test.ts`.
- `packages/webui-server/src/server/embedded-message-router.ts` (455 LOC) → add `packages/webui-server/tests/server/embedded-message-router.test.ts`.
- `packages/tui/src/hooks/use-auth-panel.ts` (425 LOC) → add `packages/tui/tests/hooks/use-auth-panel.test.ts`.
- `packages/cli/src/services/project-facts.ts` (418 LOC) → add `packages/cli/tests/services/project-facts.test.ts`.
- `packages/tui/src/reducers/panel-pickers.ts` (412 LOC) → add `packages/tui/tests/reducers/panel-pickers.test.ts`.
- `packages/core/src/defaults/index.ts` (406 LOC) → add `packages/core/tests/defaults/index.test.ts`.
- `packages/tui/src/app-status-region.tsx` (404 LOC) → add `packages/tui/tests/app-status-region.test.ts`.
- `packages/cli/src/auth-menu/auth-menu-audit.ts` (400 LOC) → add `packages/cli/tests/auth-menu/auth-menu-audit.test.ts`.
- `packages/webui-server/src/server/worktree-ws-handler.ts` (400 LOC) → add `packages/webui-server/tests/server/worktree-ws-handler.test.ts`.
- `packages/webui-server/src/server/kanban-dispatch.ts` (393 LOC) → add `packages/webui-server/tests/server/kanban-dispatch.test.ts`.
- `packages/cli/src/auth-menu/add-provider.ts` (391 LOC) → add `packages/cli/tests/auth-menu/add-provider.test.ts`.
- `packages/cli/src/subcommands/handlers/mailbox-serve.ts` (390 LOC) → add `packages/cli/tests/subcommands/handlers/mailbox-serve.test.ts`.
- `packages/webui-server/src/server/kanban-supervisor.ts` (390 LOC) → add `packages/webui-server/tests/server/kanban-supervisor.test.ts`.
- `packages/core/src/coordination/agents/phase3-wave2-meta.ts` (388 LOC) → add `packages/core/tests/coordination/agents/phase3-wave2-meta.test.ts`.
- `packages/webui-server/src/server/techstack-handlers.ts` (387 LOC) → add `packages/webui-server/tests/server/techstack-handlers.test.ts`.
- `packages/cli/src/wiring/lifecycle-plugins.ts` (378 LOC) → add `packages/cli/tests/wiring/lifecycle-plugins.test.ts`.
- `packages/webui-server/src/server/server-runtime.ts` (376 LOC) → add `packages/webui-server/tests/server/server-runtime.test.ts`.
- `packages/core/src/kernel/events/memory-events.ts` (365 LOC) → add `packages/core/tests/kernel/events/memory-events.test.ts`.
- `packages/cli/src/wiring/provider-runtime-setup.ts` (359 LOC) → add `packages/cli/tests/wiring/provider-runtime-setup.test.ts`.
- `packages/core/src/core/agent-tools.ts` (357 LOC) → add `packages/core/tests/core/agent-tools.test.ts`.
- `packages/tui/src/components/goal-kanban-panel.tsx` (355 LOC) → add `packages/tui/tests/components/goal-kanban-panel.test.ts`.
- `packages/webui-server/src/server/design-handlers.ts` (352 LOC) → add `packages/webui-server/tests/server/design-handlers.test.ts`.
- `packages/cli/src/boot/dispatch-webui.ts` (350 LOC) → add `packages/cli/tests/boot/dispatch-webui.test.ts`.
- `packages/cli/src/execute-deps.ts` (340 LOC) → add `packages/cli/tests/execute-deps.test.ts`.
- `packages/tui/src/hooks/use-core-tui-commands.ts` (340 LOC) → add `packages/tui/tests/hooks/use-core-tui-commands.test.ts`.
- `packages/tui/src/overlay-key-router.ts` (340 LOC) → add `packages/tui/tests/overlay-key-router.test.ts`.
- `packages/webui-server/src/server/message-dispatcher.ts` (340 LOC) → add `packages/webui-server/tests/server/message-dispatcher.test.ts`.
- `packages/tui/src/hooks/use-interrupt-ladder.ts` (337 LOC) → add `packages/tui/tests/hooks/use-interrupt-ladder.test.ts`.
- `packages/tui/src/submit-prompt-refinement.ts` (335 LOC) → add `packages/tui/tests/submit-prompt-refinement.test.ts`.
- `packages/core/src/coordination/agents/role-skills.ts` (330 LOC) → add `packages/core/tests/coordination/agents/role-skills.test.ts`.
- `packages/tui/src/hooks/use-panel-controllers.ts` (330 LOC) → add `packages/tui/tests/hooks/use-panel-controllers.test.ts`.
- `packages/tui/src/hooks/use-tui-event-bridge.ts` (328 LOC) → add `packages/tui/tests/hooks/use-tui-event-bridge.test.ts`.
- `packages/webui-server/src/server/handlers/worklist-handlers.ts` (327 LOC) → add `packages/webui-server/tests/server/handlers/worklist-handlers.test.ts`.
- `packages/tui/src/reducers/dialogs.ts` (325 LOC) → add `packages/tui/tests/reducers/dialogs.test.ts`.
- `packages/webui-server/src/server/frontend-static-serve.ts` (323 LOC) → add `packages/webui-server/tests/server/frontend-static-serve.test.ts`.
- `packages/core/src/coordination/fleet-bus.ts` (322 LOC) → add `packages/core/tests/coordination/fleet-bus.test.ts`.
- `packages/core/src/goal/types.ts` (322 LOC) → add `packages/core/tests/goal/types.test.ts`.
- `packages/core/src/kernel/events/agent-events.ts` (320 LOC) → add `packages/core/tests/kernel/events/agent-events.test.ts`.
- `packages/tui/src/hooks/use-app-picker-keys.ts` (318 LOC) → add `packages/tui/tests/hooks/use-app-picker-keys.test.ts`.
- `packages/cli/src/services/mcp-management.ts` (313 LOC) → add `packages/cli/tests/services/mcp-management.test.ts`.
- `packages/webui-server/src/server/sdd-wizard-wiring.ts` (310 LOC) → add `packages/webui-server/tests/server/sdd-wizard-wiring.test.ts`.
- `packages/core/src/coordination/agents/phase4-verify.ts` (306 LOC) → add `packages/core/tests/coordination/agents/phase4-verify.test.ts`.
- `packages/core/src/storage/goal-kanban.ts` (305 LOC) → add `packages/core/tests/storage/goal-kanban.test.ts`.
- `packages/tui/src/reducers/workspace-panels.ts` (305 LOC) → add `packages/tui/tests/reducers/workspace-panels.test.ts`.
- `packages/core/src/mailbox-attach.ts` (295 LOC) → add `packages/core/tests/mailbox-attach.test.ts`.
- `packages/core/src/security/directory-policy-schema.ts` (288 LOC) → add `packages/core/tests/security/directory-policy-schema.test.ts`.
- `packages/core/src/kernel/events/brain-events.ts` (287 LOC) → add `packages/core/tests/kernel/events/brain-events.test.ts`.
- `packages/tui/src/components/cron-jobs.tsx` (287 LOC) → add `packages/tui/tests/components/cron-jobs.test.ts`.
- `packages/core/src/coordination/agents/phase3-wave1-platform.ts` (279 LOC) → add `packages/core/tests/coordination/agents/phase3-wave1-platform.test.ts`.
- `packages/core/src/coordination/agents/phase8-wave3-products.ts` (279 LOC) → add `packages/core/tests/coordination/agents/phase8-wave3-products.test.ts`.
- `packages/tui/src/brain-panel-model.ts` (276 LOC) → add `packages/tui/tests/brain-panel-model.test.ts`.
- `packages/tui/src/hooks/use-statusbar-view-model.ts` (276 LOC) → add `packages/tui/tests/hooks/use-statusbar-view-model.test.ts`.
- `packages/tui/src/components/plan-panel.tsx` (275 LOC) → add `packages/tui/tests/components/plan-panel.test.ts`.
- `packages/core/src/coordination/director/director-budget-policy.ts` (274 LOC) → add `packages/core/tests/coordination/director/director-budget-policy.test.ts`.
- `packages/core/src/coordination/agents/phase9-wave4-platform-meta.ts` (273 LOC) → add `packages/core/tests/coordination/agents/phase9-wave4-platform-meta.test.ts`.
- `packages/cli/src/wiring/session-command-handlers.ts` (270 LOC) → add `packages/cli/tests/wiring/session-command-handlers.test.ts`.
- `packages/cli/src/boot/short-circuit-hq.ts` (261 LOC) → add `packages/cli/tests/boot/short-circuit-hq.test.ts`.
- `packages/cli/src/wiring/sdd-handlers.ts` (254 LOC) → add `packages/cli/tests/wiring/sdd-handlers.test.ts`.
- `packages/webui-server/src/server/embedded-host-adapters.ts` (254 LOC) → add `packages/webui-server/tests/server/embedded-host-adapters.test.ts`.
- `packages/cli/src/pre-launch/launch-prompts.ts` (252 LOC) → add `packages/cli/tests/pre-launch/launch-prompts.test.ts`.
- `packages/cli/src/services/sdd/task-manager.ts` (252 LOC) → add `packages/cli/tests/services/sdd/task-manager.test.ts`.
- `packages/cli/src/slash-commands/telegram-settings.ts` (252 LOC) → add `packages/cli/tests/slash-commands/telegram-settings.test.ts`.
- `packages/webui-server/src/server/project-handlers.ts` (251 LOC) → add `packages/webui-server/tests/server/project-handlers.test.ts`.
- `packages/cli/src/boot/tui-session-resume.ts` (249 LOC) → add `packages/cli/tests/boot/tui-session-resume.test.ts`.
- `packages/core/src/core/conversation-state.ts` (247 LOC) → add `packages/core/tests/core/conversation-state.test.ts`.
- `packages/cli/src/wiring/hq-telemetry.ts` (246 LOC) → add `packages/cli/tests/wiring/hq-telemetry.test.ts`.
- `packages/tui/src/components/goal-panel.tsx` (244 LOC) → add `packages/tui/tests/components/goal-panel.test.ts`.
- `packages/cli/src/auth-menu/loopback-server.ts` (243 LOC) → add `packages/cli/tests/auth-menu/loopback-server.test.ts`.
- `packages/core/src/storage/index.ts` (241 LOC) → add `packages/core/tests/storage/index.test.ts`.
- `packages/cli/src/auth-menu/provider-menu.ts` (240 LOC) → add `packages/cli/tests/auth-menu/provider-menu.test.ts`.
- `packages/webui-server/src/server/model-operations.ts` (239 LOC) → add `packages/webui-server/tests/server/model-operations.test.ts`.
- `packages/cli/src/boot/tui-coordinator-setup.ts` (237 LOC) → add `packages/cli/tests/boot/tui-coordinator-setup.test.ts`.
- `packages/core/src/coordination/agents/agent-prompts.ts` (236 LOC) → add `packages/core/tests/coordination/agents/agent-prompts.test.ts`.
- `packages/cli/src/cli-context.ts` (235 LOC) → add `packages/cli/tests/cli-context.test.ts`.
- `packages/cli/src/slash-commands/mailbox-demo.ts` (235 LOC) → add `packages/cli/tests/slash-commands/mailbox-demo.test.ts`.
- `packages/tui/src/components/statusline-detail-panel.tsx` (234 LOC) → add `packages/tui/tests/components/statusline-detail-panel.test.ts`.
- `packages/cli/src/slash-commands/modelcaps.ts` (233 LOC) → add `packages/cli/tests/slash-commands/modelcaps.test.ts`.
- `packages/core/src/kernel/events/session-events.ts` (233 LOC) → add `packages/core/tests/kernel/events/session-events.test.ts`.
- `packages/core/src/coordination/agents/phase6-domain.ts` (231 LOC) → add `packages/core/tests/coordination/agents/phase6-domain.test.ts`.
- `packages/tui/src/components/process-list.tsx` (230 LOC) → add `packages/tui/tests/components/process-list.test.ts`.
- `packages/tui/src/components/coordinator-panel.tsx` (226 LOC) → add `packages/tui/tests/components/coordinator-panel.test.ts`.
- `packages/webui-server/src/server/specs-ws-handler.ts` (226 LOC) → add `packages/webui-server/tests/server/specs-ws-handler.test.ts`.
- `packages/tui/src/hooks/use-session-interrupt-controller.ts` (224 LOC) → add `packages/tui/tests/hooks/use-session-interrupt-controller.test.ts`.
- `packages/tui/src/hooks/use-autonomy-drivers.ts` (222 LOC) → add `packages/tui/tests/hooks/use-autonomy-drivers.test.ts`.
- `packages/webui-server/src/server/embedded-lifecycle.ts` (221 LOC) → add `packages/webui-server/tests/server/embedded-lifecycle.test.ts`.
- `packages/tui/src/theme.ts` (216 LOC) → add `packages/tui/tests/theme.test.ts`.
- `packages/cli/src/slash-commands/agent-improve.ts` (213 LOC) → add `packages/cli/tests/slash-commands/agent-improve.test.ts`.
- `packages/core/src/kernel/events/tool-events.ts` (211 LOC) → add `packages/core/tests/kernel/events/tool-events.test.ts`.
- `packages/core/src/hq/transcript-mapper.ts` (210 LOC) → add `packages/core/tests/hq/transcript-mapper.test.ts`.
- `packages/webui-server/src/server/discover-mailbox-bridge.ts` (210 LOC) → add `packages/webui-server/tests/server/discover-mailbox-bridge.test.ts`.
- `packages/cli/src/auth-menu/shared.ts` (209 LOC) → add `packages/cli/tests/auth-menu/shared.test.ts`.
- `packages/core/src/core/instruction-bundle.ts` (202 LOC) → add `packages/core/tests/core/instruction-bundle.test.ts`.
- `packages/tui/src/hooks/use-terminal-render-lifecycle.ts` (200 LOC) → add `packages/tui/tests/hooks/use-terminal-render-lifecycle.test.ts`.
- `packages/core/src/execution/index.ts` (199 LOC) → add `packages/core/tests/execution/index.test.ts`.
- `packages/tui/src/run-blocks-controller.ts` (199 LOC) → add `packages/tui/tests/run-blocks-controller.test.ts`.
- `packages/tui/src/components/history/index.tsx` (197 LOC) → add `packages/tui/tests/components/history/index.test.ts`.
- `packages/cli/src/boot/tui-project-switch.ts` (195 LOC) → add `packages/cli/tests/boot/tui-project-switch.test.ts`.
- `packages/cli/src/subcommands/handlers/chronicle.ts` (194 LOC) → add `packages/cli/tests/subcommands/handlers/chronicle.test.ts`.
- `packages/core/src/models/alibaba-token-plan-catalog.ts` (193 LOC) → add `packages/core/tests/models/alibaba-token-plan-catalog.test.ts`.
- `packages/core/src/coordination/ifleet-manager.ts` (192 LOC) → add `packages/core/tests/coordination/ifleet-manager.test.ts`.
- `packages/tui/src/reducers/conversation.ts` (190 LOC) → add `packages/tui/tests/reducers/conversation.test.ts`.
- `packages/tui/src/scroll-anchor.ts` (187 LOC) → add `packages/tui/tests/scroll-anchor.test.ts`.
- `packages/webui-server/src/server/brain-handlers.ts` (186 LOC) → add `packages/webui-server/tests/server/brain-handlers.test.ts`.
- `packages/core/src/coordination/agents/phase3-build.ts` (184 LOC) → add `packages/core/tests/coordination/agents/phase3-build.test.ts`.
- `packages/cli/src/wiring/director-setup.ts` (183 LOC) → add `packages/cli/tests/wiring/director-setup.test.ts`.
- `packages/core/src/security/capabilities.ts` (181 LOC) → add `packages/core/tests/security/capabilities.test.ts`.
- `packages/cli/src/subcommands/handlers/diag-doctor.ts` (179 LOC) → add `packages/cli/tests/subcommands/handlers/diag-doctor.test.ts`.
- `packages/cli/src/webui-server/kanban-host-adapter.ts` (177 LOC) → add `packages/cli/tests/webui-server/kanban-host-adapter.test.ts`.
- `packages/core/src/kernel/events/provider-events.ts` (176 LOC) → add `packages/core/tests/kernel/events/provider-events.test.ts`.
- `packages/webui-server/src/server/model-catalog.ts` (176 LOC) → add `packages/webui-server/tests/server/model-catalog.test.ts`.
- `packages/cli/src/pre-launch/project-check.ts` (175 LOC) → add `packages/cli/tests/pre-launch/project-check.test.ts`.
- `packages/webui-server/src/server/types.ts` (173 LOC) → add `packages/webui-server/tests/server/types.test.ts`.
- `packages/cli/src/services/project-manifest.ts` (172 LOC) → add `packages/cli/tests/services/project-manifest.test.ts`.
- `packages/cli/src/wiring/command-host-state.ts` (171 LOC) → add `packages/cli/tests/wiring/command-host-state.test.ts`.
- `packages/core/src/coordination/agents/phase8-delivery.ts` (171 LOC) → add `packages/core/tests/coordination/agents/phase8-delivery.test.ts`.
- `packages/cli/src/wiring/runtime-picker-deps.ts` (169 LOC) → add `packages/cli/tests/wiring/runtime-picker-deps.test.ts`.
- `packages/cli/src/slash-commands/mailbox-serve.ts` (166 LOC) → add `packages/cli/tests/slash-commands/mailbox-serve.test.ts`.
- `packages/mcp/src/sse-reader.ts` (163 LOC) → add `packages/mcp/tests/sse-reader.test.ts`.
- `packages/tui/src/history-entry.ts` (160 LOC) → add `packages/tui/tests/history-entry.test.ts`.
- `packages/cli/src/services/sdd/spec-detection.ts` (159 LOC) → add `packages/cli/tests/services/sdd/spec-detection.test.ts`.
- `packages/core/src/utils/index.ts` (157 LOC) → add `packages/core/tests/utils/index.test.ts`.
- `packages/tui/src/components/todos-monitor.tsx` (157 LOC) → add `packages/tui/tests/components/todos-monitor.test.ts`.
- `packages/cli/src/slash-commands/dev.ts` (155 LOC) → add `packages/cli/tests/slash-commands/dev.test.ts`.
- `packages/tui/src/components/queue-panel.tsx` (155 LOC) → add `packages/tui/tests/components/queue-panel.test.ts`.
- `packages/tui/src/hooks/use-mailbox-view-model.ts` (155 LOC) → add `packages/tui/tests/hooks/use-mailbox-view-model.test.ts`.
- `packages/tui/src/ui-contracts.ts` (155 LOC) → add `packages/tui/tests/ui-contracts.test.ts`.
- `packages/core/src/middleware/collab-pause.ts` (152 LOC) → add `packages/core/tests/middleware/collab-pause.test.ts`.
- `packages/cli/src/pre-launch/indexing-question.ts` (151 LOC) → add `packages/cli/tests/pre-launch/indexing-question.test.ts`.
- `packages/tui/src/hooks/use-tui-environment-state.ts` (151 LOC) → add `packages/tui/tests/hooks/use-tui-environment-state.test.ts`.
- `packages/core/src/coordination/agents/phase9-meta.ts` (150 LOC) → add `packages/core/tests/coordination/agents/phase9-meta.test.ts`.
- `packages/core/src/coordination/agents/types.ts` (150 LOC) → add `packages/core/tests/coordination/agents/types.test.ts`.
- `packages/tui/src/components/provider-colors.ts` (150 LOC) → add `packages/tui/tests/components/provider-colors.test.ts`.
- `packages/webui-server/src/server/setup-screen.ts` (150 LOC) → add `packages/webui-server/tests/server/setup-screen.test.ts`.
- `packages/core/src/extension/extension-points.ts` (149 LOC) → add `packages/core/tests/extension/extension-points.test.ts`.
- `packages/tui/src/reducers/settings-panel.ts` (148 LOC) → add `packages/tui/tests/reducers/settings-panel.test.ts`.
- `packages/core/src/coordination/agents/phase5-review.ts` (146 LOC) → add `packages/core/tests/coordination/agents/phase5-review.test.ts`.
- `packages/tui/src/components/live-activity-strip.tsx` (145 LOC) → add `packages/tui/tests/components/live-activity-strip.test.ts`.
- `packages/core/src/plugins/review-types.ts` (139 LOC) → add `packages/core/tests/plugins/review-types.test.ts`.
- `packages/core/src/coordination/agents/phase2-planning.ts` (138 LOC) → add `packages/core/tests/coordination/agents/phase2-planning.test.ts`.
- `packages/cli/src/wiring/runtime-controller-deps.ts` (137 LOC) → add `packages/cli/tests/wiring/runtime-controller-deps.test.ts`.
- `packages/cli/src/wiring/runtime-lifecycle-deps.ts` (134 LOC) → add `packages/cli/tests/wiring/runtime-lifecycle-deps.test.ts`.
- `packages/core/src/kernel/events/sdd-events.ts` (133 LOC) → add `packages/core/tests/kernel/events/sdd-events.test.ts`.
- `packages/webui-server/src/server/client-presence.ts` (132 LOC) → add `packages/webui-server/tests/server/client-presence.test.ts`.
- `packages/tui/src/hooks/use-settings-auto-save.ts` (131 LOC) → add `packages/tui/tests/hooks/use-settings-auto-save.test.ts`.
- `packages/core/src/notifications/types.ts` (130 LOC) → add `packages/core/tests/notifications/types.test.ts`.
- `packages/webui-server/src/server/codemap-handlers.ts` (128 LOC) → add `packages/webui-server/tests/server/codemap-handlers.test.ts`.
- `packages/cli/src/services/statusline-config.ts` (127 LOC) → add `packages/cli/tests/services/statusline-config.test.ts`.
- `packages/core/src/coordination/brain-heuristics.ts` (127 LOC) → add `packages/core/tests/coordination/brain-heuristics.test.ts`.
- `packages/cli/src/hq-server/startup.ts` (126 LOC) → add `packages/cli/tests/hq-server/startup.test.ts`.
- `packages/core/src/coordination/director/director-collab.ts` (126 LOC) → add `packages/core/tests/coordination/director/director-collab.test.ts`.
- `packages/core/src/core/agent-types.ts` (125 LOC) → add `packages/core/tests/core/agent-types.test.ts`.
- `packages/cli/src/boot/dispatch-singleshot.ts` (124 LOC) → add `packages/cli/tests/boot/dispatch-singleshot.test.ts`.
- `packages/cli/src/cli-eternal-flag.ts` (124 LOC) → add `packages/cli/tests/cli-eternal-flag.test.ts`.
- `packages/tui/src/hooks/use-client-telemetry.ts` (122 LOC) → add `packages/tui/tests/hooks/use-client-telemetry.test.ts`.
- `packages/cli/src/hq-server/routes/system-handlers.ts` (121 LOC) → add `packages/cli/tests/hq-server/routes/system-handlers.test.ts`.
- `packages/webui-server/src/server/model-auto-discovery.ts` (121 LOC) → add `packages/webui-server/tests/server/model-auto-discovery.test.ts`.
- `packages/cli/src/slash-commands/spawn-agents.ts` (120 LOC) → add `packages/cli/tests/slash-commands/spawn-agents.test.ts`.
- `packages/core/src/coordination/coordinator/error-classifier.ts` (119 LOC) → add `packages/core/tests/coordination/coordinator/error-classifier.test.ts`.
- `packages/webui-server/src/server/connection-handler.ts` (117 LOC) → add `packages/webui-server/tests/server/connection-handler.test.ts`.
- `packages/core/src/coordination/director-session.ts` (116 LOC) → add `packages/core/tests/coordination/director-session.test.ts`.
- `packages/cli/src/wiring/runtime-dispatch-state.ts` (115 LOC) → add `packages/cli/tests/wiring/runtime-dispatch-state.test.ts`.
- `packages/core/src/hq/bridge-context.ts` (115 LOC) → add `packages/core/tests/hq/bridge-context.test.ts`.
- `packages/webui-server/src/server/mcp-routes.ts` (114 LOC) → add `packages/webui-server/tests/server/mcp-routes.test.ts`.
- `packages/cli/src/wiring/dep-watcher.ts` (113 LOC) → add `packages/cli/tests/wiring/dep-watcher.test.ts`.
- `packages/core/src/coordination/agents/index.ts` (112 LOC) → add `packages/core/tests/coordination/agents/index.test.ts`.
- `packages/cli/src/hq-server/types.ts` (111 LOC) → add `packages/cli/tests/hq-server/types.test.ts`.
- `packages/core/src/coordination/agents/phase7-knowledge.ts` (109 LOC) → add `packages/core/tests/coordination/agents/phase7-knowledge.test.ts`.
- `packages/cli/src/hq-server/auth-state.ts` (107 LOC) → add `packages/cli/tests/hq-server/auth-state.test.ts`.
- `packages/tui/src/hooks/use-tui-controllers.ts` (106 LOC) → add `packages/tui/tests/hooks/use-tui-controllers.test.ts`.
- `packages/cli/src/boot/tui-project-picker-callback.ts` (104 LOC) → add `packages/cli/tests/boot/tui-project-picker-callback.test.ts`.
- `packages/cli/src/services/sdd/state.ts` (104 LOC) → add `packages/cli/tests/services/sdd/state.test.ts`.
- `packages/cli/src/webui-server/session-start-payload.ts` (103 LOC) → add `packages/cli/tests/webui-server/session-start-payload.test.ts`.
- `packages/cli/src/wiring/provider-utility-tools.ts` (102 LOC) → add `packages/cli/tests/wiring/provider-utility-tools.test.ts`.
- `packages/core/src/coordination/icoordinator.ts` (102 LOC) → add `packages/core/tests/coordination/icoordinator.test.ts`.
- `packages/webui-server/src/server/prefs-routes.ts` (101 LOC) → add `packages/webui-server/tests/server/prefs-routes.test.ts`.
- `packages/core/src/observability/redact-command.ts` (100 LOC) → add `packages/core/tests/observability/redact-command.test.ts`.
- `packages/tui/src/hooks/use-statusline-state.ts` (99 LOC) → add `packages/tui/tests/hooks/use-statusline-state.test.ts`.
- `packages/cli/src/boot/tui-project-spawn.ts` (98 LOC) → add `packages/cli/tests/boot/tui-project-spawn.test.ts`.
- `packages/core/src/coordination/dep-watcher-bridge.ts` (97 LOC) → add `packages/core/tests/coordination/dep-watcher-bridge.test.ts`.
- `packages/core/src/skills/foreign-sources.ts` (97 LOC) → add `packages/core/tests/skills/foreign-sources.test.ts`.
- `packages/tui/src/hooks/use-prompt-picker.ts` (97 LOC) → add `packages/tui/tests/hooks/use-prompt-picker.test.ts`.
- `packages/cli/src/slash-commands/clear.ts` (96 LOC) → add `packages/cli/tests/slash-commands/clear.test.ts`.
- `packages/cli/src/slash-commands/sdd/rendering.ts` (96 LOC) → add `packages/cli/tests/slash-commands/sdd/rendering.test.ts`.
- `packages/webui-server/src/protocol/decoder.ts` (96 LOC) → add `packages/webui-server/tests/protocol/decoder.test.ts`.
- `packages/webui-server/src/server/mode-operations.ts` (96 LOC) → add `packages/webui-server/tests/server/mode-operations.test.ts`.
- `packages/core/src/coordination/director-host-contracts.ts` (95 LOC) → add `packages/core/tests/coordination/director-host-contracts.test.ts`.
- `packages/tui/src/kill-slash.ts` (95 LOC) → add `packages/tui/tests/kill-slash.test.ts`.
- `packages/tui/src/hooks/use-git-session-status.ts` (93 LOC) → add `packages/tui/tests/hooks/use-git-session-status.test.ts`.
- `packages/cli/src/boot/tui-runtime-state.ts` (92 LOC) → add `packages/cli/tests/boot/tui-runtime-state.test.ts`.
- `packages/cli/src/wiring/eternal-command-handlers.ts` (91 LOC) → add `packages/cli/tests/wiring/eternal-command-handlers.test.ts`.
- `packages/core/src/hq/protocol/client.ts` (90 LOC) → add `packages/core/tests/hq/protocol/client.test.ts`.
- `packages/core/src/chronicle/types.ts` (89 LOC) → add `packages/core/tests/chronicle/types.test.ts`.
- `packages/mcp/src/transport-security.ts` (89 LOC) → add `packages/mcp/tests/transport-security.test.ts`.
- `packages/core/src/coordination/agents/phase1-discovery.ts` (88 LOC) → add `packages/core/tests/coordination/agents/phase1-discovery.test.ts`.
- `packages/core/src/skills/registry/registry-adapter.ts` (88 LOC) → add `packages/core/tests/skills/registry/registry-adapter.test.ts`.
- `packages/core/src/utils/compaction-preview.ts` (88 LOC) → add `packages/core/tests/utils/compaction-preview.test.ts`.
- `packages/tui/src/ink.tsx` (88 LOC) → add `packages/tui/tests/ink.test.ts`.
- `packages/tui/src/app-view-state.ts` (87 LOC) → add `packages/tui/tests/app-view-state.test.ts`.
- `packages/cli/src/auth-menu/direct.ts` (86 LOC) → add `packages/cli/tests/auth-menu/direct.test.ts`.
- `packages/core/src/security/index.ts` (86 LOC) → add `packages/core/tests/security/index.test.ts`.
- `packages/core/src/utils/crash-shield.ts` (86 LOC) → add `packages/core/tests/utils/crash-shield.test.ts`.
- `packages/tui/src/app-view-contract.ts` (86 LOC) → add `packages/tui/tests/app-view-contract.test.ts`.
- `packages/core/src/models/codex-catalog.ts` (85 LOC) → add `packages/core/tests/models/codex-catalog.test.ts`.
- `packages/tui/src/components/f-key-picker.tsx` (85 LOC) → add `packages/tui/tests/components/f-key-picker.test.ts`.
- `packages/cli/src/auth-menu/oauth-menu.ts` (84 LOC) → add `packages/cli/tests/auth-menu/oauth-menu.test.ts`.
- `packages/core/src/coordination/mailbox-constants.ts` (84 LOC) → add `packages/core/tests/coordination/mailbox-constants.test.ts`.
- `packages/webui-server/src/server/mode-handlers.ts` (84 LOC) → add `packages/webui-server/tests/server/mode-handlers.test.ts`.
- `packages/tui/src/app-reducer.ts` (83 LOC) → add `packages/tui/tests/app-reducer.test.ts`.
- `packages/core/src/goal/index.ts` (81 LOC) → add `packages/core/tests/goal/index.test.ts`.
- `packages/core/src/kernel/tokens.ts` (79 LOC) → add `packages/core/tests/kernel/tokens.test.ts`.
- `packages/core/src/utils/connectivity.ts` (79 LOC) → add `packages/core/tests/utils/connectivity.test.ts`.
- `packages/webui-server/src/protocol/server-conversation.ts` (79 LOC) → add `packages/webui-server/tests/protocol/server-conversation.test.ts`.
- `packages/tui/src/components/audit-panel.tsx` (78 LOC) → add `packages/tui/tests/components/audit-panel.test.ts`.
- `packages/tui/src/components/history/tool-card.tsx` (77 LOC) → add `packages/tui/tests/components/history/tool-card.test.ts`.
- `packages/cli/src/acp-registry-cache.ts` (76 LOC) → add `packages/cli/tests/acp-registry-cache.test.ts`.
- `packages/cli/src/auth-menu/top-menu.ts` (76 LOC) → add `packages/cli/tests/auth-menu/top-menu.test.ts`.
- `packages/cli/src/subcommands/handlers/version-help.ts` (76 LOC) → add `packages/cli/tests/subcommands/handlers/version-help.test.ts`.
- `packages/cli/src/services/commit-message.ts` (75 LOC) → add `packages/cli/tests/services/commit-message.test.ts`.
- `packages/tui/src/components/entry-error-boundary.tsx` (75 LOC) → add `packages/tui/tests/components/entry-error-boundary.test.ts`.
- `packages/cli/src/services/sdd/project-context.ts` (73 LOC) → add `packages/cli/tests/services/sdd/project-context.test.ts`.
- `packages/core/src/execution/subagent-compaction.ts` (73 LOC) → add `packages/core/tests/execution/subagent-compaction.test.ts`.
- `packages/core/src/coordination/director/director-errors.ts` (72 LOC) → add `packages/core/tests/coordination/director/director-errors.test.ts`.
- `packages/cli/src/boot/short-circuit-desktop.ts` (71 LOC) → add `packages/cli/tests/boot/short-circuit-desktop.test.ts`.
- `packages/core/src/hooks/shell-hooks-equal.ts` (71 LOC) → add `packages/core/tests/hooks/shell-hooks-equal.test.ts`.
- `packages/tui/src/tui-host-capabilities.ts` (70 LOC) → add `packages/tui/tests/tui-host-capabilities.test.ts`.
- `packages/webui-server/src/protocol/client-integrations.ts` (69 LOC) → add `packages/webui-server/tests/protocol/client-integrations.test.ts`.
- `packages/webui-server/src/protocol/server-integrations.ts` (69 LOC) → add `packages/webui-server/tests/protocol/server-integrations.test.ts`.
- `packages/cli/src/boot/tui-live-sessions.ts` (67 LOC) → add `packages/cli/tests/boot/tui-live-sessions.test.ts`.
- `packages/core/src/observability/process-telemetry.ts` (65 LOC) → add `packages/core/tests/observability/process-telemetry.test.ts`.
- `packages/core/src/utils/config-backup.ts` (65 LOC) → add `packages/core/tests/utils/config-backup.test.ts`.
- `packages/cli/src/wiring/command-host-adapters.ts` (64 LOC) → add `packages/cli/tests/wiring/command-host-adapters.test.ts`.
- `packages/core/src/utils/dispatcher-types.d.ts` (64 LOC) → add `packages/core/tests/utils/dispatcher-types.d.test.ts`.
- `packages/tui/src/components/history/types.ts` (63 LOC) → add `packages/tui/tests/components/history/types.test.ts`.
- `packages/webui-server/src/protocol/index.ts` (63 LOC) → add `packages/webui-server/tests/protocol/index.test.ts`.
- `packages/cli/src/slash-commands/surfaces.ts` (62 LOC) → add `packages/cli/tests/slash-commands/surfaces.test.ts`.
- `packages/core/src/chronicle/index.ts` (62 LOC) → add `packages/core/tests/chronicle/index.test.ts`.
- `packages/cli/src/services/suggestion-store.ts` (61 LOC) → add `packages/cli/tests/services/suggestion-store.test.ts`.
- `packages/cli/src/utils/hq-ttl.ts` (61 LOC) → add `packages/cli/tests/utils/hq-ttl.test.ts`.
- `packages/webui-server/src/protocol/server-operations.ts` (61 LOC) → add `packages/webui-server/tests/protocol/server-operations.test.ts`.
- `packages/cli/src/boot/tui-sdd-callback.ts` (59 LOC) → add `packages/cli/tests/boot/tui-sdd-callback.test.ts`.
- `packages/core/src/core/index.ts` (59 LOC) → add `packages/core/tests/core/index.test.ts`.
- `packages/tui/src/settings-contracts.ts` (59 LOC) → add `packages/tui/tests/settings-contracts.test.ts`.
- `packages/webui-server/src/server/kanban-board-watcher.ts` (59 LOC) → add `packages/webui-server/tests/server/kanban-board-watcher.test.ts`.
- `packages/cli/src/hq-server/trust-boundary.ts` (58 LOC) → add `packages/cli/tests/hq-server/trust-boundary.test.ts`.
- `packages/cli/src/subcommands/handlers/export.ts` (58 LOC) → add `packages/cli/tests/subcommands/handlers/export.test.ts`.
- `packages/core/src/kernel/events/worktree-events.ts` (58 LOC) → add `packages/core/tests/kernel/events/worktree-events.test.ts`.
- `packages/mcp/src/constants.ts` (58 LOC) → add `packages/mcp/tests/constants.test.ts`.
- `packages/webui-server/src/protocol/client-operations.ts` (57 LOC) → add `packages/webui-server/tests/protocol/client-operations.test.ts`.
- `packages/core/src/skills/index.ts` (54 LOC) → add `packages/core/tests/skills/index.test.ts`.
- `packages/webui-server/src/protocol/version.ts` (54 LOC) → add `packages/webui-server/tests/protocol/version.test.ts`.
- `packages/core/src/prompts/prompt-manifest-store.ts` (53 LOC) → add `packages/core/tests/prompts/prompt-manifest-store.test.ts`.
- `packages/webui-server/src/protocol/client-conversation.ts` (53 LOC) → add `packages/webui-server/tests/protocol/client-conversation.test.ts`.
- `packages/core/src/coordination/mailbox-events.ts` (52 LOC) → add `packages/core/tests/coordination/mailbox-events.test.ts`.
- `packages/core/src/chronicle/health-monitor.ts` (50 LOC) → add `packages/core/tests/chronicle/health-monitor.test.ts`.
- `packages/webui-server/src/protocol/client-workspace.ts` (50 LOC) → add `packages/webui-server/tests/protocol/client-workspace.test.ts`.
- `packages/core/src/coordination/in-memory-transport.ts` (49 LOC) → add `packages/core/tests/coordination/in-memory-transport.test.ts`.
- `packages/core/src/notifications/index.ts` (49 LOC) → add `packages/core/tests/notifications/index.test.ts`.
- `packages/webui-server/src/server/privileged-actions.ts` (49 LOC) → add `packages/webui-server/tests/server/privileged-actions.test.ts`.
- `packages/cli/src/services/dispatch-classifier.ts` (47 LOC) → add `packages/cli/tests/services/dispatch-classifier.test.ts`.
- `packages/cli/src/auth-menu/types.ts` (46 LOC) → add `packages/cli/tests/auth-menu/types.test.ts`.
- `packages/core/src/core/modes/default.ts` (44 LOC) → add `packages/core/tests/core/modes/default.test.ts`.
- `packages/core/src/kernel/events/fleet-events.ts` (44 LOC) → add `packages/core/tests/kernel/events/fleet-events.test.ts`.
- `packages/core/src/kernel/events/process-events.ts` (44 LOC) → add `packages/core/tests/kernel/events/process-events.test.ts`.
- `packages/core/src/models/index.ts` (44 LOC) → add `packages/core/tests/models/index.test.ts`.
- `packages/core/src/utils/tool-subject.ts` (44 LOC) → add `packages/core/tests/utils/tool-subject.test.ts`.
- `packages/core/src/utils/walk-ignore.ts` (44 LOC) → add `packages/core/tests/utils/walk-ignore.test.ts`.
- `packages/cli/src/webui-server/privileged-actions.ts` (43 LOC) → add `packages/cli/tests/webui-server/privileged-actions.test.ts`.
- `packages/core/src/coordination/agents/phase3-techstack.ts` (43 LOC) → add `packages/core/tests/coordination/agents/phase3-techstack.test.ts`.
- `packages/core/src/skills/registry/github-direct-adapter.ts` (43 LOC) → add `packages/core/tests/skills/registry/github-direct-adapter.test.ts`.
- `packages/tui/src/hooks/use-slash-picker.ts` (43 LOC) → add `packages/tui/tests/hooks/use-slash-picker.test.ts`.
- `packages/core/src/core/agent-internals.ts` (42 LOC) → add `packages/core/tests/core/agent-internals.test.ts`.
- `packages/core/src/plugin/index.ts` (41 LOC) → add `packages/core/tests/plugin/index.test.ts`.
- `packages/tui/src/components/memory-context-widget.tsx` (40 LOC) → add `packages/tui/tests/components/memory-context-widget.test.ts`.
- `packages/webui-server/src/protocol/server-workspace.ts` (40 LOC) → add `packages/webui-server/tests/protocol/server-workspace.test.ts`.
- `packages/cli/src/utils/win32-cmd.ts` (38 LOC) → add `packages/cli/tests/utils/win32-cmd.test.ts`.
- `packages/core/src/infrastructure/index.ts` (38 LOC) → add `packages/core/tests/infrastructure/index.test.ts`.
- `packages/core/src/storage/session-id.ts` (37 LOC) → add `packages/core/tests/storage/session-id.test.ts`.
- `packages/webui-server/src/server/autonomy-routes.ts` (37 LOC) → add `packages/webui-server/tests/server/autonomy-routes.test.ts`.
- `packages/cli/src/boot/short-circuit-flags.ts` (36 LOC) → add `packages/cli/tests/boot/short-circuit-flags.test.ts`.
- `packages/core/src/tools/index.ts` (36 LOC) → add `packages/core/tests/tools/index.test.ts`.
- `packages/core/src/observability/index.ts` (35 LOC) → add `packages/core/tests/observability/index.test.ts`.
- `packages/core/src/utils/merge-custom-models.ts` (35 LOC) → add `packages/core/tests/utils/merge-custom-models.test.ts`.
- `packages/core/src/utils/session-scoped-path.ts` (35 LOC) → add `packages/core/tests/utils/session-scoped-path.test.ts`.
- `packages/core/src/coordination/director/director-btw-notes.ts` (34 LOC) → add `packages/core/tests/coordination/director/director-btw-notes.test.ts`.
- `packages/webui-server/src/server/conversation-routes.ts` (33 LOC) → add `packages/webui-server/tests/server/conversation-routes.test.ts`.
- `packages/core/src/core/model-ref.ts` (32 LOC) → add `packages/core/tests/core/model-ref.test.ts`.
- `packages/core/src/hooks/index.ts` (32 LOC) → add `packages/core/tests/hooks/index.test.ts`.
- `packages/webui-server/src/protocol/types.ts` (32 LOC) → add `packages/webui-server/tests/protocol/types.test.ts`.
- `packages/cli/src/subcommands/contracts.ts` (31 LOC) → add `packages/cli/tests/subcommands/contracts.test.ts`.
- `packages/webui-server/src/server/agent-roster-routes.ts` (31 LOC) → add `packages/webui-server/tests/server/agent-roster-routes.test.ts`.
- `packages/cli/src/hq-recovery-html.ts` (29 LOC) → add `packages/cli/tests/hq-recovery-html.test.ts`.
- `packages/cli/src/services/sdd-runtime.ts` (29 LOC) → add `packages/cli/tests/services/sdd-runtime.test.ts`.
- `packages/core/src/hq/protocol/browser.ts` (29 LOC) → add `packages/core/tests/hq/protocol/browser.test.ts`.
- `packages/core/src/storage/session-read-scrubber.ts` (29 LOC) → add `packages/core/tests/storage/session-read-scrubber.test.ts`.
- `packages/webui-server/src/server/process-routes.ts` (29 LOC) → add `packages/webui-server/tests/server/process-routes.test.ts`.
- `packages/cli/src/slash-commands/diag-stats.ts` (28 LOC) → add `packages/cli/tests/slash-commands/diag-stats.test.ts`.
- `packages/cli/src/subcommands/handlers/plugin-usage.ts` (28 LOC) → add `packages/cli/tests/subcommands/handlers/plugin-usage.test.ts`.
- `packages/webui-server/src/server/git-process.ts` (28 LOC) → add `packages/webui-server/tests/server/git-process.test.ts`.
- `packages/cli/src/wiring/design-studio.ts` (27 LOC) → add `packages/cli/tests/wiring/design-studio.test.ts`.
- `packages/cli/src/cli-bundled-skills.ts` (25 LOC) → add `packages/cli/tests/cli-bundled-skills.test.ts`.
- `packages/cli/src/fleet/supervisor-registry.ts` (25 LOC) → add `packages/cli/tests/fleet/supervisor-registry.test.ts`.
- `packages/core/src/kernel/index.ts` (25 LOC) → add `packages/core/tests/kernel/index.test.ts`.
- `packages/webui-server/src/server/handlers/index.ts` (25 LOC) → add `packages/webui-server/tests/server/handlers/index.test.ts`.
- `packages/cli/src/cli-bundled-prompts.ts` (24 LOC) → add `packages/cli/tests/cli-bundled-prompts.test.ts`.
- `packages/core/src/storage/storage-concurrency.ts` (24 LOC) → add `packages/core/tests/storage/storage-concurrency.test.ts`.
- `packages/cli/src/subcommands/handlers/tools-skills.ts` (23 LOC) → add `packages/cli/tests/subcommands/handlers/tools-skills.test.ts`.
- `packages/webui-server/src/server/sdd-wizard-routes.ts` (23 LOC) → add `packages/webui-server/tests/server/sdd-wizard-routes.test.ts`.
- `packages/core/src/kernel/events/network-events.ts` (22 LOC) → add `packages/core/tests/kernel/events/network-events.test.ts`.
- `packages/webui-server/src/server/goal-snapshot-routes.ts` (22 LOC) → add `packages/webui-server/tests/server/goal-snapshot-routes.test.ts`.
- `packages/core/src/hq/index.ts` (21 LOC) → add `packages/core/tests/hq/index.test.ts`.
- `packages/core/src/storage/session-tool-call-ends.ts` (21 LOC) → add `packages/core/tests/storage/session-tool-call-ends.test.ts`.
- `packages/webui-server/src/server/completion-routes.ts` (21 LOC) → add `packages/webui-server/tests/server/completion-routes.test.ts`.
- `packages/cli/src/boot/execution-mode.ts` (20 LOC) → add `packages/cli/tests/boot/execution-mode.test.ts`.
- `packages/cli/src/provider-id.ts` (19 LOC) → add `packages/cli/tests/provider-id.test.ts`.
- `packages/cli/src/subcommands/handlers/quick.ts` (19 LOC) → add `packages/cli/tests/subcommands/handlers/quick.test.ts`.
- `packages/core/src/coordination/agents.ts` (19 LOC) → add `packages/core/tests/coordination/agents.test.ts`.
- `packages/core/src/storage/session-helpers.ts` (19 LOC) → add `packages/core/tests/storage/session-helpers.test.ts`.
- `packages/core/src/tasking/index.ts` (19 LOC) → add `packages/core/tests/tasking/index.test.ts`.
- `packages/tui/src/shared-types.ts` (19 LOC) → add `packages/tui/tests/shared-types.test.ts`.
- `packages/cli/src/profile-config-path.ts` (18 LOC) → add `packages/cli/tests/profile-config-path.test.ts`.
- `packages/webui-server/src/server/sdd-board-routes.ts` (18 LOC) → add `packages/webui-server/tests/server/sdd-board-routes.test.ts`.
- `packages/webui-server/src/server/specs-routes.ts` (18 LOC) → add `packages/webui-server/tests/server/specs-routes.test.ts`.
- `packages/webui-server/src/server/goal-routes.ts` (17 LOC) → add `packages/webui-server/tests/server/goal-routes.test.ts`.
- `packages/cli/src/webui-server/contracts.ts` (16 LOC) → add `packages/cli/tests/webui-server/contracts.test.ts`.
- `packages/cli/src/theme.ts` (14 LOC) → add `packages/cli/tests/theme.test.ts`.
- `packages/cli/src/wiring/to-execute-deps.ts` (14 LOC) → add `packages/cli/tests/wiring/to-execute-deps.test.ts`.
- `packages/core/src/extension/index.ts` (14 LOC) → add `packages/core/tests/extension/index.test.ts`.
- `packages/cli/src/hq-server/audit-actor.ts` (13 LOC) → add `packages/cli/tests/hq-server/audit-actor.test.ts`.
- `packages/tui/src/components/suggestions.ts` (13 LOC) → add `packages/tui/tests/components/suggestions.test.ts`.
- `packages/core/src/coordination/collab-director-host.ts` (12 LOC) → add `packages/core/tests/coordination/collab-director-host.test.ts`.
- `packages/core/src/worktree/index.ts` (12 LOC) → add `packages/core/tests/worktree/index.test.ts`.
- `packages/core/src/coordination/null-fleet-bus.ts` (11 LOC) → add `packages/core/tests/coordination/null-fleet-bus.test.ts`.
- `packages/core/src/coordination/spawn-budget.ts` (11 LOC) → add `packages/core/tests/coordination/spawn-budget.test.ts`.
- `packages/core/src/design/index.ts` (11 LOC) → add `packages/core/tests/design/index.test.ts`.
- `packages/webui-server/src/server/setup-event-projection.ts` (10 LOC) → add `packages/webui-server/tests/server/setup-event-projection.test.ts`.
- `packages/cli/src/utils/delay-format.ts` (9 LOC) → add `packages/cli/tests/utils/delay-format.test.ts`.
- `packages/tui/src/brain-contracts.ts` (9 LOC) → add `packages/tui/tests/brain-contracts.test.ts`.
- `packages/cli/src/boot/dispatch-tui.ts` (8 LOC) → add `packages/cli/tests/boot/dispatch-tui.test.ts`.
- `packages/core/src/prompts/index.ts` (8 LOC) → add `packages/core/tests/prompts/index.test.ts`.
- `packages/cli/src/webui-server/stream-coalescer.ts` (7 LOC) → add `packages/cli/tests/webui-server/stream-coalescer.test.ts`.
- `packages/core/src/execution/regex-patterns.ts` (7 LOC) → add `packages/core/tests/execution/regex-patterns.test.ts`.
- `packages/core/src/replay/index.ts` (7 LOC) → add `packages/core/tests/replay/index.test.ts`.
- `packages/core/src/utils/sleep.ts` (7 LOC) → add `packages/core/tests/utils/sleep.test.ts`.
- `packages/cli/src/auth-menu/local-presets.ts` (5 LOC) → add `packages/cli/tests/auth-menu/local-presets.test.ts`.
- `packages/core/src/core/modes/brief.ts` (4 LOC) → add `packages/core/tests/core/modes/brief.test.ts`.
- `packages/core/src/core/modes/teach.ts` (4 LOC) → add `packages/core/tests/core/modes/teach.test.ts`.
- `packages/core/src/registry/index.ts` (4 LOC) → add `packages/core/tests/registry/index.test.ts`.
- `packages/cli/src/services/autonomy-mode.ts` (3 LOC) → add `packages/cli/tests/services/autonomy-mode.test.ts`.
- `packages/cli/src/slash-commands/mcp-utils.ts` (3 LOC) → add `packages/cli/tests/slash-commands/mcp-utils.test.ts`.
- `packages/cli/src/slash-commands/project-utils.ts` (3 LOC) → add `packages/cli/tests/slash-commands/project-utils.test.ts`.
- `packages/cli/src/slash-commands/suggestion-store.ts` (3 LOC) → add `packages/cli/tests/slash-commands/suggestion-store.test.ts`.
- `packages/tui/src/components/brain-panel-model.ts` (3 LOC) → add `packages/tui/tests/components/brain-panel-model.test.ts`.
- `packages/core/src/coordination/transport.ts` (2 LOC) → add `packages/core/tests/coordination/transport.test.ts`.
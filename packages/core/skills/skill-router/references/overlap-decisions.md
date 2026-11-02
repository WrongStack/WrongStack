# Resolve overlapping requests

Choose by the action and the artifact being delivered. Follow existing project
technology; a fashionable replacement is not automatically a task requirement.

| Request | Primary choice | Boundary / follow-up |
|---|---|---|
| Create/restyle an interface | design-craft | design-critique evaluates an existing result; design-system defines shared tokens |
| Implement a provided Figma/reference | design-to-code | Preserve supplied design constraints; add accessibility for interaction checks |
| "Make it like / inspired by <site>" | design-reference-read | Measure first; design-to-code only when a literal match is requested, design-craft when borrowing |
| Which layout/section/state structure fits | design-patterns | Structure only; visual direction stays with design-craft |
| User gets stuck in a form/journey | interaction-design | Handle state, recovery and focus; visual decoration alone does not repair a flow |
| Animate a live web page | motion-design | A live animation is not an encoded video; threejs-3d owns a real 3D scene |
| React-based product/demo video | media-production | Use Remotion for React compositions and FFmpeg for assembly/encoding |
| Scripted 2D diagram/timeline video | motion-canvas-video | Use its generators and timeline; media-production assembles final media if needed |
| Mathematical formulas/geometric proof video | manim-video | Manim Community owns the mathematical scene; do not replace it with UI motion |
| Existing video pipeline | Its existing engine skill | Change engines only for a concrete requirement; verify frames, audio and final codec |
| Next.js route/action/cache | nextjs-modern | react-modern supplies component semantics; node-backend is a separate server workflow |
| Node runtime/module/cancellation issue | node-modern | node-backend implements service endpoints; typescript-strict handles type contracts |
| Backend framework already selected | node-backend, python-backend, go-services, rust-systems, dotnet-backend, java-spring or php-laravel | Choose the actual language/framework; api-design owns public contract design |
| Login/session implementation | authentication-sessions | security-scanner reviews defensive trust boundaries; it is not the implementation recipe |
| Payment notification processing | payments-webhooks | Verify signatures and idempotency; UI payment state alone cannot establish settlement |
| React Native/Expo app | react-native-expo | React web patterns do not replace native permissions/navigation; mobile-design covers UX |
| Flutter app | flutter-mobile | Use Dart/widgets, not a React Native scaffold |
| Apple-native app/widget | swift-ios | kotlin-android owns Android/Compose; mobile-release handles store/signing delivery |
| Slow device experience | mobile-performance | Measure the physical-device bottleneck; web-performance measures the browser experience |
| Build a smaller, reproducible image | docker-deploy | container-hardening reduces privilege; container-debugging diagnoses running failures |
| Multi-service startup/readiness | compose-operations | An image build does not verify service dependency readiness or volume recovery |
| Remote login/transfer | ssh-operations | remote-debugging diagnoses a service after connection; linux-service-ops manages services |
| Publish to an existing server | vps-deploy | reverse-proxy-tls owns ingress/certificates; release-rollback proves recovery |
| Kubernetes workload issue | kubernetes-operations | infrastructure-as-code plans provisioned resources; cloud-architecture chooses topology |
| Production outage | incident-response | Stabilize and preserve evidence before risky migration or broad refactoring |
| Query/schema/index implementation | database-development | database-migrations deploys schema transitions/backfills; backup-recovery proves restoration |
| Live updates/reconnection | realtime-systems | offline-sync reconciles offline edits; queues-jobs owns background delivery/retries |
| Known failing behavior | debugging | Reproduce the reported defect; testing adds necessary behavioral protection |
| Hunt unknown real defects and fix them | evidence-audit | bug-hunter is the WrongStack-specific hunt/cascade procedure |
| Ordinary code review | code-review | code-quality measures dead code/dependency waste; security-scanner reviews defensive security |
| Adversarial review | codex-adversarial-review | Respect its explicit fix-approval gate; a review request is not fix authorization |
| Session guardian/plugin | chimera / auto-review | Read-only session guardian versus automatic-review plugin lifecycle; neither name means generic refactoring |
| Completion claim needs proof | verify-before-done | Build/render/runtime evidence must match the original acceptance path |
| Find files/owners in unfamiliar code | codebase-navigation | Do not load every technology skill before identifying the affected subsystem |
| New dependencies/latest versions | tech-stack | Live registry + migration guide + engine/peer/adapter checks; dated snapshots are not evergreen |
| Web research | research-web | Use authoritative sources; unavailable browsing means the latest claim is unverified |
| Memory maintenance | mnemosyne | SAGE corpus/anchors, not ordinary source cleanup; audit-log reads journal evidence |
| Build an MCP server | mcp-development | mailbox-bridge connects an authorized external agent; roster-only mailbox ids are not main-agent suggestions |
| Coordinate several domains | skill-router | Select a small ordered pipeline; multi-agent is usable only when delegation is authorized |
| Write or fix tests | testing | webapp-testing drives a real browser with Playwright; visual-regression owns screenshot baselines |
| Word, Excel, PowerPoint or PDF file | docx, xlsx, pptx or pdf | office-documents for conversions and mixed formats; doc-coauthoring shapes the content; internal-comms for updates and postmortems |
| Prompt wording versus model integration | prompt-engineering | llm-runtime owns API calls, tool loops, streaming, caching and retries |
| Colors, fonts and themes | design-system | theme-factory picks a ready-made palette and pairing; brand-guidelines applies WrongStack's own brand |
| Is this CSS/HTML feature supported | web-platform-baseline | web-performance measures speed; accessibility owns ARIA and focus behavior |
| Slow page versus slow server | web-performance | observability instruments server latency and production signals |
| Spec or task graph before building | sdd | refactor-planner sequences restructuring of existing code |
| Security review versus proven exploit fix | security-scanner | evidence-audit proves and fixes; codex-adversarial-review attacks one specific diff |
| Remove dead code versus restructure live code | code-quality | refactor-planner owns moves, splits and cycle breaks |
| 3D scene, UI motion or generative art | threejs-3d | motion-design for interface motion; algorithmic-art for generative 2D pieces |

## When nothing fits

Answer simple prose/translation/arithmetic requests directly. For an unfamiliar
technical task, inspect the actual project and authoritative documentation; do
not invent a skill id, pretend a neighboring skill implements the missing system,
or report a plan as a finished artifact. Ask only for information the next action
truly requires and continue independent authorized work.

## Latest stable does not mean blindly install

For a new setup or requested upgrade, establish current stable releases with
tech-stack. Preserve the project's manager and lockfile workflow. Check runtime,
peer, platform and deployment-adapter compatibility together. An incompatibility
is a migration/blocker to explain, not permission to silently choose an old major
or install a preview. Never claim latest when the registry check did not succeed.

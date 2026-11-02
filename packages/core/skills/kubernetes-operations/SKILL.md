---
name: kubernetes-operations
description: "Kubernetes workloads with kubectl, Helm and Kustomize: Deployments, StatefulSets, probes, requests, HPA, PDBs, Services, Gateway API. Use when changing manifests or charts, debugging Pending, CrashLoopBackOff, ImagePullBackOff or OOMKilled pods, tuning probes and resources, rolling out or back, or migrating off ingress-nginx. Not for cluster provisioning (use infrastructure-as-code) or image hardening (use container-hardening)."
trigger: "Use when a request touches Kubernetes manifests, Helm charts, kustomization files, kubectl output, or a pod that is pending, crashing or not receiving traffic."
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: operations
  domain: "infrastructure"
paths: ["kustomization.{yml,yaml}", "Chart.yaml", "**/k8s/**/*.{yml,yaml}"]
---

# Kubernetes Operations

## Selection card
- Task: Change, diagnose or roll out owned Kubernetes workloads.
- Start: Confirm `kubectl config current-context` and namespace, find who owns the object (Argo CD, Flux, Helm, Kustomize, an operator), then read `kubectl describe` and events for the workload.
- Finish: `kubectl rollout status` succeeds, the Service has ready EndpointSlices, real traffic reaches the new version, and the source of truth (Git or chart) holds the change.

## Overview

Every object has an owner that will reconcile it: find the controller or GitOps source first, change that source, and judge success by rollout status and served traffic rather than by `kubectl apply` returning zero.
Checked stable Kubernetes target: 1.37.2 on 2026-10-23. Verify managed-provider support, API versions, client/server skew and addon compatibility before upgrades.
The community ingress-nginx controller was retired in March 2026 (no further releases or security fixes); Gateway API is the upstream successor.

## Rules

1. Pin `--context` and `-n` on every command. Before an imperative change, check ownership (`app.kubernetes.io/managed-by`, Argo CD or Flux labels, `helm list -A`); GitOps controllers revert or fight direct edits.
2. Preview every mutation: `kubectl diff -f <dir>` or `kubectl apply --dry-run=server -f <dir>`; for Helm, render with `helm template` and diff. Deploy immutable tags or digests.
3. Separate probes: `startupProbe` gates slow boot; `readinessProbe` removes a pod from endpoints without restarting it; `livenessProbe` restarts only a locally deadlocked process and never checks shared dependencies, or a database blip restarts the whole fleet.
4. Requests drive scheduling; limits drive OOM kills and CPU throttling. Set memory limit equal to request; treat CPU limits as a deliberate choice and check throttling metrics.
5. For availability: at least two replicas, topology spread across zones, a PodDisruptionBudget that still allows one eviction, and `maxUnavailable: 0` with surge for rollouts.
6. Graceful termination: the app handles SIGTERM, a short `preStop` sleep covers endpoint propagation, and `terminationGracePeriodSeconds` exceeds the drain time.
7. Never print Secret values (`kubectl get secret -o yaml`), set `automountServiceAccountToken: false` where the API is not needed, and never delete PVCs, namespaces or finalizers to "reset" a workload.
8. Done means rollout complete, endpoints ready and real traffic answered by the new version.

## First moves by situation

| Situation | First moves |
|---|---|
| Pending | `kubectl describe pod` events: insufficient CPU or memory, taints and affinity, unbound PVC (`kubectl get pvc`), quota (`kubectl describe resourcequota`) |
| ImagePullBackOff | Event message: tag or digest typo, registry auth (`imagePullSecrets`), missing platform for the node arch, registry rate limit |
| CrashLoopBackOff | `kubectl logs <pod> -c <ctr> --previous`; Last State exit code; liveness killing a slow start; `CreateContainerConfigError` = missing ConfigMap or Secret key |
| OOMKilled | Last State reason; `kubectl top pod --containers`; runtime heap versus limit |
| Running, no traffic | `kubectl get endpointslices -n <ns> -l kubernetes.io/service-name=<svc>`; selector vs labels; `targetPort`; readiness; NetworkPolicy |
| Rollout stuck | `kubectl rollout status deploy/<name> --timeout=120s`; `kubectl get rs`; new pods not ready; quota or PDB; `progressDeadlineSeconds` |
| Node drain blocked | `kubectl get pdb -A` with zero allowed disruptions; single-replica workloads with a strict PDB |
| Shell needed in a distroless pod | `kubectl debug -it <pod> --image=busybox:stable --target=<ctr>` adds an ephemeral container sharing the target's process namespace |
| ingress-nginx still installed | `kubectl get pods -A -l app.kubernetes.io/name=ingress-nginx`; inventory annotations; plan Gateway API or another controller (not drop-in) |
| Cluster upgrade | Deprecated API usage via `kubectl get --raw /metrics \| grep apiserver_requested_deprecated_apis`; kubectl within one minor of the server; addon support |

## Patterns and pitfalls

- **ConfigMap edits do not restart pods** — env vars are read at start; mounted files update eventually but never through `subPath`. Roll with a checksum annotation or Kustomize `configMapGenerator` hash suffixes.
- **`kubectl rollout undo` scope** — it reverts only the pod template, not ConfigMaps, Secrets, Services or HPAs, and a GitOps sync will reapply the newer spec.
- **HPA versus `replicas`** — applying a manifest that sets `replicas` overrides the autoscaler on every apply; omit it when an HPA owns scaling.
- **Immutable selectors** — a Deployment's `spec.selector` cannot change; renaming labels needs a new object and a traffic switch.
- **Mutable tags cached on nodes** — non-`latest` tags default to `imagePullPolicy: IfNotPresent`, so a repushed tag is not pulled; deploy digests.
- **Server-side apply conflicts** — `--force-conflicts` takes field ownership from another manager (often a controller); use it only deliberately.
- **EndpointSlices** — the v1 Endpoints API is deprecated; tooling and debugging should read EndpointSlices.
- **Native sidecars** — init containers with `restartPolicy: Always` start before and stop after the main container; prefer them for proxies and log shippers.
- **DNS `ndots:5`** — external hostnames trigger several search-domain lookups; use FQDNs with a trailing dot or tune `dnsConfig` for chatty clients.
- **Strict PDBs** — `minAvailable` equal to the replica count blocks every node drain and upgrade.
- **Stuck Terminating** — namespaces or objects wait on finalizers; find the owning controller instead of stripping finalizers.
- **In-place resize** — recent versions can change container resources without a restart; check the cluster version and docs before relying on it.

## Workflow

1. Confirm context, namespace, owner and current state (`kubectl get deploy,rs,pods -n <ns> -o wide`, events).
2. Classify the failure (scheduling, image, start, readiness, traffic, capacity) and read the matching evidence.
3. Change the source of truth (Git manifests, values file, kustomization) with the narrow fix.
4. Validate offline and preview server-side in the exact target context.
5. Roll out through the owning path; watch rollout status, events and new pod logs.
6. Verify endpoints and real traffic; record image digest, revision and the rollback path.

## Proof

- Schema: `kubeconform -strict -summary k8s/`, `helm lint`, `helm template . | kubeconform -strict -`
- Preview: `kubectl diff -f k8s/` (exit 0 none, 1 differences, above 1 error); `kubectl apply --dry-run=server -f k8s/`
- Rollout: `kubectl rollout status deploy/<name> -n <ns> --timeout=180s`
- Identity: `kubectl get pods -n <ns> -l app=<name> -o jsonpath='{.items[*].status.containerStatuses[*].imageID}'`
- Endpoints: `kubectl get endpointslices -n <ns> -l kubernetes.io/service-name=<svc>`
- Traffic: `kubectl port-forward -n <ns> svc/<svc> 8080:80` then `curl -fsS localhost:8080/healthz`, and the real Gateway or Ingress hostname
- RBAC: `kubectl auth can-i --list --as=system:serviceaccount:<ns>:<sa>`

## Stop and ask

- Any mutation in a production context, or on cluster-scoped objects (CRDs, ClusterRoles, webhooks, StorageClasses, nodes).
- Deleting PVCs, namespaces or StatefulSets with volumes, or removing finalizers.
- `--force-conflicts`, `kubectl replace --force`, or force-deleting stateful pods with `--grace-period=0`.
- Imperative edits to GitOps-managed objects, or pausing their sync.
- Reading or exporting Secret values.

## Before returning

- [ ] Context, namespace, workload controller and owning tool (GitOps, Helm, Kustomize) recorded
- [ ] Change made in the source of truth; server-side preview reviewed
- [ ] Images pinned by digest or immutable tag
- [ ] Probes separated; liveness has no external dependency
- [ ] Requests, limits, PDB, spread and termination grace consistent with the workload
- [ ] Rollout status succeeded, EndpointSlices ready, real traffic answered by the new version
- [ ] No Secret values printed; rollback revision and command recorded

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[Kubernetes releases](https://kubernetes.io/releases/), [Deployment contract](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/), [Ingress NGINX retirement](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/).

## Skills in scope

- container-hardening — review and improve container image/runtime protection for an owned application with tested compatibility.
- release-rollback — plan and execute authorized release promotion or rollback with exact artifact and data compatibility.
- observability — Prometheus/OpenTelemetry pod metrics, probe failure alerts, and structured container log collection.
- infrastructure-as-code — build and maintain Terraform, OpenTofu, Pulumi or cloud-native IaC with reviewable plans and protected state.
- container-debugging — image-level causes (entrypoint, arch, loader) behind a crashing pod.
- incident-response — when a workload failure is a live outage.

---
name: infrastructure-as-code
description: "Terraform, OpenTofu, Pulumi and CDK: plans, remote state, backends, provider locks, moved/import blocks, drift and modules. Use when writing or reviewing IaC, reading a plan for destroys or replacements, refactoring without recreation, importing existing resources, fixing drift, upgrading providers or clearing a stuck state lock. Not for choosing services (use cloud-architecture) or cluster runtime work (use kubernetes-operations)."
trigger: "Use when a request touches .tf or .tfvars files, Pulumi stacks or CDK apps, a terraform plan or apply, state, drift or a provider upgrade."
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: operations
  domain: "infrastructure"
paths: ["*.tf", "*.tfvars", "Pulumi.yaml", "Pulumi.*.yaml"]
---

# Infrastructure As Code

## Selection card
- Task: Change, refactor or reconcile infrastructure through reviewable IaC plans.
- Start: Identify the engine, backend, workspace or stack, target account and region, and the committed provider lock file; read the module being changed.
- Finish: fmt, validate and lint pass, a saved plan shows only the intended actions, and any authorized apply is followed by a clean no-change plan.

## Overview

The plan is the change: review the saved plan line by line, apply exactly that file, and express every state move in code so the next reviewer can see it.
Checked 2026-11-02: Terraform 1.17.1, OpenTofu 1.13.2, Pulumi 3.273.0 and AWS CDK library 2.275.0. Verify engine/provider/backend compatibility and licensing before choosing or migrating.
State holds secrets and the identity of every real resource; losing or corrupting it is an outage.

## Rules

1. Pin the target before any command: account (`aws sts get-caller-identity` or equivalent), region, workspace or stack (`terraform workspace show`, `pulumi stack ls`), backend config and lock file.
2. Plan to a file and apply that file: `terraform plan -out=tfplan`, review `terraform show tfplan`, then `terraform apply tfplan`. A plan never authorizes an apply.
3. Read every delete and `-/+` replacement on stateful resources (databases, buckets, keys, volumes, DNS zones) and find the attribute marked `# forces replacement`; protect them with `lifecycle { prevent_destroy = true }`.
4. Express state changes as reviewed `moved`, `import` and `removed` blocks. `terraform state mv/rm`, `force-unlock` and `-target` are documented break-glass steps with approval.
5. Treat state as a secret: encrypted remote backend with locking (S3 backends support native `use_lockfile = true`; DynamoDB locking is deprecated), versioned bucket, narrow IAM; never commit `.tfstate`, plan files or secret `.tfvars`.
6. Keep secrets out of state where the engine allows: ephemeral values and write-only arguments in recent Terraform, or a secrets-manager reference; `sensitive = true` only hides output.
7. Commit `.terraform.lock.hcl` with hashes for every platform that runs init, pin providers with `~>`, and upgrade providers in a dedicated change.
8. One engine per state. Do not alternate Terraform and OpenTofu on the same state; OpenTofu state encryption makes it unreadable to Terraform.

## First moves by situation

| Situation | First moves |
|---|---|
| New resource or module | Copy sibling module conventions; `terraform init -lockfile=readonly`; `terraform validate`; plan to a file |
| Unexpected replacement | Find `# forces replacement`; provider default changed, name or ID changed, `count` index shift? Fix with `moved`, stable keys or a narrow `ignore_changes` |
| Drift | `terraform plan -refresh-only` shows out-of-band changes; adopt into code or revert; scheduled job on `-detailed-exitcode` |
| Adopt existing resources | An `import` block (`to =` resource address, `id =` provider ID) plus `terraform plan -generate-config-out=generated.tf`; plan must show imports only |
| Rename or split modules | A `moved` block from `module.old.aws_x.y` to `module.new.aws_x.y`; plan shows moves with 0 to add and 0 to destroy |
| Stop managing a resource | A `removed` block with `lifecycle { destroy = false }` instead of `terraform state rm` |
| State lock stuck | Read the lock ID, holder and time from the error; confirm no CI run is active; `terraform force-unlock <ID>` only with approval |
| Provider or engine upgrade | Read the upgrade guide; `terraform init -upgrade` on a branch; plan must be empty or fully explained; refresh lock hashes |
| Pulumi or CDK | `pulumi stack select <stack>` then `pulumi preview --diff`; `cdk diff` and `cdk synth`; logical ID changes in CDK mean replacement |

## Patterns and pitfalls

- **`count` index shift** — removing a middle element renumbers and recreates everything after it; key resources with `for_each` over stable identifiers instead.
- **Lock file platforms** — a lock created on macOS lacks Linux hashes, so CI fails `init -lockfile=readonly`; run `terraform providers lock -platform=linux_amd64 -platform=darwin_arm64`.
- **Exit codes** — with `-detailed-exitcode`, plan returns 0 (no changes), 1 (error) or 2 (changes); scripts treating any non-zero as failure misreport.
- **Plan files leak** — `tfplan` contains sensitive values in plaintext; do not publish it as a public CI artifact.
- **Perpetual diffs** — providers normalize JSON policies and ordering; build policies with `jsonencode` or policy-document data sources; `ignore_changes` only per attribute with a comment.
- **`-target` leaves debt** — the next full plan surprises; reconcile immediately after break-glass use.
- **Replacement downtime** — `create_before_destroy` avoids gaps but needs unique names (`name_prefix`); unknown values (`known after apply`) can cascade replacements to dependents.
- **Workspaces are not isolation** — CLI workspaces share code and backend credentials; separate accounts and state per environment limit blast radius.
- **Data sources at plan time** — they read live infrastructure during plan; one depending on a not-yet-created resource defers and can churn diffs.
- **Pulumi secrets** — set with `pulumi config set --secret`; values are encrypted by the stack's secrets provider, which must be available to every runner.
- **CDK construct moves** — moving a construct changes its logical ID, so CloudFormation replaces the resource; set `RemovalPolicy.RETAIN` on stateful resources and check `cdk diff`.

## Workflow

1. Confirm engine, version, backend, workspace or stack, account and region; read current state for the touched addresses (`terraform state list`, `terraform state show <addr>`).
2. Implement the narrow change with stable keys and `moved`, `import` or `removed` blocks where identity changes.
3. Format, validate and lint; run module tests where present.
4. Plan to a file; list every delete or replace and explain each one.
5. Hand the plan to the approver; apply only the reviewed file in the authorized environment.
6. Re-plan after apply and confirm no changes; record versions, plan summary and outputs.

## Proof

- Format and validation: `terraform fmt -check -recursive`, `terraform init -lockfile=readonly`, `terraform validate`
- Lint and policy: `tflint`, `trivy config .` or `checkov -d .`
- Module tests: `terraform test` for `.tftest.hcl` suites
- Plan: `terraform plan -out=tfplan -detailed-exitcode`, then `terraform show -json tfplan | jq -r '.resource_changes[] | select(.change.actions | contains(["delete"])) | .address'` lists deletes and replacements
- After apply: `terraform plan -detailed-exitcode` exits 0
- OpenTofu: same commands via the `tofu` CLI; Pulumi: `pulumi preview --diff --expect-no-changes`; CDK: `cdk diff`

## Stop and ask

- Any apply or destroy, or a plan that deletes or replaces a stateful resource.
- State surgery (`state mv`, `state rm`, `state push`), `force-unlock`, `-target`, or imports into production state.
- Backend migration, engine switch, or a provider major upgrade.
- Production credentials are required, or variable values are secrets that would be printed.

## Before returning

- [ ] Engine, versions, backend, workspace or stack, account and region recorded
- [ ] Lock file committed with hashes for CI and developer platforms
- [ ] `fmt`, `validate`, lint and module tests pass with output reported
- [ ] Saved plan reviewed; every delete or replacement explained or prevented
- [ ] Identity changes expressed as `moved`, `import` or `removed` blocks
- [ ] No secrets committed; state backend encrypted, locked and versioned
- [ ] Plan-only and applied outcomes reported separately; post-apply plan shows no changes

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[Terraform state](https://developer.hashicorp.com/terraform/language/state), [OpenTofu docs](https://opentofu.org/docs/), [Pulumi docs](https://www.pulumi.com/docs/).

## Skills in scope

- cloud-architecture — choose and design cloud services from concrete application, data, availability and operational requirements.
- kubernetes-operations — operate and deploy owned Kubernetes workloads with explicit cluster, namespace and rollout identity.
- ci-cd — build and repair reproducible CI and deployment workflows with explicit artifacts, permissions and release gates.
- backup-recovery — design and verify backups and restoration for owned databases, files and application state.
- security-scanner — misconfiguration findings in IaC with evidence and remediation.

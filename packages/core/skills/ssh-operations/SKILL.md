---
name: ssh-operations
description: "Connect to and administer explicitly authorized hosts through OpenSSH with verified identity and bounded operations. Use when setting up SSH config, approved bastions, file transfer or a known remote maintenance task; a connection does not authorize work on additional hosts."
trigger: "Connect to and administer explicitly authorized hosts through OpenSSH with verified identity and bounded operations. Use when setting up SSH config, approved bastions, file transfer or a known remote maintenance task; a connection does not authorize work on additional hosts."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: operations
  domain: "operations"
---

# Ssh Operations

## Selection card
- Task: Establish verified SSH identities, sessions and transfers.
- Start: Identify the authorized target, current health and rollback boundary.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Connect to and administer explicitly authorized hosts through OpenSSH with verified identity and bounded operations.

Checked upstream target 2026-10-09: OpenSSH portable 10.6p1. Distribution and Windows builds may carry different versions/backports; inspect installed support before changing host/client software.

## Rules

1. Resolve the approved hostname, account, port and purpose before connecting. Operate only on the known authorized host set.
2. Verify the host key through an established trusted record/out-of-band source; do not disable verification to get past a mismatch.
3. Use least-required identities and avoid printing private keys, tokens or expanded credential-bearing commands.
4. Keep agent forwarding and remote exposure disabled unless a concrete authorized workflow requires them.
5. Read host/config identity and ownership before mutations. Connection retries must not repeat a partially completed remote operation blindly.
6. Do not scan hosts, try alternate credentials or bypass access controls when a connection is denied; report the actual access/configuration gap.

## Workflow

1. Inspect local client version and effective config for the named target, redacting sensitive values.
2. Validate host identity and connect through the explicitly approved route/bastion.
3. Establish remote OS/user/work directory and operation preconditions.
4. Perform the requested bounded maintenance or transfer; validate paths and expected result.
5. Verify the outcome and close owned sessions/tunnels. Record any live state left running.

## Before returning

Host/account/purpose explicit; host key verification retained; credentials redacted; actual remote result and session/tunnel ownership reported.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[OpenSSH releases](https://www.openssh.com/releasenotes.html), [SSH config](https://man.openbsd.org/ssh_config).

## Skills in scope

- linux-service-ops — owned service configuration and lifecycle.
- remote-debugging — bounded evidence on the authorized host.
- vps-deploy — versioned deployment to the authorized server.
